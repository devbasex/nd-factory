import type { TablePurpose, TableSpec } from "@nd-factory/contracts/tables";
import type { RowKey, StoredRow } from "@nd-factory/core/db";
import type { Context } from "aws-lambda";
import { isPurpose, isUuidV4, keyOfRow, MIGRATE_PAGE_SIZE, MIGRATE_RESERVE_MS, rowKindOf, type MigrateDeps } from "./migrate.ts";

// 版の数え（issues/issue-2-design-detail.md の「表の移し」の countRowVersions、版を上げる子の手順の 5）。
// 行の種類の、ある版の読み手を外してよいかを、保存してある schema_version の値だけで確かめる。readRow も repair も narrow も通さず、
// writeVersion によらずどの行も数える（記録の表も同じ）。書き込まない。資源（表の読みだけの Lambda）は最初に形の版を上げる子が足す

// 数える欄。1 以上の整数ならその数、列が無ければ absent、ほかの値（文字列の "1" を含む）は invalid
export type VersionBucket = "absent" | "invalid" | `${number}`;

// 行の種類の名前（当たらなければ row_kind_unknown）ごとの、欄ごとの行の数
export type VersionCounts = Readonly<Record<string, Readonly<Partial<Record<VersionBucket, number>>>>>;

export type CensusDeps = MigrateDeps;

export type CensusResult = { readonly done: boolean; readonly cursor: RowKey | null; readonly counts: VersionCounts };

function rowKindName(spec: TableSpec, raw: StoredRow): string {
  return rowKindOf(spec, raw)?.name ?? "row_kind_unknown";
}

function bucketOf(raw: StoredRow): VersionBucket {
  if (!Object.hasOwn(raw, "schema_version") || raw["schema_version"] === undefined) return "absent";
  const value = raw["schema_version"];
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? `${value}` : "invalid";
}

type MutableCounts = Record<string, Partial<Record<VersionBucket, number>>>;

function addCount(counts: MutableCounts, kind: string, bucket: VersionBucket, n: number): void {
  const byBucket = counts[kind] ?? {};
  byBucket[bucket] = (byBucket[bucket] ?? 0) + n;
  counts[kind] = byBucket;
}

function addCounts(a: VersionCounts, b: VersionCounts): VersionCounts {
  const out: MutableCounts = {};
  for (const counts of [a, b]) {
    for (const [kind, byBucket] of Object.entries(counts)) {
      for (const [bucket, n] of Object.entries(byBucket)) addCount(out, kind, bucket as VersionBucket, n ?? 0);
    }
  }
  return out;
}

// 事後条件: 返した cursor より前の行は 1 行ずつ数えてある。戻り値には行の種類の名前・版・数だけを載せ、鍵の値と列の値を載せない
export async function countRowVersions(input: { purpose: TablePurpose; cursor: RowKey | null }, deps: CensusDeps): Promise<CensusResult> {
  const spec = deps.tables[input.purpose];
  const counts: MutableCounts = {};
  let position = input.cursor;
  for (;;) {
    const page = await deps.db.scan(input.purpose, { limit: MIGRATE_PAGE_SIZE, startKey: position, consistent: true });
    for (const raw of page.items) {
      if (deps.remainingMs() <= MIGRATE_RESERVE_MS) return { done: false, cursor: position, counts };
      addCount(counts, rowKindName(spec, raw), bucketOf(raw), 1);
      position = keyOfRow(raw);
    }
    if (page.lastKey === null) return { done: true, cursor: null, counts };
    position = page.lastKey;
  }
}

export type CensusEvent = {
  readonly purpose: TablePurpose;
  readonly census_id: string;
  // 最初の起動（運用者の起こし）が時計の今で決め、続きの起動へ変えずに渡す
  readonly started_at: string | null;
  readonly cursor: RowKey | null;
  readonly counts: VersionCounts;
};

export type CensusHandlerDeps = Omit<CensusDeps, "remainingMs"> & {
  readonly reinvoke: (event: CensusEvent) => Promise<void>;
};

// countRowVersions を呼び、終わっていなければ続きの位置とここまでの counts の合計を、受け取った census_id と started_at と一緒に持って自分を起こし直す。
// 版を上げる子の手順の 5b は、起こした census_id で started_at が 5a の待ちの後の census_done だけを採る
export function createCensusHandler(deps: CensusHandlerDeps): (event: CensusEvent, context: Context) => Promise<void> {
  return async (event, context) => {
    const censusId: unknown = event?.census_id;
    if (!isUuidV4(censusId) || !isPurpose(event.purpose)) {
      deps.log.error("census_invalid_event", { reason: isUuidV4(censusId) ? "purpose" : "census_id" });
      return;
    }
    const log = deps.log.child({ census_id: censusId });
    let startedAt = event.started_at;
    if (startedAt === null || startedAt === undefined) {
      startedAt = deps.clock.iso();
      log.info("census_start", { purpose: event.purpose, started_at: startedAt });
    }
    const out = await countRowVersions({ purpose: event.purpose, cursor: event.cursor ?? null }, { ...deps, log, remainingMs: () => context.getRemainingTimeInMillis() });
    const counts = addCounts(event.counts ?? {}, out.counts);
    if (!out.done) {
      await deps.reinvoke({ purpose: event.purpose, census_id: censusId, started_at: startedAt, cursor: out.cursor, counts });
      return;
    }
    log.info("census_done", { purpose: event.purpose, started_at: startedAt, counts });
  };
}
