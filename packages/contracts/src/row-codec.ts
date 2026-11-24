import { createHash } from "node:crypto";
import { z } from "zod";
import type { RowKey } from "./rows/common.ts";

// 行の版の読み手と書き手（issues/issue-2-design-detail.md の「表の移し」、決定 9）。
// 読み手が受ける版（latest と previous の 2 つ）と、書き手が出す版（writeVersion）を分けて持つ。読み手はどちらの版も latest の形へそろえ、
// 書き手は writeVersion の形で書く。次の版を読めるが前の版だけを書く 1 段目と、2 段目の後に書き手だけを戻した状態が、同じ値で表せる。
// 書き換えは読んだ行から作った行全体の置き換えで、rowReplaceOf がその行を作る（issues/issue-2-design-row-writers.md の決定 1・8）

export type PreviousVersion<L> = {
  readonly version: number;
  readonly schema: z.ZodType;
  // 前の版の形（schema を通した値）を latest の形へ上げる
  upgrade(row: unknown): L;
  // latest の形を前の版の形へ下げる
  downgrade(row: L): unknown;
};

// 保存の形がその版の形を通らない行を、通る行へ直す関数。直せない行は null を返す。直した行は schema_version を持ち、その版の形で読む
export type RowRepair = (raw: Readonly<Record<string, unknown>>) => Record<string, unknown> | null;

// 次の版だけの値を、前の版で表せる値へ狭める関数（版を上げる子の手順の 4a で足す）。latest の形を受けて latest の形を返す
// メソッドの形で書き、引数を双変にする（行の種類を問わない AnyRowCodec へ入れるため。keyOf と同じ）
export type RowNarrow<L> = { narrow(row: L): L }["narrow"];

export type RowCodec<L> = {
  readonly latest: { readonly version: number; readonly schema: z.ZodType<L> };
  readonly previous: PreviousVersion<L> | null;
  // 形を通らない行だけに当てる直し（版を上げる子の手順の 2c と、U3b の旧形式の補い repairIdentity）。無ければ null
  readonly repair: RowRepair | null;
  // 読み手が latest の形へそろえた後に通す狭め（手順の 4a）。無ければ null。あれば downgradable は true
  readonly narrow: RowNarrow<L> | null;
  readonly writeVersion: number;
  // 書き手を前の版へ戻せる間（版を上げる子の手順の 1 から 4 の前まで）は true。true の間、writeRow は writeVersion によらず、
  // 前の版へ下げて失う値を書かずに投げる。previous が無ければ false
  readonly downgradable: boolean;
  // 鍵の列は行の列から組む写しで、keyOf だけが組む（Value 13）
  keyOf(row: L): RowKey;
};

// 行の種類を問わない RowCodec（表の仕様と表の移しが持つ）
export type AnyRowCodec = RowCodec<Record<string, unknown>>;

// 保存してあった列の値そのもの。列が無ければ absent、形を外れた値もそのまま value に載せる
export type Stored = { readonly kind: "absent" } | { readonly kind: "value"; readonly value: unknown };

// 読んだ行に保存してあった schema_version・version・incarnation。書き手と表の移しは条件にこの値を、書く値に readRow の row を使う
export type StoredIdentity = { readonly schema_version: Stored; readonly version: Stored; readonly incarnation: Stored };

// from は読んだ行（repair で直したときは直した行）の schema_version
export type ReadRowResult<L> =
  | { readonly ok: true; readonly row: L; readonly from: number; readonly stored: StoredIdentity }
  | { readonly ok: false; readonly reason: "version_unsupported" | "shape_invalid" };

// 例外の理由の符号。message は Zod の issue.path（z.record の検証に外れた鍵の値を含みうる）を載せるため、
// ログ（表の移しの migrate_refused）には message でなくこの符号を載せる
export type RowCodecErrorCode =
  | "codec_invalid" // rowCodec の引数の誤り
  | "shared_buffer" // 共有バッファを持つ値で、独立した写しを作れない
  | "row_invalid" // writeRow に渡した行が latest の形を通らない
  | "downgrade_invalid" // downgrade の結果が前の版の形を通らない
  | "previous_shape_invalid" // rowReplaceOf が読んだ前の版の行が前の版の形を通らず、repair でも直らない
  | "value_lost" // 版の変換（upgrade か downgrade）で値が失われる
  | "key_mismatch"; // 書き換え後の鍵が読んだ行の鍵と違う

