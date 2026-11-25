import { readRow, RowCodecError, rowReplaceOf, sameValue, type AnyRowCodec, type RowCodecErrorCode } from "@nd-factory/contracts/row-codec";
import { TABLE_PURPOSES, type RowSpec, type TablePurpose, type TableSpec } from "@nd-factory/contracts/tables";
import type { Clock } from "@nd-factory/core/clock";
import { replaceIfUnchanged, writeAtomically } from "@nd-factory/core/conditional-write";
import type { Db, Row, RowKey, StoredRow } from "@nd-factory/core/db";
import type { Logger } from "@nd-factory/core/log";
import type { Context } from "aws-lambda";

// 表の移し（issues/issue-2-design-detail.md の「表の移し」、受け入れ条件 9）。保存の形が読み手の見る形と違う行を、書き手の版の行全体へ書き直す。
// 書き手の決まりは issues/issue-2-design-row-writers.md の決定 1〜9。資源（Lambda）と起こし方は最初に形の版を上げる子が足す

// 行に取りかかる前に、残り時間がこれ以下なら止めて続きの位置を返す
export const MIGRATE_RESERVE_MS = 10_000;
export const MIGRATE_PAGE_SIZE = 100;
// 1 行の書き込みが外れて読み直す回数の上限。外れは並んだ書き手の確定だけで起き、続けば書き手が書き続けている行として次の全走査に回す
const MIGRATE_ROW_ATTEMPTS = 3;

// 移しの拒みの理由の符号（閉じた語）
type MigrateRefusal = "version_unsupported" | "shape_invalid" | RowCodecErrorCode | "contended" | "row_kind_unknown" | "append_only";

// 拒んだ行の数を理由の符号ごとに持つ。欄の和は refused
type RefusedByReason = Partial<Record<MigrateRefusal, number>>;

export type MigrateDeps = {
  readonly db: Db;
  readonly clock: Clock;
  readonly log: Logger;
  // 関数の残り時間（ミリ秒）
  readonly remainingMs: () => number;
  readonly tables: Readonly<Record<TablePurpose, TableSpec>>;
};

export type MigrateResult = {
  readonly done: boolean;
  readonly cursor: RowKey | null;
  readonly rewritten: number;
  readonly skipped: number;
  readonly refused: number;
  readonly refusedByReason: RefusedByReason;
};

type RowOutcome = { readonly kind: "rewritten" | "unchanged" | "skipped" } | { readonly kind: "refused"; readonly reason: MigrateRefusal; readonly rowKind: string };

export function keyOfRow(raw: StoredRow): RowKey {
  const sk = raw["sk"];
  return { pk: String(raw["pk"]), sk: typeof sk === "string" ? sk : null };
}

// 並びの鍵で行の種類を決める（上から当てて最初に当たったもの）。区切りの鍵だけの表は行の種類が 1 つ
export function rowKindOf(spec: TableSpec, raw: StoredRow): RowSpec | null {
  const sk = raw["sk"];
  if (spec.sortKey === null) return spec.rows[0] ?? null;
  if (typeof sk !== "string") return null;
  return spec.rows.find((row) => row.skPattern?.test(sk) === true) ?? null;
}

// 読み手の見る形を書き手の版で保存した行（書く行）。rowReplaceOf の戻り値に、行の種類が持てば読み手の見る形の version と incarnation を足す
function rowToStore(codec: AnyRowCodec, raw: StoredRow, row: Record<string, unknown>): Record<string, unknown> {
  const replaced = rowReplaceOf(codec, raw, row);
  return {
    ...replaced,
    ...(row["version"] === undefined ? {} : { version: row["version"] }),
    ...(row["incarnation"] === undefined ? {} : { incarnation: row["incarnation"] }),
  };
}

async function migrateRow(purpose: TablePurpose, spec: TableSpec, first: StoredRow, deps: MigrateDeps): Promise<RowOutcome> {
  const kind = rowKindOf(spec, first);
  // 数えずに飛ばすと、実データを飛ばした走査が refused 0 になる
  if (kind === null) return { kind: "refused", reason: "row_kind_unknown", rowKind: purpose };
  const codec = kind.codec;
  // 1 段目か、書き手を戻した状態の行の種類は書かない
  if (codec.writeVersion !== codec.latest.version) return { kind: "unchanged" };
  let raw = first;
  for (let attempt = 1; ; attempt += 1) {
    const read = readRow(codec, raw);
    if (!read.ok) return { kind: "refused", reason: read.reason, rowKind: kind.name };
    let item: Record<string, unknown>;
    try {
      item = rowToStore(codec, raw, read.row);
    } catch (error) {
      if (error instanceof RowCodecError) return { kind: "refused", reason: error.code, rowKind: kind.name };
      throw error;
    }
    if (sameValue(item, raw)) return { kind: "unchanged" };
    // 記録の表は追記だけで、置き換えを writeAtomically が拒む（決定 9）
    if (purpose === "audit") return { kind: "refused", reason: "append_only", rowKind: kind.name };
    // 条件は読んだ行に保存してあった値そのもの（repair で直した値を使うと、保存の値と合わずに外れ続ける）
    const outcome = await writeAtomically(deps.db, [replaceIfUnchanged({ table: purpose, item: item as Row, expect: read.stored, onConflict: "fail" })]);
    if (outcome.ok) return { kind: "rewritten" };
    if (attempt >= MIGRATE_ROW_ATTEMPTS) return { kind: "refused", reason: "contended", rowKind: kind.name };
    const again = await deps.db.get(purpose, keyOfRow(raw), true);
    if (again === null) return { kind: "skipped" };
    raw = again;
  }
}

