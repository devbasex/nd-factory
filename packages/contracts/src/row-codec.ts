import { z } from "zod";
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

// 版の形は z.object で、schema_version の列が version だけのリテラルであること（食い違うと writeRow が投げるか、readRow が読めない行を出す）
function assertSchemaVersion(which: string, schema: z.ZodType, version: number): void {
  const column = schema instanceof z.ZodObject ? (schema.shape as Record<string, unknown>)["schema_version"] : undefined;
  const values = column instanceof z.ZodLiteral ? [...column.values] : null;
  if (values === null || values.length !== 1 || values[0] !== version) throw new RowCodecError(`${which}.schema の schema_version は z.literal(${version})`);
}

export function rowCodec<L, P>(spec: {
  latest: { version: number; schema: z.ZodType<L> };
  previous?: { version: number; schema: z.ZodType<P>; upgrade: (row: P) => L; downgrade: (row: L) => P };
  writeVersion: number;
  keyOf: (row: L) => RowKey;
}): RowCodec<L> {
  const { latest, previous, writeVersion, keyOf } = spec;
  if (!isVersion(latest.version)) throw new RowCodecError(`latest.version は 1 以上の整数: ${latest.version}`);
  assertSchemaVersion("latest", latest.schema, latest.version);
  if (previous !== undefined) {
    if (!isVersion(previous.version)) throw new RowCodecError(`previous.version は 1 以上の整数: ${previous.version}`);
    if (previous.version !== latest.version - 1) throw new RowCodecError(`previous.version は latest.version - 1: ${previous.version}`);
    if (typeof previous.upgrade !== "function" || typeof previous.downgrade !== "function") throw new RowCodecError("previous は upgrade と downgrade を持つ");
    assertSchemaVersion("previous", previous.schema, previous.version);
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

function withSchemaVersion(body: unknown, version: number): unknown {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? { ...body, schema_version: version } : body;
}

function issuePaths(error: z.ZodError): string {
  return error.issues.map((i) => i.path.join(".")).join(", ");
}

// 値が undefined の列は無い列と同じに見る（writeRow は undefined の列を書かない）
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameValue(v, b[i]));
  }
  const entries = (o: object) => Object.entries(o).filter(([, v]) => v !== undefined);
  const ea = entries(a);
  const eb = new Map(entries(b));
  return ea.length === eb.size && ea.every(([k, v]) => eb.has(k) && sameValue(v, eb.get(k)));
}

// 前の版で書くときは、下げた行を上げ直して元の行（latest の形）に戻ることを確かめ、戻らなければ投げる。
// 次の版にだけ持てる値を前の版で書くと、その値が行から消える（rowUpdateOf の remove が次の版だけの列を消す）。
// 書き手を前の版へ戻せる間は、次の版の値も前の版で表せる値だけを書く決まり（版を上げる子の手順）で、ここはその決まりが破られたときに書かずに止める
function assertLosslessDowngrade<L>(codec: RowCodec<L>, previous: PreviousVersion<L>, row: L, downgraded: unknown): void {
  const original = codec.latest.schema.safeParse(withSchemaVersion(row, codec.latest.version));
  if (!original.success) throw new RowCodecError(`行が版 ${codec.latest.version} の形を通らない: ${issuePaths(original.error)}`);
  let back: unknown;
  try {
    back = codec.latest.schema.safeParse(previous.upgrade(downgraded));
  } catch {
    back = null;
  }
  const restored = back as { success?: boolean; data?: unknown } | null;
  if (restored?.success !== true || !sameValue(restored.data, original.data)) throw new RowCodecError(`版 ${previous.version} へ下げると版 ${codec.latest.version} の値が失われる`);
}

// latest の版はそのまま、previous の版は upgrade で latest の形へそろえて返し、ほかの版を拒む。writeVersion によらず同じ結果を返す。
// upgrade が投げたときは、前の版の行を latest の形へそろえられなかったものとして shape_invalid を返す（読み手は投げない）
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
  let upgradedRow: L;
  try {
    upgradedRow = previous.upgrade(old.data);
  } catch {
    return { ok: false, reason: "shape_invalid" };
  }
  const upgraded = codec.latest.schema.safeParse(upgradedRow);
  return upgraded.success ? { ok: true, row: upgraded.data, from } : { ok: false, reason: "shape_invalid" };
}

// writeVersion の形の行（schema_version と鍵の列を含む）を返す。writeVersion が previous.version なら downgrade を通す。
// 値が undefined の列は出さない（DynamoDB へ書く値に undefined を残さない）。版の形を通らなければ投げる（書き手の誤り）
export function writeRow<L>(codec: RowCodec<L>, row: L): Record<string, unknown> {
  const key = codec.keyOf(row);
  const previous = codec.previous;
  const toPrevious = previous !== null && codec.writeVersion === previous.version;
  const body = toPrevious ? previous.downgrade(row) : row;
  const schema = toPrevious ? previous.schema : codec.latest.schema;
  const parsed = schema.safeParse(withSchemaVersion(body, codec.writeVersion));
  if (!parsed.success) throw new RowCodecError(`行が版 ${codec.writeVersion} の形を通らない: ${issuePaths(parsed.error)}`);
  if (toPrevious) assertLosslessDowngrade(codec, previous, row, parsed.data);
  const columns = Object.entries(parsed.data as Record<string, unknown>).filter(([, value]) => value !== undefined);
  return { ...Object.fromEntries(columns), pk: key.pk, ...(key.sk === null ? {} : { sk: key.sk }) };
}

// 読んだ行（raw）を row へ書き換える更新の set と remove を作る。set は writeRow の戻り値から pk・sk・version を外したもの（schema_version を含む）。
// remove は raw の列のうち writeRow の戻り値に無く、pk・sk・version でもない列（別の版で消した列と、undefined にした任意の列。索引の鍵なら書き込みで索引から外れる）。
// 列の有無は自身の列だけで見る（constructor などの継承した名前を列と取り違えない）
// 書き換え後の鍵（keyOf）が読んだ行の鍵と違えば投げる。鍵は書き込みの key に読んだ行のものを使うため、違う鍵の列から組んだ中身を古い鍵の行へ書かない
// （たとえば席の user_id を変えると、旧利用者の SEAT#… に新利用者の user_id が載り、主キーと索引で引く所属が食い違う）
export function rowUpdateOf<L>(codec: RowCodec<L>, raw: Readonly<Record<string, unknown>>, row: L): RowUpdate {
  const written = writeRow(codec, row);
  const rawSk = Object.hasOwn(raw, "sk") ? raw["sk"] : undefined;
  if (raw["pk"] !== written["pk"] || rawSk !== written["sk"]) throw new RowCodecError(`書き換え後の鍵が読んだ行の鍵と違う: ${String(raw["pk"])} / ${String(rawSk)} → ${String(written["pk"])} / ${String(written["sk"])}`);
  const set = Object.fromEntries(Object.entries(written).filter(([column]) => !NOT_UPDATED.has(column)));
  const remove = Object.keys(raw).filter((column) => !Object.hasOwn(written, column) && !NOT_UPDATED.has(column));
  return { set, remove };
}
