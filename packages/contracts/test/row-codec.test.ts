import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type RowCodec, RowCodecError, readRow, rowCodec, rowUpdateOf, writeRow } from "../src/row-codec.ts";
import { ROW_CODECS, TABLES } from "../src/tables.ts";
import { ROW_CASES } from "./fixtures/rows.ts";

// 版を上げる子の手順（詳細設計の「表の移し」）を作り物の行の種類で表す。
// 版 1 の nick を、版 2 で display_name に改めた（版 2 で nick の列を消した）

const v1 = z.object({ schema_version: z.literal(1), version: z.int().min(1), item_id: z.string(), nick: z.string() });
const v2 = z.object({ schema_version: z.literal(2), version: z.int().min(1), item_id: z.string(), display_name: z.string() });
type V1 = z.infer<typeof v1>;
type V2 = z.infer<typeof v2>;

const upgrade = (row: V1): V2 => ({ schema_version: 2, version: row.version, item_id: row.item_id, display_name: row.nick });
const downgrade = (row: V2): V1 => ({ schema_version: 1, version: row.version, item_id: row.item_id, nick: row.display_name });
const keyOf = (row: { item_id: string }) => ({ pk: `ITEM#${row.item_id}`, sk: "ITEM" });

function codecWriting(writeVersion: number): RowCodec<V2> {
  return rowCodec({ latest: { version: 2, schema: v2 }, previous: { version: 1, schema: v1, upgrade, downgrade }, writeVersion, keyOf });
}

// 1 段目（読み手は両方、書き手は前の版）・2 段目（書き手も次の版）・書き手を戻した状態（1 段目と同じ値）
const stage1 = codecWriting(1);
const stage2 = codecWriting(2);
const rolledBack = codecWriting(1);
const onlyV1 = rowCodec({ latest: { version: 1, schema: v1 }, writeVersion: 1, keyOf });

const rowV1 = { pk: "ITEM#a", sk: "ITEM", schema_version: 1, version: 3, item_id: "a", nick: "acme" };
const rowV2 = { pk: "ITEM#a", sk: "ITEM", schema_version: 2, version: 3, item_id: "a", display_name: "acme" };
const asV2: V2 = { schema_version: 2, version: 3, item_id: "a", display_name: "acme" };

describe("rowCodec", () => {
  it("版 1 と 2 の組で作れる", () => {
    expect(stage1.latest.version).toBe(2);
    expect(stage1.previous?.version).toBe(1);
    expect(stage1.writeVersion).toBe(1);
  });

  it("previous の無い行の種類を作れる", () => {
    expect(onlyV1.previous).toBeNull();
  });

  it("writeVersion が 3・previous.version が latest.version - 1 でない・previous があって downgrade が無い組で投げる", () => {
    expect(() => codecWriting(3)).toThrow(RowCodecError);
    expect(() => rowCodec({ latest: { version: 1, schema: v1 }, writeVersion: 2, keyOf })).toThrow(RowCodecError);
    expect(() => rowCodec({ latest: { version: 3, schema: v2 }, previous: { version: 1, schema: v1, upgrade, downgrade }, writeVersion: 3, keyOf })).toThrow(RowCodecError);
    const noDowngrade = { version: 1, schema: v1, upgrade } as unknown as { version: number; schema: typeof v1; upgrade: typeof upgrade; downgrade: typeof downgrade };
    expect(() => rowCodec({ latest: { version: 2, schema: v2 }, previous: noDowngrade, writeVersion: 2, keyOf })).toThrow(RowCodecError);
    expect(() => rowCodec({ latest: { version: 0, schema: v1 }, writeVersion: 0, keyOf })).toThrow(RowCodecError);
  });
});

