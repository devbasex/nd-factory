import { TABLE_PURPOSES, TABLES, type TablePurpose } from "@nd-factory/contracts/tables";
import { createClock } from "@nd-factory/core/clock";
import type { Db } from "@nd-factory/core/db";
import { createLogger, type Logger, type LogFields } from "@nd-factory/core/log";
import type { Context } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { fakeTable } from "../../../packages/core/test/fakes/table.ts";
import { createCensusHandler } from "../src/entries/census.ts";
import { createMigrateHandler } from "../src/entries/migrate.ts";

// 起動イベントの確かめ（UUID v4 の識別子と表の用途、<見出し>_invalid_event の error、識別子を載せた子のログの書き手）を、
// createMigrateHandler と createCensusHandler の両方で同じ筋書きで固定する。表は空の偽の表で、Scan の呼び出しと子の作りを残す

const ID = "0b6e3c2a-5d4f-4a1b-9c8d-7e6f5a4b3c2d";

type Kind = {
  readonly name: string;
  readonly idField: "migrate_id" | "census_id";
  readonly prefix: "migrate" | "census";
  // 確かめを通った起動が最後に出す見出し
  readonly doneMsg: string;
  readonly baseEvent: Record<string, unknown>;
  readonly run: (deps: { db: Db; log: Logger; reinvoke: (e: unknown) => Promise<void> }, event: unknown) => Promise<void>;
};

const context = { getRemainingTimeInMillis: () => 60_000 } as unknown as Context;

const KINDS: readonly Kind[] = [
  {
    name: "createMigrateHandler",
    idField: "migrate_id",
    prefix: "migrate",
    doneMsg: "migrate_done",
    baseEvent: { purpose: "users", migrate_id: ID, cursor: null, refused: 0, refusedByReason: {} },
    run: (deps, event) => createMigrateHandler({ ...deps, clock: createClock(), tables: TABLES })(event as never, context),
  },
  {
    name: "createCensusHandler",
    idField: "census_id",
    prefix: "census",
    doneMsg: "census_done",
    baseEvent: { purpose: "users", census_id: ID, started_at: null, cursor: null, counts: {} },
    run: (deps, event) => createCensusHandler({ ...deps, clock: createClock(() => Date.parse("2026-11-24T00:00:00.000Z")), tables: TABLES })(event as never, context),
  },
];

