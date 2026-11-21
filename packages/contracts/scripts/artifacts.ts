import { createHash } from "node:crypto";
import { type Faker, faker } from "@faker-js/faker";
import { z } from "zod";
import { createDocument } from "zod-openapi";
import { fake, seed, setFaker } from "zod-schema-faker/v4";
import type { DummyDoc } from "../src/client.ts";
import { SECRET_SHAPES } from "../src/data.ts";
import { PREFIX_SHAPE } from "../src/settings.ts";
import { isPending, itemReasonsOf, MAX_ITEMS, type OperationDef, resultSchemaOf, type Shape } from "../src/operation.ts";
import { ITEM_REASONS, type ReasonDef, REQUEST_REASONS } from "../src/reasons.ts";
import { AWS_ACCOUNT_ID, itemsArray } from "../src/values.ts";

// 操作の表から生成物を組む（設計の「生成物」の表）。どの関数も値を返すだけで、書くのは generate.ts

export type JsonSchema = Record<string, unknown>;
export type JsonSchemaDoc = { $schema: string; $defs: Record<string, JsonSchema> };
export type OpenApiDoc = ReturnType<typeof createDocument>;
export type McpToolDoc = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  annotations: { readOnlyHint: boolean; idempotentHint: boolean; destructiveHint: boolean };
};
export type RouteDoc = { method: "POST"; path: string; operation: string; endpoint: OperationDef["endpoint"] };
export type ReasonPair = { code: string; status: number };
export type ReasonsDoc = { request: ReasonPair[]; item: ReasonPair[]; operations: Record<string, ReasonPair[]> };
export type PendingDoc = { operation: string; owner: string };
export type ExampleScene = "normal" | "edge" | "empty";
export type ExampleProblem = { operation: string; scene: ExampleScene; index: number; problem: string };
export type Examples = { normal: unknown[]; edge: unknown[] };
export type ExampleSet = Examples & { empty: unknown };

const JSON_SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema";
const DESTRUCTIVE_VERBS = new Set(["delete", "remove", "cancel", "revoke"]);
const NORMAL_COUNT = 3;
// 作り物の値（AGENTS.md）。見本の 12 桁の数とメールの域名はこれだけを許す
const FAKE_ACCOUNT_ID = "123456789012";
const FAKE_MAIL_DOMAIN = "example.com";
const FAKE_MAIL = `ops@${FAKE_MAIL_DOMAIN}`;
const FAKE_PREFIX = "acme";
// 境目の見本の文字列の元の長さの下限。形に上限がある文字列は、その上限まで伸ばしてから切り詰める
const EDGE_TEXT_LENGTH = 1024;

// 要求全体の誤りの本文（RFC 9457 の形。title・detail を持たず、拡張の reason に理由のコードを置く）
const problemBody = z.strictObject({
  type: z.literal("about:blank"),
  status: z.int(),
  reason: z.enum(REQUEST_REASONS.map((r) => r.code) as [string, ...string[]]),
});

function shapeSchema(shape: Shape): z.ZodType {
  return isPending(shape) ? shape.schema : shape;
}

function resultShapeSchema(op: OperationDef): z.ZodType {
  return isPending(op.result) ? op.result.schema : resultSchemaOf(op);
}

// 要素は受け取る値の形（入力のモード）、結果は返す値の形（出力のモード）で出す。zod-openapi も要求を入力、応答を出力で出すため、
// z.object の要素は追加の項目を受け、strictObject だけが拒む（Zod と同じ合否）
function toSchema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io }) as JsonSchema;
  return rest;
}

function maxItemsOf(op: OperationDef): number {
  return op.allOrNothing?.maxItems ?? MAX_ITEMS;
}

function pair(r: ReasonDef): ReasonPair {
  return { code: r.code, status: r.status };
}

// 操作ごとの要素と結果の JSON Schema。形の未定は z.never() の {"not": {}}
export function buildOperationSchemas(ops: readonly OperationDef[]): JsonSchemaDoc {
  const defs: Record<string, JsonSchema> = {};
  for (const op of ops) {
    defs[`${op.name}.item`] = toSchema(shapeSchema(op.item), "input");
    defs[`${op.name}.result`] = toSchema(resultShapeSchema(op), "output");
  }
  return { $schema: JSON_SCHEMA_DRAFT, $defs: defs };
}

