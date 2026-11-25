import { rowCodec, type AnyRowCodec } from "@nd-factory/contracts/row-codec";
import { TABLES, type TablePurpose, type TableSpec } from "@nd-factory/contracts/tables";
import { createClock } from "@nd-factory/core/clock";
import type { Db, RowKey, ScanOptions, StoredRow } from "@nd-factory/core/db";
import { createLogger } from "@nd-factory/core/log";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeTable } from "../../../packages/core/test/fakes/table.ts";
import { countRowVersions } from "../src/entries/census.ts";
import { MIGRATE_PAGE_SIZE, MIGRATE_RESERVE_MS, migrateTable, type MigrateDeps } from "../src/entries/migrate.ts";

// 表の全走査（強整合の Scan・行ごとの残り時間の確かめ・処理済みの行の鍵と LastEvaluatedKey による続きの位置）を、
// migrateTable と countRowVersions の両方で同じ筋書きで固定する。Scan は台本どおりのページを返す偽物で、呼ばれた引数を残す

const v2 = z.object({ schema_version: z.literal(2), version: z.int().min(1), incarnation: z.string().min(1), item_id: z.string(), display_name: z.string() });
const v1 = z.object({ schema_version: z.literal(1), version: z.int().min(1), incarnation: z.string().min(1), item_id: z.string(), nick: z.string() });
type V1 = z.infer<typeof v1>;
type V2 = z.infer<typeof v2>;
const codec = rowCodec({
  latest: { version: 2, schema: v2 },
  previous: {
    version: 1,
    schema: v1,
    upgrade: (r: V1): V2 => ({ schema_version: 2, version: r.version, incarnation: r.incarnation, item_id: r.item_id, display_name: r.nick }),
    downgrade: (r: V2): V1 => ({ schema_version: 1, version: r.version, incarnation: r.incarnation, item_id: r.item_id, nick: r.display_name }),
  },
  writeVersion: 2,
  keyOf: (r: { item_id: string }): RowKey => ({ pk: `ITEM#${r.item_id}`, sk: "ITEM" }),
}) as unknown as AnyRowCodec;

const PURPOSE: TablePurpose = "users";
const tables: Readonly<Record<TablePurpose, TableSpec>> = {
  ...TABLES,
  [PURPOSE]: { ...TABLES[PURPOSE], indexes: [], rows: [{ name: "item", skPattern: /^ITEM/, codec, writes: "overwrite" }] },
};

// 保存の形が読み手の見る形と同じ行（移しは書かず、数えは item の "2" に数える）
const row = (id: string, sk = "ITEM"): StoredRow => ({ pk: `ITEM#${id}`, sk, schema_version: 2, version: 1, incarnation: "3f2b6c1e-8a4d-4f7b-9c2e-1d5a7b9e0f13", item_id: id, display_name: `n-${id}` });
const keyOfId = (id: string, sk = "ITEM"): RowKey => ({ pk: `ITEM#${id}`, sk });

type ScriptPage = { readonly items: StoredRow[]; readonly lastKey: RowKey | null };

// 台本のページを順に返す Scan。呼ばれた表と引数を残す。書き込みは数える
function scripted(pages: readonly ScriptPage[]): { db: Db; calls: { table: string; opts: ScanOptions }[]; writes: () => number } {
  const base = fakeTable().db;
  const calls: { table: string; opts: ScanOptions }[] = [];
  let writes = 0;
  const db: Db = {
    ...base,
    async scan(table, opts) {
      calls.push({ table, opts: { ...opts } });
      const page = pages[calls.length - 1];
      if (page === undefined) throw new Error("scan called past the script");
      return { items: structuredClone(page.items), lastKey: page.lastKey };
    },
    async transactWrite(items) {
      writes += 1;
      return base.transactWrite(items);
    },
    async update(...args) {
      writes += 1;
      return base.update(...args);
    },
  };
  return { db, calls, writes: () => writes };
}

// n 回目（1 始まり）の確かめから予備の時間ちょうどを返す。確かめた回数も数える
function budget(stopAt: number | null): { remainingMs: () => number; checks: () => number } {
  let checks = 0;
  return {
    remainingMs: () => {
      checks += 1;
      return stopAt !== null && checks >= stopAt ? MIGRATE_RESERVE_MS : MIGRATE_RESERVE_MS + 1;
    },
    checks: () => checks,
  };
}

type Scan = (input: { purpose: TablePurpose; cursor: RowKey | null }, deps: MigrateDeps) => Promise<{ done: boolean; cursor: RowKey | null; seen: number }>;

const runners: readonly (readonly [string, Scan])[] = [
  [
    "migrateTable",
    async (input, deps) => {
      const out = await migrateTable(input, deps);
      expect(out.refused).toBe(0);
      expect(out.rewritten).toBe(0);
      expect(out.skipped).toBe(0);
      return { done: out.done, cursor: out.cursor, seen: -1 };
    },
  ],
  [
    "countRowVersions",
    async (input, deps) => {
      const out = await countRowVersions(input, deps);
      const seen = Object.values(out.counts).reduce((sum, byBucket) => sum + Object.values(byBucket).reduce<number>((s, n) => s + (n ?? 0), 0), 0);
      return { done: out.done, cursor: out.cursor, seen };
    },
  ],
];