describe("readRow と writeRow（受け入れ条件 9 の読み手）", () => {
  it("1 段目: 版 1 と版 2 の行をどちらも版 2 の形で読み、writeRow は版 1 の行を出す", () => {
    expect(readRow(stage1, rowV1)).toEqual({ ok: true, row: asV2, from: 1 });
    expect(readRow(stage1, rowV2)).toEqual({ ok: true, row: asV2, from: 2 });
    expect(writeRow(stage1, asV2)).toEqual(rowV1);
  });

  it("2 段目: 同じ 2 つの行を同じに読み、writeRow は版 2 の行を出す", () => {
    expect(readRow(stage2, rowV1)).toEqual({ ok: true, row: asV2, from: 1 });
    expect(readRow(stage2, rowV2)).toEqual({ ok: true, row: asV2, from: 2 });
    expect(writeRow(stage2, asV2)).toEqual(rowV2);
  });

  it("書き手を戻した状態: 2 段目に書いた版 2 の行と版 1 の行をどちらも読み、writeRow は版 1 の行を出す", () => {
    const written = writeRow(stage2, { ...asV2, display_name: "acme-2" });
    expect(readRow(rolledBack, written)).toEqual({ ok: true, row: { ...asV2, display_name: "acme-2" }, from: 2 });
    expect(readRow(rolledBack, rowV1)).toEqual({ ok: true, row: asV2, from: 1 });
    expect(writeRow(rolledBack, asV2)).toEqual(rowV1);
  });

  it("版 1 → upgrade → downgrade で元の行に戻る", () => {
    const { pk: _pk, sk: _sk, ...body } = rowV1;
    expect(downgrade(upgrade(v1.parse(body)))).toEqual(body);
  });

  it("writeVersion によらず同じ結果を返す", () => {
    for (const raw of [rowV1, rowV2, { ...rowV1, schema_version: 0 }, { ...rowV2, schema_version: 3 }, { ...rowV2, display_name: 1 }]) {
      expect(readRow(stage1, raw)).toEqual(readRow(stage2, raw));
    }
  });

  it("previous の無い行の種類は版 1 だけを読む", () => {
    expect(readRow(onlyV1, rowV1)).toEqual({ ok: true, row: { schema_version: 1, version: 3, item_id: "a", nick: "acme" }, from: 1 });
    expect(readRow(onlyV1, rowV2)).toEqual({ ok: false, reason: "version_unsupported" });
    expect(readRow(onlyV1, { ...rowV1, schema_version: 0 })).toEqual({ ok: false, reason: "version_unsupported" });
  });

  it("版 0（previous より古い）・版 3（latest より新しい）を拒む", () => {
    expect(readRow(stage1, { ...rowV1, schema_version: 0 })).toEqual({ ok: false, reason: "version_unsupported" });
    expect(readRow(stage2, { ...rowV2, schema_version: 3 })).toEqual({ ok: false, reason: "version_unsupported" });
  });

  it("形の違い・形の版の無い行・行でない値を拒む", () => {
    expect(readRow(stage2, { ...rowV2, display_name: 1 })).toEqual({ ok: false, reason: "shape_invalid" });
    expect(readRow(stage2, { ...rowV1, nick: undefined })).toEqual({ ok: false, reason: "shape_invalid" });
    const { schema_version: _sv, ...noVersion } = rowV2;
    expect(readRow(stage2, noVersion)).toEqual({ ok: false, reason: "shape_invalid" });
    expect(readRow(stage2, { ...rowV2, schema_version: "2" })).toEqual({ ok: false, reason: "shape_invalid" });
    for (const raw of [null, [], "row", 2]) expect(readRow(stage2, raw)).toEqual({ ok: false, reason: "shape_invalid" });
  });

  it("次の版だけの列を捨てて読む", () => {
    const read = readRow(stage2, { ...rowV2, next_only: "x" });
    expect(read.ok && read.row).toEqual(asV2);
  });

  it("writeRow に版の形を外れた値を渡すと投げる", () => {
    expect(() => writeRow(stage2, { ...asV2, display_name: 1 } as unknown as V2)).toThrow(RowCodecError);
    expect(() => writeRow(stage1, { ...asV2, version: 0 })).toThrow(RowCodecError);
  });

  it("writeRow は形の版を writeVersion にし、鍵を keyOf から入れる", () => {
    expect(writeRow(stage2, { ...asV2, schema_version: 1 } as unknown as V2)["schema_version"]).toBe(2);
    expect(writeRow(stage2, asV2)).toMatchObject({ pk: "ITEM#a", sk: "ITEM" });
  });
});

describe("rowUpdateOf", () => {
  it("set は writeRow の戻り値から pk・sk・version を外したもので schema_version を含み、latest の版で消した列が remove に並ぶ", () => {
    const update = rowUpdateOf(stage2, rowV1, asV2);
    const { pk: _pk, sk: _sk, version: _v, ...rest } = writeRow(stage2, asV2);
    expect(update.set).toEqual(rest);
    expect(update.set["schema_version"]).toBe(2);
    expect(update.remove).toEqual(["nick"]);
  });

  it("書き手を戻した状態では、次の版だけの列を remove に並べる", () => {
    expect(rowUpdateOf(rolledBack, rowV2, asV2)).toEqual({ set: { schema_version: 1, item_id: "a", nick: "acme" }, remove: ["display_name"] });
  });

  it("消した列が無ければ remove が空", () => {
    expect(rowUpdateOf(stage2, rowV2, { ...asV2, display_name: "acme-2" })).toEqual({ set: { schema_version: 2, item_id: "a", display_name: "acme-2" }, remove: [] });
  });

  it("version を持たない行は set と remove に version が出ない", () => {
    const codec = ROW_CODECS["login"];
    const sample = ROW_CASES["login"]?.sample;
    if (codec === undefined || sample === undefined) throw new Error("ログインの組の行が無い");
    const raw = writeRow(codec, codec.latest.schema.parse(sample));
    const update = rowUpdateOf(codec, raw, codec.latest.schema.parse(sample));
    expect(update.set).not.toHaveProperty("version");
    expect(update.remove).toEqual([]);
  });

  it("raw が持っていても、set と remove のどちらにも pk・sk・version が出ない", () => {
    const update = rowUpdateOf(stage2, { ...rowV1, version: 9 }, asV2);
    for (const column of ["pk", "sk", "version"]) {
      expect(update.set).not.toHaveProperty(column);
      expect(update.remove).not.toContain(column);
    }
  });
});

describe("表の行の種類の RowCodec", () => {
  it("どの行の種類も版 1 だけを読み書きする（今の行はどれも版 1）", () => {
    for (const spec of Object.values(TABLES)) {
      for (const row of spec.rows) {
        expect(row.codec.latest.version).toBe(1);
        expect(row.codec.previous).toBeNull();
        expect(row.codec.writeVersion).toBe(1);
        expect(ROW_CODECS[row.name]).toBe(row.codec);
      }
    }
  });

  it.each(Object.entries(ROW_CASES))("%s: 書いた行を同じ形で読み、鍵の列と形の版を持つ", (name, c) => {
    const codec = ROW_CODECS[name];
    if (codec === undefined) throw new Error(`RowCodec が無い: ${name}`);
    const row = codec.latest.schema.parse(c.sample);
    const written = writeRow(codec, row);
    expect(written["schema_version"]).toBe(1);
    expect(typeof written["pk"]).toBe("string");
    const spec = Object.values(TABLES).find((t) => t.rows.some((r) => r.name === name));
    if (spec?.sortKey === null) expect(written).not.toHaveProperty("sk");
    else expect(typeof written["sk"]).toBe("string");
    expect(readRow(codec, written)).toEqual({ ok: true, row, from: 1 });
  });
});
