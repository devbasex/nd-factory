import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type RowCodec, RowCodecError, readRow, repairIdentity, rowCodec, rowReplaceOf, type Stored, writeRow } from "../src/row-codec.ts";
import { uuid } from "../src/rows/common.ts";
import { ROW_CODECS, TABLES } from "../src/tables.ts";
import { id, ROW_CASES } from "./fixtures/rows.ts";

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

// 1 段目（読み手は両方、書き手は前の版）・2 段目（書き手も次の版）。書き手を戻した状態は 1 段目と同じ値なので stage1 で表し、
// 確かめるのは 2 段目で書いた行をその状態で読み書きできること
const stage1 = codecWriting(1);
const stage2 = codecWriting(2);
const onlyV1 = rowCodec({ latest: { version: 1, schema: v1 }, writeVersion: 1, keyOf });

const rowV1 = { pk: "ITEM#a", sk: "ITEM", schema_version: 1, version: 3, item_id: "a", nick: "acme" };
const rowV2 = { pk: "ITEM#a", sk: "ITEM", schema_version: 2, version: 3, item_id: "a", display_name: "acme" };
const asV2: V2 = { schema_version: 2, version: 3, item_id: "a", display_name: "acme" };

const ABSENT: Stored = { kind: "absent" };
const val = (value: unknown): Stored => ({ kind: "value", value });
// 保存してあった schema_version・version・incarnation（作り物の行は incarnation を持たない）
const storedOf = (schemaVersion: unknown, version: unknown = 3, incarnation: Stored = ABSENT) => ({ schema_version: val(schemaVersion), version: val(version), incarnation });

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
    const v3 = v2.extend({ schema_version: z.literal(3) });
    expect(() => rowCodec({ latest: { version: 3, schema: v3 }, previous: { version: 1, schema: v1, upgrade: (r: V1) => ({ ...upgrade(r), schema_version: 3 as const }), downgrade: (r) => downgrade({ ...r, schema_version: 2 }) }, writeVersion: 3, keyOf })).toThrow(/previous.version は latest.version - 1/);
    const noDowngrade = { version: 1, schema: v1, upgrade } as unknown as { version: number; schema: typeof v1; upgrade: typeof upgrade; downgrade: typeof downgrade };
    expect(() => rowCodec({ latest: { version: 2, schema: v2 }, previous: noDowngrade, writeVersion: 2, keyOf })).toThrow(RowCodecError);
    expect(() => rowCodec({ latest: { version: 0, schema: v1 }, writeVersion: 0, keyOf })).toThrow(RowCodecError);
  });

  it("latest.version が 1 のときの previous.version 0 を拒む（版 0 を読まず、writeVersion 0 も選べない）", () => {
    const v0 = v1.extend({ schema_version: z.literal(0) });
    const up = (r: z.infer<typeof v0>): V1 => ({ ...r, schema_version: 1 });
    const down = (r: V1) => ({ ...r, schema_version: 0 as const });
    expect(() => rowCodec({ latest: { version: 1, schema: v1 }, previous: { version: 0, schema: v0, upgrade: up, downgrade: down }, writeVersion: 1, keyOf })).toThrow(/previous.version は 1 以上の整数/);
    expect(() => rowCodec({ latest: { version: 1, schema: v1 }, previous: { version: 0, schema: v0, upgrade: up, downgrade: down }, writeVersion: 0, keyOf })).toThrow(RowCodecError);
  });

  it("schema の schema_version のリテラルが各 version と食い違う組・schema_version の列が無い形で投げる", () => {
    expect(() => rowCodec({ latest: { version: 2, schema: v1 as unknown as typeof v2 }, writeVersion: 2, keyOf })).toThrow(/latest.schema の schema_version/);
    expect(() => rowCodec({ latest: { version: 2, schema: v2 }, previous: { version: 1, schema: v2 as unknown as typeof v1, upgrade, downgrade }, writeVersion: 1, keyOf })).toThrow(/previous.schema の schema_version/);
    const noColumn = z.object({ version: z.int().min(1), item_id: z.string(), display_name: z.string() });
    expect(() => rowCodec({ latest: { version: 2, schema: noColumn as unknown as typeof v2 }, writeVersion: 2, keyOf })).toThrow(/latest.schema の schema_version/);
    const twoValues = v2.extend({ schema_version: z.literal([1, 2]) });
    expect(() => rowCodec({ latest: { version: 2, schema: twoValues as unknown as typeof v2 }, writeVersion: 2, keyOf })).toThrow(/latest.schema の schema_version/);
  });
});

