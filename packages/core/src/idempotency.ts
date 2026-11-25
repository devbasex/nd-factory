import { IDEMPOTENCY_TTL_SECONDS, type OperationDef } from "@nd-factory/contracts/operation";
import { readRow, rowReplaceOf, writeRow } from "@nd-factory/contracts/row-codec";
import { idempotencyCodec, idempotencyKey, type IdempotencyRow } from "@nd-factory/contracts/rows/idempotency";
import type { Clock } from "./clock.ts";
import { deleteIfVersion, putIfAbsent, replaceIfVersion, rowToCreate, writeAtomically, type TransactItem } from "./conditional-write.ts";
import type { Db, Row, RowKey } from "./db.ts";
import type { Logger } from "./log.ts";

// 冪等の鍵（docs/design/api.md の「冪等の鍵」）。主体・操作・鍵の組の 1 回目を借りの行で押さえ、
// 済みの行は状態の書き込みと同じトランザクションで書く（settleIdempotency の 1 件を dispatch が writeAtomically へ入れる）。
// 冪等の鍵の行は version と incarnation を持ち、取り直し・確定・手放しは読んだ（書いた）行の version と incarnation を条件にした
// 行全体の置き換えと消しで書く（docs/specifications/contracts-and-core.md の行の書き手の決定 7・8）

// API の関数の時間切れ（infra/lib/app-stack.ts の 10 秒）。形の正本の設定にこの値がまだ無いため、置かれるまでここに置く
const API_FUNCTION_TIMEOUT_MS = 10_000;

// 借りの期限。API の関数の時間切れの 2 倍（借りた要求が落ちても、この後に取り直せる）
export const IDEMPOTENCY_LEASE_MS = 2 * API_FUNCTION_TIMEOUT_MS;

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

// fresh の leased は書いた借りの行（読み手の見る形）。確定（settleIdempotency）と手放し（releaseIdempotency）はこの行を条件にする
export type IdempotencyClaim =
  | { readonly kind: "fresh"; readonly leased: IdempotencyRow }
  | { readonly kind: "replay"; readonly result: ItemResult }
  | { readonly kind: "in_progress" }
  | { readonly kind: "reused" };

// 冪等の鍵の行を読めない（行の版の読み手が拒んだ）。呼び手は表に届かないときと同じく要求全体の 503 にする
export class IdempotencyRowError extends Error {
  override name = "IdempotencyRowError";
}

export function idempotencyKeyOf(claim: IdempotencyClaimInput): RowKey {
  return { pk: `${claim.principalKey}#${claim.operation}#${claim.key}`, sk: null };
}

function isoAfter(clock: Clock, ms: number): string {
  return new Date(clock.epochMs() + ms).toISOString();
}

function expireAt(clock: Clock): number {
  return Math.floor(clock.epochMs() / 1000) + IDEMPOTENCY_TTL_SECONDS;
}

// 新しい借りの行の列（version と incarnation のほか）
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
  } as const;
}

// 書く行（putIfAbsent・replaceIfVersion の item）を読み手の見る形にする。書き手の誤りでなければ通る
function rowOf(written: Row | undefined): IdempotencyRow {
  const read = readRow(idempotencyCodec, written);
  if (!read.ok) throw new IdempotencyRowError(`書いた冪等の鍵の行を読めない（${read.reason}）`);
  return read.row;
}

function isPast(iso: string, clock: Clock): boolean {
  return Date.parse(iso) <= clock.epochMs();
}

