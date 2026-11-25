import { rowCodec, type AnyRowCodec } from "@nd-factory/contracts/row-codec";
import { TABLES, type TablePurpose, type TableSpec } from "@nd-factory/contracts/tables";
import { createClock } from "@nd-factory/core/clock";
import type { Db, RowKey } from "@nd-factory/core/db";
import { createLogger } from "@nd-factory/core/log";
import type { Context } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeTable, type FakeTable } from "../../../packages/core/test/fakes/table.ts";
import { countRowVersions, createCensusHandler, type CensusDeps, type CensusEvent } from "../src/entries/census.ts";
import { MIGRATE_RESERVE_MS } from "../src/entries/migrate.ts";

// 版の数え（版を上げる子の手順の 5）。保存してある schema_version の値だけで数え、readRow も repair も narrow も通さず、書き込まない

const CENSUS_ID = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
const NOW = Date.parse("2026-11-24T01:02:03.000Z");

const v1 = z.object({ schema_version: z.literal(1), item_id: z.string(), nick: z.string() });
const v2 = z.object({ schema_version: z.literal(2), item_id: z.string(), display_name: z.string() });
type V1 = z.infer<typeof v1>;
type V2 = z.infer<typeof v2>;
// 3b の後（writeVersion が前の版）と、4a の後の narrow を持つ行の種類。数えはどちらにも左右されない
const codec = rowCodec({
  latest: { version: 2, schema: v2 },
  previous: { version: 1, schema: v1, upgrade: (r: V1): V2 => ({ schema_version: 2, item_id: r.item_id, display_name: r.nick }), downgrade: (r: V2): V1 => ({ schema_version: 1, item_id: r.item_id, nick: r.display_name }) },
  writeVersion: 1,
  narrow: (r: V2) => r,
  keyOf: (r: { item_id: string }): RowKey => ({ pk: `ITEM#${r.item_id}`, sk: "ITEM" }),
}) as unknown as AnyRowCodec;

function tablesWith(purpose: TablePurpose): Readonly<Record<TablePurpose, TableSpec>> {
  return { ...TABLES, [purpose]: { ...TABLES[purpose], indexes: [], rows: [{ name: "item", skPattern: /^ITEM$/, codec, writes: "append" }] } };
}

const row = (id: string, schemaVersion?: unknown) => ({ pk: `ITEM#${id}`, sk: "ITEM", item_id: id, nick: `secret-${id}`, ...(schemaVersion === undefined ? {} : { schema_version: schemaVersion }) });