// zod-openapi は判別の鍵つきの和に type: "object" と discriminator を足す。z.toJSONSchema の出力（operations.schema.json）と
// 同じ値にそろえるため、足した 2 つを外す（OpenAPI 3.1 は JSON Schema 2020-12 をそのまま受ける）
function sameAsJsonSchema(ctx: { zodSchema: z.core.$ZodType; jsonSchema: Record<string, unknown> }): void {
  const def = ctx.zodSchema._zod.def;
  if (def.type !== "union" || !("discriminator" in def)) return;
  delete ctx.jsonSchema.type;
  delete ctx.jsonSchema.discriminator;
}

// 受け口 user の操作の OpenAPI 3.1.1。要素と結果の形は .meta({ id }) の名前で components.schemas に出る
export function buildOpenApi(ops: readonly OperationDef[]): OpenApiDoc {
  const problem = problemBody.meta({ id: "problem" });
  const paths: Record<string, unknown> = {};
  for (const op of ops) {
    if (op.endpoint !== "user") continue;
    const item = shapeSchema(op.item).meta({ id: `${op.name}.item` });
    const result = resultShapeSchema(op).meta({ id: `${op.name}.result` });
    paths[op.route] = {
      post: {
        operationId: op.name,
        description: op.description_en,
        requestBody: { required: true, content: { "application/json": { schema: itemsArray(item, maxItemsOf(op)) } } },
        responses: {
          200: { description: "results per item", content: { "application/json": { schema: z.array(result) } } },
          default: { description: "request error", content: { "application/problem+json": { schema: problem } } },
        },
      },
    };
  }
  return createDocument(
    {
      openapi: "3.1.1",
      info: { title: "nd-factory API", version: "1" },
      security: [{ bearer: [] }],
      paths: paths as Parameters<typeof createDocument>[0]["paths"],
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    },
    { override: sameAsJsonSchema },
  );
}

// 人だけでない利用者向けの操作の道具。入力は要素の形を持たず、出力は結果の配列の形
export function buildMcpTools(ops: readonly OperationDef[], schemas: JsonSchemaDoc): McpToolDoc[] {
  return ops
    .filter((op) => op.endpoint === "user" && op.humanOnly !== "always")
    .map((op) => ({
      name: op.name,
      description: op.description_en,
      inputSchema: {
        type: "object",
        properties: { items: { type: "array", minItems: 1, maxItems: maxItemsOf(op) } },
        required: ["items"],
      },
      outputSchema: { type: "array", items: schemas.$defs[`${op.name}.result`] ?? { not: {} } },
      annotations: {
        readOnlyHint: op.access === "read",
        idempotentHint: op.idempotencyKey,
        destructiveHint: DESTRUCTIVE_VERBS.has(op.verb),
      },
    }));
}

export function buildRoutes(ops: readonly OperationDef[]): RouteDoc[] {
  return ops.map((op) => ({ method: "POST", path: op.route, operation: op.name, endpoint: op.endpoint }));
}

export function buildReasons(ops: readonly OperationDef[]): ReasonsDoc {
  const operations: Record<string, ReasonPair[]> = {};
  for (const op of ops) operations[op.name] = itemReasonsOf(op).map(pair);
  return { request: REQUEST_REASONS.map(pair), item: ITEM_REASONS.map(pair), operations };
}

export function buildPending(ops: readonly OperationDef[]): PendingDoc[] {
  const out: PendingDoc[] = [];
  for (const op of ops) {
    const pending = [op.item, op.result].find(isPending);
    if (pending) out.push({ operation: op.name, owner: pending.owner });
  }
  return out;
}

function seedOf(name: string): number {
  return Number.parseInt(createHash("sha256").update(name).digest("hex").slice(0, 8), 16);
}

type Bounds = { min?: number; max?: number; multipleOf?: number };
type Side = "upper" | "lower";

