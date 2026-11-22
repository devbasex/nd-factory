import { isPending, resultSchemaOf, type OperationDef } from "@nd-factory/contracts/operation";
import type { IdempotencyRow } from "@nd-factory/contracts/rows/idempotency";
import { cognitoSubjectKey, sessionRevocationKey, type CognitoSubjectRow, type SessionRevocationRow } from "@nd-factory/contracts/rows/users";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { actorOfCreatedUser, appendAudit, auditItem, type AuditActor, type AuditEntry, type AuditResult } from "../audit.ts";
import { authenticate, idempotencyPrincipalKey, SESSIONS_DELETE, type Principal } from "../auth/authenticate.ts";
import { authorize, type ItemAuthz, type ProjectId } from "../authorize.ts";
import { AuditAppendOnlyError, cond, TRANSACT_MAX_ITEMS, WriteSpecError, WriteUnavailableError, writeAtomically, type ConflictRule, type TransactItem, type WriteOutcome } from "../conditional-write.ts";
import type { StoredRow } from "../db.ts";
import { claimIdempotency, releaseIdempotency, settleIdempotency, type IdempotencyClaimInput, type ItemResult } from "../idempotency.ts";
import { newId, type Id } from "../ids.ts";
import type { Logger } from "../log.ts";
import { bodyFaultOf, canonicalJson, problem } from "./http.ts";
import type { AllowedAuthz, DispatchDeps, DispatchResult, Handler, HandlerOutput, OperationCall, Problem, WriteConflict } from "./types.ts";

export { readHttpCall, writeHttpResponse } from "./http.ts";
export type * from "./types.ts";

// 操作の振り分け（docs/design/detail.md の「処理の手順」の dispatch）。受けた方法 → 認証 → 本文の形 → 人だけ・委任の種類 →
// 要素ごとの 形 → 見えない → 人だけの要素 → 役割 → 冪等の鍵 → ハンドラー → 確定 を、どの受け口でも同じ順で通す。
// 書く要素ごとに、状態の書き込み・要素の記録の行・冪等の鍵の済みの行（と、主体が人なら要求元の照らし）を 1 つの writeAtomically で確定し（I9）、
// 要求ごとに要約の記録の行を appendAudit で書く。記録を書けなければ 503 で値を返さない

// 要約の記録と応答に残す時間（ミリ秒）。要素の前の残り時間がこれを下回れば、残りの要素を処理しない
export const DISPATCH_RESERVE_MS = 1500;

// 予備の時間のうち、要約の記録と応答だけに残す時間（ミリ秒）。確定しなかった要素の後始末（冪等の鍵の借りの手放し）はこれを超える分だけを使う
export const DISPATCH_SUMMARY_MS = 1000;

// 1 つのトランザクションの組み直しの上限（onConflict が rebuild の件だけが外れたとき、ハンドラーを呼び直して組み直す回数。
// issues/issue-2-design-row-writers.md の決定 6）。外れは並んだ書き手の確定のときだけ起きる
export const DISPATCH_REBUILD_LIMIT = 3;

// 認可の対象を要素の指す行でなく主体の利用者自身にする操作（外したログインの行の有無は、冪等の鍵の照合の後にハンドラーが照らす）
const LOGINS_DELETE = "logins.delete";

// 残りの要素を処理せずに要求全体の誤りで返す
class Halt extends Error {
  override name = "Halt";
  readonly problem: Problem;
  constructor(result: Problem) {
    super(`要求を止める（${result.status}）`);
    this.problem = result;
  }
}

const halt = (status: number, reason: string): Halt => new Halt(problem(status, reason));

// 要約の行に書く、要求の中で決まったこと。authz は要求の要素と同じ番号（形の誤りの要素は undefined）
type Seen = { principal: Principal | null; createdUserId: Id<"usr"> | null; items: readonly unknown[]; authz: readonly (ItemAuthz | undefined)[] };

type Request = {
  readonly call: OperationCall;
  readonly deps: DispatchDeps;
  readonly op: OperationDef | null;
  readonly at: string;
  readonly auditId: Id<"aud">;
  readonly log: Logger;
  readonly seen: Seen;
};

const operationTables = new WeakMap<readonly OperationDef[], Map<string, OperationDef>>();

function operationOf(operations: readonly OperationDef[], name: string): OperationDef | null {
  let table = operationTables.get(operations);
  if (table === undefined) {
    table = new Map(operations.map((op) => [op.name, op]));
    operationTables.set(operations, table);
  }
  return table.get(name) ?? null;
}

const failure = (status: number, reason: string, fields?: readonly string[]): ItemResult => (fields === undefined ? { ok: false, status, reason } : { ok: false, status, reason, fields });

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function fingerprintOf(item: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(item))));
}

// 記録

