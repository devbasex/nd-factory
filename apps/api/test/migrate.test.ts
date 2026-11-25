import { repairIdentity, rowCodec, type AnyRowCodec } from "@nd-factory/contracts/row-codec";
import { TABLES, type TablePurpose, type TableSpec } from "@nd-factory/contracts/tables";
import { createClock } from "@nd-factory/core/clock";
import { replaceIfVersion } from "@nd-factory/core/conditional-write";
import type { Db, RowKey } from "@nd-factory/core/db";
import { createLogger } from "@nd-factory/core/log";
import type { Context } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeTable, type FakeTable } from "../../../packages/core/test/fakes/table.ts";
import { createMigrateHandler, MIGRATE_RESERVE_MS, migrateTable, type MigrateDeps, type MigrateEvent } from "../src/entries/migrate.ts";

// DynamoDB は呼ばない。表は偽の表（packages/core の fakeTable）で、版を上げる子の手順を作り物の行の種類で表す。
// 版 1 の nick を版 2 で display_name に改めた（版 2 で nick の列を消した）。版 1 の legacy は版 2 で表せない（upgrade で失う値）

const INC = "3f2b6c1e-8a4d-4f7b-9c2e-1d5a7b9e0f13";
const OTHER_INC = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const MIGRATE_ID = "0b6e3c2a-5d4f-4a1b-9c8d-7e6f5a4b3c2d";

const base = { version: z.int().min(1), incarnation: z.string().min(1), item_id: z.string() };
const v1 = z.object({ schema_version: z.literal(1), ...base, nick: z.string(), legacy: z.string().optional() });
const v2 = z.object({ schema_version: z.literal(2), ...base, display_name: z.string(), tags: z.array(z.string()).optional() });
type V1 = z.infer<typeof v1>;
type V2 = z.infer<typeof v2>;
const upgrade = (r: V1): V2 => ({ schema_version: 2, version: r.version, incarnation: r.incarnation, item_id: r.item_id, display_name: r.nick });
const downgrade = (r: V2): V1 => ({ schema_version: 1, version: r.version, incarnation: r.incarnation, item_id: r.item_id, nick: r.display_name });
const keyOf = (r: { item_id: string }): RowKey => ({ pk: `ITEM#${r.item_id}`, sk: "ITEM" });

type CodecOpts = { writeVersion?: number; narrow?: (r: V2) => V2; repair?: boolean };
function itemCodec(opts: CodecOpts = {}): AnyRowCodec {
  return rowCodec({
    latest: { version: 2, schema: v2 },
    previous: { version: 1, schema: v1, upgrade, downgrade },
    writeVersion: opts.writeVersion ?? 2,
    ...(opts.narrow === undefined ? {} : { narrow: opts.narrow }),
    ...(opts.repair === true ? { repair: repairIdentity({ version: true }) } : {}),
    keyOf,
  }) as unknown as AnyRowCodec;
}

function tablesWith(purpose: TablePurpose, codec: AnyRowCodec): Readonly<Record<TablePurpose, TableSpec>> {
  const spec: TableSpec = { ...TABLES[purpose], indexes: [], rows: [{ name: "item", skPattern: /^ITEM$/, codec, writes: purpose === "audit" ? "append" : "overwrite" }] };
  return { ...TABLES, [purpose]: spec };
}

const v1Row = (id: string, extra: Record<string, unknown> = {}) => ({ pk: `ITEM#${id}`, sk: "ITEM", schema_version: 1, version: 3, incarnation: INC, item_id: id, nick: `n-${id}`, ...extra });
const v2Row = (id: string, extra: Record<string, unknown> = {}) => ({ pk: `ITEM#${id}`, sk: "ITEM", schema_version: 2, version: 3, incarnation: INC, item_id: id, display_name: `n-${id}`, ...extra });
const keyOfId = (id: string): RowKey => ({ pk: `ITEM#${id}`, sk: "ITEM" });