// 倍数かの判定は Zod の multipleOf と同じにする（Zod は小数の倍数を桁をそろえて照らし、0.3 を 0.1 の倍数とみなす）
function isMultipleOf(value: number, step: number): boolean {
  return z.number().multipleOf(step).safeParse(value).success;
}

// 倍数の k 倍を 10 進で組む。step を「整数の仮数 × 10 の指数」に分け、k × 仮数を整数で掛けてから指数を付けて読む。
// toFixed は 100 桁までしか書けず 1e-101 の倍数をゼロに丸めるため使わない（指数の書き方なら桁数に上限が無い）
function multipleAt(k: number, step: number): number {
  const [mantissa = "0", exponent = "0"] = step.toExponential().split("e");
  const fraction = mantissa.split(".")[1] ?? "";
  const digits = BigInt(mantissa.replace(".", ""));
  if (!Number.isSafeInteger(k)) return k * step;
  return Number(`${(BigInt(k) * digits).toString()}e${Number(exponent) - fraction.length}`);
}

// 端の値。上の端は上限（無ければ下限）、下の端は下限（無ければ上限）に寄せる。multipleOf があり端そのものが倍数でなければ、
// 範囲の内側で端に最も近い倍数へ丸める。小数の倍数は除算と乗算の誤差（0.3 / 0.1 = 2.9999…・3 * 0.1 = 0.3000…04）が出るため、
// 端そのものを Zod と同じ判定で先に照らし、丸めた値は倍数を 10 進で組んでから照らす
export function edgeOf(opts: Bounds | undefined, side: Side, fallback: () => number): number {
  const lo = opts?.min !== undefined && Number.isFinite(opts.min) ? opts.min : undefined;
  const hi = opts?.max !== undefined && Number.isFinite(opts.max) ? opts.max : undefined;
  const end = side === "upper" ? (hi ?? lo) : (lo ?? hi);
  if (end === undefined) return fallback();
  const step = opts?.multipleOf;
  if (!step || isMultipleOf(end, step)) return end;
  const towardLower = end === hi;
  const at = (k: number) => multipleAt(k, step);
  const k = towardLower ? Math.floor(end / step) : Math.ceil(end / step);
  // 誤差で k が 1 つずれても拾えるよう、端に近い側から前後 1 つを照らす
  const near = towardLower ? [k + 1, k, k - 1] : [k - 1, k, k + 1];
  for (const c of near) {
    const v = at(c);
    if ((towardLower ? v <= end : v >= end) && isMultipleOf(v, step)) return v;
  }
  return at(k);
}

// 形の中の文字列の上限・下限の長さのうち最大のもの。境目の見本の文字列の元をこの長さにし、どの上限も満たせるようにする
function longestText(schema: z.core.$ZodType, seen = new Set<z.core.$ZodType>()): number {
  if (seen.has(schema)) return 0;
  seen.add(schema);
  let out = 0;
  const def = schema._zod.def as z.core.$ZodTypeDef & Record<string, unknown>;
  if (def.type === "string") {
    for (const c of (def.checks ?? []) as z.core.$ZodCheck[]) {
      const d = c._zod.def as { check: string; maximum?: number; minimum?: number; length?: number };
      for (const n of [d.maximum, d.minimum, d.length]) if (typeof n === "number" && Number.isFinite(n)) out = Math.max(out, n);
    }
  }
  for (const child of childrenOf(def)) out = Math.max(out, longestText(child, seen));
  return out;
}

function childrenOf(def: z.core.$ZodTypeDef & Record<string, unknown>): z.core.$ZodType[] {
  const out: z.core.$ZodType[] = [];
  const add = (v: unknown) => {
    if (v instanceof z.core.$ZodType) out.push(v);
    else if (Array.isArray(v)) for (const x of v) add(x);
  };
  if (def.type === "object") {
    for (const v of Object.values(def.shape as Record<string, unknown>)) add(v);
    add(def.catchall);
  } else if (def.type === "lazy") add((def.getter as () => unknown)());
  else for (const key of CHILD_KEYS) add(def[key]);
  return out;
}