function actorOf(req: Request, principal: Principal | null, createdUserId: Id<"usr"> | null): AuditActor {
  const actor: AuditActor = { principal, mcpClientName: req.call.mcpClientName ?? null };
  return createdUserId === null ? actor : actorOfCreatedUser(actor, createdUserId);
}

function entryOf(req: Request, actor: AuditActor, fields: Pick<AuditEntry, "targetIds" | "projectId" | "result" | "itemIndex">): AuditEntry {
  return { auditId: req.auditId, requestId: req.call.requestId, at: req.at, actor, channel: req.call.channel, operation: req.op?.name ?? null, ...fields };
}

function itemAuditResult(result: ItemResult): AuditResult {
  if (result.ok) return { outcome: "ok", status: 200, reasons: [] };
  return { outcome: "rejected", status: typeof result["status"] === "number" ? result["status"] : 0, reasons: typeof result["reason"] === "string" ? [result["reason"]] : [] };
}

function summaryResult(result: DispatchResult): AuditResult {
  if (result.kind === "problem") return { outcome: "rejected", status: result.status, reasons: result.reason === null ? [] : [result.reason] };
  const reasons = [...new Set(result.items.flatMap((r) => (!r.ok && typeof r["reason"] === "string" ? [r["reason"]] : [])))];
  return { outcome: result.items.every((r) => r.ok) ? "ok" : "partial", status: 200, reasons };
}

// 要約の行の対象の ID の元。許した鍵（op.auditKeys）ごとに要素の値を集める（行へは ID の形の値だけを auditItem が写す）
function summaryTargets(op: OperationDef | null, items: readonly unknown[]): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const key of op?.auditKeys ?? []) {
    const values = items.flatMap((item) => {
      const value = record(item)[key];
      return Array.isArray(value) ? value : value === undefined ? [] : [value];
    });
    if (values.length > 0) out[key] = values;
  }
  return out;
}

// 見られたプロジェクトが 1 つに決まるときだけ、その区切りに置く
function soleProject(authz: readonly (ItemAuthz | undefined)[]): ProjectId | null {
  const ids = new Set(authz.flatMap((a) => (a?.decision === "allow" && a.projectId !== null ? [a.projectId] : [])));
  return ids.size === 1 ? ([...ids][0] ?? null) : null;
}

// 要約の行の対象と結果。プロジェクトの区切りに置くときは、そのプロジェクトで許された要素だけから組む（そのプロジェクトを読める人へ、
// 許されなかった要素の対象の ID と結果を見せない）。主体の区切りに置くときは、主体が送った要素のすべて
function summaryFields(req: Request, result: DispatchResult): Pick<AuditEntry, "targetIds" | "projectId" | "result" | "itemIndex"> {
  const { seen } = req;
  const projectId = soleProject(seen.authz);
  if (projectId === null) return { targetIds: summaryTargets(req.op, seen.items), projectId, result: summaryResult(result), itemIndex: null };
  const shown = seen.items.flatMap((_, i) => {
    const a = seen.authz[i];
    return a?.decision === "allow" && a.projectId === projectId ? [i] : [];
  });
  const items = shown.map((i) => seen.items[i]);
  const visible: DispatchResult = result.kind === "items" ? { kind: "items", items: shown.flatMap((i) => (result.items[i] === undefined ? [] : [result.items[i]])) } : result;
  return { targetIds: summaryTargets(req.op, items), projectId, result: summaryResult(visible), itemIndex: null };
}

// 要約の行を書いてから返す。書けなければ 503 audit_unavailable で値を返さない。既に 503 の結果は書けなくてもそのまま
async function finish(req: Request, result: DispatchResult): Promise<DispatchResult> {
  const { seen } = req;
  try {
    await appendAudit(req.deps.db, entryOf(req, actorOf(req, seen.principal, seen.createdUserId), summaryFields(req, result)), req.op, req.deps.clock);
    return result;
  } catch (error) {
    req.log.error("要約の記録の行を書けない", { error: errorName(error) });
    return result.kind === "problem" && result.status === 503 ? result : problem(503, "audit_unavailable");
  }
}

// 人の書き込みの要求元の照らし（docs/design/data.md の「人の書き込みの要求元の照らし」）。主体が人の書く操作で、sessions.delete を除く。
// 要求元の対応の行が今も主体の利用者と結んだ時刻のままであることと、要求元のセッションの取り消しの行が無いことを、書かない条件で照らす
function requesterGuards(op: OperationDef, principal: Principal): TransactItem[] {
  if (op.access !== "write" || principal.kind !== "human" || op.name === SESSIONS_DELETE) return [];
  const binding = cognitoSubjectKey({ cognito_sub: principal.cognitoSub } as CognitoSubjectRow);
  const revocation = sessionRevocationKey({ cognito_sub: principal.cognitoSub, session_id: principal.sessionId } as SessionRevocationRow);
  return [
    {
      table: "users",
      op: "check",
      key: binding,
      condition: cond.and(cond.exists("pk"), cond.eq("user_id", principal.userId), cond.eq("bound_auth_time", principal.boundAuthTime)),
      onConflict: "state_mismatch",
    },
    { table: "users", op: "check", key: revocation, condition: cond.notExists("pk"), onConflict: "state_mismatch" },
  ];
}