export class RowCodecError extends Error {
  override name = "RowCodecError";
  readonly code: RowCodecErrorCode;
  constructor(code: RowCodecErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// rowReplaceOf の戻り値に出さない列。どちらも条件つきの書き込みの部品が入れる（version は 1 上げた値、incarnation は読み手の見る形の値）
const SET_BY_WRITER = new Set(["version", "incarnation"]);

function isVersion(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

// 版の形は z.object で、schema_version の列が version だけのリテラルであること（食い違うと writeRow が投げるか、readRow が読めない行を出す）
function assertSchemaVersion(which: string, schema: z.ZodType, version: number): void {
  const column = schema instanceof z.ZodObject ? (schema.shape as Record<string, unknown>)["schema_version"] : undefined;
  const values = column instanceof z.ZodLiteral ? [...column.values] : null;
  if (values === null || values.length !== 1 || values[0] !== version) throw new RowCodecError("codec_invalid", `${which}.schema の schema_version は z.literal(${version})`);
}

export function rowCodec<L, P>(spec: {
  latest: { version: number; schema: z.ZodType<L> };
  previous?: { version: number; schema: z.ZodType<P>; upgrade: (row: P) => L; downgrade: (row: L) => P };
  writeVersion: number;
  // 既定は true（previous があるとき）。false にするのは、次の版だけの列を使う機能を出す反映（版を上げる子の手順の 4）から
  downgradable?: boolean;
  // 形を通らない行だけに当てる直し。省けば直さない
  repair?: RowRepair;
  // 次の版だけの値を狭める読み手の直し（手順の 4a から）。writeVersion はどちらの版でもよい（3b で writeVersion だけを前の版へ戻し、narrow は残す）
  narrow?: (row: L) => L;
  keyOf: (row: L) => RowKey;
}): RowCodec<L> {
  const { latest, previous, writeVersion, keyOf } = spec;
  if (spec.repair !== undefined && typeof spec.repair !== "function") throw new RowCodecError("codec_invalid", "repair は関数");
  if (spec.narrow !== undefined && typeof spec.narrow !== "function") throw new RowCodecError("codec_invalid", "narrow は関数");
  const downgradable = previous !== undefined && spec.downgradable !== false;
  // 狭めた値が前の版で表せることを writeRow に確かめさせるため（downgradable の間だけ writeRow が下げて上げ直す）
  if (spec.narrow !== undefined && !downgradable) throw new RowCodecError("codec_invalid", "narrow があれば downgradable は true（previous が要る）");
  if (!isVersion(latest.version)) throw new RowCodecError("codec_invalid", `latest.version は 1 以上の整数: ${latest.version}`);
  assertSchemaVersion("latest", latest.schema, latest.version);
  if (previous !== undefined) {
    if (!isVersion(previous.version)) throw new RowCodecError("codec_invalid", `previous.version は 1 以上の整数: ${previous.version}`);
    if (previous.version !== latest.version - 1) throw new RowCodecError("codec_invalid", `previous.version は latest.version - 1: ${previous.version}`);
    if (typeof previous.upgrade !== "function" || typeof previous.downgrade !== "function") throw new RowCodecError("codec_invalid", "previous は upgrade と downgrade を持つ");
    assertSchemaVersion("previous", previous.schema, previous.version);
  }
  if (writeVersion !== latest.version && writeVersion !== previous?.version) throw new RowCodecError("codec_invalid", `writeVersion は latest.version か previous.version: ${writeVersion}`);
  if (previous !== undefined && !downgradable && writeVersion === previous.version) throw new RowCodecError("codec_invalid", "downgradable が false なら writeVersion は latest.version");
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
    repair: spec.repair ?? null,
    narrow: spec.narrow ?? null,
    writeVersion,
    downgradable,
    keyOf,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function withSchemaVersion(body: unknown, version: number): unknown {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? { ...body, schema_version: version } : body;
}

function issuePaths(error: z.ZodError): string {
  return error.issues.map((i) => i.path.join(".")).join(", ");
}

function bytesOf(v: object): Uint8Array | null {
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer)) return new Uint8Array(v);
  return null;
}

// 値が undefined の列は無い列と同じに見る（writeRow は undefined の列を書かない）。
// DynamoDB の集合（文字列・数・バイナリの集合）は Set で表すため、Set は要素まで比べる（Object.entries は Set の中身を並べない）。
// 表の移しが書く行と保存の行を比べるときも同じ比べを使う
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
    const covers = (x: Set<unknown>, y: Set<unknown>) => [...x].every((v) => y.has(v) || [...y].some((w) => sameValue(v, w)));
    return covers(a, b) && covers(b, a);
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
    return [...a].every(([k, v]) => b.has(k) && sameValue(v, b.get(k)));
  }
  // バイナリ（型付きの配列・DataView と ArrayBuffer 本体。DynamoDB SDK はどちらもバイナリとして書く）は中身のバイトまで比べる
  const ba = bytesOf(a);
  const bb = bytesOf(b);
  if (ba !== null || bb !== null) {
    if (ba === null || bb === null || ba.byteLength !== bb.byteLength) return false;
    return ba.every((v, i) => v === bb[i]);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameValue(v, b[i]));
  }
  const entries = (o: object) => Object.entries(o).filter(([, v]) => v !== undefined);
  const ea = entries(a);
  const eb = new Map(entries(b));
  return ea.length === eb.size && ea.every(([k, v]) => eb.has(k) && sameValue(v, eb.get(k)));
}