// 中に形を持つ def のキー（object の shape と lazy の getter は別に読む）
const CHILD_KEYS = ["element", "innerType", "options", "left", "right", "items", "rest", "keyType", "valueType", "in", "out"] as const;

// 作り物の値だけを返す文字列の形。zod-schema-faker の custom は z.custom の形にしか効かず、メールの形は内部の randexp で作るため、
// 生成の前に形の木を写し、メール・アカウント ID・接頭辞の文字列をそれぞれの作り物の値の literal へ置き換える
function fakeValueOf(def: z.core.$ZodTypeDef & Record<string, unknown>): string | null {
  if (def.type !== "string") return null;
  const formats = new Set<string>();
  const patterns = new Set<string>();
  if (typeof def.format === "string") formats.add(def.format);
  for (const c of (def.checks ?? []) as z.core.$ZodCheck[]) {
    const d = c._zod.def as { check: string; format?: string; pattern?: RegExp };
    if (d.check !== "string_format") continue;
    if (d.format) formats.add(d.format);
    if (d.pattern) patterns.add(d.pattern.source);
  }
  if (formats.has("email")) return FAKE_MAIL;
  if (patterns.has(AWS_ACCOUNT_ID.source)) return FAKE_ACCOUNT_ID;
  if (patterns.has(PREFIX_SHAPE.source)) return FAKE_PREFIX;
  return null;
}

// 形が自分へ戻れるのは z.lazy と、shape に getter を持つ object だけである。この 2 つは子を写す前に写しを作って memo に入れ、
// 子は初めて読まれたときに写す。循環で戻ってきた枝も同じ写しを指すため、再帰の深い層まで作り物の値になる
export function withFakeValues(schema: z.core.$ZodType, memo = new Map<z.core.$ZodType, z.core.$ZodType>()): z.core.$ZodType {
  const known = memo.get(schema);
  if (known) return known;
  const def = schema._zod.def as z.core.$ZodTypeDef & Record<string, unknown>;
  const fakeValue = fakeValueOf(def);
  if (fakeValue !== null) {
    const literal = z.literal(fakeValue);
    memo.set(schema, literal);
    return literal;
  }
  const map = (v: unknown): unknown =>
    v instanceof z.core.$ZodType ? withFakeValues(v, memo) : Array.isArray(v) ? v.map(map) : v;
  const once = <T>(make: () => T): (() => T) => {
    let done = false;
    let value: T;
    return () => {
      if (!done) {
        value = make();
        done = true;
      }
      return value;
    };
  };
  const clone = (next: Record<string, unknown>) => (schema as z.ZodType).clone({ ...def, ...next } as z.core.$ZodTypeDef);
  if (def.type === "object") {
    const source = def.shape as Record<string, unknown>;
    const shape: Record<string, unknown> = {};
    for (const k of Object.keys(source)) {
      Object.defineProperty(shape, k, { get: once(() => map(source[k])), enumerable: true, configurable: true });
    }
    // catchall は自分を直に持てず（持つなら lazy か getter の object を挟み、それらはすぐ写しを返す）、先に写しても戻ってこない
    const copy = clone(def.catchall ? { shape, catchall: map(def.catchall) } : { shape });
    memo.set(schema, copy);
    return copy;
  }
  if (def.type === "lazy") {
    const getter = def.getter as () => z.core.$ZodType;
    const copy = clone({ getter: once(() => withFakeValues(getter(), memo)) });
    memo.set(schema, copy);
    return copy;
  }
  const next: Record<string, unknown> = {};
  let changed = false;
  for (const key of CHILD_KEYS) {
    if (!(key in def) || def[key] === undefined) continue;
    const value = def[key];
    const mapped = map(value);
    const same = Array.isArray(value) ? value.every((x, i) => x === (mapped as unknown[])[i]) : mapped === value;
    if (!same) changed = true;
    next[key] = mapped;
  }
  const out = changed ? clone(next) : schema;
  memo.set(schema, out);
  return out;
}