// 確定の組み立て。件ごとに、どの要素のどの役の件かを持つ（外れた件を要素の結果へ戻すため）。
// 同じ行を指す件は 1 件にまとめるため、1 つの件が複数の持ち手を持つ

type Handled = {
  readonly result: ItemResult;
  readonly writes: readonly TransactItem[];
  readonly conflicts: readonly (WriteConflict | undefined)[];
  // claimIdempotency が fresh で返した借りの行（冪等の鍵を持たない操作は null）。組み直しでも借りたまま使う
  readonly leased: IdempotencyRow | null;
  readonly authz: AllowedAuthz;
  readonly item: unknown;
  readonly createdUserId: Id<"usr"> | null;
};

type Part = { readonly element: number; readonly writes: readonly TransactItem[]; readonly audit: TransactItem; readonly settle: TransactItem | null };

// guarded は要求元の照らしの持ち手
type Owner = { readonly element: number | null; readonly role: "write" | "audit" | "settle" | "guard"; readonly writeIndex: number; readonly guarded: boolean; readonly onConflict: ConflictRule };

const sameRow = (a: TransactItem, b: TransactItem): boolean => a.table === b.table && a.key.pk === b.key.pk && a.key.sk === b.key.sk;

function partOf(req: Request, principal: Principal, op: OperationDef, element: number, h: Handled, result: ItemResult, writes: readonly TransactItem[]): Part {
  const entry = entryOf(req, actorOf(req, principal, h.createdUserId), { targetIds: record(h.item), projectId: h.authz.projectId, result: itemAuditResult(result), itemIndex: element });
  return { element, writes, audit: auditItem(entry, op, req.deps.clock), settle: h.leased === null ? null : settleIdempotency(h.leased, result, op, req.deps.clock) };
}

// 同じ行を指す件は 2 回指せないため 1 件にまとめる。書かない照らし（check）は、同じ行の照らしか書き込みの条件へ AND で足す
// （要求元の照らしと同じ行を指す logins.delete の書き込み・全部か無かで要素ごとに同じプロジェクトの行を照らす repositories.add）。
// まとめた件が外れたら、その件のすべての持ち手が外れたとする。書き込みどうしが同じ行を指すのは組み方の誤りで、writeAtomically が断つ
function compose(parts: readonly Part[], guards: readonly TransactItem[]): { items: TransactItem[]; slots: Owner[][] } {
  const items: TransactItem[] = [];
  const slots: Owner[][] = [];
  const add = (item: TransactItem, owner: Owner): void => {
    const at = items.findIndex((existing) => sameRow(existing, item) && (existing.op === "check" || item.op === "check"));
    const existing = at < 0 ? undefined : items[at];
    if (existing === undefined) {
      items.push(item);
      slots.push([{ ...owner, onConflict: item.onConflict }]);
      return;
    }
    const base = existing.op === "check" ? item : existing;
    items[at] = { ...base, condition: cond.and(base.condition, base === item ? existing.condition : item.condition) };
    slots[at]?.push({ ...owner, onConflict: item.onConflict });
  };
  for (const part of parts) {
    part.writes.forEach((write, writeIndex) => add(write, { element: part.element, role: "write", writeIndex, guarded: false, onConflict: write.onConflict }));
    add(part.audit, { element: part.element, role: "audit", writeIndex: -1, guarded: false, onConflict: part.audit.onConflict });
    if (part.settle !== null) add(part.settle, { element: part.element, role: "settle", writeIndex: -1, guarded: false, onConflict: part.settle.onConflict });
  }
  for (const guard of guards) add(guard, { element: null, role: "guard", writeIndex: -1, guarded: true, onConflict: guard.onConflict });
  return { items, slots };
}

// 確定。届かないときは記録の行を含むため 503 audit_unavailable。組み方の誤り（記録の表の書き換え・件の数の越え・同じ行の書き込みの重なり）と表が断った失敗は 503 unavailable
async function commit(req: Request, items: readonly TransactItem[]): Promise<WriteOutcome> {
  try {
    return await writeAtomically(req.deps.db, items, req.log);
  } catch (error) {
    if (error instanceof WriteUnavailableError) throw halt(503, error.includesAudit ? "audit_unavailable" : "unavailable");
    if (error instanceof AuditAppendOnlyError || error instanceof WriteSpecError) req.log.error("ハンドラーが組んだ書き込みを確定しない", { error: error.name });
    throw halt(503, "unavailable");
  }
}

function failedOf(outcome: Extract<WriteOutcome, { ok: false }>, slots: readonly (readonly Owner[])[]): Owner[] {
  return outcome.failed.flatMap((f) => slots[f.index] ?? []);
}