function isShared(v: unknown): boolean {
  return typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer;
}

// 値のどこかに SharedArrayBuffer（それを裏に持つ型付きの配列・DataView を含む）があれば true を返す。
// structuredClone は共有バッファを写さず同じバイトを指したまま渡すため、写しの独立を保てない
function holdsSharedBuffer(value: unknown, seen: Set<object> = new Set()): boolean {
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  if (isShared(value)) return true;
  if (ArrayBuffer.isView(value)) return isShared(value.buffer);
  if (value instanceof ArrayBuffer) return false;
  if (value instanceof Set) return [...value].some((v) => holdsSharedBuffer(v, seen));
  if (value instanceof Map) return [...value].some(([k, v]) => holdsSharedBuffer(k, seen) || holdsSharedBuffer(v, seen));
  return Object.values(value).some((v) => holdsSharedBuffer(v, seen));
}

// downgrade と upgrade は引数をその場で書き換えうるため、どちらにも独立した写しを渡す（比べる元の行と、書く前の版の値を変えさせない）。
// 共有バッファを持つ値は写しが元とバイトを共有するため、写さずに投げる（DynamoDB の SDK は共有バッファを返さず、表の行に現れない）。
// readRow はこの例外を shape_invalid として返し、writeRow と rowReplaceOf はそのまま投げる
function copyOf<T>(value: T): T {
  if (holdsSharedBuffer(value)) throw new RowCodecError("shared_buffer", "共有バッファ（SharedArrayBuffer）を持つ行は扱わない");
  return structuredClone(value);
}

// 前の版の形の行（previous.schema を通した値）を返す。downgrade には latest の形の写しを渡す
function downgradeOf<L>(previous: PreviousVersion<L>, latestRow: L): Record<string, unknown> {
  const parsed = previous.schema.safeParse(withSchemaVersion(previous.downgrade(copyOf(latestRow)), previous.version));
  if (!parsed.success) throw new RowCodecError("downgrade_invalid", `行が版 ${previous.version} の形を通らない: ${issuePaths(parsed.error)}`);
  return parsed.data as Record<string, unknown>;
}