describe("readRow と writeRow（受け入れ条件 9 の読み手）", () => {
  it("1 段目: 版 1 と版 2 の行をどちらも版 2 の形で読み、writeRow は版 1 の行を出す", () => {
    expect(readRow(stage1, rowV1)).toEqual({ ok: true, row: asV2, from: 1, stored: storedOf(1) });
    expect(readRow(stage1, rowV2)).toEqual({ ok: true, row: asV2, from: 2, stored: storedOf(2) });
    expect(writeRow(stage1, asV2)).toEqual(rowV1);
  });

  it("2 段目: 同じ 2 つの行を同じに読み、writeRow は版 2 の行を出す", () => {
    expect(readRow(stage2, rowV1)).toEqual({ ok: true, row: asV2, from: 1, stored: storedOf(1) });
    expect(readRow(stage2, rowV2)).toEqual({ ok: true, row: asV2, from: 2, stored: storedOf(2) });
    expect(writeRow(stage2, asV2)).toEqual(rowV2);
  });

  it("書き手を戻した状態: 2 段目に書いた版 2 の行を読み、書き換えると版 1 の行になる", () => {
    const written = writeRow(stage2, { ...asV2, display_name: "acme-2" });
    const read = readRow(stage1, written);
    expect(read).toEqual({ ok: true, row: { ...asV2, display_name: "acme-2" }, from: 2, stored: storedOf(2) });
    if (!read.ok) throw new Error("読めない");
    expect(writeRow(stage1, read.row)).toEqual({ ...rowV1, nick: "acme-2" });
    expect(rowReplaceOf(stage1, written, read.row)).toEqual({ pk: "ITEM#a", sk: "ITEM", schema_version: 1, item_id: "a", nick: "acme-2" });
  });

  it("書き手を戻した状態: 2 段目に書いた版 2 の行の別の列を書き換えても、版 2 で書いた値が残る", () => {
    const written = writeRow(stage2, { ...asV2, display_name: "acme-2" });
    const read = readRow(stage1, written);
    if (!read.ok) throw new Error("読めない");
    // 置き換えの行全体に、条件つきの書き込みの部品が入れる version を足したものが保存される
    const after = { ...rowReplaceOf(stage1, written, { ...read.row, version: 4 }), version: 4 };
    expect(readRow(stage1, after)).toEqual({ ok: true, row: { ...asV2, version: 4, display_name: "acme-2" }, from: 1, stored: storedOf(1, 4) });
  });

  const v2n = v2.extend({ tags: z.array(z.string()).optional() });
  type V2n = z.infer<typeof v2n>;
  const lossy = (writeVersion: number, downgradable?: boolean) =>
    rowCodec({ latest: { version: 2, schema: v2n }, previous: { version: 1, schema: v1, upgrade: (r: V1): V2n => upgrade(r), downgrade: (r: V2n) => downgrade(r) }, writeVersion, ...(downgradable === undefined ? {} : { downgradable }), keyOf });
  const tagged = { ...asV2, tags: ["x"] };

  it("前の版へ下げると失われる値は、前の版で書くときも 2 段目に次の版で書くときも、書かずに投げる（書き手を戻せる間の守り）", () => {
    expect(() => writeRow(lossy(1), tagged)).toThrow(/値が失われる/);
    expect(() => writeRow(lossy(2), tagged)).toThrow(/値が失われる/);
    expect(() => rowReplaceOf(lossy(2), rowV2, tagged)).toThrow(/値が失われる/);
    expect(writeRow(lossy(1), asV2)).toEqual(rowV1);
    expect(writeRow(lossy(2), asV2)).toEqual(rowV2);
  });

  it("downgradable を false にした後（手順の 4）は次の版だけの値を書け、前の版で書く組は作れない", () => {
    expect(lossy(2).downgradable).toBe(true);
    expect(lossy(2, false).downgradable).toBe(false);
    expect(onlyV1.downgradable).toBe(false);
    expect(writeRow(lossy(2, false), tagged)["tags"]).toEqual(["x"]);
    expect(() => lossy(1, false)).toThrow(/downgradable が false なら writeVersion は latest.version/);
  });

  it("downgrade が引数の列をその場で消しても、値を失う書き込みを通さない", () => {
    const deleting = (writeVersion: number) =>
      rowCodec({
        latest: { version: 2, schema: v2n },
        previous: {
          version: 1,
          schema: v1,
          upgrade: (r: V1): V2n => upgrade(r),
          downgrade: (r: V2n) => {
            delete r.tags;
            return downgrade(r);
          },
        },
        writeVersion,
        keyOf,
      });
    const row = { ...asV2, tags: ["x"] };
    expect(() => writeRow(deleting(1), row)).toThrow(/値が失われる/);
    expect(() => writeRow(deleting(2), row)).toThrow(/値が失われる/);
    expect(row.tags).toEqual(["x"]);
  });

  it("upgrade が引数の列をその場で改めても、書く前の版の行は前の版の形のまま", () => {
    const renaming = rowCodec({
      latest: { version: 2, schema: v2 },
      previous: {
        version: 1,
        schema: v1,
        upgrade: (r: V1): V2 => {
          const m = r as unknown as Record<string, unknown>;
          m["display_name"] = m["nick"];
          delete m["nick"];
          m["schema_version"] = 2;
          return m as unknown as V2;
        },
        downgrade,
      },
      writeVersion: 1,
      keyOf,
    });
    const written = writeRow(renaming, asV2);
    expect(written).toEqual(rowV1);
    expect(readRow(renaming, written)).toEqual({ ok: true, row: asV2, from: 1, stored: storedOf(1) });
  });

  it("集合（Set）は要素まで比べ、下げると集合の要素を失う行を書かずに投げる", () => {
    const meta = z.looseObject({}).optional();
    const s1 = v1.extend({ meta });
    const s2 = v2.extend({ meta });
    type S1 = z.infer<typeof s1>;
    type S2 = z.infer<typeof s2>;
    const dropping = (writeVersion: number) =>
      rowCodec({
        latest: { version: 2, schema: s2 },
        previous: {
          version: 1,
          schema: s1,
          upgrade: (r: S1): S2 => ({ ...upgrade(r), ...(r.meta === undefined ? {} : { meta: r.meta }) }),
          downgrade: (r: S2): S1 => {
            const labels = r.meta?.["labels"];
            const kept = labels instanceof Set ? new Set([...labels].slice(0, 1)) : labels;
            return { ...downgrade(r), ...(r.meta === undefined ? {} : { meta: { ...r.meta, labels: kept } }) };
          },
        },
        writeVersion,
        keyOf,
      });
    const two = { ...asV2, meta: { labels: new Set(["a", "b"]) } };
    expect(() => writeRow(dropping(2), two)).toThrow(/値が失われる/);
    expect(() => writeRow(dropping(1), two)).toThrow(/値が失われる/);
    const one = { ...asV2, meta: { labels: new Set(["a"]) } };
    expect(writeRow(dropping(2), one)["meta"]).toEqual({ labels: new Set(["a"]) });
    expect(writeRow(dropping(1), one)["meta"]).toEqual({ labels: new Set(["a"]) });
  });

  it("readRow は upgrade に写しを渡し、upgrade が集合から要素をその場で消しても、読んだ行（raw）は変わらず rowReplaceOf が値の損失を拒む", () => {
    const meta = z.looseObject({}).optional();
    const s1 = v1.extend({ meta });
    const s2 = v2.extend({ meta });
    type S1 = z.infer<typeof s1>;
    type S2 = z.infer<typeof s2>;
    const pruning = (writeVersion: number) =>
      rowCodec({
        latest: { version: 2, schema: s2 },
        previous: {
          version: 1,
          schema: s1,
          upgrade: (r: S1): S2 => {
            const labels = r.meta?.["labels"];
            if (labels instanceof Set) labels.delete("legacy");
            return { ...upgrade(r), ...(r.meta === undefined ? {} : { meta: r.meta }) };
          },
          downgrade: (r: S2): S1 => ({ ...downgrade(r), ...(r.meta === undefined ? {} : { meta: r.meta }) }),
        },
        writeVersion,
        keyOf,
      });
    for (const writeVersion of [1, 2]) {
      const raw = { ...rowV1, meta: { labels: new Set(["a", "legacy"]) } };
      const read = readRow(pruning(writeVersion), raw);
      if (!read.ok) throw new Error("読めない");
      expect(raw.meta.labels).toEqual(new Set(["a", "legacy"]));
      expect(() => rowReplaceOf(pruning(writeVersion), raw, read.row)).toThrow(/値が失われる/);
    }
  });

  it("ArrayBuffer 本体のバイナリも中身のバイトまで比べ、下げるとバイト列が変わる行を書かずに投げる", () => {
    const meta = z.looseObject({}).optional();
    const b1 = v1.extend({ meta });
    const b2 = v2.extend({ meta });
    type B1 = z.infer<typeof b1>;
    type B2 = z.infer<typeof b2>;
    const rewriting = (writeVersion: number) =>
      rowCodec({
        latest: { version: 2, schema: b2 },
        previous: {
          version: 1,
          schema: b1,
          upgrade: (r: B1): B2 => ({ ...upgrade(r), ...(r.meta === undefined ? {} : { meta: r.meta }) }),
          downgrade: (r: B2): B1 => {
            const blob = r.meta?.["blob"];
            const changed = blob instanceof ArrayBuffer ? new Uint8Array(blob.byteLength).buffer : blob;
            return { ...downgrade(r), ...(r.meta === undefined ? {} : { meta: { ...r.meta, blob: changed } }) };
          },
        },
        writeVersion,
        keyOf,
      });
    const nonZero = { ...asV2, meta: { blob: new Uint8Array([1, 2, 3]).buffer } };
    expect(() => writeRow(rewriting(1), nonZero)).toThrow(/値が失われる/);
    expect(() => writeRow(rewriting(2), nonZero)).toThrow(/値が失われる/);
    const zeros = { ...asV2, meta: { blob: new Uint8Array(3).buffer } };
    expect(() => writeRow(rewriting(1), zeros)).not.toThrow();
    expect(() => writeRow(rewriting(2), zeros)).not.toThrow();
  });

  it("共有バッファ（SharedArrayBuffer）を裏に持つバイナリの行は、写しが元とバイトを共有するため読まずに拒み、書かずに投げる", () => {
    const meta = z.looseObject({}).optional();
    const b1 = v1.extend({ meta });
    const b2 = v2.extend({ meta });
    type B1 = z.infer<typeof b1>;
    type B2 = z.infer<typeof b2>;
    const zeroing = (writeVersion: number) =>
      rowCodec({
        latest: { version: 2, schema: b2 },
        previous: {
          version: 1,
          schema: b1,
          upgrade: (r: B1): B2 => {
            const blob = r.meta?.["blob"];
            if (blob instanceof Uint8Array) blob.fill(0);
            return { ...upgrade(r), ...(r.meta === undefined ? {} : { meta: r.meta }) };
          },
          downgrade: (r: B2): B1 => ({ ...downgrade(r), ...(r.meta === undefined ? {} : { meta: r.meta }) }),
        },
        writeVersion,
        keyOf,
      });
    for (const writeVersion of [1, 2]) {
      const shared = new Uint8Array(new SharedArrayBuffer(3));
      shared.set([1, 2, 3]);
      const raw = { ...rowV1, meta: { blob: shared } };
      expect(readRow(zeroing(writeVersion), raw)).toEqual({ ok: false, reason: "shape_invalid" });
      expect([...shared]).toEqual([1, 2, 3]);
      expect(() => rowReplaceOf(zeroing(writeVersion), raw, asV2)).toThrow(expect.objectContaining({ code: "shared_buffer" }));
      expect(() => writeRow(zeroing(writeVersion), { ...asV2, meta: { blob: shared } })).toThrow(/共有バッファ/);
      expect(() => writeRow(zeroing(writeVersion), { ...asV2, meta: { set: new Set([new DataView(new SharedArrayBuffer(1))]) } })).toThrow(/共有バッファ/);
      expect([...shared]).toEqual([1, 2, 3]);
    }
  });

  it("upgrade が投げた前の版の行は、投げずに shape_invalid を返す", () => {
    const throwing = rowCodec({
      latest: { version: 2, schema: v2 },
      previous: {
        version: 1,
        schema: v1,
        upgrade: () => {
          throw new Error("upgrade の誤り");
        },
        downgrade,
      },
      writeVersion: 2,
      keyOf,
    });
    expect(readRow(throwing, rowV1)).toEqual({ ok: false, reason: "shape_invalid" });
    expect(readRow(throwing, rowV2)).toEqual({ ok: true, row: asV2, from: 2, stored: storedOf(2) });
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
    expect(readRow(onlyV1, rowV1)).toEqual({ ok: true, row: { schema_version: 1, version: 3, item_id: "a", nick: "acme" }, from: 1, stored: storedOf(1) });
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


describe("readRow の stored（行の書き手の設計の決定 8）", () => {
  it("保存してあった schema_version・version・incarnation の値そのものを返し、列が無ければ absent にする", () => {
    const withInc = { ...rowV2, incarnation: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b" };
    const read = readRow(stage2, withInc);
    expect(read.ok && read.stored).toEqual(storedOf(2, 3, val("6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b")));
    expect(readRow(stage2, rowV1)).toMatchObject({ ok: true, stored: { incarnation: ABSENT } });
    // undefined の列は無い列と同じに見る（writeRow も undefined の列を書かない）
    expect(readRow(stage2, { ...rowV2, incarnation: undefined })).toMatchObject({ ok: true, stored: { incarnation: ABSENT } });
  });

  it("前の版の行でも、upgrade の後の値でなく保存してあった schema_version を返す", () => {
    const read = readRow(stage2, rowV1);
    expect(read.ok && read.row.schema_version).toBe(2);
    expect(read.ok && read.stored.schema_version).toEqual(val(1));
  });
});

// repair を持つ作り物の行の種類。版 2 の display_name が数で保存された誤った行を、文字へ直す
const fixDisplayName = (raw: Readonly<Record<string, unknown>>): Record<string, unknown> | null =>
  typeof raw["display_name"] === "number" ? { ...raw, display_name: String(raw["display_name"]) } : null;
const repairing = (repair: (raw: Readonly<Record<string, unknown>>) => Record<string, unknown> | null, writeVersion = 2) =>
  rowCodec({ latest: { version: 2, schema: v2 }, previous: { version: 1, schema: v1, upgrade, downgrade }, writeVersion, repair, keyOf });

describe("rowCodec の repair", () => {
  it("repair を持たない行の種類は repair が null、持つ種類は渡した関数を持つ", () => {
    expect(stage2.repair).toBeNull();
    expect(repairing(fixDisplayName).repair).not.toBeNull();
  });

  it("repair が関数でない組で投げる", () => {
    const notFunction = "x" as unknown as (raw: Readonly<Record<string, unknown>>) => Record<string, unknown> | null;
    expect(() => repairing(notFunction)).toThrow(expect.objectContaining({ code: "codec_invalid" }));
  });

  it("形を外れた行は repair で直した形で読み、stored は保存してあった値を返す", () => {
    const read = readRow(repairing(fixDisplayName), { ...rowV2, display_name: 7 });
    expect(read).toEqual({ ok: true, row: { ...asV2, display_name: "7" }, from: 2, stored: storedOf(2) });
  });

  it("形を通る行には repair を当てない", () => {
    let calls = 0;
    const counting = repairing((raw) => {
      calls += 1;
      return fixDisplayName(raw);
    });
    expect(readRow(counting, rowV2)).toEqual({ ok: true, row: asV2, from: 2, stored: storedOf(2) });
    expect(readRow(counting, rowV1)).toEqual({ ok: true, row: asV2, from: 1, stored: storedOf(1) });
    expect(calls).toBe(0);
  });

  it("repair が null を返す・投げる・行でない値を返す行は shape_invalid のまま", () => {
    expect(readRow(repairing(fixDisplayName), { ...rowV2, display_name: true })).toEqual({ ok: false, reason: "shape_invalid" });
    const throwing = repairing(() => {
      throw new Error("repair の誤り");
    });
    expect(readRow(throwing, { ...rowV2, display_name: 7 })).toEqual({ ok: false, reason: "shape_invalid" });
    expect(readRow(repairing(() => [] as unknown as Record<string, unknown>), { ...rowV2, display_name: 7 })).toEqual({ ok: false, reason: "shape_invalid" });
    // 直した行がなお形を通らない
    expect(readRow(repairing((raw) => ({ ...raw, display_name: null })), { ...rowV2, display_name: 7 })).toEqual({ ok: false, reason: "shape_invalid" });
  });

  it("受けない版の行は repair を通さずに version_unsupported を返す", () => {
    let calls = 0;
    const counting = repairing((raw) => {
      calls += 1;
      return { ...raw, schema_version: 2 };
    });
    expect(readRow(counting, { ...rowV2, schema_version: 3 })).toEqual({ ok: false, reason: "version_unsupported" });
    expect(calls).toBe(0);
  });

  it("前の版の誤った行は repair で直してから upgrade で今の形にし、from は直した行の版", () => {
    const fixNick = (raw: Readonly<Record<string, unknown>>) => (typeof raw["nick"] === "number" ? { ...raw, nick: String(raw["nick"]) } : null);
    expect(readRow(repairing(fixNick), { ...rowV1, nick: 5 })).toEqual({ ok: true, row: { ...asV2, display_name: "5" }, from: 1, stored: storedOf(1) });
    // 形の版の無い行を、直す関数が版を入れて読ませる
    const { schema_version: _sv, ...noVersion } = rowV2;
    expect(readRow(repairing((raw) => ({ ...raw, schema_version: 2 })), noVersion)).toEqual({ ok: true, row: asV2, from: 2, stored: { ...storedOf(2), schema_version: ABSENT } });
  });

  it("repair が引数をその場で変えても、読んだ行は変わらない", () => {
    const raw: Record<string, unknown> = { ...rowV2, display_name: 7 };
    const mutating = repairing((r) => {
      const m = r as Record<string, unknown>;
      m["display_name"] = "changed";
      return m;
    });
    expect(readRow(mutating, raw)).toMatchObject({ ok: true, row: { display_name: "changed" } });
    expect(raw["display_name"]).toBe(7);
  });
});

describe("rowReplaceOf", () => {
  it("戻り値は writeRow の戻り値から version と incarnation を外したもので、pk・sk・schema_version を含み、latest の版で消した列が無い", () => {
    const { version: _v, ...rest } = writeRow(stage2, asV2);
    const replaced = rowReplaceOf(stage2, rowV1, asV2);
    expect(replaced).toEqual(rest);
    expect(replaced).toMatchObject({ pk: "ITEM#a", sk: "ITEM", schema_version: 2 });
    expect(replaced).not.toHaveProperty("nick");
  });

  it("書き手を戻した状態（1 段目と同じ値）では、前の版の行全体になり、次の版だけの列が無い", () => {
    expect(rowReplaceOf(stage1, rowV2, asV2)).toEqual({ pk: "ITEM#a", sk: "ITEM", schema_version: 1, item_id: "a", nick: "acme" });
  });

  it("読んだ行にあって書き手の行に無い列（undefined にした任意の列・知らない列・継承した名前の列）は戻り値に無い", () => {
    const withNote = z.object({ schema_version: z.literal(1), version: z.int().min(1), item_id: z.string(), note: z.string().optional() });
    const codec = rowCodec({ latest: { version: 1, schema: withNote }, writeVersion: 1, keyOf });
    const row = { schema_version: 1 as const, version: 3, item_id: "a", note: undefined };
    const raw = { pk: "ITEM#a", sk: "ITEM", schema_version: 1, version: 3, item_id: "a", note: "old", next_only: "x", constructor: "y", toString: "z" };
    expect(rowReplaceOf(codec, raw, row)).toEqual({ pk: "ITEM#a", sk: "ITEM", schema_version: 1, item_id: "a" });
  });

  it("raw が持っていても、戻り値に version と incarnation が出ない", () => {
    const withInc = v2.extend({ incarnation: uuid });
    const codec = rowCodec({ latest: { version: 2, schema: withInc }, writeVersion: 2, keyOf });
    const inc = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    const replaced = rowReplaceOf(codec, { ...rowV2, version: 9, incarnation: inc }, { ...asV2, incarnation: inc });
    expect(replaced).not.toHaveProperty("version");
    expect(replaced).not.toHaveProperty("incarnation");
    expect(replaced).toEqual({ pk: "ITEM#a", sk: "ITEM", schema_version: 2, item_id: "a", display_name: "acme" });
  });

  // upgrade が前の版の列（memo）を捨て、downgrade がその列を固定値で補う組。upgrade(downgrade(次の版の行)) は戻るが、前の版の行の memo は失われる
  const m1 = v1.extend({ memo: z.string() });
  type M1 = z.infer<typeof m1>;
  const droppingMemo = (writeVersion: number, downgradable?: boolean, repair?: (raw: Readonly<Record<string, unknown>>) => Record<string, unknown> | null) =>
    rowCodec({
      latest: { version: 2, schema: v2 },
      previous: { version: 1, schema: m1, upgrade: (r: M1): V2 => upgrade(r), downgrade: (r: V2): M1 => ({ ...downgrade(r), memo: "" }) },
      writeVersion,
      ...(downgradable === undefined ? {} : { downgradable }),
      ...(repair === undefined ? {} : { repair }),
      keyOf,
    });
  const rowM1 = { ...rowV1, memo: "keep" };

  it("downgradable の間、upgrade で失う値を持つ前の版の行は、移し（次の版で書く）でも通常の書き換え（前の版で書く）でも置き換えずに投げる", () => {
    expect(writeRow(droppingMemo(2), asV2)).toEqual(rowV2);
    expect(() => rowReplaceOf(droppingMemo(2), rowM1, asV2)).toThrow(/上げると値が失われる/);
    expect(() => rowReplaceOf(droppingMemo(1), rowM1, { ...asV2, version: 4 })).toThrow(/上げると値が失われる/);
    expect(rowReplaceOf(droppingMemo(1), { ...rowM1, memo: "" }, { ...asV2, version: 4 })).toEqual({ pk: "ITEM#a", sk: "ITEM", schema_version: 1, item_id: "a", nick: "acme", memo: "" });
    expect(rowReplaceOf(droppingMemo(2, false), rowM1, asV2)).toEqual({ pk: "ITEM#a", sk: "ITEM", schema_version: 2, item_id: "a", display_name: "acme" });
  });

  it("downgradable の間、読んだ前の版の行が前の版の形を通らず repair でも直らなければ投げる", () => {
    expect(() => rowReplaceOf(stage2, { ...rowV1, nick: 1 }, asV2)).toThrow(/読んだ行が版 1 の形を通らない/);
    expect(() => rowReplaceOf(repairing(() => null), { ...rowV1, nick: 1 }, asV2)).toThrow(expect.objectContaining({ code: "previous_shape_invalid" }));
  });

  it("downgradable の間、repair で直る前の版の行は直した行で値の損失を照らす", () => {
    const fixNick = (raw: Readonly<Record<string, unknown>>) => (typeof raw["nick"] === "number" ? { ...raw, nick: String(raw["nick"]) } : null);
    expect(rowReplaceOf(repairing(fixNick), { ...rowV1, nick: 1 }, asV2)).toEqual({ pk: "ITEM#a", sk: "ITEM", schema_version: 2, item_id: "a", display_name: "acme" });
    // 直した行が upgrade で値を失う（memo を持つ）なら投げ、失わない（memo が空）なら置き換えられる
    const fixMemo = (fill: string) => (raw: Readonly<Record<string, unknown>>) => (raw["memo"] === undefined ? { ...raw, memo: fill } : null);
    const { memo: _memo, ...noMemo } = rowM1;
    expect(() => rowReplaceOf(droppingMemo(2, undefined, fixMemo("keep")), noMemo, asV2)).toThrow(expect.objectContaining({ code: "value_lost" }));
    expect(rowReplaceOf(droppingMemo(2, undefined, fixMemo("")), noMemo, asV2)).toMatchObject({ schema_version: 2 });
  });

  it("書き換え後の鍵が読んだ行の鍵と違えば投げる（pk・sk のどちらでも、読んだ行に sk が無くても）", () => {
    expect(() => rowReplaceOf(stage2, rowV2, { ...asV2, item_id: "b" })).toThrow(/書き換え後の鍵が読んだ行の鍵と違う: pk$/);
    const otherSk = rowCodec({ latest: { version: 2, schema: v2 }, writeVersion: 2, keyOf: (row) => ({ pk: `ITEM#${row.item_id}`, sk: "OTHER" }) });
    expect(() => rowReplaceOf(otherSk, rowV2, asV2)).toThrow(RowCodecError);
    const { sk: _sk, ...noSk } = rowV2;
    expect(() => rowReplaceOf(stage2, noSk, asV2)).toThrow(RowCodecError);
    const pkOnly = rowCodec({ latest: { version: 2, schema: v2 }, writeVersion: 2, keyOf: (row) => ({ pk: `ITEM#${row.item_id}`, sk: null }) });
    expect(rowReplaceOf(pkOnly, noSk, asV2)).toEqual({ pk: "ITEM#a", schema_version: 2, item_id: "a", display_name: "acme" });
    expect(() => rowReplaceOf(pkOnly, rowV2, asV2)).toThrow(RowCodecError);
  });

  it("席の user_id を変える書き換えは、旧利用者の席の行へ書かずに投げる", () => {
    const codec = ROW_CODECS["seat"];
    const sample = ROW_CASES["seat"]?.sample;
    if (codec === undefined || sample === undefined) throw new Error("席の行が無い");
    const row = codec.latest.schema.parse(sample);
    const raw = writeRow(codec, row);
    expect(() => rowReplaceOf(codec, raw, { ...row, user_id: id("usr", 99) })).toThrow(RowCodecError);
  });

  it("例外は理由の符号（code）を持ち、移しのログはこの符号で形の不正・値の損失・鍵の不一致を分けられる", () => {
    const codeOf = (f: () => unknown): string | null => {
      try {
        f();
      } catch (e) {
        return e instanceof RowCodecError ? e.code : null;
      }
      return null;
    };
    expect(codeOf(() => rowReplaceOf(stage2, { ...rowV1, nick: 1 }, asV2))).toBe("previous_shape_invalid");
    expect(codeOf(() => rowReplaceOf(droppingMemo(2), rowM1, asV2))).toBe("value_lost");
    expect(codeOf(() => rowReplaceOf(stage2, rowV2, { ...asV2, item_id: "b" }))).toBe("key_mismatch");
    expect(codeOf(() => writeRow(stage2, { ...asV2, display_name: 1 } as unknown as V2))).toBe("row_invalid");
  });

  it("鍵の不一致の例外は違った列の名前だけを載せ、鍵の値を載せない", () => {
    const codec = ROW_CODECS["login"];
    const sample = ROW_CASES["login"]?.sample;
    if (codec === undefined || sample === undefined) throw new Error("ログインの組の行が無い");
    const row = codec.latest.schema.parse(sample);
    const raw = { ...writeRow(codec, row), pk: "LOGIN#secret-subject", sk: "SECRET-SK" };
    let message = "";
    try {
      rowReplaceOf(codec, raw, row);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/鍵と違う: pk, sk$/);
    expect(message).not.toContain("secret-subject");
    expect(message).not.toContain(String(writeRow(codec, row)["pk"]));
  });

  it("version を持たない行（セッションの取り消し）は戻り値に version が出ず、incarnation も出ない", () => {
    const codec = ROW_CODECS["session_revocation"];
    const sample = ROW_CASES["session_revocation"]?.sample;
    if (codec === undefined || sample === undefined) throw new Error("セッションの取り消しの行が無い");
    const row = codec.latest.schema.parse(sample);
    const replaced = rowReplaceOf(codec, writeRow(codec, row), row);
    expect(replaced).not.toHaveProperty("version");
    expect(replaced).not.toHaveProperty("incarnation");
    expect(replaced["schema_version"]).toBe(1);
  });
});

describe("repairIdentity（旧形式の補い）", () => {
  const legacy = { pk: "ITEM#a", sk: "ITEM", schema_version: 1, item_id: "a" };

  it("incarnation が無ければ鍵から決まる UUID の形の値で補い、同じ行で読むたびに同じ値になる", () => {
    const repaired = repairIdentity({ version: false })(legacy);
    expect(uuid.safeParse(repaired["incarnation"]).success).toBe(true);
    expect(repairIdentity({ version: false })({ ...legacy })["incarnation"]).toBe(repaired["incarnation"]);
    // ほかの列が違っても鍵が同じなら同じ値、鍵が違えば違う値
    expect(repairIdentity({ version: true })({ ...legacy, item_id: "z" })["incarnation"]).toBe(repaired["incarnation"]);
    expect(repairIdentity({ version: false })({ ...legacy, sk: "OTHER" })["incarnation"]).not.toBe(repaired["incarnation"]);
    expect(repairIdentity({ version: false })({ ...legacy, pk: "ITEM#b" })["incarnation"]).not.toBe(repaired["incarnation"]);
  });

  it("区切りの鍵だけの行（sk が無い）も補える", () => {
    const { sk: _sk, ...pkOnly } = legacy;
    const repaired = repairIdentity({ version: true })(pkOnly);
    expect(uuid.safeParse(repaired["incarnation"]).success).toBe(true);
    expect(repaired["incarnation"]).not.toBe(repairIdentity({ version: true })(legacy)["incarnation"]);
  });

  it("opts.version なら version が無いときだけ 1 で補い、そうでなければ補わない", () => {
    expect(repairIdentity({ version: true })(legacy)["version"]).toBe(1);
    expect(repairIdentity({ version: false })(legacy)).not.toHaveProperty("version");
    expect(repairIdentity({ version: true })({ ...legacy, version: 4 })["version"]).toBe(4);
  });

  it("列があれば値を変えず（形を外れた値でも）、ほかの列も変えない", () => {
    const inc = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    expect(repairIdentity({ version: true })({ ...legacy, version: 2, incarnation: inc })).toEqual({ ...legacy, version: 2, incarnation: inc });
    expect(repairIdentity({ version: true })({ ...legacy, version: "x", incarnation: 7 })).toEqual({ ...legacy, version: "x", incarnation: 7 });
    const repaired = repairIdentity({ version: true })(legacy);
    const { incarnation: _i, version: _v, ...rest } = repaired;
    expect(rest).toEqual(legacy);
  });

  // incarnation と version を必須にした作り物の行の種類
  const withIdentity = z.object({ schema_version: z.literal(1), version: z.int().min(1), incarnation: uuid, item_id: z.string() });
  const identityCodec = rowCodec({ latest: { version: 1, schema: withIdentity }, writeVersion: 1, repair: repairIdentity({ version: true }), keyOf });

  it("U3b より前の行が補った値で読め、stored は補った列を absent で返す", () => {
    const first = readRow(identityCodec, legacy);
    const second = readRow(identityCodec, { ...legacy });
    if (!first.ok || !second.ok) throw new Error("読めない");
    expect(first.row.version).toBe(1);
    expect(uuid.safeParse(first.row.incarnation).success).toBe(true);
    expect(second.row.incarnation).toBe(first.row.incarnation);
    expect(first.stored).toEqual({ schema_version: val(1), version: ABSENT, incarnation: ABSENT });
    expect(first.from).toBe(1);
  });

  it("補った後もほかの列の誤りで形を通らない行は shape_invalid のまま", () => {
    expect(readRow(identityCodec, { ...legacy, item_id: 1 })).toEqual({ ok: false, reason: "shape_invalid" });
    expect(readRow(identityCodec, { ...legacy, incarnation: "not-a-uuid" })).toEqual({ ok: false, reason: "shape_invalid" });
  });

  it("補った行を置き換えると、戻り値に補った値を足した行が保存の形を通り、次の読みで stored が値になる", () => {
    const read = readRow(identityCodec, legacy);
    if (!read.ok) throw new Error("読めない");
    // 条件つきの書き込みの部品（replaceIfVersion）が version を 1 上げ、読み手の見る形の incarnation を入れる
    const saved = { ...rowReplaceOf(identityCodec, legacy, read.row), version: read.row.version + 1, incarnation: read.row.incarnation };
    const again = readRow(identityCodec, saved);
    expect(again).toEqual({ ok: true, row: { ...read.row, version: 2 }, from: 1, stored: { schema_version: val(1), version: val(2), incarnation: val(read.row.incarnation) } });
  });
});

describe("表の行の種類の RowCodec", () => {
  it("どの行の種類も版 1 だけを読み書きする（今の行はどれも版 1）", () => {
    for (const spec of Object.values(TABLES)) {
      for (const row of spec.rows) {
        expect(row.codec.latest.version).toBe(1);
        expect(row.codec.previous).toBeNull();
        expect(row.codec.writeVersion).toBe(1);
        expect(row.codec.downgradable).toBe(false);
        expect(ROW_CODECS[row.name]).toBe(row.codec);
      }
    }
  });

  const storedOfWritten = (written: Record<string, unknown>) => ({
    schema_version: val(written["schema_version"]),
    version: "version" in written ? val(written["version"]) : ABSENT,
    incarnation: "incarnation" in written ? val(written["incarnation"]) : ABSENT,
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
    expect(readRow(codec, written)).toEqual({ ok: true, row, from: 1, stored: storedOfWritten(written) });
  });

  // U3b で version を新しく足した行の種類（行の書き手の設計の決定 2。委任の使った時刻の行は U3b で足した種類）
  const NEW_VERSION = ["login", "login_subject", "login_link", "idempotency", "answer", "delegation_used"];
  const identityCases = Object.entries(ROW_CASES).filter(([name]) => name !== "audit");

  it.each(identityCases)("%s: U3b より前の書き手が保存した行（incarnation と新しく足した version の無い行）を repairIdentity の補いで読める", (name, c) => {
    const codec = ROW_CODECS[name];
    if (codec === undefined) throw new Error(`RowCodec が無い: ${name}`);
    expect(codec.repair).not.toBeNull();
    const written = writeRow(codec, codec.latest.schema.parse(c.sample));
    const newVersion = NEW_VERSION.includes(name);
    const { incarnation: _inc, version: storedVersion, ...rest } = written;
    const old = newVersion || storedVersion === undefined ? rest : { ...rest, version: storedVersion };
    const first = readRow(codec, old);
    const second = readRow(codec, { ...old });
    if (!first.ok || !second.ok) throw new Error(`読めない: ${name}`);
    const row = first.row as Record<string, unknown>;
    expect(uuid.safeParse(row["incarnation"]).success).toBe(true);
    expect((second.row as Record<string, unknown>)["incarnation"]).toBe(row["incarnation"]);
    expect(first.stored.incarnation).toEqual(ABSENT);
    if (newVersion) {
      expect(row["version"]).toBe(1);
      expect(first.stored.version).toEqual(ABSENT);
    } else if (storedVersion !== undefined) {
      expect(first.stored.version).toEqual(val(storedVersion));
    }
  });

  it("記録の表の行の種類は incarnation を持たず、旧形式の補いも持たない", () => {
    const codec = ROW_CODECS["audit"];
    if (codec === undefined) throw new Error("記録の行が無い");
    expect(codec.repair).toBeNull();
    expect(Object.keys((codec.latest.schema as z.ZodObject).shape)).not.toContain("incarnation");
  });
});
