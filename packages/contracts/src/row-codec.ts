import type { z } from "zod";
import type { RowKey } from "./rows/common.ts";

// 行の版の読み手と書き手（issues/issue-2-design-detail.md の「表の移し」、決定 9）。
// 読み手が受ける版（latest と previous の 2 つ）と、書き手が出す版（writeVersion）を分けて持つ。読み手はどちらの版も latest の形へそろえ、
// 書き手は writeVersion の形で書く。次の版を読めるが前の版だけを書く 1 段目と、2 段目の後に書き手だけを戻した状態が、同じ値で表せる

export type PreviousVersion<L> = {
  readonly version: number;
  readonly schema: z.ZodType;
  // 前の版の形（schema を通した値）を latest の形へ上げる
  upgrade(row: unknown): L;
  // latest の形を前の版の形へ下げる
  downgrade(row: L): unknown;
};

export type RowCodec<L> = {
  readonly latest: { readonly version: number; readonly schema: z.ZodType<L> };
  readonly previous: PreviousVersion<L> | null;
  readonly writeVersion: number;
  // 鍵の列は行の列から組む写しで、keyOf だけが組む（Value 13）
  keyOf(row: L): RowKey;
};

// 行の種類を問わない RowCodec（表の仕様と表の移しが持つ）
export type AnyRowCodec = RowCodec<Record<string, unknown>>;

export type ReadRowResult<L> = { readonly ok: true; readonly row: L; readonly from: number } | { readonly ok: false; readonly reason: "version_unsupported" | "shape_invalid" };

export type RowUpdate = { readonly set: Record<string, unknown>; readonly remove: string[] };

export class RowCodecError extends Error {
  override name = "RowCodecError";
}

// set と remove に出さない列。鍵は書き込みの key に、エンティティの版は条件つきの書き込みの照らしと引き上げに回す
const NOT_UPDATED = new Set(["pk", "sk", "version"]);

function isVersion(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

export function rowCodec<L, P>(spec: {
  latest: { version: number; schema: z.ZodType<L> };
  previous?: { version: number; schema: z.ZodType<P>; upgrade: (row: P) => L; downgrade: (row: L) => P };
  writeVersion: number;
  keyOf: (row: L) => RowKey;
}): RowCodec<L> {
  const { latest, previous, writeVersion, keyOf } = spec;
  if (!isVersion(latest.version)) throw new RowCodecError(`latest.version は 1 以上の整数: ${latest.version}`);
  if (previous !== undefined) {
    if (previous.version !== latest.version - 1) throw new RowCodecError(`previous.version は latest.version - 1: ${previous.version}`);
    if (typeof previous.upgrade !== "function" || typeof previous.downgrade !== "function") throw new RowCodecError("previous は upgrade と downgrade を持つ");
  }
  if (writeVersion !== latest.version && writeVersion !== previous?.version) throw new RowCodecError(`writeVersion は latest.version か previous.version: ${writeVersion}`);
  return {
    latest,
    previous:
      previous === undefined
        ? null
        : {
            version: previous.version,
            schema: previous.schema,
            // 呼ぶのは previous.schema を通した値だけ
            upgrade: (row) => previous.upgrade(row as P),
            downgrade: (row) => previous.downgrade(row),
          },
    writeVersion,
    keyOf,
  };
}

// latest の版はそのまま、previous の版は upgrade で latest の形へそろえて返し、ほかの版を拒む。writeVersion によらず同じ結果を返す
export function readRow<L>(codec: RowCodec<L>, raw: unknown): ReadRowResult<L> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "shape_invalid" };
  const from = (raw as Record<string, unknown>)["schema_version"];
  if (typeof from !== "number" || !Number.isInteger(from)) return { ok: false, reason: "shape_invalid" };
  if (from === codec.latest.version) {
    const parsed = codec.latest.schema.safeParse(raw);
    return parsed.success ? { ok: true, row: parsed.data, from } : { ok: false, reason: "shape_invalid" };
  }
  const previous = codec.previous;
  if (previous === null || from !== previous.version) return { ok: false, reason: "version_unsupported" };
  const old = previous.schema.safeParse(raw);
  if (!old.success) return { ok: false, reason: "shape_invalid" };
  const upgraded = codec.latest.schema.safeParse(previous.upgrade(old.data));
  return upgraded.success ? { ok: true, row: upgraded.data, from } : { ok: false, reason: "shape_invalid" };
}

// writeVersion の形の行（schema_version と鍵の列を含む）を返す。writeVersion が previous.version なら downgrade を通す。
// 版の形を通らなければ投げる（書き手の誤り）
export function writeRow<L>(codec: RowCodec<L>, row: L): Record<string, unknown> {
  const key = codec.keyOf(row);
  const previous = codec.previous;
  const toPrevious = previous !== null && codec.writeVersion === previous.version;
  const body = toPrevious ? previous.downgrade(row) : row;
  const schema = toPrevious ? previous.schema : codec.latest.schema;
  const parsed = schema.safeParse(typeof body === "object" && body !== null ? { ...body, schema_version: codec.writeVersion } : body);
  if (!parsed.success) throw new RowCodecError(`行が版 ${codec.writeVersion} の形を通らない: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  return { ...(parsed.data as Record<string, unknown>), pk: key.pk, ...(key.sk === null ? {} : { sk: key.sk }) };
}

// 読んだ行（raw）を row へ書き換える更新の set と remove を作る。set は writeRow の戻り値から pk・sk・version を外したもの（schema_version を含む）。
// remove は raw の列のうち writeRow の戻り値に無く、pk・sk・version でもない列（別の版で消した列。索引の鍵なら書き込みで索引から外れる）
export function rowUpdateOf<L>(codec: RowCodec<L>, raw: Readonly<Record<string, unknown>>, row: L): RowUpdate {
  const written = writeRow(codec, row);
  const set = Object.fromEntries(Object.entries(written).filter(([column]) => !NOT_UPDATED.has(column)));
  const remove = Object.keys(raw).filter((column) => !(column in written) && !NOT_UPDATED.has(column));
  return { set, remove };
}