function logs() {
  const lines: string[] = [];
  const log = createLogger({ request_id: "migrate", fn: "migrate", endpoint: "migrate" }, (l) => lines.push(l));
  return { lines, log, records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

function depsOf(table: FakeTable, tables: Readonly<Record<TablePurpose, TableSpec>>, extra: Partial<MigrateDeps> = {}): MigrateDeps & { logs: ReturnType<typeof logs> } {
  const l = logs();
  return { db: table.db, clock: createClock(), log: l.log, remainingMs: () => 60_000, tables, ...extra, logs: l };
}

// 書き込みの前に、並んだ書き手の確定を真似て表の行を書き換える（times 回まで）
function racing(table: FakeTable, times: number, mutate: (n: number) => void): Db {
  let n = 0;
  return {
    ...table.db,
    async transactWrite(items) {
      if (n < times) {
        mutate(n);
        n += 1;
      }
      return table.db.transactWrite(items);
    },
  };
}

describe("migrateTable（受け入れ条件 9 の移し）", () => {
  it("前の版の行が latest の版になり、version と incarnation は変わらず、latest の版で消した列が行から消える", async () => {
    const table = fakeTable();
    table.seed("users", v1Row("a"));
    const out = await migrateTable({ purpose: "users", cursor: null }, depsOf(table, tablesWith("users", itemCodec())));
    expect(out).toEqual({ done: true, cursor: null, rewritten: 1, skipped: 0, refused: 0, refusedByReason: {} });
    expect(table.row("users", keyOfId("a"))).toEqual(v2Row("a"));
  });

  it("2 回走らせても行が同じで、2 回目は 1 件も書かない", async () => {
    const table = fakeTable();
    for (const id of ["a", "b", "c"]) table.seed("users", v1Row(id));
    table.seed("users", v2Row("d"));
    const deps = depsOf(table, tablesWith("users", itemCodec()));
    await migrateTable({ purpose: "users", cursor: null }, deps);
    const after = table.rows("users");
    const sent = table.transactions.length;
    expect(sent).toBe(3);
    const second = await migrateTable({ purpose: "users", cursor: null }, deps);
    expect(second.rewritten).toBe(0);
    expect(table.transactions.length).toBe(sent);
    expect(table.rows("users")).toEqual(after);
  });

  it("保存の形が読み手の見る形と同じ行は書かない", async () => {
    const table = fakeTable();
    table.seed("users", v2Row("a"));
    const out = await migrateTable({ purpose: "users", cursor: null }, depsOf(table, tablesWith("users", itemCodec())));
    expect(out.rewritten).toBe(0);
    expect(table.transactions).toEqual([]);
  });

  it("repair が version を補う行（列が無い）と incarnation を補う行を、保存の値を条件に直した値で書き直し、次の走査で書かない", async () => {
    const table = fakeTable();
    const { version: _v, incarnation: _i, ...bare } = v2Row("a");
    table.seed("users", bare);
    const deps = depsOf(table, tablesWith("users", itemCodec({ repair: true })));
    expect((await migrateTable({ purpose: "users", cursor: null }, deps)).rewritten).toBe(1);
    const written = table.row("users", keyOfId("a"));
    expect(written?.["version"]).toBe(1);
    expect(typeof written?.["incarnation"]).toBe("string");
    const condition = JSON.stringify(table.transactions[0]?.[0]?.condition);
    expect(condition).toContain('"not_exists","path":"version"');
    expect(condition).toContain('"not_exists","path":"incarnation"');
    expect((await migrateTable({ purpose: "users", cursor: null }, deps)).rewritten).toBe(0);
  });

  it("narrow で狭まる行は、schema_version が latest の行でも書き直す", async () => {
    const narrow = (r: V2): V2 => {
      const { tags: _t, ...rest } = r;
      return rest;
    };
    const table = fakeTable();
    table.seed("users", v2Row("a", { tags: ["x"] }));
    const out = await migrateTable({ purpose: "users", cursor: null }, depsOf(table, tablesWith("users", itemCodec({ narrow }))));
    expect(out.rewritten).toBe(1);
    expect(table.row("users", keyOfId("a"))).toEqual(v2Row("a"));
  });

  it("writeVersion が前の版の行の種類は書き換えない", async () => {
    const table = fakeTable();
    table.seed("users", v1Row("a"));
    const out = await migrateTable({ purpose: "users", cursor: null }, depsOf(table, tablesWith("users", itemCodec({ writeVersion: 1 }))));
    expect(out).toMatchObject({ done: true, rewritten: 0, refused: 0 });
    expect(table.transactions).toEqual([]);
  });

  it("残り時間がちょうど予備の時間なら、取りかかる前に止まり、受け取った cursor を返す", async () => {
    const table = fakeTable();
    table.seed("users", v1Row("a"));
    const cursor = { pk: "ITEM#0", sk: "ITEM" };
    const out = await migrateTable({ purpose: "users", cursor }, depsOf(table, tablesWith("users", itemCodec()), { remainingMs: () => MIGRATE_RESERVE_MS }));
    expect(out).toEqual({ done: false, cursor, rewritten: 0, skipped: 0, refused: 0, refusedByReason: {} });
    expect(table.row("users", keyOfId("a"))).toEqual(v1Row("a"));
  });

  it("ページの途中（3 行目を終えたところ）で残り時間が尽きると 3 行目の鍵を返し、その cursor で 4 行目から読み、2 回の後に前の版の行が残らない", async () => {
    const table = fakeTable();
    const ids = ["a", "b", "c", "d", "e"];
    for (const id of ids) table.seed("users", v1Row(id));
    let calls = 0;
    const tables = tablesWith("users", itemCodec());
    const first = await migrateTable({ purpose: "users", cursor: null }, depsOf(table, tables, { remainingMs: () => (calls++ < 3 ? 60_000 : MIGRATE_RESERVE_MS) }));
    expect(first).toMatchObject({ done: false, cursor: keyOfId("c"), rewritten: 3 });
    expect(table.row("users", keyOfId("d"))).toEqual(v1Row("d"));
    const second = await migrateTable({ purpose: "users", cursor: first.cursor }, depsOf(table, tables));
    expect(second).toMatchObject({ done: true, cursor: null, rewritten: 2 });
    expect(table.rows("users").every((r) => r["schema_version"] === 2)).toBe(true);
  });

  it("書き込みが 1 回・2 回外れた行は読み直して書き直し、3 回外れた行は contended で拒んで書かない", async () => {
    for (const [times, rewritten] of [
      [1, 1],
      [2, 1],
      [3, 0],
    ] as const) {
      const table = fakeTable();
      table.seed("users", v1Row("a"));
      // 書き手が前の版のまま version を上げる
      const db = racing(table, times, (n) => table.seed("users", v1Row("a", { version: 4 + n })));
      const deps = depsOf(table, tablesWith("users", itemCodec()), { db });
      const out = await migrateTable({ purpose: "users", cursor: null }, deps);
      expect(out.rewritten).toBe(rewritten);
      if (times < 3) {
        expect(table.row("users", keyOfId("a"))).toEqual(v2Row("a", { version: 3 + times }));
      } else {
        expect(out).toMatchObject({ refused: 1, refusedByReason: { contended: 1 } });
        expect(table.row("users", keyOfId("a"))?.["schema_version"]).toBe(1);
      }
    }
  });

  it("外れの後に読み直して消えていた行は飛ばし、作り直さない", async () => {
    const table = fakeTable();
    table.seed("users", v1Row("a"));
    const db = racing(table, 1, () => table.remove("users", keyOfId("a")));
    const out = await migrateTable({ purpose: "users", cursor: null }, depsOf(table, tablesWith("users", itemCodec()), { db }));
    expect(out).toMatchObject({ rewritten: 0, skipped: 1, refused: 0 });
    expect(table.rows("users")).toEqual([]);
  });

  it("移しが読んだ後に同じ鍵の行を消して作り直すと（version の同じ値）、incarnation の違いで外れて読み直す", async () => {
    const table = fakeTable();
    table.seed("users", v1Row("a"));
    const db = racing(table, 1, () => table.seed("users", v1Row("a", { incarnation: OTHER_INC, nick: "renewed" })));
    await migrateTable({ purpose: "users", cursor: null }, depsOf(table, tablesWith("users", itemCodec()), { db }));
    expect(table.row("users", keyOfId("a"))).toEqual(v2Row("a", { incarnation: OTHER_INC, display_name: "renewed" }));
  });

  it("2 段目の書き手が先に replaceIfVersion で前の版の行を置き換えた場合、移しはその行を書かず、消した列は残らない", async () => {
    const table = fakeTable();
    table.seed("users", v1Row("a"));
    const codec = itemCodec();
    const db = racing(table, 1, () => {
      // 書き手が読んだ前の版の行を、版 2 の行全体で置き換える（消した列 nick は書き手の行に無い）
      const { version: _v, incarnation: _i, ...item } = v2Row("a", { display_name: "by-writer" });
      const put = replaceIfVersion({ table: "users", item, version: 3, incarnation: INC, expect: { version: { kind: "value", value: 3 }, incarnation: { kind: "value", value: INC } }, onConflict: "version_mismatch" });
      table.seed("users", put.item as Record<string, unknown>);
    });
    const out = await migrateTable({ purpose: "users", cursor: null }, depsOf(table, tablesWith("users", codec), { db }));
    expect(out).toMatchObject({ rewritten: 0, skipped: 0, refused: 0 });
    expect(table.row("users", keyOfId("a"))).toEqual(v2Row("a", { version: 4, display_name: "by-writer" }));
  });

  it("readRow が読めない行と rowReplaceOf が投げる行は書かずに refused に数え、鍵の値も例外の文も載せない migrate_refused を出し、後ろの行は移す", async () => {
    const table = fakeTable();
    table.seed("users", v1Row("a", { nick: 1 }));
    table.seed("users", v1Row("b", { legacy: "kept" }));
    table.seed("users", v1Row("c"));
    const deps = depsOf(table, tablesWith("users", itemCodec()));
    const out = await migrateTable({ purpose: "users", cursor: null }, deps);
    expect(out).toMatchObject({ done: true, rewritten: 1, refused: 2, refusedByReason: { shape_invalid: 1, value_lost: 1 } });
    expect(table.row("users", keyOfId("b"))).toEqual(v1Row("b", { legacy: "kept" }));
    const refused = deps.logs.records().filter((r) => r["msg"] === "migrate_refused");
    expect(refused.map((r) => [r["level"], r["row_kind"], r["reason"]])).toEqual([
      ["error", "item", "shape_invalid"],
      ["error", "item", "value_lost"],
    ]);
    const text = deps.logs.lines.join("\n");
    expect(text).not.toContain("ITEM#");
    expect(text).not.toContain("失われる");
  });

  it("どの行の種類の skPattern にも当たらない行を row_kind_unknown で数え、表の用途を載せる", async () => {
    const table = fakeTable();
    table.seed("users", { pk: "ELSE#x", sk: "ELSEWHERE", schema_version: 1 });
    const deps = depsOf(table, tablesWith("users", itemCodec()));
    const out = await migrateTable({ purpose: "users", cursor: null }, deps);
    expect(out).toMatchObject({ refused: 1, refusedByReason: { row_kind_unknown: 1 } });
    expect(deps.logs.records().find((r) => r["msg"] === "migrate_refused")).toMatchObject({ row_kind: "users", reason: "row_kind_unknown" });
  });

  it("記録の表は 1 行も書かず、前の版の行を append_only で数えて走査を最後まで続ける", async () => {
    const table = fakeTable();
    table.seed("audit", v1Row("a"));
    table.seed("audit", v2Row("b"));
    table.seed("audit", v1Row("c"));
    const out = await migrateTable({ purpose: "audit", cursor: null }, depsOf(table, tablesWith("audit", itemCodec())));
    expect(out).toMatchObject({ done: true, rewritten: 0, refused: 2, refusedByReason: { append_only: 2 } });
    expect(table.transactions).toEqual([]);
  });

  it("移しが先に確定した前の版の行を、前の版を読んだ書き手が replaceIfVersion で置き換えても、移しが足した列は書き手の行に無ければ残らない", async () => {
    const table = fakeTable();
    table.seed("users", v1Row("a"));
    await migrateTable({ purpose: "users", cursor: null }, depsOf(table, tablesWith("users", itemCodec())));
    // 前の版を読んだ書き手（version 3・incarnation INC を読んだ）が、前の版の行全体で置き換える
    const { version: _v, incarnation: _i, ...item } = v1Row("a", { nick: "by-writer" });
    const put = replaceIfVersion({ table: "users", item, version: 3, incarnation: INC, expect: { version: { kind: "value", value: 3 }, incarnation: { kind: "value", value: INC } }, onConflict: "version_mismatch" });
    await table.db.transactWrite([put]);
    expect(table.row("users", keyOfId("a"))).toEqual(v1Row("a", { version: 4, nick: "by-writer" }));
    expect(table.row("users", keyOfId("a"))).not.toHaveProperty("display_name");
  });
});

function contextWith(remaining: () => number): Context {
  return { getRemainingTimeInMillis: remaining } as unknown as Context;
}

const event = (over: Partial<MigrateEvent> = {}): MigrateEvent => ({ purpose: "users", migrate_id: MIGRATE_ID, cursor: null, refused: 0, refusedByReason: {}, ...over });

describe("createMigrateHandler", () => {
  it("終わっていなければ続きの位置と refused の合計を、受け取った migrate_id を変えずに渡して起こし直し、migrate_page に同じ migrate_id が出る", async () => {
    const table = fakeTable();
    table.seed("users", v1Row("a", { nick: 1 }));
    table.seed("users", v1Row("b"));
    table.seed("users", v1Row("c"));
    const deps = depsOf(table, tablesWith("users", itemCodec()));
    const sent: MigrateEvent[] = [];
    let calls = 0;
    const handler = createMigrateHandler({ ...deps, reinvoke: async (e) => void sent.push(e) });
    await handler(event({ refused: 2, refusedByReason: { contended: 2 } }), contextWith(() => (calls++ < 2 ? 60_000 : MIGRATE_RESERVE_MS)));
    expect(sent).toEqual([{ purpose: "users", migrate_id: MIGRATE_ID, cursor: keyOfId("b"), refused: 3, refusedByReason: { contended: 2, shape_invalid: 1 } }]);
    const records = deps.logs.records();
    expect(records.find((r) => r["msg"] === "migrate_page")).toMatchObject({ purpose: "users", migrate_id: MIGRATE_ID, rewritten: 1, skipped: 0, refused: 1 });
    expect(records.find((r) => r["msg"] === "migrate_refused")).toMatchObject({ migrate_id: MIGRATE_ID });
    expect(records.some((r) => r["msg"] === "migrate_done")).toBe(false);
  });

  it("終わったら migrate_done に合計を出し、合計が 1 以上なら error、0 なら info の水準で出し、起こし直さない", async () => {
    for (const [refused, level] of [
      [0, "info"],
      [1, "error"],
    ] as const) {
      const table = fakeTable();
      table.seed("users", v1Row("a"));
      const deps = depsOf(table, tablesWith("users", itemCodec()));
      const sent: MigrateEvent[] = [];
      await createMigrateHandler({ ...deps, reinvoke: async (e) => void sent.push(e) })(event({ refused, refusedByReason: refused === 0 ? {} : { contended: 1 } }), contextWith(() => 60_000));
      expect(sent).toEqual([]);
      expect(deps.logs.records().find((r) => r["msg"] === "migrate_done")).toMatchObject({ level, purpose: "users", migrate_id: MIGRATE_ID, refused, refusedByReason: refused === 0 ? {} : { contended: 1 } });
    }
  });

  it("migrate_id が無いか UUID v4 でない起動と、表の用途の違う起動は移さずに error を出して終える", async () => {
    for (const bad of [{ migrate_id: "" }, { migrate_id: "0b6e3c2a-5d4f-7a1b-9c8d-7e6f5a4b3c2d" }, { migrate_id: undefined as unknown as string }, { purpose: "nope" as TablePurpose }]) {
      const table = fakeTable();
      table.seed("users", v1Row("a"));
      const deps = depsOf(table, tablesWith("users", itemCodec()));
      const sent: MigrateEvent[] = [];
      await createMigrateHandler({ ...deps, reinvoke: async (e) => void sent.push(e) })(event(bad), contextWith(() => 60_000));
      expect(table.transactions).toEqual([]);
      expect(sent).toEqual([]);
      expect(deps.logs.records().map((r) => r["level"])).toEqual(["error"]);
    }
  });
});