// 外れた件がどれもハンドラーの rebuild の件か（要求元の照らし・記録の行・冪等の鍵の済みの行・ほかの扱いの件が外れていない）。
// 同じ行へまとめた件は持ち手のどれかが rebuild でなければ組み直さない
function rebuildOnly(failed: readonly Owner[]): boolean {
  return failed.length > 0 && failed.every((f) => f.role === "write" && !f.guarded && f.onConflict === "rebuild");
}

// 組み直しの前の照らし。使い切ったら要求全体の 503 unavailable（呼び手は同じ冪等の鍵で送り直せる）、残り時間が足りなければ checkTime の 503
function checkRebuild(req: Request, rebuilds: number): void {
  if (rebuilds >= DISPATCH_REBUILD_LIMIT) {
    req.log.warn("組み直しの上限を使い切った", { rebuilds });
    throw halt(503, "unavailable");
  }
  checkTime(req);
}

type Verdict = { readonly kind: "result"; readonly result: ItemResult } | { readonly kind: "existing"; readonly writeIndex: number };

// 1 つの要素の外れた件を結果へ訳す。要求元の照らし（同じ行へまとめた件を含む）を先に当て、残りはハンドラーが並べた件の順の最初の理由
// （ハンドラーが conflicts に操作の契約の失敗の結果を置いた件はその結果、ほかは onConflict の version_mismatch・state_mismatch）。
// 記録の行が外れたら 503 audit_unavailable、済みの行だけが外れたら（借りを失った）409 in_progress。
// 既にある行から結果を組める return_existing の件が外れたら、付随する書き込みの外れによらず、その件の既にある行から結果を組む（existing）。
// 同じレーンの同じ連番の並行の再送では、先に確定した要求が付随する行（レーンの版など）も進めるため、付随する件も外れる。
// 既にある行の結果では付随する書き込みを確定しないため、その外れは結果を決めない。再送そのものを拒む条件（要求元の照らし・記録の行・
// 冪等の鍵の済みの行）は上で先に当て、既にある行の結果を確定するトランザクションでも同じ件を照らし直す
function verdictOf(req: Request, failed: readonly Owner[], conflicts: readonly (WriteConflict | undefined)[]): Verdict {
  const result = (r: ItemResult): Verdict => ({ kind: "result", result: r });
  if (failed.some((f) => f.guarded)) return result(failure(409, "state_mismatch"));
  if (failed.some((f) => f.role === "audit")) throw halt(503, "audit_unavailable");
  // rebuild の件は、ほかの件と一緒に外れたときだけここへ来る（rebuild の件だけなら組み直す）。結果はほかの件で決める
  const own = failed.filter((f) => f.role === "write" && f.onConflict !== "rebuild").sort((a, b) => a.writeIndex - b.writeIndex);
  if (own.length === 0) return result(failure(409, "in_progress"));
  const replayable = own.find((f) => {
    const conflict = conflicts[f.writeIndex];
    return f.onConflict === "return_existing" && conflict !== undefined && "existing" in conflict;
  });
  if (replayable !== undefined) return { kind: "existing", writeIndex: replayable.writeIndex };
  const decisive = own.find((f) => f.onConflict !== "return_existing");
  if (decisive === undefined) {
    req.log.error("既にある行から結果を組む手立ての無い return_existing の件が外れた", {});
    throw halt(503, "unavailable");
  }
  const conflict = conflicts[decisive.writeIndex];
  if (conflict !== undefined && "result" in conflict) return result(conflict.result);
  if (decisive.onConflict === "version_mismatch" || decisive.onConflict === "state_mismatch") return result(failure(409, decisive.onConflict));
  req.log.error("ハンドラーの書き込みの条件が外れた", { failed: own.map((f) => f.onConflict) });
  throw halt(503, "unavailable");
}

// 要素ごと

type ParsedItem = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly fields: string[] };

function parseItems(op: OperationDef, items: readonly unknown[]): ParsedItem[] {
  const schema = op.item;
  if (isPending(schema)) return items.map(() => ({ ok: false, fields: [] }));
  return items.map((item, index) => {
    const parsed = schema.safeParse(item);
    if (parsed.success) return { ok: true, value: parsed.data };
    return { ok: false, fields: [...new Set(parsed.error.issues.map((issue) => [`/${index}`, ...issue.path.map(String)].join("/")))] };
  });
}

function checkTime(req: Request): void {
  if (req.call.remainingMs() < DISPATCH_RESERVE_MS) {
    req.log.warn("関数の残り時間が足りないため残りの要素を処理しない", { reserve_ms: DISPATCH_RESERVE_MS });
    throw halt(503, "unavailable");
  }
}