// 境目の見本の生成器。zod-schema-faker は組み込みの形の生成器を差し替える口を持たないため、
// 形の max・min を受け取る faker の関数（数・件数・文の長さ・有無）を、上の端か下の端へ寄せたものを渡す
function edgeFaker(base: Faker, side: Side, textLength: number): Faker {
  const number = Object.assign(Object.create(base.number) as Faker["number"], {
    int: (opts?: Bounds | number) => (typeof opts === "number" ? (side === "upper" ? opts : 0) : edgeOf(opts, side, () => base.number.int())),
    float: (opts?: Bounds | number) => (typeof opts === "number" ? (side === "upper" ? opts : 0) : edgeOf(opts, side, () => base.number.float())),
  });
  const helpers = Object.assign(Object.create(base.helpers) as Faker["helpers"], {
    multiple: <T>(fn: (v?: unknown, i?: number) => T, opts?: { count?: number | { min: number; max: number } }) => {
      const count = opts?.count;
      const n = typeof count === "number" ? count : side === "upper" ? (count?.max ?? 3) : (count?.min ?? 0);
      return Array.from({ length: n }, (_, i) => fn(undefined, i));
    },
  });
  // 下の端は空の文から始め、zod-schema-faker が下限の長さまで埋める
  const lorem = Object.assign(Object.create(base.lorem) as Faker["lorem"], {
    sentence: () => {
      if (side === "lower") return "";
      let text = base.lorem.sentence();
      while (text.length < textLength) text = `${text} ${base.lorem.sentence()}`;
      return text.slice(0, textLength);
    },
  });
  const datatype = Object.assign(Object.create(base.datatype) as Faker["datatype"], { boolean: () => side === "upper" });
  return Object.assign(Object.create(base) as Faker, { number, helpers, lorem, datatype });
}

// 結果の zod の形から見本を作る。種は操作の名前から決め、同じ版と同じ種で同じ値になる。
// 境目は上の端（文字列を上限の長さ・配列を上限の件数・数を上限）と下の端（下限）の 2 件
export function fakeExamples(op: OperationDef): Examples {
  if (isPending(op.result)) return { normal: [], edge: [] };
  const shape = withFakeValues(op.result);
  const s = seedOf(op.name);
  const textLength = Math.max(EDGE_TEXT_LENGTH, longestText(shape));
  try {
    setFaker(faker);
    seed(s);
    const normal = Array.from({ length: NORMAL_COUNT }, () => fake(shape));
    const edge = (["upper", "lower"] as const).map((side) => {
      setFaker(edgeFaker(faker, side, textLength));
      seed(s);
      return fake(shape);
    });
    return { normal, edge };
  } finally {
    setFaker(faker);
  }
}

const NOT_FOUND = { ok: false, status: 404, reason: "not_found" } as const;

// 空の場面の結果。examples.empty を書いた操作は動詞によらずそれを使う。書かなければ list は空の一覧、get は 404、
// それ以外は null（空の場面が無い）。封筒が ok・items・next_cursor のほかに必須の項目を持つ list は examples.empty を必須にする
// （extraListKeysOf。書かなければ checkExamples が問題にする）
function emptyOf(op: OperationDef): unknown {
  if (op.examples && "empty" in op.examples) return op.examples.empty ?? null;
  if (op.verb === "get") return NOT_FOUND;
  if (op.verb !== "list") return null;
  return { ok: true, items: [], next_cursor: null };
}

const LIST_ENVELOPE_KEYS = new Set(["ok", "items", "next_cursor"]);

// 一覧の封筒が ok・items・next_cursor のほかに持つ必須の項目。空の一覧でのその値（件数・届いた番号など）は items と結びつきうる。
// 正常の見本から写すと items: [] と食い違い（total: 3 など）、しかも結果の形は通るため、生成で決めず examples.empty に書かせる
function extraListKeysOf(op: OperationDef): string[] {
  if (op.verb !== "list" || isPending(op.result)) return [];
  const shape: Record<string, z.core.$ZodType> = op.result.shape;
  return Object.entries(shape).filter(([k, v]) => !LIST_ENVELOPE_KEYS.has(k) && !z.safeParse(v, undefined).success).map(([k]) => k);
}