function harness() {
  const table = fakeTable();
  const lines: string[] = [];
  const scans: unknown[][] = [];
  const children: LogFields[] = [];
  const sent: unknown[] = [];
  const root = createLogger({ request_id: "r", fn: "f", endpoint: "e" }, (l) => lines.push(l));
  const log: Logger = {
    info: (m, f) => root.info(m, f),
    warn: (m, f) => root.warn(m, f),
    error: (m, f) => root.error(m, f),
    child: (fields) => (children.push(fields), root.child(fields)),
  };
  const db: Db = { ...table.db, scan: async (...args) => (scans.push(args), table.db.scan(...args)) };
  return {
    deps: { db, log, reinvoke: async (e: unknown) => void sent.push(e) },
    scans,
    children,
    sent,
    records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

// 識別子として拒む値（欄が無い・UUID v4 でない・文字列でない）
const BAD_IDS: readonly [string, unknown][] = [
  ["空の文字列", ""],
  ["版の桁が 1", "0b6e3c2a-5d4f-1a1b-9c8d-7e6f5a4b3c2d"],
  ["版の桁が 7", "0b6e3c2a-5d4f-7a1b-9c8d-7e6f5a4b3c2d"],
  ["変種の桁が c", "0b6e3c2a-5d4f-4a1b-cc8d-7e6f5a4b3c2d"],
  ["大文字の 16 進", "0B6E3C2A-5D4F-4A1B-9C8D-7E6F5A4B3C2D"],
  ["前後に空白", ` ${ID} `],
  ["末尾に余分な文字", `${ID}0`],
  ["括弧つき", `{${ID}}`],
  ["区切りの無い 32 桁", ID.replaceAll("-", "")],
  ["数", 42],
  ["null", null],
  ["undefined", undefined],
  ["物", { id: ID }],
];

// 表の用途として拒む値
const BAD_PURPOSES: readonly [string, unknown][] = [
  ["知らない名前", "nope"],
  ["大文字", "USERS"],
  ["空の文字列", ""],
  ["Object の持つ名前", "toString"],
  ["__proto__", "__proto__"],
  ["undefined", undefined],
  ["null", null],
  ["配列", ["users"]],
];

for (const kind of KINDS) {
  const invalid = `${kind.prefix}_invalid_event`;

  describe(`${kind.name} の起動イベントの確かめ`, () => {
    const expectRejected = (h: ReturnType<typeof harness>, reason: string) => {
      expect(h.records()).toHaveLength(1);
      const [line] = h.records();
      expect(line).toMatchObject({ level: "error", msg: invalid, reason });
      // 子を作る前の error で、識別子の欄を載せない
      expect(Object.hasOwn(line!, kind.idField)).toBe(false);
      expect(h.children).toEqual([]);
      expect(h.scans).toEqual([]);
      expect(h.sent).toEqual([]);
    };

    for (const [label, value] of BAD_IDS) {
      it(`${kind.idField} が${label}の起動は走査せず、reason が ${kind.idField} の ${invalid} を 1 行だけ error で出す`, async () => {
        const h = harness();
        await kind.run(h.deps, { ...kind.baseEvent, [kind.idField]: value });
        expectRejected(h, kind.idField);
      });
    }

    it(`${kind.idField} の欄そのものが無い起動は reason が ${kind.idField} になる`, async () => {
      const h = harness();
      const { [kind.idField]: _omit, ...rest } = kind.baseEvent;
      await kind.run(h.deps, rest);
      expectRejected(h, kind.idField);
    });

    for (const [label, value] of [
      ["undefined", undefined],
      ["null", null],
    ] as const) {
      it(`イベントが${label}の起動は投げずに reason が ${kind.idField} の ${invalid} を出す`, async () => {
        const h = harness();
        await kind.run(h.deps, value);
        expectRejected(h, kind.idField);
      });
    }

    for (const [label, value] of BAD_PURPOSES) {
      it(`識別子が UUID v4 で purpose が${label}の起動は走査せず、reason が purpose の ${invalid} を出す`, async () => {
        const h = harness();
        await kind.run(h.deps, { ...kind.baseEvent, purpose: value });
        expectRejected(h, "purpose");
      });
    }

    it(`識別子も purpose も違う起動は reason が ${kind.idField} になる（識別子を先に確かめる）`, async () => {
      const h = harness();
      await kind.run(h.deps, { ...kind.baseEvent, [kind.idField]: "x", purpose: "nope" });
      expectRejected(h, kind.idField);
    });

    it("purpose の欄の無い起動は reason が purpose になる", async () => {
      const h = harness();
      const { purpose: _omit, ...rest } = kind.baseEvent;
      await kind.run(h.deps, rest);
      expectRejected(h, "purpose");
    });

    it.each(TABLE_PURPOSES.map((p) => [p]))("表の用途 %s の起動は受け入れ、その表を走査する", async (purpose: TablePurpose) => {
      const h = harness();
      await kind.run(h.deps, { ...kind.baseEvent, purpose });
      expect(h.scans.map((args) => args[0])).toEqual([purpose]);
      expect(h.records().some((r) => r["msg"] === invalid)).toBe(false);
      expect(h.records().find((r) => r["msg"] === kind.doneMsg)).toMatchObject({ purpose });
    });

    it(`確かめを通った起動は ${kind.idField} だけを載せた子のログの書き手を 1 回だけ作り、以後の行はどれもその識別子を載せる`, async () => {
      const h = harness();
      await kind.run(h.deps, kind.baseEvent);
      expect(h.children).toEqual([{ [kind.idField]: ID }]);
      const records = h.records();
      expect(records.length).toBeGreaterThan(0);
      for (const r of records) expect(r[kind.idField]).toBe(ID);
      // もう一方の識別子の欄は載せない
      const otherField = kind.idField === "migrate_id" ? "census_id" : "migrate_id";
      for (const r of records) expect(Object.hasOwn(r, otherField)).toBe(false);
    });

    it("起動イベントの識別子をそのまま（書き換えずに）子へ渡す", async () => {
      const other = "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f";
      const h = harness();
      await kind.run(h.deps, { ...kind.baseEvent, [kind.idField]: other });
      expect(h.children).toEqual([{ [kind.idField]: other }]);
      expect(h.records().find((r) => r["msg"] === kind.doneMsg)).toMatchObject({ [kind.idField]: other });
    });
  });
}
