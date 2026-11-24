import type { OperationDef } from "@nd-factory/contracts/operation";
import { ID_KINDS, UUID_V7_PATTERN } from "@nd-factory/contracts/ids";
import { REASON_CODE } from "@nd-factory/contracts/reasons";
import { utcDateTime } from "@nd-factory/contracts/values";
import { writeRow } from "@nd-factory/contracts/row-codec";
import { auditCodec, type AuditRow } from "@nd-factory/contracts/rows/audit";
import type { Principal } from "./auth/authenticate.ts";
import type { Clock } from "./clock.ts";
import { putIfAbsent, WriteSpecError, writeAtomically, WriteUnavailableError, type TransactItem } from "./conditional-write.ts";
import type { Db, Row } from "./db.ts";
import type { Id } from "./ids.ts";
import { redact } from "./redact.ts";
import { classifyFailure } from "./retry.ts";

// 操作の記録（docs/design/api.md の「操作の記録」、I9）。追記だけで、許した鍵の ID だけを写し、本文・秘密・個人情報を持たない。
// 状態を書く要素の行は auditItem をそのトランザクションへ入れ、状態を書かない要求の行は appendAudit で 1 行追記する

// 入口
export type AuditChannel = "screen" | "api" | "mcp" | "runner" | "machine" | "github" | "patrol" | "db_prep";

export type AuditResult = {
  // ok（すべての要素が成功）・partial（一部の要素が失敗）・rejected（要求全体を断った）
  readonly outcome: "ok" | "partial" | "rejected";
  readonly status: number;
  // 理由のコードの並び
  readonly reasons: readonly string[];
};

export type AuditActor = {
  // 決まらなかった 401 は null
  readonly principal: Principal | null;
  // MCP の要求が名乗るクライアントの名前（確かめられないため委任のクライアントの名前と分けて持つ）
  readonly mcpClientName: string | null;
};

export type AuditEntry = {
  readonly auditId: Id<"aud">;
  readonly requestId: string;
  // 受けた時刻（UTC、ミリ秒まで）
  readonly at: string;
  readonly actor: AuditActor;
  readonly channel: AuditChannel;
  // 操作の名前。表に無い HTTP の経路は null
  readonly operation: string | null;
  // 対象の ID を取り出す元（要素の値）。行へは op.auditKeys の鍵の値だけを写す
  readonly targetIds: Readonly<Record<string, unknown>>;
  // 主体がそのプロジェクトを見られたときだけ
  readonly projectId: Id<"prj"> | null;
  readonly result: AuditResult;
  // 要素の番号。要約の行は null
  readonly itemIndex: number | null;
};

// まだ利用者へ結んでいない人（newcomer）が利用者を作った要素（sessions.create の初回）の記録の主体。作った利用者の人の主体に替え、
// 区切りの鍵もその利用者（USER#<利用者>）にして、本人が自分の記録として読めるようにする。dispatch はハンドラーが利用者を作った要素の行と
// その要求の要約の行をこの主体で組み、要素の行を利用者の行と同じトランザクションへ入れる。利用者を作らなかった要素と要求は newcomer のまま書く
// （主体の種類だけで、Cognito の sub・username・IdP の主体を写さない）。newcomer でない主体はそのまま返す
export function actorOfCreatedUser(actor: AuditActor, userId: Id<"usr">): AuditActor {
  const p = actor.principal;
  if (p === null || p.kind !== "newcomer") return actor;
  return {
    ...actor,
    // 作った対応の行は要求の token の auth_time を bound_auth_time に持つため、結んだ時のサインインの時刻と要求のサインインの時刻は同じ
    principal: { kind: "human", userId, cognitoSub: p.login.cognitoSub, sessionId: p.login.sessionId, boundAuthTime: new Date(p.login.authTime * 1000).toISOString(), authTime: p.login.authTime },
  };
}

// 状態を書かない要求の記録を書けない（表に届かない・表が断った）。呼び手は要求全体の 503 audit_unavailable にし、読む操作は値を返さない
export class AuditUnavailableError extends Error {
  override name = "AuditUnavailableError";
}

// 記録を残す日数の既定（設置の設定のファイルで長くできる。設定の形が置かれるまで既定だけを持つ）
export const AUDIT_RETENTION_DAYS = 365;

const SECONDS_PER_DAY = 86_400;