export async function claimIdempotency(db: Db, claim: IdempotencyClaimInput, clock: Clock, log?: Logger): Promise<IdempotencyClaim> {
  const decided = (result: IdempotencyClaim): IdempotencyClaim => {
    // 鍵の値と fingerprint は出さない
    log?.info("冪等の鍵を照らした", { operation: claim.operation, result: result.kind });
    return result;
  };
  const key = idempotencyKeyOf(claim);
  const put = putIfAbsent({ table: "idempotency", item: rowToCreate(idempotencyCodec, { ...leasedColumns(claim, clock), version: 1 }), onConflict: "fail" });
  const first = await writeAtomically(db, [put], log);
  if (first.ok) return decided({ kind: "fresh", leased: rowOf(put.item) });

  const raw = await db.get("idempotency", key, true);
  // 条件が外れた後に行が消えた（期限で消えた）。取り直しは 1 回だけのため、呼び手に待たせる
  if (raw === null) return decided({ kind: "in_progress" });
  const read = readRow(idempotencyCodec, raw);
  if (!read.ok) {
    log?.warn("冪等の鍵の行を読めない", { operation: claim.operation, reason: read.reason });
    throw new IdempotencyRowError(`冪等の鍵の行を読めない（${read.reason}）`);
  }
  const row = read.row;

  // 新しい借りの行全体を、読んだ行に保存してあった version と incarnation を条件に置き換える。同時に取り直す 2 つのうち 1 つだけが勝つ
  const takeOver = async (): Promise<IdempotencyClaim> => {
    const next: IdempotencyRow = { ...leasedColumns(claim, clock), schema_version: row.schema_version, version: row.version, incarnation: row.incarnation };
    const item = replaceIfVersion({
      table: "idempotency",
      item: rowReplaceOf(idempotencyCodec, raw, next) as Row,
      version: row.version,
      incarnation: row.incarnation,
      expect: { version: read.stored.version, incarnation: read.stored.incarnation },
      onConflict: "fail",
    });
    const taken = await writeAtomically(db, [item], log);
    return taken.ok ? { kind: "fresh", leased: rowOf(item.item) } : { kind: "in_progress" };
  };

  // 24 時間を過ぎて表の期限の消しを待つ行は、無い行と同じに取り直す
  if (row.expire_at * 1000 <= clock.epochMs()) return decided(await takeOver());
  // 指紋の照らしは借りの期限の照らしより先に行う。中身の違う送り直しは借りの状態と期限によらず reused
  if (row.fingerprint !== claim.fingerprint) return decided({ kind: "reused" });
  if (row.state === "settled") return decided({ kind: "replay", result: (row.result ?? { ok: false }) as ItemResult });
  if (!isPast(row.lease_until, clock)) return decided({ kind: "in_progress" });
  return decided(await takeOver());
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

// 借りの行（claimIdempotency が fresh で返した行）を済みにし、要素の結果を足した行全体を、借りの行の version と incarnation を条件に置き換える。
// 取り直されれば version が、手放しや表の期限の後に同じ鍵で借り直されれば incarnation が変わるため、持ち主・状態・指紋の条件はこれに含まれる
export function settleIdempotency(leased: IdempotencyRow, result: ItemResult, op: Pick<OperationDef, "onceOnly">, _clock: Clock): TransactItem {
  const settled: IdempotencyRow = { ...leased, state: "settled", result: withoutOnceOnly(result, op.onceOnly) };
  return replaceIfVersion({
    table: "idempotency",
    item: rowReplaceOf(idempotencyCodec, writeRow(idempotencyCodec, leased), settled) as Row,
    version: leased.version,
    incarnation: leased.incarnation,
    expect: { version: { kind: "value", value: leased.version }, incarnation: { kind: "value", value: leased.incarnation } },
    onConflict: "fail",
  });
}

// 全部か無かで確定しなかったときの借りの手放し。借りの行の version と incarnation を条件に消す
// （手放しや表の期限の後に同じ鍵で作り直した借りと、取り直された借り・済みにした行を消さない）
export function releaseIdempotency(leased: IdempotencyRow): TransactItem {
  return deleteIfVersion({
    table: "idempotency",
    key: idempotencyKey(leased),
    expect: { version: { kind: "value", value: leased.version }, incarnation: { kind: "value", value: leased.incarnation } },
    onConflict: "fail",
  });
}