// taken は全部か無かの操作で、この要求が借りた冪等の鍵の借りの行を集める（確定しなかったときに手放すため）
type Ctx = { readonly req: Request; readonly principal: Principal; readonly sessionRevokedAt: string | null; readonly op: OperationDef; readonly handler: Handler; readonly taken: IdempotencyRow[] };

// 要素の結果を操作の結果の形で照らし、照らした値（形に無い鍵を除いた値）を返す。合わなければ 503 unavailable
function resultOf(c: Ctx, value: unknown): ItemResult {
  const parsed = resultSchemaOf(c.op).safeParse(value);
  if (!parsed.success) {
    c.req.log.error("ハンドラーの結果が操作の形に合わない", {});
    throw halt(503, "unavailable");
  }
  return parsed.data as ItemResult;
}

function checkOutput(c: Ctx, output: HandlerOutput | undefined): HandlerOutput & { readonly conflicts: readonly (WriteConflict | undefined)[] } {
  const conflicts: unknown = output?.conflicts ?? [];
  const valid = output !== null && typeof output === "object" && Array.isArray(output.writes) && Array.isArray(conflicts) && conflicts.length <= output.writes.length;
  if (!valid || output === undefined) {
    c.req.log.error("ハンドラーの戻り値が操作の形に合わない", {});
    throw halt(503, "unavailable");
  }
  if (c.op.access === "read" && output.writes.length > 0) {
    c.req.log.error("読む操作のハンドラーが書き込みを返した", {});
    throw halt(503, "unavailable");
  }
  const checked = (conflicts as unknown[]).map((conflict): WriteConflict | undefined => {
    if (conflict === undefined) return undefined;
    const r = record(conflict);
    if (typeof r["existing"] === "function") return { existing: r["existing"] as (row: StoredRow | null) => ItemResult };
    if ("result" in r) {
      const result = resultOf(c, r["result"]);
      if (!result.ok) return { result };
    }
    c.req.log.error("ハンドラーの外れたときの結果が失敗の結果でない", {});
    throw halt(503, "unavailable");
  });
  return { ...output, result: resultOf(c, output.result), conflicts: checked };
}

// 要求の中で同期に外へ働きかける直前の要求元の照らし。照らしの 2 件だけを打ち、外れたら false（docs/design/data.md の「要求の中で同期に外へ働きかける操作」）
// 表に届かないときの 503 は控えておき、ハンドラーが例外を握っても dispatch が要求全体の 503 にする
type RequesterCheck = { failed: boolean; halted: Halt | null };

async function checkRequesterOf(c: Ctx, state: RequesterCheck): Promise<boolean> {
  const guards = requesterGuards(c.op, c.principal);
  if (guards.length === 0) return true;
  let outcome: WriteOutcome;
  try {
    outcome = await commit(c.req, guards);
  } catch (error) {
    if (error instanceof Halt) state.halted = error;
    throw error;
  }
  if (!outcome.ok) state.failed = true;
  return outcome.ok;
}

// 1 つの要素の、形 → 見えない・人だけの要素・役割（authorize が決めた）→ 冪等の鍵 → ハンドラー
async function prepare(c: Ctx, index: number, parsed: ParsedItem, authz: ItemAuthz | undefined): Promise<ItemResult | Handled> {
  const { req, principal, op } = c;
  if (!parsed.ok) return failure(400, "item_invalid", parsed.fields);
  if (authz === undefined || authz.decision === "deny") return failure(authz?.status ?? 404, authz?.reason ?? "not_found");

  let leased: IdempotencyRow | null = null;
  if (op.idempotencyKey) {
    const key = record(parsed.value)["idempotency_key"];
    if (typeof key !== "string" || key.length === 0) return failure(400, "item_invalid", [`/${index}/idempotency_key`]);
    const claim: IdempotencyClaimInput = { principalKey: idempotencyPrincipalKey(principal, op.name), operation: op.name, key, fingerprint: fingerprintOf(parsed.value), requestId: req.call.requestId };
    let claimed;
    try {
      claimed = await claimIdempotency(req.deps.db, claim, req.deps.clock, req.log);
    } catch (error) {
      req.log.error("冪等の鍵の表に届かない", { error: errorName(error) });
      throw halt(503, "unavailable");
    }
    if (claimed.kind === "replay") return claimed.result;
    if (claimed.kind === "in_progress") return failure(409, "in_progress");
    if (claimed.kind === "reused") return failure(422, "idempotency_key_reused");
    leased = claimed.leased;
    c.taken.push(leased);
  }
  return handle(c, parsed.value, authz, leased);
}