// 主体の種類と、当たる ID とクライアントの名前だけ。委任の範囲は写さない
function actorColumns(actor: AuditActor): Record<string, unknown> {
  const p = actor.principal;
  const mcp = actor.mcpClientName === null ? {} : { mcp_client_name: actor.mcpClientName };
  if (p === null) return { kind: null, ...mcp };
  switch (p.kind) {
    case "human":
      return { kind: p.kind, user_id: p.userId, ...mcp };
    case "delegation":
      return { kind: p.kind, user_id: p.userId, delegation_id: p.delegationId, client_name: p.clientName, ...mcp };
    case "runner":
      return { kind: p.kind, lane_id: p.laneId, project_id: p.projectId, generation: p.generation, ...mcp };
    case "machine":
      return { kind: p.kind, team_id: p.teamId, machine_id: p.machineId, ...mcp };
    case "db_prep":
      return { kind: p.kind, project_id: p.projectId, prep_id: p.prepId, ...mcp };
    // まだ利用者へ結んでいない人は種類だけ（Cognito の sub・username・IdP の主体は写さない。作った利用者は actorOfCreatedUser で人の主体にする）
    case "newcomer":
    case "github":
    case "patrol":
      return { kind: p.kind, ...mcp };
  }
}

// ID の形（<種類の頭>_<UUIDv7>）。許した鍵に個人情報（メールアドレスなど）や本文が入っても写さないよう、鍵に加えて値の形も照らす
const ID_SHAPE = new RegExp(`^(?:${ID_KINDS.join("|")})_${UUID_V7_PATTERN}$`);

function isIdShaped(value: unknown): value is string {
  return typeof value === "string" && ID_SHAPE.test(value);
}

// 許した鍵の値のうち、ID の形の文字列（と、その配列の ID の形の要素）だけ。形の外れた値は写さずに捨てる
function targetIdsOf(entry: AuditEntry, op: OperationDef | null): string[] {
  if (op === null) return [];
  return op.auditKeys.flatMap((key) => {
    const value = entry.targetIds[key];
    if (isIdShaped(value)) return [value];
    if (Array.isArray(value)) return value.filter(isIdShaped);
    return [];
  });
}

// 記録の行の中身を組む。行の形の版・鍵（PK・SK）の組み立て・形の照らしは行の版の書き手（auditCodec と writeRow）が持ち、ここでは持たない
export function auditItem(entry: AuditEntry, op: OperationDef | null, clock: Clock): TransactItem {
  if (!utcDateTime.safeParse(entry.at).success) throw new WriteSpecError("auditItem: at は UTC の日時");
  if (entry.itemIndex !== null && (!Number.isInteger(entry.itemIndex) || entry.itemIndex < 0)) throw new WriteSpecError("auditItem: itemIndex は 0 以上の整数");
  const columns = {
    audit_id: entry.auditId,
    request_id: entry.requestId,
    at: entry.at,
    actor: actorColumns(entry.actor),
    channel: entry.channel,
    operation: entry.operation ?? "",
    target_ids: targetIdsOf(entry, op),
    ...(entry.projectId === null ? {} : { project_id: entry.projectId }),
    ...(entry.itemIndex === null ? {} : { item_index: entry.itemIndex }),
    result: {
      outcome: entry.result.outcome,
      status: entry.result.status,
      // 理由のコードの形の値だけ（文を運ばない）
      reasons: entry.result.reasons.filter((r) => REASON_CODE.test(r)),
    },
    expire_at: Math.floor(clock.epochMs() / 1000) + AUDIT_RETENTION_DAYS * SECONDS_PER_DAY,
  };
  // 写した値にも秘密の形が紛れうる（ID の欄に token を入れた要素など）ため、行全体を redact へ通す
  const safe = redact(columns) as Omit<AuditRow, "schema_version">;
  const item = writeRow(auditCodec, { ...safe, schema_version: auditCodec.latest.version }) as Row;
  return putIfAbsent({ table: "audit", item, onConflict: "fail" });
}

export async function appendAudit(db: Db, entry: AuditEntry, op: OperationDef | null, clock: Clock): Promise<void> {
  const item = auditItem(entry, op, clock);
  let outcome;
  try {
    outcome = await writeAtomically(db, [item]);
  } catch (error) {
    if (error instanceof WriteUnavailableError) throw new AuditUnavailableError("操作の記録を書けない", { cause: error });
    // 表が断った失敗（rejected。SerializationException・取り消しの理由の ValidationError など）も記録を書けなかったことに変わりないため、
    // 汎用の unavailable でなく audit_unavailable に分けられるよう包む。組み立ての誤り（WriteSpecError など）は包まない
    if (classifyFailure(error) === "rejected") throw new AuditUnavailableError("操作の記録を表が断った", { cause: error });
    throw error;
  }
  // 同じ記録の行が既にある（記録の ID の重なり）。上書きせず、書けなかったと同じに扱う
  if (!outcome.ok) throw new AuditUnavailableError("操作の記録の行が既にある");
}