function depsOf(db: Db, remainingMs: () => number): MigrateDeps {
  const log = createLogger({ request_id: "scan", fn: "scan", endpoint: "scan" }, () => undefined);
  return { db, clock: createClock(), log, remainingMs, tables };
}

// 数えは見た行の数を確かめる（移しは数を返さないので -1 を飛ばす）
function expectSeen(seen: number, n: number): void {
  if (seen >= 0) expect(seen).toBe(n);
}

describe.each(runners)("表の全走査（%s）", (_name, run) => {
  it("Scan を用途の表へ、強整合・ページの大きさ MIGRATE_PAGE_SIZE（100）・受け取った cursor を startKey にして呼ぶ", async () => {
    expect(MIGRATE_PAGE_SIZE).toBe(100);
    expect(MIGRATE_RESERVE_MS).toBe(10_000);
    const s = scripted([{ items: [row("b")], lastKey: null }]);
    const cursor = keyOfId("a");
    const out = await run({ purpose: PURPOSE, cursor }, depsOf(s.db, budget(null).remainingMs));
    expect(out).toMatchObject({ done: true, cursor: null });
    expect(s.calls).toEqual([{ table: PURPOSE, opts: { limit: 100, startKey: cursor, consistent: true } }]);
    expect(s.writes()).toBe(0);
  });

  it("cursor が null なら startKey を null にして最初から読む", async () => {
    const s = scripted([{ items: [], lastKey: null }]);
    await run({ purpose: PURPOSE, cursor: null }, depsOf(s.db, budget(null).remainingMs));
    expect(s.calls).toEqual([{ table: PURPOSE, opts: { limit: 100, startKey: null, consistent: true } }]);
  });

  it("LastEvaluatedKey があれば（最後の行の鍵と違っても）それを次の startKey にして読み続け、lastKey が null のページで終える", async () => {
    const lastKey1 = keyOfId("b-evaluated");
    const lastKey2 = keyOfId("d-evaluated");
    const s = scripted([
      { items: [row("a"), row("b")], lastKey: lastKey1 },
      { items: [row("c"), row("d")], lastKey: lastKey2 },
      { items: [row("e")], lastKey: null },
    ]);
    const b = budget(null);
    const out = await run({ purpose: PURPOSE, cursor: null }, depsOf(s.db, b.remainingMs));
    expect(out).toMatchObject({ done: true, cursor: null });
    expectSeen(out.seen, 5);
    expect(s.calls.map((c) => c.opts.startKey)).toEqual([null, lastKey1, lastKey2]);
    expect(s.calls.every((c) => c.opts.consistent && c.opts.limit === 100 && c.table === PURPOSE)).toBe(true);
    // 残り時間は行ごとに 1 回だけ確かめる
    expect(b.checks()).toBe(5);
  });

  it("行の無いページでも LastEvaluatedKey があれば続きを読む", async () => {
    const lastKey = keyOfId("x");
    const s = scripted([
      { items: [], lastKey },
      { items: [row("y")], lastKey: null },
    ]);
    const out = await run({ purpose: PURPOSE, cursor: null }, depsOf(s.db, budget(null).remainingMs));
    expect(out).toMatchObject({ done: true, cursor: null });
    expectSeen(out.seen, 1);
    expect(s.calls.map((c) => c.opts.startKey)).toEqual([null, lastKey]);
  });

  it("残り時間は行に取りかかる前だけ確かめ、行が無ければ残り時間が尽きていても終わりを返す", async () => {
    const s = scripted([
      { items: [], lastKey: keyOfId("x") },
      { items: [], lastKey: null },
    ]);
    let checks = 0;
    const out = await run({ purpose: PURPOSE, cursor: keyOfId("a") }, depsOf(s.db, () => (checks++, 0)));
    expect(out).toMatchObject({ done: true, cursor: null });
    expect(checks).toBe(0);
    expect(s.calls).toHaveLength(2);
  });

  it("最初の行の前で残り時間が予備の時間ちょうどなら止まり、受け取った cursor（null を含む）をそのまま返し、次のページを読まない", async () => {
    for (const cursor of [null, keyOfId("0")]) {
      const s = scripted([{ items: [row("a"), row("b")], lastKey: keyOfId("b") }]);
      const out = await run({ purpose: PURPOSE, cursor }, depsOf(s.db, budget(1).remainingMs));
      expect(out).toMatchObject({ done: false, cursor });
      expectSeen(out.seen, 0);
      expect(s.calls).toHaveLength(1);
    }
  });

  it("残り時間が予備の時間より 1 ミリ秒多ければ続ける", async () => {
    const s = scripted([{ items: [row("a")], lastKey: null }]);
    const out = await run({ purpose: PURPOSE, cursor: null }, depsOf(s.db, () => MIGRATE_RESERVE_MS + 1));
    expect(out).toMatchObject({ done: true, cursor: null });
    expectSeen(out.seen, 1);
  });

  it("ページの途中で止まると、最後に処理を終えた行の鍵を返す", async () => {
    const s = scripted([{ items: [row("a"), row("b"), row("c")], lastKey: keyOfId("c") }]);
    const out = await run({ purpose: PURPOSE, cursor: null }, depsOf(s.db, budget(3).remainingMs));
    expect(out).toEqual({ done: false, cursor: keyOfId("b"), seen: out.seen });
    expectSeen(out.seen, 2);
    expect(s.calls).toHaveLength(1);
  });

  it("次のページの最初の行の前で止まると、前のページの LastEvaluatedKey を返す", async () => {
    const lastKey = keyOfId("b-evaluated");
    const s = scripted([
      { items: [row("a"), row("b")], lastKey },
      { items: [row("c")], lastKey: null },
    ]);
    const out = await run({ purpose: PURPOSE, cursor: null }, depsOf(s.db, budget(3).remainingMs));
    expect(out).toEqual({ done: false, cursor: lastKey, seen: out.seen });
    expectSeen(out.seen, 2);
    expect(s.calls.map((c) => c.opts.startKey)).toEqual([null, lastKey]);
  });

  it("行の無いページの LastEvaluatedKey の後、次のページの最初の行の前で止まると、その LastEvaluatedKey を返す", async () => {
    const lastKey = keyOfId("empty-evaluated");
    const s = scripted([
      { items: [], lastKey },
      { items: [row("c")], lastKey: null },
    ]);
    const out = await run({ purpose: PURPOSE, cursor: keyOfId("a") }, depsOf(s.db, budget(1).remainingMs));
    expect(out).toEqual({ done: false, cursor: lastKey, seen: out.seen });
  });

  it("Scan が投げた誤りはそのまま投げる", async () => {
    const boom = new Error("scan failed");
    const s = scripted([]);
    const db: Db = { ...s.db, scan: async () => Promise.reject(boom) };
    await expect(run({ purpose: PURPOSE, cursor: null }, depsOf(db, budget(null).remainingMs))).rejects.toBe(boom);
  });

  it("途中で止めた cursor で起こし直すと、残りの行だけを読み、通しで全行を 1 回ずつ見る", async () => {
    const table = fakeTable();
    const ids = Array.from({ length: 205 }, (_, i) => `r${String(i).padStart(3, "0")}`);
    for (const id of ids) table.seed(PURPOSE, row(id));
    const scans: (RowKey | null)[] = [];
    const db: Db = {
      ...table.db,
      async scan(t, opts) {
        scans.push(opts.startKey);
        return table.db.scan(t, opts);
      },
    };
    let cursor: RowKey | null = null;
    let total = 0;
    let rounds = 0;
    for (;;) {
      rounds += 1;
      const out = await run({ purpose: PURPOSE, cursor }, depsOf(db, budget(71).remainingMs));
      if (out.seen >= 0) total += out.seen;
      if (out.done) break;
      cursor = out.cursor;
    }
    // 1 回に 70 行ずつ進む
    expect(rounds).toBe(3);
    if (total !== 0) expect(total).toBe(205);
    // 2 回目は 70 行目の鍵から、3 回目は 140 行目の鍵から読む
    expect(scans).toContainEqual(keyOfId("r069"));
    expect(scans).toContainEqual(keyOfId("r139"));
  });
});