// 書き手を前の版へ戻せる間（downgradable）は、下げた行を上げ直して元の行（latest の形）に戻ることを確かめ、戻らなければ投げる。
// 次の版にだけ持てる値を書くと、書き手を前の版へ戻した後の書き換えでその値が行から消える（rowReplaceOf の行全体に次の版だけの列が無い）か、
// その行の書き換えをここが拒む。そのため writeVersion が次の版でも、書き込みの前にここで止める（版を上げる子の手順の 2）
function assertLosslessDowngrade<L>(codec: RowCodec<L>, previous: PreviousVersion<L>, latestRow: L, downgraded: Record<string, unknown>): void {
  let back: unknown;
  try {
    back = codec.latest.schema.safeParse(previous.upgrade(copyOf(downgraded)));
  } catch {
    back = null;
  }
  const restored = back as { success?: boolean; data?: unknown } | null;
  if (restored?.success !== true || !sameValue(restored.data, latestRow)) throw new RowCodecError("value_lost", `版 ${previous.version} へ下げると版 ${codec.latest.version} の値が失われる`);
}

// 書き手を前の版へ戻せる間（downgradable）は、読んだ前の版の行を上げて下げ直すと元の行に戻ることを確かめ、戻らなければ投げる。
// upgrade で失う値（latest の版で消した、downgrade が latest の値から作り直せない列）は、移し（次の版で書く）では行全体の置き換えで消え、
// 通常の書き換え（前の版で書く）では downgrade の作り直した値で上書きされ、書き手を戻しても元へ戻らない。
// そうした列の削除は downgradable を false にする反映（版を上げる子の手順の 4）まで延ばす
function assertLosslessUpgrade<L>(codec: RowCodec<L>, previous: PreviousVersion<L>, raw: Readonly<Record<string, unknown>>): void {
  const old = previous.schema.safeParse(raw);
  if (!old.success) throw new RowCodecError("previous_shape_invalid", `読んだ行が版 ${previous.version} の形を通らない: ${issuePaths(old.error)}`);
  let back: unknown = null;
  try {
    const upgraded = codec.latest.schema.safeParse(previous.upgrade(copyOf(old.data)));
    if (upgraded.success) back = downgradeOf(previous, upgraded.data);
  } catch {
    back = null;
  }
  if (back === null || !sameValue(back, old.data)) throw new RowCodecError("value_lost", `版 ${previous.version} の行を版 ${codec.latest.version} へ上げると値が失われる`);
}

// 保存の形（raw の schema_version の版の形）で読んだ結果。previous は前の版の形で読んだか
type StoredParse = { readonly ok: true; readonly data: unknown; readonly from: number; readonly previous: boolean } | { readonly ok: false; readonly reason: "version_unsupported" | "shape_invalid" };

function parseStored<L>(codec: RowCodec<L>, raw: Readonly<Record<string, unknown>>): StoredParse {
  const from = raw["schema_version"];
  if (typeof from !== "number" || !Number.isInteger(from)) return { ok: false, reason: "shape_invalid" };
  if (from === codec.latest.version) {
    const parsed = codec.latest.schema.safeParse(raw);
    return parsed.success ? { ok: true, data: parsed.data, from, previous: false } : { ok: false, reason: "shape_invalid" };
  }
  const previous = codec.previous;
  if (previous === null || from !== previous.version) return { ok: false, reason: "version_unsupported" };
  const parsed = previous.schema.safeParse(raw);
  return parsed.success ? { ok: true, data: parsed.data, from, previous: true } : { ok: false, reason: "shape_invalid" };
}

// 読み手の見る保存の形の行。raw がその版の形を通ればそのまま、通らず repair があれば直した行（直せなければ raw）を返す。
// repair には写しを渡す（その場で変えても raw を変えさせない）。repair が投げた行・行でない値を返した行は直せなかったものとする。
// 受けない版の行（version_unsupported）には repair を当てない
function seenStored<L>(codec: RowCodec<L>, raw: Readonly<Record<string, unknown>>): { readonly parsed: StoredParse; readonly row: Readonly<Record<string, unknown>> } {
  const first = parseStored(codec, raw);
  if (first.ok || first.reason !== "shape_invalid" || codec.repair === null) return { parsed: first, row: raw };
  let fixed: unknown;
  try {
    fixed = codec.repair(copyOf(raw));
  } catch {
    fixed = null;
  }
  if (!isRecord(fixed)) return { parsed: first, row: raw };
  return { parsed: parseStored(codec, fixed), row: fixed };
}

