import { IDEMPOTENCY_TTL_SECONDS, type OperationDef } from "@nd-factory/contracts/operation";
import type { Clock } from "./clock.ts";
import { cond, putIfAbsent, writeAtomically, type TransactItem } from "./conditional-write.ts";
import type { Db, RowKey, StoredRow } from "./db.ts";
import type { Logger } from "./log.ts";

// 冪等の鍵（docs/design/api.md の「冪等の鍵」）。主体・操作・鍵の組の 1 回目を借りの行で押さえ、
// 済みの行は状態の書き込みと同じトランザクションで書く（settleIdempotency の 1 件を dispatch が writeAtomically へ入れる）

// API の関数の時間切れ（infra/lib/app-stack.ts の 10 秒）。形の正本の設定にこの値がまだ無いため、置かれるまでここに置く
const API_FUNCTION_TIMEOUT_MS = 10_000;

// 借りの期限。API の関数の時間切れの 2 倍（借りた要求が落ちても、この後に取り直せる）
export const IDEMPOTENCY_LEASE_MS = 2 * API_FUNCTION_TIMEOUT_MS;

// 冪等の鍵の行の形の版
const IDEMPOTENCY_SCHEMA_VERSION = 1;

export type IdempotencyClaimInput = {
  // 主体の利用者など、主体を見分ける値
  readonly principalKey: string;
  readonly operation: string;
  readonly key: string;
  // 要素の正規化した JSON の SHA-256
  readonly fingerprint: string;
  readonly requestId: string;
};

// 要素の結果（成功か失敗の 1 件）
export type ItemResult = { readonly ok: boolean; readonly [field: string]: unknown };

export type IdempotencyClaim =
  | { readonly kind: "fresh" }
  | { readonly kind: "replay"; readonly result: ItemResult }
  | { readonly kind: "in_progress" }
  | { readonly kind: "reused" };

export function idempotencyKeyOf(claim: IdempotencyClaimInput): RowKey {
  return { pk: `${claim.principalKey}#${claim.operation}#${claim.key}`, sk: null };
}

function isoAfter(clock: Clock, ms: number): string {
  return new Date(clock.epochMs() + ms).toISOString();
}

function expireAt(clock: Clock): number {
  return Math.floor(clock.epochMs() / 1000) + IDEMPOTENCY_TTL_SECONDS;
}

function leasedColumns(claim: IdempotencyClaimInput, clock: Clock) {
  return {
    principal_key: claim.principalKey,
    operation: claim.operation,
    key: claim.key,
    fingerprint: claim.fingerprint,
    state: "leased",
    owner_request_id: claim.requestId,
    lease_until: isoAfter(clock, IDEMPOTENCY_LEASE_MS),
    expire_at: expireAt(clock),
    schema_version: IDEMPOTENCY_SCHEMA_VERSION,
  } as const;
}

// 持ち主を自分へ替える。前の持ち主と期限（読んだ値）を条件にし、同時に取り直す 2 つのうち 1 つだけが勝つ
function takeOver(claim: IdempotencyClaimInput, row: StoredRow, clock: Clock): TransactItem {
  const columns = leasedColumns(claim, clock);
  return {
    table: "idempotency",
    op: "update",
    key: idempotencyKeyOf(claim),
    update: [...Object.entries(columns).map(([path, value]) => ({ kind: "set" as const, path, value })), { kind: "remove", path: "result" }],
    condition: cond.and(cond.eq("owner_request_id", row["owner_request_id"]), cond.eq("state", row["state"]), cond.eq("expire_at", row["expire_at"])),
    onConflict: "fail",
  };
}

function isPast(iso: unknown, clock: Clock): boolean {
  return typeof iso === "string" && Date.parse(iso) <= clock.epochMs();
}

export async function claimIdempotency(db: Db, claim: IdempotencyClaimInput, clock: Clock, log?: Logger): Promise<IdempotencyClaim> {
  const decided = (result: IdempotencyClaim): IdempotencyClaim => {
    // 鍵の値と fingerprint は出さない
    log?.info("冪等の鍵を照らした", { operation: claim.operation, result: result.kind });
    return result;
  };
  const key = idempotencyKeyOf(claim);
  const first = await writeAtomically(db, [putIfAbsent({ table: "idempotency", item: { pk: key.pk, ...leasedColumns(claim, clock) }, onConflict: "fail" })], log);
  if (first.ok) return decided({ kind: "fresh" });

  const row = await db.get("idempotency", key, true);
  // 条件が外れた後に行が消えた（期限で消えた）。取り直しは 1 回だけのため、呼び手に待たせる
  if (row === null) return decided({ kind: "in_progress" });

  const expired = typeof row["expire_at"] === "number" && row["expire_at"] * 1000 <= clock.epochMs();
  // 24 時間を過ぎて表の期限の消しを待つ行は、無い行と同じに取り直す
  if (expired) {
    const taken = await writeAtomically(db, [takeOver(claim, row, clock)], log);
    return decided(taken.ok ? { kind: "fresh" } : { kind: "in_progress" });
  }
  const sameItem = row["fingerprint"] === claim.fingerprint;
  if (row["state"] === "settled") return decided(sameItem ? { kind: "replay", result: (row["result"] ?? { ok: false }) as ItemResult } : { kind: "reused" });
  if (!isPast(row["lease_until"], clock)) return decided(sameItem ? { kind: "in_progress" } : { kind: "reused" });
  // 期限を過ぎた借りの行は、中身によらず取り直す。済みの結果を持たず、前の持ち主の済みの行は持ち主の条件で外れるため、もう確定しない
  // （全部か無かで確定せず、後始末の時間が足りずに手放せなかった鍵を、直した要素で送り直せるようにする）

  const taken = await writeAtomically(db, [takeOver(claim, row, clock)], log);
  return decided(taken.ok ? { kind: "fresh" } : { kind: "in_progress" });
}

// 1 回だけ返す値を null に替えた写し。場所は操作の定義の onceOnly（"item.token" の形）だけで、ほかの値は形を変えずに控える。
// 配列は要素ごとに同じ場所を替え、場所が無い結果（失敗の要素など）はそのまま
function nullAt(value: unknown, segments: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => nullAt(v, segments));
  const [head, ...rest] = segments;
  if (head === undefined || value === null || typeof value !== "object" || !Object.hasOwn(value, head)) return value;
  const record = value as Record<string, unknown>;
  return { ...record, [head]: rest.length === 0 ? null : nullAt(record[head], rest) };
}

function withoutOnceOnly(result: ItemResult, onceOnly: readonly string[]): ItemResult {
  return onceOnly.reduce<unknown>((acc, path) => nullAt(acc, path.split(".")), result) as ItemResult;
}

export function settleIdempotency(claim: IdempotencyClaimInput, result: ItemResult, op: Pick<OperationDef, "onceOnly">, _clock: Clock): TransactItem {
  return {
    table: "idempotency",
    op: "update",
    key: idempotencyKeyOf(claim),
    update: [
      { kind: "set", path: "state", value: "settled" },
      { kind: "set", path: "result", value: withoutOnceOnly(result, op.onceOnly) },
      // 書き手の決まり: どの書き換えも schema_version を書き手の版にする
      { kind: "set", path: "schema_version", value: IDEMPOTENCY_SCHEMA_VERSION },
    ],
    // 借りの行の持ち主が自分のときだけ
    condition: cond.and(cond.eq("state", "leased"), cond.eq("owner_request_id", claim.requestId), cond.eq("fingerprint", claim.fingerprint)),
    onConflict: "fail",
  };
}