// ハンドラーを呼び、戻り値を照らす。組み直しでは同じ要素と借りの行のまま呼び直す（ハンドラーは行を読み直す）
async function handle(c: Ctx, value: unknown, authz: AllowedAuthz, leased: IdempotencyRow | null): Promise<ItemResult | Handled> {
  const { req, principal } = c;
  const requester: RequesterCheck = { failed: false, halted: null };
  let output: HandlerOutput | undefined;
  try {
    output = await c.handler(value, {
      principal,
      authz,
      clock: req.deps.clock,
      db: req.deps.db,
      sessionRevokedAt: c.sessionRevokedAt,
      checkRequester: () => checkRequesterOf(c, requester),
    });
  } catch (error) {
    if (error instanceof Halt) throw error;
    req.log.error("ハンドラーが想定しない例外を投げた", { error: errorName(error) });
    throw halt(503, "unavailable");
  }
  if (requester.halted !== null) throw requester.halted;
  // 外へ働きかける前の照らしが外れた要素は、ハンドラーの戻り値によらず何も確定しない
  if (requester.failed) return failure(409, "state_mismatch");
  const checked = checkOutput(c, output);
  const createdUserId = principal.kind === "newcomer" ? (checked.createdUserId ?? null) : null;
  return { result: checked.result, writes: checked.writes, conflicts: checked.conflicts, leased, authz, item: value, createdUserId };
}

const isHandled = (p: ItemResult | Handled): p is Handled => "writes" in p && "leased" in p;

// return_existing の件の既にある行を強い整合で読み、ハンドラーの組み方で今回の結果にする
async function existingResult(c: Ctx, h: Handled, writeIndex: number): Promise<ItemResult> {
  const write = h.writes[writeIndex];
  const conflict = h.conflicts[writeIndex];
  if (write === undefined || conflict === undefined || !("existing" in conflict)) throw halt(503, "unavailable");
  let value: unknown;
  try {
    value = conflict.existing(await c.req.deps.db.get(write.table, write.key, true));
  } catch (error) {
    c.req.log.error("既にある行から結果を組めない", { error: errorName(error) });
    throw halt(503, "unavailable");
  }
  return resultOf(c, value);
}

// 要素ごとの確定。状態を書かず冪等の鍵も押さえていない要素は、要約の行だけに残す。
// 外れた件がどれも rebuild の件なら、ハンドラーを呼び直して組み直したトランザクションを確定し直す（DISPATCH_REBUILD_LIMIT 回まで）
async function settleElement(c: Ctx, index: number, handled: Handled): Promise<ItemResult> {
  const { req, principal, op } = c;
  const guards = requesterGuards(op, principal);
  let h = handled;
  let outcome: WriteOutcome;
  let slots: Owner[][];
  for (let rebuilds = 0; ; rebuilds += 1) {
    if (op.access === "read" || (h.writes.length === 0 && h.leased === null)) return h.result;
    const composed = compose([partOf(req, principal, op, index, h, h.result, h.writes)], guards);
    slots = composed.slots;
    outcome = await commit(req, composed.items);
    if (outcome.ok) {
      // 要約の主体は利用者を作ったトランザクションが確定してから替える
      if (h.createdUserId !== null) req.seen.createdUserId = h.createdUserId;
      return h.result;
    }
    if (!rebuildOnly(failedOf(outcome, slots))) break;
    checkRebuild(req, rebuilds);
    const again = await handle(c, h.item, h.authz, h.leased);
    if (!isHandled(again)) return again;
    h = again;
  }
  const verdict = verdictOf(req, failedOf(outcome, slots), h.conflicts);
  if (verdict.kind === "result") return verdict.result;

  // 既にある行（同じレーンの同じ連番の事象など）: その行に当たる結果を返す。付随する状態の書き込みは確定せず、
  // 要素の記録の行と冪等の鍵の済みの行（と要求元の照らし）だけを確定する
  const result = await existingResult(c, h, verdict.writeIndex);
  const replay: Handled = { ...h, createdUserId: null };
  const again = compose([partOf(req, principal, op, index, replay, result, [])], guards);
  const second = await commit(req, again.items);
  if (second.ok) return result;
  const last = verdictOf(req, failedOf(second, again.slots), []);
  if (last.kind === "result") return last.result;
  throw halt(503, "unavailable");
}

async function eachItem(c: Ctx, parsed: readonly ParsedItem[], authz: readonly (ItemAuthz | undefined)[]): Promise<ItemResult[]> {
  const results: ItemResult[] = [];
  for (const [index, item] of parsed.entries()) {
    checkTime(c.req);
    const p = await prepare(c, index, item, authz[index]);
    results.push(isHandled(p) ? await settleElement(c, index, p) : p);
  }
  return results;
}