function storedColumn(raw: Readonly<Record<string, unknown>>, column: string): Stored {
  return Object.hasOwn(raw, column) && raw[column] !== undefined ? { kind: "value", value: raw[column] } : { kind: "absent" };
}

function storedOf(raw: Readonly<Record<string, unknown>>): StoredIdentity {
  return { schema_version: storedColumn(raw, "schema_version"), version: storedColumn(raw, "version"), incarnation: storedColumn(raw, "incarnation") };
}

// 処理の順: (1) raw の schema_version の版の形で読む (2) 通らず repair があれば、直した行を (1) と同じく読む (3) 前の版なら upgrade で今の形にする
// (4) narrow があれば通し、latest の形で照らす。ほかの版を拒む。writeVersion によらず同じ結果を返す。stored は raw に保存してあった値（repair の前の値）。
// upgrade か narrow が投げたときは、行を latest の形へそろえられなかったものとして shape_invalid を返す（読み手は投げない）
export function readRow<L>(codec: RowCodec<L>, raw: unknown): ReadRowResult<L> {
  if (!isRecord(raw)) return { ok: false, reason: "shape_invalid" };
  const { parsed } = seenStored(codec, raw);
  if (!parsed.ok) return parsed;
  const stored = storedOf(raw);
  const previous = codec.previous;
  const narrow = codec.narrow;
  if ((!parsed.previous || previous === null) && narrow === null) return { ok: true, row: parsed.data as L, from: parsed.from, stored };
  let row: L;
  try {
    // 写しを渡す。z.looseObject の下の Set などは raw と同じ物を指すため、upgrade と narrow がその場で変えると、呼び出し元が rowReplaceOf に渡す raw まで変わる
    const latestRow = parsed.previous && previous !== null ? previous.upgrade(copyOf(parsed.data)) : copyOf(parsed.data as L);
    row = narrow === null ? latestRow : narrow(copyOf(latestRow));
  } catch {
    return { ok: false, reason: "shape_invalid" };
  }
  const checked = codec.latest.schema.safeParse(row);
  return checked.success ? { ok: true, row: checked.data, from: parsed.from, stored } : { ok: false, reason: "shape_invalid" };
}

// writeVersion の形の行（schema_version と鍵の列を含む）を返す。writeVersion が previous.version なら downgrade を通す。
// downgradable なら writeVersion によらず、前の版へ下げて失う値を書かずに投げる。
// 値が undefined の列は出さない（DynamoDB へ書く値に undefined を残さない）。版の形を通らなければ投げる（書き手の誤り）
export function writeRow<L>(codec: RowCodec<L>, row: L): Record<string, unknown> {
  const key = codec.keyOf(row);
  const parsed = codec.latest.schema.safeParse(withSchemaVersion(copyOf(row), codec.latest.version));
  if (!parsed.success) throw new RowCodecError("row_invalid", `行が版 ${codec.latest.version} の形を通らない: ${issuePaths(parsed.error)}`);
  const latestRow = parsed.data;
  const previous = codec.previous;
  const toPrevious = previous !== null && codec.writeVersion === previous.version;
  const downgraded = previous !== null && (toPrevious || codec.downgradable) ? downgradeOf(previous, latestRow) : null;
  if (previous !== null && downgraded !== null && codec.downgradable) assertLosslessDowngrade(codec, previous, latestRow, downgraded);
  const body = toPrevious && downgraded !== null ? downgraded : (latestRow as Record<string, unknown>);
  const columns = Object.entries(body).filter(([, value]) => value !== undefined);
  return { ...Object.fromEntries(columns), pk: key.pk, ...(key.sk === null ? {} : { sk: key.sk }) };
}

