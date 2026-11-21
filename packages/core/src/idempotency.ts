import { IDEMPOTENCY_TTL_SECONDS, type OperationDef } from "@nd-factory/contracts/operation";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
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

// 外へ働きかける 1 回の試み。id は同じ鍵の 1 回目が外へ働きかけ始めた時に決まり、結果が分からないまま取り直した再開でも同じ値になる
// （通知先へ重複を除く識別子として渡す）。resumed は前の持ち主が外へ働きかけ始めていた（外の処理が済んでいるかもしれない）再開で、
// ハンドラーは初めての実行と同じに働きかけず、id で外の重複を除かせるか、外の処理が済んだかを照らしてから進める
export type ExternalAttempt = { readonly id: string; readonly resumed: boolean };

export type IdempotencyClaim =
  | { readonly kind: "fresh"; readonly attempt: ExternalAttempt }
  | { readonly kind: "replay"; readonly result: ItemResult }
  | { readonly kind: "in_progress" }
  | { readonly kind: "reused" };

export function idempotencyKeyOf(claim: IdempotencyClaimInput): RowKey {
  return { pk: `${claim.principalKey}#${claim.operation}#${claim.key}`, sk: null };
}

// 新しく外へ働きかけ始める試みの識別子。鍵の行と要求の組の SHA-256 で、鍵の値そのものは外へ出さない
function newAttemptId(claim: IdempotencyClaimInput): string {
  return bytesToHex(sha256(utf8ToBytes(`${idempotencyKeyOf(claim).pk}\n${claim.requestId}`)));
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

// 持ち主を自分へ替える。前の持ち主と期限（読んだ値）を条件にし、同時に取り直す 2 つのうち 1 つだけが勝つ。
// renew は 24 時間を過ぎた行を無い行と同じに取り直し、働きかけ始めた印（started_at）も消す。resume は期限を過ぎた借りを同じ中身で取り直し、
// 印を残し、読んだ印（無ければ無いこと）を条件にする（読んだ後に前の持ち主が印を付けたら外れ、再開かどうかを読んだ値で決められる）。
// replace は中身を差し替え、働きかけ始めていないことも条件にする（読んだ後に前の持ち主が印を付けたら外れる）
function takeOver(claim: IdempotencyClaimInput, row: StoredRow, clock: Clock, mode: "renew" | "replace" | "resume"): TransactItem {
  const columns = leasedColumns(claim, clock);
  const removed = mode === "resume" ? ["result"] : ["result", "started_at", "attempt_id"];
  const owner = cond.and(cond.eq("owner_request_id", row["owner_request_id"]), cond.eq("state", row["state"]), cond.eq("expire_at", row["expire_at"]));
  const base = mode === "resume" ? cond.and(owner, row["started_at"] === undefined ? cond.notExists("started_at") : cond.eq("started_at", row["started_at"])) : owner;
  return {
    table: "idempotency",
    op: "update",
    key: idempotencyKeyOf(claim),
    update: [...Object.entries(columns).map(([path, value]) => ({ kind: "set" as const, path, value })), ...removed.map((path) => ({ kind: "remove" as const, path }))],
    condition: mode === "replace" ? cond.and(base, cond.notExists("started_at")) : base,
    onConflict: "fail",
  };
}

// 借りた要求が外へ働きかける直前に、借りの行へ働きかけ始めた印を付ける件（dispatch が要求元の照らしと同じトランザクションで打つ）。
// 印の付いた借りは、期限を過ぎても同じ中身でだけ取り直せ（外の処理を元の中身で再開する）、全部か無かの後始末でも手放さない。
// 初めての試みは印（started_at）と試みの識別子（attempt_id）を、まだ印が無いことを条件に書く。再開は印を書き換えず、
// 前の持ち主が書いた識別子が同じことを条件にする（どちらも借りの持ち主の条件つき。借りを失えば外れ、外へ働きかけない）
export function markIdempotencyStarted(claim: IdempotencyClaimInput, attempt: ExternalAttempt, clock: Clock): TransactItem {
  const owner = cond.and(cond.eq("state", "leased"), cond.eq("owner_request_id", claim.requestId), cond.eq("fingerprint", claim.fingerprint));
  const version = { kind: "set" as const, path: "schema_version", value: IDEMPOTENCY_SCHEMA_VERSION };
  return {
    table: "idempotency",
    op: "update",
    key: idempotencyKeyOf(claim),
    update: attempt.resumed
      ? [version]
      : [{ kind: "set", path: "started_at", value: clock.iso() }, { kind: "set", path: "attempt_id", value: attempt.id }, version],
    condition: attempt.resumed ? cond.and(owner, cond.eq("attempt_id", attempt.id)) : cond.and(owner, cond.notExists("started_at")),
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
  const firstAttempt: IdempotencyClaim = { kind: "fresh", attempt: { id: newAttemptId(claim), resumed: false } };
  if (first.ok) return decided(firstAttempt);

  const row = await db.get("idempotency", key, true);
  // 条件が外れた後に行が消えた（期限で消えた）。取り直しは 1 回だけのため、呼び手に待たせる
  if (row === null) return decided({ kind: "in_progress" });

  const expired = typeof row["expire_at"] === "number" && row["expire_at"] * 1000 <= clock.epochMs();
  // 24 時間を過ぎて表の期限の消しを待つ行は、無い行と同じに取り直す
  if (expired) {
    const taken = await writeAtomically(db, [takeOver(claim, row, clock, "renew")], log);
    return decided(taken.ok ? firstAttempt : { kind: "in_progress" });
  }
  const sameItem = row["fingerprint"] === claim.fingerprint;
  if (row["state"] === "settled") return decided(sameItem ? { kind: "replay", result: (row["result"] ?? { ok: false }) as ItemResult } : { kind: "reused" });
  if (!isPast(row["lease_until"], clock)) return decided(sameItem ? { kind: "in_progress" } : { kind: "reused" });
  // 期限を過ぎた借りの行。外へ働きかけ始めた借り（started_at がある）は外の処理が済んでいるかもしれないため、元の中身に結び付け、
  // 同じ中身でだけ取り直して再開する（違う中身は reused）。働きかけ始めていない借りは済みの結果も外の処理も持たず、前の持ち主の済みの行は
  // 持ち主の条件で外れるため、中身によらず取り直す（全部か無かで確定せず、後始末の時間が足りずに手放せなかった鍵を、直した要素で送り直せるようにする）
  // 働きかけ始めた借りの取り直しは、前の持ち主の試みの識別子を引き継ぐ再開（送信の結果が分からない再試行）で、初めての試みと分けて返す
  const started = row["started_at"] !== undefined;
  if (started && !sameItem) return decided({ kind: "reused" });
  const attemptId = row["attempt_id"];
  // 印があって識別子が無い行は書き手の決まりの外。再開の識別子を決められないため、外へ二度働きかけないよう待たせる
  if (started && typeof attemptId !== "string") return decided({ kind: "in_progress" });
  const taken = await writeAtomically(db, [takeOver(claim, row, clock, sameItem ? "resume" : "replace")], log);
  if (!taken.ok) return decided({ kind: "in_progress" });
  return decided(started ? { kind: "fresh", attempt: { id: attemptId as string, resumed: true } } : firstAttempt);
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