// 見本。examples を書いた場面はそれを、書かない場面は生成した値を使う
export function examplesOf(op: OperationDef): ExampleSet {
  const written = op.examples;
  const picked =
    written?.normal && written.edge
      ? { normal: written.normal, edge: written.edge }
      : (() => {
          const faked = fakeExamples(op);
          return { normal: written?.normal ?? faked.normal, edge: written?.edge ?? faked.edge };
        })();
  return { ...picked, empty: emptyOf(op) };
}

export function buildDummy(op: OperationDef): DummyDoc | null {
  if (isPending(op.result)) return null;
  const { normal, edge, empty } = examplesOf(op);
  const failures = itemReasonsOf(op).map((r) => ({ ok: false as const, status: r.status, reason: r.code }));
  return { operation: op.name, normal, empty, edge, failures };
}

// 照らす文字列と数。オブジェクトはキーも含める（z.record の見本のキーにメールや ID が入りうる）
function leaves(value: unknown, out: Array<string | number> = []): Array<string | number> {
  if (typeof value === "string" || typeof value === "number") out.push(value);
  else if (Array.isArray(value)) for (const v of value) leaves(v, out);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      leaves(v, out);
    }
  }
  return out;
}

const SECRET_PATTERNS = SECRET_SHAPES.valuePatterns.map((p) => ({ name: p.name, re: new RegExp(p.pattern, "u") }));
const TWELVE_DIGITS = /(?<!\d)\d{12}(?!\d)/g;
const MAIL = /[^\s@]*@([^\s@]*)/g;

// 診断は違反の種類だけを返し、当たった値を含めない（本物のアカウント ID やメールが CI のログに残らないようにする）
function leafProblems(leaf: string | number): string[] {
  const text = String(leaf);
  const out: string[] = [];
  if (typeof leaf === "string") {
    for (const p of SECRET_PATTERNS) if (p.re.test(text)) out.push(`秘密の形 ${p.name} に当たる値がある`);
    for (const m of text.matchAll(MAIL)) {
      if ((m[1] ?? "").toLowerCase() !== FAKE_MAIL_DOMAIN) out.push(`メールの域名が ${FAKE_MAIL_DOMAIN} でない`);
    }
  }
  for (const m of text.matchAll(TWELVE_DIGITS)) {
    if (m[0] !== FAKE_ACCOUNT_ID) out.push(`12 桁の数が ${FAKE_ACCOUNT_ID} でない`);
  }
  return out;
}

// 形に合わない理由は誤りの種類（Zod の issue の code）だけにする。prettifyError は値やレコードの鍵を含みうるため使わない
function shapeProblem(error: z.ZodError): string {
  const codes = [...new Set(error.issues.map((i) => i.code))];
  return `結果の形に合わない（${codes.join("・")}）`;
}

// 見本を結果の形・秘密の形・作り物の値の決まりで照らす。問題が 1 つでもあれば生成は書かない
export function checkExamples(ops: readonly OperationDef[]): ExampleProblem[] {
  const problems: ExampleProblem[] = [];
  for (const op of ops) {
    if (isPending(op.result)) continue;
    const schema = resultSchemaOf(op);
    const examples = examplesOf(op);
    const extra = extraListKeysOf(op);
    // 項目の名前は診断に載せない（キーもメールや ID でありうり、見本の照らしでは伏せる値を CI のログに残さない）
    if (extra.length > 0 && !(op.examples && "empty" in op.examples)) {
      problems.push({ operation: op.name, scene: "empty", index: 0, problem: `一覧の封筒が ok・items・next_cursor のほかに必須の項目を持つため、examples.empty を書く` });
    }
    const scenes: Array<[ExampleScene, unknown[]]> = [
      ["normal", examples.normal],
      ["edge", examples.edge],
      ["empty", examples.empty === null ? [] : [examples.empty]],
    ];
    for (const [scene, values] of scenes) {
      values.forEach((value, index) => {
        const add = (problem: string) => problems.push({ operation: op.name, scene, index, problem });
        const parsed = schema.safeParse(value);
        if (!parsed.success) add(shapeProblem(parsed.error));
        for (const leaf of leaves(value)) for (const p of leafProblems(leaf)) add(p);
      });
    }
  }
  return problems;
}