// 読んだ行（raw）を row へ書き換える行全体を作る。戻り値は writeRow の戻り値（pk・sk・schema_version を含む）から version と incarnation を外したもの
// （2 つは条件つきの書き込みの部品が入れる）。raw にあって書き手の行に無い列（別の版で消した列・undefined にした任意の列・知らない列）は戻り値に無く、
// 行全体の置き換えで消える（索引の鍵なら索引から外れる）。
// downgradable の間に、読み手の見る前の版の行（raw が前の版の形を通ればその行、通らず repair が直せば直した行）を上げて下げ直すと元の行に戻らなければ投げる
// （移しと通常の書き換えのどちらでも、upgrade で失う値を消さない）。前の版の形を通らず repair でも直らない raw で投げる（previous_shape_invalid）。
// 書き換え後の鍵（keyOf）が読んだ行の鍵と違えば投げる。鍵は書き込みの key に読んだ行のものを使うため、違う鍵の列から組んだ中身を古い鍵の行へ書かない
// （たとえば席の user_id を変えると、旧利用者の SEAT#… に新利用者の user_id が載り、主キーと索引で引く所属が食い違う）
export function rowReplaceOf<L>(codec: RowCodec<L>, raw: Readonly<Record<string, unknown>>, row: L): Record<string, unknown> {
  if (holdsSharedBuffer(raw)) throw new RowCodecError("shared_buffer", "共有バッファ（SharedArrayBuffer）を持つ行は扱わない");
  const previous = codec.previous;
  if (previous !== null && codec.downgradable) {
    const seen = seenStored(codec, raw).row;
    if (seen["schema_version"] === previous.version) assertLosslessUpgrade(codec, previous, seen);
  }
  const written = writeRow(codec, row);
  const rawSk = Object.hasOwn(raw, "sk") ? raw["sk"] : undefined;
  // 鍵の値はログインの組の IdP の主体や利用者の ID を含むため、例外には違った列の名前だけを載せる
  const mismatched = [raw["pk"] !== written["pk"] ? "pk" : null, rawSk !== written["sk"] ? "sk" : null].filter((c) => c !== null);
  if (mismatched.length > 0) throw new RowCodecError("key_mismatch", `書き換え後の鍵が読んだ行の鍵と違う: ${mismatched.join(", ")}`);
  return Object.fromEntries(Object.entries(written).filter(([column]) => !SET_BY_WRITER.has(column)));
}

// 旧形式の補いで、鍵から決まる incarnation の値。区切りと並びの鍵の SHA-256 の頭の 16 バイトを、UUID の形（RFC 9562 の版 8・変種 10）にする。
// 同じ鍵なら読むたびに同じ値になり、putIfAbsent が入れる UUID v4 と版の桁で分かれる
function incarnationOfKey(pk: string, sk: string | null): string {
  const bytes = createHash("sha256").update(JSON.stringify(["nd-factory/incarnation", pk, sk])).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// 旧形式の補い（U3b、issues/issue-2-design-row-writers.md の決定 8）。U3b より前の書き手が保存した行を読めるよう、
// 列が無いときだけ incarnation を鍵から決まる値で、opts.version なら version を 1 で補う repair を返す。ほかの列は変えない。
// 補った値は保存されておらず、readRow の stored はその列を absent で返す（書き手の条件は列が無いことになる）。
// 鍵の列（pk が文字・sk が文字か無い）を持たない行には incarnation を補わない（形の検査で shape_invalid になる）
export function repairIdentity(opts: { version: boolean }): (raw: Readonly<Record<string, unknown>>) => Record<string, unknown> {
  return (raw) => {
    const out: Record<string, unknown> = { ...raw };
    const pk = raw["pk"];
    const sk = Object.hasOwn(raw, "sk") ? raw["sk"] : undefined;
    if (storedColumn(raw, "incarnation").kind === "absent" && typeof pk === "string" && (sk === undefined || typeof sk === "string")) {
      out["incarnation"] = incarnationOfKey(pk, sk ?? null);
    }
    if (opts.version && storedColumn(raw, "version").kind === "absent") out["version"] = 1;
    return out;
  };
}
