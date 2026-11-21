import { createHash } from "node:crypto";
import { type Faker, faker } from "@faker-js/faker";
import { z } from "zod";
import { createDocument } from "zod-openapi";
import { fake, seed, setFaker } from "zod-schema-faker/v4";
import type { DummyDoc } from "../src/client.ts";
import { SECRET_SHAPES } from "../src/data.ts";
import { isPending, itemReasonsOf, MAX_ITEMS, type OperationDef, resultSchemaOf, type Shape } from "../src/operation.ts";
import { ITEM_REASONS, type ReasonDef, REQUEST_REASONS } from "../src/reasons.ts";
import { itemsArray } from "../src/values.ts";

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
export type ExampleScene = "normal" | "edge";
export type ExampleProblem = { operation: string; scene: ExampleScene; index: number; problem: string };
export type Examples = { normal: unknown[]; edge: unknown[] };

const JSON_SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema";
const DESTRUCTIVE_VERBS = new Set(["delete", "remove", "cancel", "revoke"]);
const NORMAL_COUNT = 3;
// 作り物の値（AGENTS.md）。見本の 12 桁の数とメールの域名はこれだけを許す
const FAKE_ACCOUNT_ID = "123456789012";
const FAKE_MAIL_DOMAIN = "example.com";
// 境目の見本の文字列の元の長さ。形の上限で切り詰める
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

function toSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as JsonSchema;
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
    defs[`${op.name}.item`] = toSchema(shapeSchema(op.item));
    defs[`${op.name}.result`] = toSchema(resultShapeSchema(op));
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

// 端の値。上限があれば上限、無ければ下限に寄せる
function edgeOf(opts: Bounds | undefined, fallback: () => number): number {
  const end = opts?.max ?? opts?.min;
  if (end === undefined || !Number.isFinite(end)) return fallback();
  const step = opts?.multipleOf;
  return step ? Math.floor(end / step) * step : end;
}

// 境目の見本の生成器。zod-schema-faker は組み込みの形の生成器を差し替える口を持たないため、
// 形の max・min を受け取る faker の関数（数・件数・文の長さ・有無）を端へ寄せたものを渡す
function edgeFaker(base: Faker): Faker {
  const number = Object.assign(Object.create(base.number) as Faker["number"], {
    int: (opts?: Bounds | number) => (typeof opts === "number" ? opts : edgeOf(opts, () => base.number.int())),
    float: (opts?: Bounds | number) => (typeof opts === "number" ? opts : edgeOf(opts, () => base.number.float())),
  });
  const helpers = Object.assign(Object.create(base.helpers) as Faker["helpers"], {
    multiple: <T>(fn: (v?: unknown, i?: number) => T, opts?: { count?: number | { min: number; max: number } }) => {
      const count = opts?.count;
      const n = typeof count === "number" ? count : (count?.max ?? 3);
      return Array.from({ length: n }, (_, i) => fn(undefined, i));
    },
  });
  const lorem = Object.assign(Object.create(base.lorem) as Faker["lorem"], {
    sentence: () => {
      let text = base.lorem.sentence();
      while (text.length < EDGE_TEXT_LENGTH) text = `${text} ${base.lorem.sentence()}`;
      return text.slice(0, EDGE_TEXT_LENGTH);
    },
  });
  const datatype = Object.assign(Object.create(base.datatype) as Faker["datatype"], { boolean: () => true });
  return Object.assign(Object.create(base) as Faker, { number, helpers, lorem, datatype });
}

// 結果の zod の形から見本を作る。種は操作の名前から決め、同じ版と同じ種で同じ値になる
export function fakeExamples(op: OperationDef): Examples {
  if (isPending(op.result)) return { normal: [], edge: [] };
  const shape = op.result;
  const s = seedOf(op.name);
  setFaker(faker);
  seed(s);
  const normal = Array.from({ length: NORMAL_COUNT }, () => fake(shape));
  setFaker(edgeFaker(faker));
  try {
    seed(s);
    return { normal, edge: [fake(shape)] };
  } finally {
    setFaker(faker);
  }
}

// 見本。examples を書いた場面はそれを、書かない場面は生成した値を使う
export function examplesOf(op: OperationDef): Examples {
  const written = op.examples;
  if (written?.normal && written.edge) return { normal: written.normal, edge: written.edge };
  const faked = fakeExamples(op);
  return { normal: written?.normal ?? faked.normal, edge: written?.edge ?? faked.edge };
}

const NOT_FOUND = { ok: false, status: 404, reason: "not_found" } as const;

export function buildDummy(op: OperationDef): DummyDoc | null {
  if (isPending(op.result)) return null;
  const { normal, edge } = examplesOf(op);
  const empty = op.verb === "list" ? { ok: true, items: [], next_cursor: null } : op.verb === "get" ? NOT_FOUND : null;
  const failures = itemReasonsOf(op).map((r) => ({ ok: false as const, status: r.status, reason: r.code }));
  return { operation: op.name, normal, empty, edge, failures };
}

function leaves(value: unknown, out: Array<string | number> = []): Array<string | number> {
  if (typeof value === "string" || typeof value === "number") out.push(value);
  else if (Array.isArray(value)) for (const v of value) leaves(v, out);
  else if (value !== null && typeof value === "object") for (const v of Object.values(value)) leaves(v, out);
  return out;
}

const SECRET_PATTERNS = SECRET_SHAPES.valuePatterns.map((p) => ({ name: p.name, re: new RegExp(p.pattern, "u") }));
const TWELVE_DIGITS = /(?<!\d)\d{12}(?!\d)/g;
const MAIL = /[^\s@]*@([^\s@]*)/g;

function leafProblems(leaf: string | number): string[] {
  const text = String(leaf);
  const out: string[] = [];
  if (typeof leaf === "string") {
    for (const p of SECRET_PATTERNS) if (p.re.test(text)) out.push(`秘密の形 ${p.name} に当たる値がある`);
    for (const m of text.matchAll(MAIL)) {
      if ((m[1] ?? "").toLowerCase() !== FAKE_MAIL_DOMAIN) out.push(`メールの域名が ${FAKE_MAIL_DOMAIN} でない: ${m[0]}`);
    }
  }
  for (const m of text.matchAll(TWELVE_DIGITS)) {
    if (m[0] !== FAKE_ACCOUNT_ID) out.push(`12 桁の数が ${FAKE_ACCOUNT_ID} でない: ${m[0]}`);
  }
  return out;
}

// 見本を結果の形・秘密の形・作り物の値の決まりで照らす。問題が 1 つでもあれば生成は書かない
export function checkExamples(ops: readonly OperationDef[]): ExampleProblem[] {
  const problems: ExampleProblem[] = [];
  for (const op of ops) {
    if (isPending(op.result)) continue;
    const schema = resultSchemaOf(op);
    const examples = examplesOf(op);
    for (const scene of ["normal", "edge"] as const) {
      examples[scene].forEach((value, index) => {
        const add = (problem: string) => problems.push({ operation: op.name, scene, index, problem });
        const parsed = schema.safeParse(value);
        if (!parsed.success) add(`結果の形に合わない: ${z.prettifyError(parsed.error)}`);
        for (const leaf of leaves(value)) for (const p of leafProblems(leaf)) add(p);
      });
    }
  }
  return problems;
}