// 表の全走査（強整合の Scan）。行ごとに、取りかかる前に残り時間を確かめ、足りなければ止めて続きの位置を返す。
// 続きの位置は処理を終えた行の鍵で、ページを終えたらその LastEvaluatedKey。事後条件: 返した cursor より前の行は visit を終えてあり、後の行は 1 行も飛ばしていない
export async function scanTable(
  input: { purpose: TablePurpose; cursor: RowKey | null },
  deps: Pick<MigrateDeps, "db" | "remainingMs">,
  visit: (raw: StoredRow) => Promise<void> | void,
): Promise<{ readonly done: boolean; readonly cursor: RowKey | null }> {
  let position = input.cursor;
  for (;;) {
    const page = await deps.db.scan(input.purpose, { limit: MIGRATE_PAGE_SIZE, startKey: position, consistent: true });
    for (const raw of page.items) {
      if (deps.remainingMs() <= MIGRATE_RESERVE_MS) return { done: false, cursor: position };
      await visit(raw);
      position = keyOfRow(raw);
    }
    if (page.lastKey === null) return { done: true, cursor: null };
    position = page.lastKey;
  }
}

// 事後条件: 返した cursor より前（走査の順）の行は、処理を終えた時点で読み手の見る形を書き手の版で保存しているか、消えたか、拒んだ行（refused に数えた行）。
// refused はこの呼び出しで拒んだ行の数。返した cursor より後の行は 1 行も飛ばしていない
export async function migrateTable(input: { purpose: TablePurpose; cursor: RowKey | null }, deps: MigrateDeps): Promise<MigrateResult> {
  const { purpose } = input;
  const spec = deps.tables[purpose];
  let rewritten = 0;
  let skipped = 0;
  let refused = 0;
  const refusedByReason: Record<string, number> = {};
  const scanned = await scanTable(input, deps, async (raw) => {
    const outcome = await migrateRow(purpose, spec, raw, deps);
    if (outcome.kind === "rewritten") rewritten += 1;
    else if (outcome.kind === "skipped") skipped += 1;
    else if (outcome.kind === "refused") {
      refused += 1;
      refusedByReason[outcome.reason] = (refusedByReason[outcome.reason] ?? 0) + 1;
      // 鍵の値と例外の文（Zod の issue.path・IdP の主体や利用者の ID を含みうる）は載せない
      deps.log.error("migrate_refused", { purpose, row_kind: outcome.rowKind, reason: outcome.reason });
    }
  });
  return { done: scanned.done, cursor: scanned.cursor, rewritten, skipped, refused, refusedByReason: refusedByReason as RefusedByReason };
}

export type MigrateEvent = {
  readonly purpose: TablePurpose;
  readonly migrate_id: string;
  readonly cursor: RowKey | null;
  readonly refused: number;
  readonly refusedByReason: RefusedByReason;
};

export type MigrateHandlerDeps = Omit<MigrateDeps, "remainingMs"> & {
  // 続きの起動を非同期で起こす（自分の関数を Event の呼び出しで起こす）
  readonly reinvoke: (event: MigrateEvent) => Promise<void>;
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// 起動ごとの識別子（migrate_id・census_id）は UUID v4
export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

export function isPurpose(value: unknown): value is TablePurpose {
  return typeof value === "string" && (TABLE_PURPOSES as readonly string[]).includes(value);
}

function addReasons(a: RefusedByReason, b: RefusedByReason): RefusedByReason {
  const out: Record<string, number> = { ...a };
  for (const [reason, n] of Object.entries(b)) out[reason] = (out[reason] ?? 0) + (n ?? 0);
  return out as RefusedByReason;
}

// migrateTable を呼び、終わっていなければ続きの位置とここまでの refused の合計を、受け取った migrate_id と一緒に持って自分を起こし直す。
// 運用者は起こすごとに新しい UUID v4 の migrate_id で起こし、版を上げる子の手順はその migrate_id の migrate_done だけを採る
export function createMigrateHandler(deps: MigrateHandlerDeps): (event: MigrateEvent, context: Context) => Promise<void> {
  return async (event, context) => {
    const migrateId: unknown = event?.migrate_id;
    if (!isUuidV4(migrateId) || !isPurpose(event.purpose)) {
      deps.log.error("migrate_invalid_event", { reason: isUuidV4(migrateId) ? "purpose" : "migrate_id" });
      return;
    }
    const log = deps.log.child({ migrate_id: migrateId });
    const out = await migrateTable({ purpose: event.purpose, cursor: event.cursor ?? null }, { ...deps, log, remainingMs: () => context.getRemainingTimeInMillis() });
    log.info("migrate_page", { purpose: event.purpose, rewritten: out.rewritten, skipped: out.skipped, refused: out.refused });
    const refused = (event.refused ?? 0) + out.refused;
    const refusedByReason = addReasons(event.refusedByReason ?? {}, out.refusedByReason);
    if (!out.done) {
      await deps.reinvoke({ purpose: event.purpose, migrate_id: migrateId, cursor: out.cursor, refused, refusedByReason });
      return;
    }
    // 拒んだ行が残れば error（読み手の見る形で保存できずに残った行があると運用者が気づく）
    const fields = { purpose: event.purpose, refused, refusedByReason };
    if (refused > 0) log.error("migrate_done", fields);
    else log.info("migrate_done", fields);
  };
}