// 全部か無かで確定しなかったとき、この要求が借りた冪等の鍵を手放す。借りの行の version と incarnation を条件に消す（releaseIdempotency）ため、
// 取り直された行・済みの行と、手放しや表の期限の後に同じ鍵で借り直した行は残す。
// 手放せなかった鍵は借りの期限の後に取り直せるため、要求の結果は変えない。
// 後始末は要約の記録と応答の時間（DISPATCH_SUMMARY_MS）を食わない。残り時間がそれを超える分だけを使い、鍵ごとの手放しを並べて打ち、
// その時間で終わらなければ待たずに返す（終わらなかった手放しは借りの行の条件つきのため、後で届いても他の要求の行を消さない）
async function releaseTaken(c: Ctx): Promise<void> {
  const leases = c.taken.splice(0);
  if (leases.length === 0) return;
  const budget = c.req.call.remainingMs() - DISPATCH_SUMMARY_MS;
  if (budget <= 0) {
    c.req.log.warn("残り時間が足りないため冪等の鍵の借りを手放さない", { count: leases.length });
    return;
  }
  const release = async (leased: IdempotencyRow): Promise<void> => {
    try {
      await writeAtomically(c.req.deps.db, [releaseIdempotency(leased)], c.req.log);
    } catch (error) {
      c.req.log.warn("確定しなかった要素の冪等の鍵の借りを手放せない", { error: errorName(error) });
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), budget);
  });
  try {
    const done = await Promise.race([Promise.all(leases.map(release)).then(() => "done" as const), expired]);
    if (done === "expired") c.req.log.warn("後始末の時間内に冪等の鍵の借りを手放し終えない", { count: leases.length });
  } finally {
    clearTimeout(timer);
  }
}

// 全部か無か: すべての要素の書き込みを 1 つの writeAtomically に集め（要求元の照らしは 1 回）、要素の失敗が 1 つでもあれば確定しない。
// 確定しなければ（要素の失敗・件の数の越え・条件の外れ・確定の失敗）、借りた冪等の鍵を手放し、直した送り直しが in_progress や idempotency_key_reused にならないようにする
async function allOrNothing(c: Ctx, parsed: readonly ParsedItem[], authz: readonly (ItemAuthz | undefined)[]): Promise<ItemResult[]> {
  let committed = false;
  try {
    const results = await allOrNothingOnce(c, parsed, authz, () => (committed = true));
    return results;
  } finally {
    if (!committed) await releaseTaken(c);
  }
}

async function allOrNothingOnce(c: Ctx, parsed: readonly ParsedItem[], authz: readonly (ItemAuthz | undefined)[], onCommitted: () => void): Promise<ItemResult[]> {
  const { req, principal, op } = c;
  const prepared: (ItemResult | Handled)[] = [];
  for (const [index, item] of parsed.entries()) {
    checkTime(req);
    prepared.push(await prepare(c, index, item, authz[index]));
  }
  const notApplied = failure(409, "not_applied");
  for (let rebuilds = 0; ; rebuilds += 1) {
    const results = prepared.map((p) => (isHandled(p) ? p.result : p));
    if (results.some((r) => !r.ok)) return results.map((r) => (r.ok ? notApplied : r));

    const parts = prepared.flatMap((p, index) => (isHandled(p) && (p.writes.length > 0 || p.leased !== null) ? [partOf(req, principal, op, index, p, p.result, p.writes)] : []));
    if (parts.length === 0) {
      onCommitted();
      return results;
    }
    const { items, slots } = compose(parts, requesterGuards(op, principal));
    if (items.length > TRANSACT_MAX_ITEMS) {
      req.log.error("全部か無かの書き込みが 1 つのトランザクションに収まらない", { count: items.length });
      throw halt(503, "unavailable");
    }
    const outcome = await commit(req, items);
    if (outcome.ok) {
      onCommitted();
      return results;
    }
    const failed = failedOf(outcome, slots);
    if (rebuildOnly(failed)) {
      // 外れた件を返した要素のハンドラーだけを呼び直す。外れていない要素の書き込みはそのまま使う
      checkRebuild(req, rebuilds);
      for (const element of new Set(failed.map((f) => f.element))) {
        const p = element === null ? undefined : prepared[element];
        if (element === null || p === undefined || !isHandled(p)) continue;
        prepared[element] = await handle(c, p.item, p.authz, p.leased);
      }
      continue;
    }
    if (failed.some((f) => f.role === "audit")) throw halt(503, "audit_unavailable");
    // 要求元の照らしの件が外れたら、どの要素も 409 state_mismatch
    if (failed.some((f) => f.guarded)) return results.map(() => failure(409, "state_mismatch"));
    return results.map((_, element) => {
      const mine = failed.filter((f) => f.element === element);
      const p = prepared[element];
      // rebuild の件だけが外れた要素は、ほかの要素の外れで確定しなかっただけ
      if (mine.length === 0 || p === undefined || !isHandled(p) || rebuildOnly(mine)) return notApplied;
      const verdict = verdictOf(req, mine, p.conflicts);
      // 全部か無かでは既にある行の結果を返さない（ほかの要素とともに確定しない）
      return verdict.kind === "result" ? verdict.result : failure(409, "state_mismatch");
    });
  }
}