describe("続きの位置の行の鍵", () => {
  it("続きの位置にする行の鍵は pk を文字列にし、sk が文字列でなければ null にする", async () => {
    // sk の無い行と、pk と sk が数の行を読ませる（並びの鍵のある表なので、移しはどちらも row_kind_unknown で拒んで数える）
    const s = scripted([{ items: [{ ...row("a"), sk: undefined }, { ...row("b"), pk: 42, sk: 7 }, row("c")], lastKey: null }]);
    const first = budget(2);
    const log = createLogger({ request_id: "scan", fn: "scan", endpoint: "scan" }, () => undefined);
    const out1 = await countRowVersions({ purpose: PURPOSE, cursor: null }, { db: s.db, clock: createClock(), log, remainingMs: first.remainingMs, tables });
    expect(out1.cursor).toEqual({ pk: "ITEM#a", sk: null });
    const s2 = scripted([{ items: [{ ...row("a"), sk: undefined }, { ...row("b"), pk: 42, sk: 7 }, row("c")], lastKey: null }]);
    const out2 = await migrateTable({ purpose: PURPOSE, cursor: null }, { db: s2.db, clock: createClock(), log, remainingMs: budget(3).remainingMs, tables });
    expect(out2.cursor).toEqual({ pk: "42", sk: null });
    expect(out2.refusedByReason).toEqual({ row_kind_unknown: 2 });
  });
});