function depsOf(table: FakeTable, purpose: TablePurpose, extra: Partial<CensusDeps> = {}) {
  const lines: string[] = [];
  const log = createLogger({ request_id: "census", fn: "census", endpoint: "census" }, (l) => lines.push(l));
  const deps: CensusDeps = { db: table.db, clock: createClock(() => NOW), log, remainingMs: () => 60_000, tables: tablesWith(purpose), ...extra };
  return { deps, lines, records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

// 書き込みを数える（数えは 1 件も書かない）
function noWrites(table: FakeTable): { db: Db; writes: () => number } {
  let writes = 0;
  return {
    db: {
      ...table.db,
      async transactWrite(items) {
        writes += 1;
        return table.db.transactWrite(items);
      },
      async update(...args) {
        writes += 1;
        return table.db.update(...args);
      },
    },
    writes: () => writes,
  };
}

describe("countRowVersions", () => {
  it("行の種類と保存の schema_version ごとに数え、列の無い値を absent、整数でない値（文字列の \"1\" を含む）を invalid、当たらない鍵を row_kind_unknown で数え、書き込まない", async () => {
    const table = fakeTable();
    table.seed("audit", row("a", 1));
    table.seed("audit", row("b", 2));
    table.seed("audit", row("c", 2));
    table.seed("audit", row("d"));
    table.seed("audit", row("e", "1"));
    table.seed("audit", row("f", 0));
    table.seed("audit", { pk: "ELSE#x", sk: "ELSEWHERE", schema_version: 1 });
    const watched = noWrites(table);
    const { deps, lines } = depsOf(table, "audit", { db: watched.db });
    const out = await countRowVersions({ purpose: "audit", cursor: null }, deps);
    expect(out).toEqual({ done: true, cursor: null, counts: { item: { "1": 1, "2": 2, absent: 1, invalid: 2 }, row_kind_unknown: { "1": 1 } } });
    expect(watched.writes()).toBe(0);
    expect(lines.join("\n")).not.toContain("ITEM#");
  });

  it("残り時間が予備の時間で止まり、返した cursor で続きから数える", async () => {
    const table = fakeTable();
    for (const id of ["a", "b", "c"]) table.seed("users", row(id, 1));
    let calls = 0;
    const first = await countRowVersions({ purpose: "users", cursor: null }, depsOf(table, "users", { remainingMs: () => (calls++ < 1 ? 60_000 : MIGRATE_RESERVE_MS) }).deps);
    expect(first).toEqual({ done: false, cursor: { pk: "ITEM#a", sk: "ITEM" }, counts: { item: { "1": 1 } } });
    const second = await countRowVersions({ purpose: "users", cursor: first.cursor }, depsOf(table, "users").deps);
    expect(second).toEqual({ done: true, cursor: null, counts: { item: { "1": 2 } } });
  });
});

function contextWith(remaining: () => number): Context {
  return { getRemainingTimeInMillis: remaining } as unknown as Context;
}

const event = (over: Partial<CensusEvent> = {}): CensusEvent => ({ purpose: "users", census_id: CENSUS_ID, started_at: null, cursor: null, counts: {}, ...over });

describe("createCensusHandler", () => {
  it("started_at が null の起動は時計の今を started_at にして census_start を出し、続きの起動へ同じ census_id と started_at とここまでの合計を渡す", async () => {
    const table = fakeTable();
    for (const id of ["a", "b"]) table.seed("users", row(id, 1));
    const { deps, records } = depsOf(table, "users");
    const sent: CensusEvent[] = [];
    let calls = 0;
    await createCensusHandler({ ...deps, reinvoke: async (e) => void sent.push(e) })(event({ counts: { item: { "2": 4 } } }), contextWith(() => (calls++ < 1 ? 60_000 : MIGRATE_RESERVE_MS)));
    const startedAt = new Date(NOW).toISOString();
    expect(sent).toEqual([{ purpose: "users", census_id: CENSUS_ID, started_at: startedAt, cursor: { pk: "ITEM#a", sk: "ITEM" }, counts: { item: { "1": 1, "2": 4 } } }]);
    expect(records().find((r) => r["msg"] === "census_start")).toMatchObject({ purpose: "users", census_id: CENSUS_ID, started_at: startedAt });
  });

  it("続きの起動は受け取った started_at を書き換えず、終わったら census_done に合計を info で出す", async () => {
    const table = fakeTable();
    table.seed("users", row("b", 1));
    const { deps, records } = depsOf(table, "users");
    const sent: CensusEvent[] = [];
    const startedAt = "2026-11-24T00:00:00.000Z";
    await createCensusHandler({ ...deps, reinvoke: async (e) => void sent.push(e) })(event({ started_at: startedAt, cursor: { pk: "ITEM#a", sk: "ITEM" }, counts: { item: { "1": 1 } } }), contextWith(() => 60_000));
    expect(sent).toEqual([]);
    expect(records().some((r) => r["msg"] === "census_start")).toBe(false);
    expect(records().find((r) => r["msg"] === "census_done")).toMatchObject({ level: "info", purpose: "users", census_id: CENSUS_ID, started_at: startedAt, counts: { item: { "1": 2 } } });
  });

  it("census_id が無いか UUID v4 でない起動は数えずに error を出して終える", async () => {
    for (const bad of [{ census_id: "" }, { census_id: "5a4b3c2d-1e0f-1a9b-8c7d-6e5f4a3b2c1d" }, { census_id: undefined as unknown as string }]) {
      const table = fakeTable();
      table.seed("users", row("a", 1));
      const scans: unknown[] = [];
      const { deps, records } = depsOf(table, "users", { db: { ...table.db, scan: async (...args) => (scans.push(args), table.db.scan(...args)) } });
      await createCensusHandler({ ...deps, reinvoke: async () => {} })(event(bad), contextWith(() => 60_000));
      expect(scans).toEqual([]);
      expect(records().map((r) => r["level"])).toEqual(["error"]);
    }
  });
});