// logins.delete の認可の対象は、要素が指すログインの組の行でなく認証した主体の利用者自身（読み手に外すログインの行を引かせない）
function authzItemOf(op: OperationDef, principal: Principal, item: unknown): unknown {
  return op.name === LOGINS_DELETE && principal.kind === "human" ? { user_id: principal.userId } : item;
}

async function run(req: Request): Promise<DispatchResult> {
  const { call, deps, op } = req;
  // 受けた方法が POST でない・受け口と操作の受け口の食い違い（MCP の受け口は利用者向けの操作を呼ぶ）
  const expected = call.endpoint === "mcp" ? "user" : call.endpoint;
  // 表に無い HTTP の経路（操作の名前は空で、記録の行の操作は null）
  if (call.fault?.status === 404) return finish(req, problem(404, null));
  if (call.fault?.status === 405 || (op !== null && op.endpoint !== expected)) return finish(req, problem(405, null));

  // 認証。MCP の tools/call は serveMcp が決めた主体のまま続ける
  let principal: Principal;
  let sessionRevokedAt: string | null = null;
  if (call.principal !== undefined) principal = call.principal;
  else {
    const auth = await authenticate({ endpoint: call.endpoint, operation: call.operation, token: call.token }, { ...deps.auth, db: deps.db, scope: deps.scope, log: req.log });
    if (!auth.ok) return finish(req, auth.reason === "unavailable" ? problem(503, "unavailable") : problem(401, auth.reason));
    principal = auth.principal;
    sessionRevokedAt = auth.sessionRevokedAt;
  }
  req.seen.principal = principal;

  // 本文の形（HTTP は readHttpCall が見つけた誤り、MCP の入口は arguments.items を同じ順で照らす）
  const bodyFault = call.fault?.status === 400 ? call.fault.reason : bodyFaultOf(call.items, op);
  if (bodyFault !== null) return finish(req, problem(400, bodyFault));
  req.seen.items = call.items;

  // 形の未定か、ハンドラーの表に無い操作
  const handler = op === null ? undefined : deps.handlers[op.name];
  if (op === null || isPending(op.item) || isPending(op.result) || handler === undefined) {
    req.log.error("操作の形が未定かハンドラーが無い", {});
    return finish(req, problem(503, "unavailable"));
  }

  // 要素の形を照らし、通った要素だけを認可へ渡す。人だけ・委任の種類は要求全体で、見えない・人だけの要素・役割は要素ごとに決まる
  const parsed = parseItems(op, call.items);
  const valid = parsed.flatMap((p, i) => (p.ok ? [{ index: i, value: p.value }] : []));
  let decision;
  try {
    decision = await authorize(principal, op, valid.map((v) => authzItemOf(op, principal, v.value)), deps.scope, req.log);
  } catch (error) {
    req.log.error("認可の読み手が失敗した", { error: errorName(error) });
    return finish(req, problem(503, "unavailable"));
  }
  if ("reject" in decision) return finish(req, problem(403, decision.reject));
  const authz: (ItemAuthz | undefined)[] = parsed.map(() => undefined);
  valid.forEach((v, i) => (authz[v.index] = decision.items[i]));
  req.seen.authz = authz;

  const c: Ctx = { req, principal, sessionRevokedAt, op, handler, taken: [] };
  try {
    const results = op.allOrNothing === null ? await eachItem(c, parsed, authz) : await allOrNothing(c, parsed, authz);
    return await finish(req, { kind: "items", items: results });
  } catch (error) {
    if (error instanceof Halt) return finish(req, error.problem);
    throw error;
  }
}

export async function dispatch(call: OperationCall, deps: DispatchDeps): Promise<DispatchResult> {
  const started = deps.clock.epochMs();
  // 受け口はログの文脈の必須の endpoint が持つ（起点が受け口ごとに渡す）
  const log = deps.log.child({ channel: call.channel, operation: call.operation });
  const req: Request = {
    call,
    deps,
    op: operationOf(deps.operations, call.operation),
    at: deps.clock.iso(),
    auditId: newId("aud", deps.clock),
    log,
    seen: { principal: null, createdUserId: null, items: [], authz: [] },
  };
  let result: DispatchResult;
  try {
    result = await run(req);
  } catch (error) {
    // 想定しない失敗は 503 にし、500 を返さない
    log.error("振り分けで想定しない失敗", { error: errorName(error) });
    result = await finish(req, problem(503, "unavailable"));
  }
  // 要求の終わりに 1 行。要素の中身・token・応答の値は出さない
  const fields = {
    items: Array.isArray(call.items) ? call.items.length : 0,
    principal: req.seen.principal?.kind ?? null,
    outcome: summaryResult(result).outcome,
    status: result.kind === "problem" ? result.status : 200,
    duration_ms: deps.clock.epochMs() - started,
  };
  if (result.kind === "problem" && result.status === 503) log.error("要求を終えた", fields);
  else log.info("要求を終えた", fields);
  return result;
}
