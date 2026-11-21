import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { settingsSchema } from "@nd-factory/contracts/settings";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

// 形の正本の往復のテスト（#1 の決定 8。中身は issues/issue-1-design-detail.md の「形の正本の往復のテスト」）。
// 照らしの関数はどれも作り物の入力を渡せる純粋な関数にし、壊れが無ければ空の配列、あれば 1 件 1 文字列の当たりを返す。
// リポジトリの入力に打つテストと、1 か所を壊した作り物の入力で落ちることを確かめるテストを分ける
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 経路の登録（#2 の書き出し K2-3）。無い間は照らすこと 8 の比べを「相手が無い」で飛ばす */
const REGISTRY = "packages/contracts/generated/routes.json";
/** 操作の表の書き出し（#2 の K2-3）。無い間は照らすこと 1〜7 をリポジトリの表に打たない */
const OPERATIONS = "packages/contracts/src/operations/index.ts";
/** 設定のファイルの形の生成物と見本（packages/contracts/scripts/generate.ts が作る） */
const SETTINGS_SCHEMA = "packages/contracts/schema/settings.schema.json";
const SETTINGS_EXAMPLE = "infra/settings.example.json";
/** 合成の起点と、`npm run synth` と同じ作り物の設定 */
const SYNTH_ENTRY = "infra/bin/app.ts";
const SYNTH_SETTINGS = "infra/test/fixtures/settings.json";
// 合成の 1 回は手元で 2 秒ほど。CI の遅さを見込む
const SYNTH_TIMEOUT = 120_000;

type JsonSchema = { [key: string]: unknown };
type Part = "item" | "result";
type Form = "zod" | "json-schema" | "openapi" | "mcp";
type HumanOnly = "always" | "per_item" | "never";

/** 照らしが読む操作の定義の部分（#2 の `OperationDef` のうち照らしに要る項目。item と result は要素 1 つの形） */
type OperationView = {
  name: string;
  entity: string;
  endpoint: string;
  method: string;
  route: string;
  access: "read" | "write";
  humanOnly: HumanOnly;
  features: readonly string[];
  item: z.ZodType;
  result: z.ZodType;
  examples: Record<Part, unknown>;
};

/** 経路の登録の 1 行（#2 の `generated/routes.json` の形） */
type RouteEntry = { method: string; path: string; operation: string; endpoint: string };

type McpTool = { name: string; inputSchema: JsonSchema; outputSchema: JsonSchema };
type JsonBody = { content: { "application/json": { schema: JsonSchema } } };
type OpenApiOperation = { operationId: string; requestBody: JsonBody; responses: { "200": JsonBody } };

/** 照らしが読む生成物（JSON Schema・OpenAPI・MCP の道具の一覧・経路の登録） */
type GeneratedView = {
  jsonSchema: { $defs: Record<string, JsonSchema> };
  openapi: { paths: Record<string, Record<string, OpenApiOperation>>; components: { schemas: Record<string, JsonSchema> } };
  mcpTools: McpTool[];
  routes: RouteEntry[];
};

type Representation = { form: Form; part: Part; accepts: (value: unknown) => boolean };
type Mutation = { label: string; value: unknown };

/** 照らすこと 8 の除外の 1 行。外すのを終える課題の Pull Request で、要らなくなった行が落ちるので消す */
type RouteExclusion =
  | { kind: "legacy"; route: string; until: string; why: string }
  | { kind: "endpoint"; endpoint: string; until: string; why: string };

const PARTS: readonly Part[] = ["item", "result"];
const PART_LABEL: Record<Part, string> = { item: "要素", result: "結果" };
const FEATURES = Array.from({ length: 20 }, (_, i) => `F${i + 1}`);

/**
 * 照らすこと 8 の期限付きの除外（承認で足したこと 2）。表が空になったとき、照らすこと 8 は合成の経路と登録の経路の完全一致になる。
 * #2 の登録にある受け口（user・runner・machine・db_prep）はすべてここに持つ。表に無い受け口の経路は「登録にだけある経路」で落ちる
 */
const ROUTE_EXCLUSIONS: readonly RouteExclusion[] = [
  { kind: "legacy", route: "PUT /v1/users", until: "#4", why: "骨組みの経路で、操作の表に無い（#2 の設計の「骨組みの経路」の行）" },
  { kind: "endpoint", endpoint: "user", until: "#4", why: "#2 は api-fn と ApiRoutes をスタックへ入れない（#2 の決定 11）" },
  { kind: "endpoint", endpoint: "runner", until: "#4", why: "#2 は api-fn と ApiRoutes をスタックへ入れない（#2 の決定 11）" },
  { kind: "endpoint", endpoint: "machine", until: "#4", why: "#2 は api-fn と ApiRoutes をスタックへ入れない（#2 の決定 11）" },
  { kind: "endpoint", endpoint: "db_prep", until: "#13", why: "#13 が DB の用意を Lambda へ移し、2 本を操作の表から消す" },
];

// ---- 照らしの関数（作り物の入力を渡せる純粋な関数） ----

/** JSON Schema の検証の関数（ajv の draft 2020-12）。日時やメールの形は ajv-formats で照らす */
const AJV = new Ajv2020({ strict: true, strictTypes: false });
// ajv-formats は CommonJS の書き出しで、NodeNext の型では既定の書き出しの .default が関数になる
addFormats.default(AJV);

function jsonValidator(schema: JsonSchema): (value: unknown) => boolean {
  const validate = AJV.compile(schema);
  return (value) => validate(value) === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asSchema(value: unknown): JsonSchema | undefined {
  return isRecord(value) ? value : undefined;
}

/** 型を変えた値。文字列は数に、ほかは文字列にする */
function otherType(value: unknown): unknown {
  return typeof value === "string" ? 0 : "changed";
}

const UNKNOWN_KEY = "unknown_key";

/**
 * 見本から変形を作る。項目を 1 つずつ消す（必須の項目を含む）・項目の型を変える・知らない項目を足す・配列を最初の 1 件の値にする。
 * 入れ子のオブジェクトと配列の最初の 1 件にも同じ変形を掛け、ラベルを `.` で結ぶ。形は入れ子の場所を辿るのにだけ使う
 */
function mutate(value: unknown, schema: JsonSchema): Mutation[] {
  const out: Mutation[] = [];
  if (Array.isArray(value)) {
    if (value.length === 0) return out;
    out.push({ label: "配列を最初の 1 件の値にする", value: value[0] });
    const items = asSchema(schema.items);
    if (items !== undefined) {
      for (const m of mutate(value[0], items)) out.push({ label: `[0].${m.label}`, value: [m.value, ...value.slice(1)] });
    }
    return out;
  }
  if (!isRecord(value)) return out;
  const properties = asSchema(schema.properties) ?? {};
  for (const [key, child] of Object.entries(value)) {
    // 必須かは照らす相手の形が決めるので、生成物の required に頼らず見本にある項目をどれも 1 つずつ消す
    const rest = { ...value };
    delete rest[key];
    out.push({ label: `${key} を消す`, value: rest });
    out.push({ label: `${key} の型を変える`, value: { ...value, [key]: otherType(child) } });
    const sub = asSchema(properties[key]);
    if (sub === undefined) continue;
    for (const m of mutate(child, sub)) out.push({ label: `${key}.${m.label}`, value: { ...value, [key]: m.value } });
  }
  out.push({ label: "知らない項目を足す", value: { ...value, [UNKNOWN_KEY]: 1 } });
  return out;
}

/** OpenAPI の `#/components/schemas/` の参照を、同じ形を `$defs` に置いた JSON Schema の参照へ書き換える */
function openApiSchema(schema: JsonSchema, components: Record<string, JsonSchema>): JsonSchema {
  const rewrite = (v: unknown): JsonSchema => JSON.parse(JSON.stringify(v).replaceAll('"#/components/schemas/', '"#/$defs/')) as JsonSchema;
  return { ...rewrite(schema), $defs: rewrite(components) };
}

function jsonSchemaOf(op: OperationView, generated: GeneratedView, part: Part): JsonSchema {
  const schema = generated.jsonSchema.$defs[defKey(op.name, part)];
  if (schema === undefined) throw new Error(`JSON Schema に ${defKey(op.name, part)} が無い`);
  return schema;
}

function hasMcp(op: OperationView): boolean {
  return op.endpoint === "user" && op.humanOnly !== "always";
}

/**
 * 1 つの操作の要素と結果の形を、zod・JSON Schema・OpenAPI の要素の形・MCP の道具の入力と出力の形の検証の関数として返す。
 * どの関数も要素 1 つを受け、形ごとの包み方（OpenAPI と MCP の出力は配列、MCP の入力は `{"items": [...]}`）で包んで検証する。
 * 人だけの操作と機械向けの操作は MCP の形を持たない
 */
function representationsOf(op: OperationView, generated: GeneratedView): Representation[] {
  const reps: Representation[] = [];
  const openapi = generated.openapi.paths[op.route]?.[op.method.toLowerCase()];
  if (openapi === undefined) throw new Error(`OpenAPI に ${op.method} ${op.route} が無い`);
  const tool = generated.mcpTools.find((t) => t.name === op.name);
  if (hasMcp(op) && tool === undefined) throw new Error("MCP の道具が無い");
  const { schemas } = generated.openapi.components;
  for (const part of PARTS) {
    const zodSchema = op[part];
    reps.push({ form: "zod", part, accepts: (v) => zodSchema.safeParse(v).success });
    jsonSchemaOf(op, generated, part);
    const json = jsonValidator({ $ref: `#/$defs/${defKey(op.name, part)}`, $defs: generated.jsonSchema.$defs });
    reps.push({ form: "json-schema", part, accepts: json });
    const body = part === "item" ? openapi.requestBody : openapi.responses["200"];
    const api = jsonValidator(openApiSchema(body.content["application/json"].schema, schemas));
    reps.push({ form: "openapi", part, accepts: (v) => api([v]) });
    if (tool === undefined || !hasMcp(op)) continue;
    const mcp = jsonValidator(part === "item" ? tool.inputSchema : tool.outputSchema);
    reps.push({ form: "mcp", part, accepts: part === "item" ? (v) => mcp({ items: [v] }) : (v) => mcp([v]) });
  }
  return reps;
}

/** 見本がすべての形で通ることと、変形ごとに通すか拒むかが形の間で揃うことを照らす */
function agreementIssues(label: string, reps: readonly Representation[], example: unknown, schema: JsonSchema): string[] {
  const issues: string[] = [];
  const rejecting = reps.filter((r) => !r.accepts(example)).map((r) => r.form);
  if (rejecting.length > 0) issues.push(`${label}: 見本を ${rejecting.join("・")} が拒む`);
  for (const m of mutate(example, schema)) {
    const passed = reps.filter((r) => r.accepts(m.value)).map((r) => r.form);
    const rejected = reps.filter((r) => !passed.includes(r.form)).map((r) => r.form);
    if (passed.length > 0 && rejected.length > 0) issues.push(`${label}（${m.label}）: ${passed.join("・")} は通し ${rejected.join("・")} は拒む`);
  }
  return issues;
}

/** 照らすこと 1: 見本と変形を 4 つの形で検証し、通るか拒むかが違う組と、見本を拒む形を返す */
function roundTripIssues(ops: readonly OperationView[], generated: GeneratedView): string[] {
  const issues: string[] = [];
  for (const op of ops) {
    let reps: Representation[];
    try {
      reps = representationsOf(op, generated);
    } catch (e) {
      issues.push(`${op.name}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (const part of PARTS) {
      const label = `${op.name} の${PART_LABEL[part]}`;
      issues.push(...agreementIssues(label, reps.filter((r) => r.part === part), op.examples[part], jsonSchemaOf(op, generated, part)));
    }
  }
  return issues;
}

/** 照らすこと 1 を、操作でない形（設定のファイル）の zod と JSON Schema の 2 つの形に打つ */
function schemaPairIssues(name: string, zodSchema: z.ZodType, jsonSchema: JsonSchema, example: unknown): string[] {
  const reps: Representation[] = [
    { form: "zod", part: "item", accepts: (v) => zodSchema.safeParse(v).success },
    { form: "json-schema", part: "item", accepts: jsonValidator(jsonSchema) },
  ];
  return agreementIssues(name, reps, example, jsonSchema);
}

function difference(a: Iterable<string>, b: Iterable<string>): string[] {
  const other = new Set(b);
  return [...new Set(a)].filter((x) => !other.has(x)).sort();
}

/** 照らすこと 2: MCP の道具の名前の集まりと、利用者向けの人だけでない操作の名前の集まりの食い違い */
function mcpToolIssues(ops: readonly OperationView[], generated: GeneratedView): string[] {
  const wanted = ops.filter(hasMcp).map((o) => o.name);
  const tools = generated.mcpTools.map((t) => t.name);
  return [
    ...difference(wanted, tools).map((n) => `MCP の道具が無い操作: ${n}`),
    ...difference(tools, wanted).map((n) => `人だけでない利用者向けの操作に無い MCP の道具: ${n}`),
  ];
}

/** 照らすこと 3: 人だけの操作ごとに、同じエンティティの人だけでない読む操作がある */
function humanOnlyReadIssues(ops: readonly OperationView[]): string[] {
  return ops
    .filter((o) => o.humanOnly === "always")
    .filter((o) => !ops.some((r) => r.entity === o.entity && r.humanOnly !== "always" && r.access === "read"))
    .map((o) => `人だけの操作 ${o.name} に、エンティティ ${o.entity} の人だけでない読む操作が無い`);
}

/** 照らすこと 4: F1〜F20 がどれかの操作の機能にある */
function featureIssues(ops: readonly OperationView[], features: readonly string[] = FEATURES): string[] {
  const used = new Set(ops.flatMap((o) => o.features));
  return features.filter((f) => !used.has(f)).map((f) => `どの操作の機能にも無い: ${f}`);
}

/** 照らすこと 5（I12）: 利用者向けの操作の要求と応答の形が配列 */
function arrayShapeIssues(ops: readonly OperationView[], generated: GeneratedView): string[] {
  const issues: string[] = [];
  for (const op of ops.filter((o) => o.endpoint === "user")) {
    const openapi = generated.openapi.paths[op.route]?.[op.method.toLowerCase()];
    if (openapi === undefined) {
      issues.push(`${op.name} の形が OpenAPI に無い`);
      continue;
    }
    if (openapi.requestBody.content["application/json"].schema.type !== "array") issues.push(`${op.name} の要求の形が配列でない`);
    if (openapi.responses["200"].content["application/json"].schema.type !== "array") issues.push(`${op.name} の応答の形が配列でない`);
  }
  return issues;
}

/** UTC の日時だけを通す形か。時刻帯の無い日時と UTC でない時刻帯の日時を拒み、UTC の日時を通す */
const UTC_SAMPLES = { accept: "2026-01-02T03:04:05Z", reject: ["2026-01-02T03:04:05", "2026-01-02T03:04:05+09:00"] } as const;

function isUtcDateTime(schema: JsonSchema, defs: Record<string, JsonSchema>): boolean {
  const validate = jsonValidator({ ...schema, $defs: defs });
  return validate(UTC_SAMPLES.accept) && UTC_SAMPLES.reject.every((v) => !validate(v));
}

/** 形の木を辿り、プロパティを持つオブジェクトの形ごとに `visit` を呼ぶ。パスはプロパティの名前を `.` で結ぶ */
function walkObjects(schema: JsonSchema, path: string, visit: (schema: JsonSchema, path: string) => void): void {
  const properties = asSchema(schema.properties);
  if (properties !== undefined) {
    visit(schema, path);
    for (const [key, sub] of Object.entries(properties)) {
      const child = asSchema(sub);
      if (child !== undefined) walkObjects(child, `${path}.${key}`, visit);
    }
  }
  const items = asSchema(schema.items);
  if (items !== undefined) walkObjects(items, path, visit);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    for (const b of branches) {
      const branch = asSchema(b);
      if (branch !== undefined) walkObjects(branch, path, visit);
    }
  }
}

/** 照らすこと 6（I15）: `_at` で終わる項目は UTC の日時、`amount_minor` を持つ要素は `currency` を必須にする */
function timeAndMoneyIssues(generated: GeneratedView): string[] {
  const issues: string[] = [];
  const defs = generated.jsonSchema.$defs;
  for (const [name, schema] of Object.entries(defs)) {
    walkObjects(schema, name, (obj, path) => {
      const properties = asSchema(obj.properties) ?? {};
      for (const [key, sub] of Object.entries(properties)) {
        const child = asSchema(sub);
        if (key.endsWith("_at") && child !== undefined && !isUtcDateTime(child, defs)) issues.push(`${path}.${key}: UTC の日時の形でない`);
      }
      const required = Array.isArray(obj.required) ? (obj.required as unknown[]) : [];
      if (Object.hasOwn(properties, "amount_minor") && !required.includes("currency")) {
        issues.push(`${path}: amount_minor を持つが currency を必須にしない`);
      }
    });
  }
  return issues;
}

function routeKey(r: { method: string; path: string }): string {
  return `${r.method} ${r.path}`;
}

/** 照らすこと 7: HTTP の経路の登録の経路の集まりと、操作の表の経路の集まりの食い違い */
function routeTableIssues(ops: readonly OperationView[], routes: readonly RouteEntry[]): string[] {
  const table = ops.map((o) => routeKey({ method: o.method, path: o.route }));
  const registry = routes.map(routeKey);
  return [
    ...difference(registry, table).map((k) => `操作の表に無い登録の経路: ${k}`),
    ...difference(table, registry).map((k) => `登録に無い操作の表の経路: ${k}`),
  ];
}

/** 合成したテンプレートの `AWS::ApiGatewayV2::Route` の `RouteKey`（`PUT /v1/users` の形） */
function templateRoutes(template: unknown): string[] {
  const resources = asSchema(asSchema(template)?.Resources) ?? {};
  const keys: string[] = [];
  for (const r of Object.values(resources)) {
    const resource = asSchema(r);
    if (resource?.Type !== "AWS::ApiGatewayV2::Route") continue;
    const key = asSchema(resource.Properties)?.RouteKey;
    if (typeof key !== "string") throw new Error(`経路の RouteKey が文字列でない: ${JSON.stringify(key)}`);
    keys.push(key);
  }
  return keys;
}

/**
 * 照らすこと 8: 合成の経路から除外の旧経路を引いた集まりと、登録から除外の受け口の経路を引いた集まり（反映済みの経路）の食い違いと、
 * 要らなくなった除外の行（旧経路が合成に無い・受け口の経路が合成に 1 本でもある・受け口が登録に無い）を返す
 */
function synthRouteIssues(synth: readonly string[], registry: readonly RouteEntry[], exclusions: readonly RouteExclusion[]): string[] {
  const issues: string[] = [];
  const synthSet = new Set(synth);
  const legacy = new Set<string>();
  const endpoints = new Set<string>();
  for (const ex of exclusions) {
    const stale = `除外の行が要らない（${ex.until} が終えた。行を消す）`;
    if (ex.kind === "legacy") {
      legacy.add(ex.route);
      if (!synthSet.has(ex.route)) issues.push(`${stale}: 旧経路 ${ex.route} が合成に無い`);
      continue;
    }
    endpoints.add(ex.endpoint);
    const routes = registry.filter((r) => r.endpoint === ex.endpoint).map(routeKey);
    if (routes.length === 0) issues.push(`${stale}: 受け口 ${ex.endpoint} の経路が登録に無い`);
    for (const k of routes.filter((k) => synthSet.has(k))) issues.push(`${stale}: 受け口 ${ex.endpoint} の経路 ${k} が合成にある`);
  }
  const deployedSynth = synth.filter((k) => !legacy.has(k));
  const deployedRegistry = registry.filter((r) => !endpoints.has(r.endpoint)).map(routeKey);
  issues.push(...difference(deployedRegistry, deployedSynth).map((k) => `登録にだけある経路: ${k}`));
  issues.push(...difference(deployedSynth, deployedRegistry).map((k) => `合成にだけある経路: ${k}`));
  return issues;
}

/** 経路の登録（#2 の `generated/routes.json`）を読む。形が違えば止める */
function parseRegistry(raw: unknown): RouteEntry[] {
  const isEntry = (v: unknown): v is RouteEntry =>
    isRecord(v) && ["method", "path", "operation", "endpoint"].every((k) => typeof v[k] === "string");
  if (!Array.isArray(raw) || !raw.every(isEntry)) throw new Error(`経路の登録の形が違う（${REGISTRY}）`);
  return raw.map(({ method, path, operation, endpoint }) => ({ method, path, operation, endpoint }));
}

// ---- 作り物の操作の表と生成物 ----

const teamRef = z.strictObject({ team_id: z.string().min(1) });

function fakeOperations(): OperationView[] {
  const op = (o: Omit<OperationView, "entity" | "method" | "route">): OperationView => {
    const parts = o.name.split(".");
    return { ...o, entity: parts.at(-2) ?? "", method: "POST", route: `/v1/${parts.join("/")}` };
  };
  return [
    op({
      name: "teams.list",
      endpoint: "user",
      access: "read",
      humanOnly: "never",
      features: FEATURES.slice(0, 10),
      item: teamRef,
      result: z.strictObject({
        ok: z.literal(true),
        item: z.strictObject({ team_id: z.string(), name: z.string(), created_at: z.iso.datetime(), tags: z.array(z.string()) }),
      }),
      examples: {
        item: { team_id: "team-1" },
        result: { ok: true, item: { team_id: "team-1", name: "acme", created_at: "2026-01-02T03:04:05Z", tags: ["a", "b"] } },
      },
    }),
    op({
      name: "teams.update",
      endpoint: "user",
      access: "write",
      humanOnly: "never",
      features: FEATURES.slice(10, 15),
      item: z.strictObject({ team_id: z.string().min(1), name: z.string().min(1) }),
      result: z.strictObject({ ok: z.literal(true), item: z.strictObject({ team_id: z.string(), updated_at: z.iso.datetime() }) }),
      examples: {
        item: { team_id: "team-1", name: "acme" },
        result: { ok: true, item: { team_id: "team-1", updated_at: "2026-01-02T03:04:05Z" } },
      },
    }),
    op({
      name: "teams.delete",
      endpoint: "user",
      access: "write",
      humanOnly: "always",
      features: FEATURES.slice(15, 18),
      item: teamRef,
      result: z.strictObject({ ok: z.literal(true) }),
      examples: { item: { team_id: "team-1" }, result: { ok: true } },
    }),
    op({
      name: "invoices.get",
      endpoint: "user",
      access: "read",
      humanOnly: "per_item",
      features: FEATURES.slice(18),
      item: z.strictObject({ invoice_id: z.string().min(1) }),
      result: z.strictObject({
        ok: z.literal(true),
        item: z.strictObject({ amount_minor: z.number().int(), currency: z.string().length(3), issued_at: z.iso.datetime() }),
      }),
      examples: {
        item: { invoice_id: "inv-1" },
        result: { ok: true, item: { amount_minor: 1200, currency: "USD", issued_at: "2026-01-02T03:04:05Z" } },
      },
    }),
    op({
      name: "runner.jobs.list",
      endpoint: "runner",
      access: "read",
      humanOnly: "never",
      features: [],
      item: z.strictObject({ job_id: z.string().min(1) }),
      result: z.strictObject({ ok: z.literal(true), item: z.strictObject({ job_id: z.string() }) }),
      examples: { item: { job_id: "job-1" }, result: { ok: true, item: { job_id: "job-1" } } },
    }),
  ];
}

function defKey(name: string, part: Part): string {
  return `${name}.${part}`;
}

/** zod の形の JSON Schema（最上位の `$schema` を外し、`$defs` の下に置ける形にする） */
function toSchema(schema: z.ZodType): JsonSchema {
  const out: JsonSchema = { ...(z.toJSONSchema(schema) as JsonSchema) };
  delete out.$schema;
  return out;
}

function jsonBody(schema: JsonSchema): JsonBody {
  return { content: { "application/json": { schema } } };
}

/** 作り物の操作の表から、揃った生成物を作る（#2 の生成物と同じ包み方） */
function fakeGenerated(ops: readonly OperationView[]): GeneratedView {
  const defs: Record<string, JsonSchema> = {};
  for (const op of ops) for (const part of PARTS) defs[defKey(op.name, part)] = toSchema(op[part]);
  const arrayOf = (key: string): JsonSchema => ({ type: "array", items: { $ref: `#/components/schemas/${key}` } });
  const paths: GeneratedView["openapi"]["paths"] = {};
  for (const op of ops) {
    paths[op.route] = {
      [op.method.toLowerCase()]: {
        operationId: op.name,
        requestBody: jsonBody(arrayOf(defKey(op.name, "item"))),
        responses: { "200": jsonBody(arrayOf(defKey(op.name, "result"))) },
      },
    };
  }
  const mcpTools = ops
    .filter((op) => op.endpoint === "user" && op.humanOnly !== "always")
    .map((op) => ({
      name: op.name,
      inputSchema: {
        type: "object",
        properties: { items: { type: "array", items: structuredClone(defs[defKey(op.name, "item")]) } },
        required: ["items"],
        additionalProperties: false,
      },
      outputSchema: { type: "array", items: structuredClone(defs[defKey(op.name, "result")]) },
    }));
  return {
    jsonSchema: { $defs: defs },
    openapi: { paths, components: { schemas: structuredClone(defs) } },
    mcpTools,
    routes: ops.map((op) => ({ method: op.method, path: op.route, operation: op.name, endpoint: op.endpoint })),
  };
}

/** 生成物の 1 か所を壊すための道具。`$defs` の下の形をパスで辿る */
function schemaAt(root: JsonSchema, path: readonly string[]): JsonSchema {
  let cur: unknown = root;
  for (const key of path) cur = (cur as JsonSchema)[key];
  return cur as JsonSchema;
}

function fakeTemplate(routeKeys: readonly string[]): unknown {
  const resources: Record<string, unknown> = {
    Api: { Type: "AWS::ApiGatewayV2::Api", Properties: { Name: "acme-test-api" } },
  };
  routeKeys.forEach((key, i) => {
    resources[`Route${i}`] = { Type: "AWS::ApiGatewayV2::Route", Properties: { ApiId: { Ref: "Api" }, RouteKey: key } };
  });
  return { Resources: resources };
}

function entry(endpoint: string, path: string): RouteEntry {
  return { method: "POST", path, operation: path.replace(/^\/v1\//, "").replaceAll("/", "."), endpoint };
}

/** #2 の登録の形の作り物。4 つの受け口がそろい、合成には骨組みの旧経路だけがある */
const FAKE_REGISTRY: readonly RouteEntry[] = [
  entry("user", "/v1/teams/list"),
  entry("user", "/v1/teams/update"),
  entry("runner", "/v1/runner/jobs/list"),
  entry("machine", "/v1/machine/tokens/create"),
  entry("db_prep", "/v1/db_prep/exchanges/create"),
  entry("db_prep", "/v1/db_prep/completions/create"),
];

// ---- 作り物の入力のテスト ----

describe("照らすこと 1: 見本と変形を 4 つの形で検証し、通るか拒むかが揃う", () => {
  it("揃った表で当たりが 0 件", () => {
    const ops = fakeOperations();
    expect(roundTripIssues(ops, fakeGenerated(ops))).toEqual([]);
  });

  it("変形は項目（必須の項目を含む）を 1 つずつ消し、型を変え、知らない項目を足し、配列を最初の 1 件の値にする", () => {
    const ops = fakeOperations();
    const teamsList = ops[0];
    if (teamsList === undefined) throw new Error("作り物の表が空");
    const labels = mutate(teamsList.examples.result, fakeGenerated(ops).jsonSchema.$defs["teams.list.result"] ?? {}).map((m) => m.label);
    expect(labels).toEqual(
      expect.arrayContaining(["ok を消す", "item.team_id を消す", "ok の型を変える", "知らない項目を足す", "item.tags.配列を最初の 1 件の値にする"]),
    );
  });

  it("人だけでない利用者向けの操作は 4 つの形、人だけの操作は MCP を除く 3 つの形で比べる", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    const forms = (name: string) => [...new Set(representationsOf(ops.find((o) => o.name === name) as OperationView, generated).map((r) => r.form))];
    expect(forms("teams.list")).toEqual(["zod", "json-schema", "openapi", "mcp"]);
    expect(forms("teams.delete")).toEqual(["zod", "json-schema", "openapi"]);
  });

  it("空の配列の見本は、配列の変形を作らずに通る", () => {
    const ops = fakeOperations();
    const teamsList = ops[0];
    if (teamsList === undefined) throw new Error("作り物の表が空");
    const result = teamsList.examples.result as { item: { tags: string[] } };
    result.item.tags = [];
    expect(roundTripIssues(ops, fakeGenerated(ops))).toEqual([]);
  });

  it("JSON Schema だけ必須の項目を外すと、食い違いが 1 件", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    const item = schemaAt(generated.jsonSchema.$defs, ["teams.update.item"]);
    item.required = (item.required as string[]).filter((k) => k !== "team_id");
    const issues = roundTripIssues(ops, generated);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("teams.update の要素（team_id を消す）");
    expect(issues[0]).toContain("json-schema");
  });

  it("4 つの形がそろって見本を拒むと、見本が拒まれたことが 1 件", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    const teamsUpdate = ops.find((o) => o.name === "teams.update") as OperationView;
    teamsUpdate.examples.item = {};
    expect(roundTripIssues(ops, generated)).toEqual(["teams.update の要素: 見本を zod・json-schema・openapi・mcp が拒む"]);
  });

  it("形が生成物に無い操作は、無いことが 1 件", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    generated.mcpTools = generated.mcpTools.filter((t) => t.name !== "invoices.get");
    expect(roundTripIssues(ops, generated)).toEqual(["invoices.get: MCP の道具が無い"]);
  });
});

describe("照らすこと 1: 設定のファイルの見本と変形を zod と JSON Schema で検証する", () => {
  const example = { prefix: "acme", environment: "test", login: { google: {} } };

  it("揃った形で当たりが 0 件", () => {
    expect(schemaPairIssues("設定のファイル", settingsSchema, toSchema(settingsSchema), example)).toEqual([]);
  });

  it("JSON Schema だけ必須の項目を外すと、食い違いが 1 件", () => {
    const schema = toSchema(settingsSchema);
    schema.required = (schema.required as string[]).filter((k) => k !== "environment");
    const issues = schemaPairIssues("設定のファイル", settingsSchema, schema, example);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("設定のファイル（environment を消す）");
  });
});

describe("照らすこと 2: MCP の道具の名前の集まりが、利用者向けの人だけでない操作の名前の集まりと等しい", () => {
  it("揃った表で 0 件", () => {
    const ops = fakeOperations();
    expect(mcpToolIssues(ops, fakeGenerated(ops))).toEqual([]);
  });

  it("道具を 1 つ消すと 1 件", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    generated.mcpTools = generated.mcpTools.filter((t) => t.name !== "teams.update");
    expect(mcpToolIssues(ops, generated)).toEqual(["MCP の道具が無い操作: teams.update"]);
  });

  it("人だけの操作や機械向けの操作に道具があると 1 件", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    generated.mcpTools.push({ name: "teams.delete", inputSchema: {}, outputSchema: {} });
    expect(mcpToolIssues(ops, generated)).toEqual(["人だけでない利用者向けの操作に無い MCP の道具: teams.delete"]);
  });
});

describe("照らすこと 3: 人だけの操作ごとに、同じエンティティの人だけでない読む操作がある", () => {
  it("揃った表で 0 件", () => {
    expect(humanOnlyReadIssues(fakeOperations())).toEqual([]);
  });

  it("人だけの操作の読み出しを消すと 1 件", () => {
    const ops = fakeOperations().filter((o) => o.name !== "teams.list");
    expect(humanOnlyReadIssues(ops)).toEqual(["人だけの操作 teams.delete に、エンティティ teams の人だけでない読む操作が無い"]);
  });
});

describe("照らすこと 4: F1〜F20 がどれかの操作の機能にある", () => {
  it("揃った表で 0 件", () => {
    expect(featureIssues(fakeOperations())).toEqual([]);
  });

  it("機能を 1 つ消すと 1 件", () => {
    const ops = fakeOperations();
    const teamsUpdate = ops.find((o) => o.name === "teams.update") as OperationView;
    teamsUpdate.features = teamsUpdate.features.filter((f) => f !== "F15");
    expect(featureIssues(ops)).toEqual(["どの操作の機能にも無い: F15"]);
  });
});

describe("照らすこと 5: 利用者向けの操作の要求と応答の形が配列（I12）", () => {
  it("揃った表で 0 件", () => {
    const ops = fakeOperations();
    expect(arrayShapeIssues(ops, fakeGenerated(ops))).toEqual([]);
  });

  it("配列でない要求を置くと 1 件", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    const post = generated.openapi.paths["/v1/teams/update"]?.post as OpenApiOperation;
    post.requestBody = jsonBody({ $ref: "#/components/schemas/teams.update.item" });
    expect(arrayShapeIssues(ops, generated)).toEqual(["teams.update の要求の形が配列でない"]);
  });
});

describe("照らすこと 6: `_at` の項目は UTC の日時、`amount_minor` を持つ要素は `currency` を必須にする（I15）", () => {
  it("揃った表で 0 件", () => {
    expect(timeAndMoneyIssues(fakeGenerated(fakeOperations()))).toEqual([]);
  });

  it("時刻帯の無い日時を通す形にすると 1 件", () => {
    const generated = fakeGenerated(fakeOperations());
    const item = schemaAt(generated.jsonSchema.$defs, ["teams.list.result", "properties", "item", "properties"]);
    item.created_at = { type: "string" };
    expect(timeAndMoneyIssues(generated)).toEqual(["teams.list.result.item.created_at: UTC の日時の形でない"]);
  });

  it("UTC でない時刻帯の日時を通す形にすると 1 件", () => {
    const generated = fakeGenerated(fakeOperations());
    const item = schemaAt(generated.jsonSchema.$defs, ["teams.update.result", "properties", "item", "properties"]);
    item.updated_at = { type: "string", format: "date-time" };
    expect(timeAndMoneyIssues(generated)).toEqual(["teams.update.result.item.updated_at: UTC の日時の形でない"]);
  });

  it("通貨の無い金額を通す形にすると 1 件", () => {
    const generated = fakeGenerated(fakeOperations());
    const item = schemaAt(generated.jsonSchema.$defs, ["invoices.get.result", "properties", "item"]);
    item.required = (item.required as string[]).filter((k) => k !== "currency");
    expect(timeAndMoneyIssues(generated)).toEqual(["invoices.get.result.item: amount_minor を持つが currency を必須にしない"]);
  });
});

describe("照らすこと 7: HTTP の経路の登録の経路の集まりが、操作の表の経路の集まりと等しい", () => {
  it("揃った表で 0 件", () => {
    const ops = fakeOperations();
    expect(routeTableIssues(ops, fakeGenerated(ops).routes)).toEqual([]);
  });

  it("表に無い経路を登録に置くと 1 件", () => {
    const ops = fakeOperations();
    const routes = [...fakeGenerated(ops).routes, entry("user", "/v1/teams/archive")];
    expect(routeTableIssues(ops, routes)).toEqual(["操作の表に無い登録の経路: POST /v1/teams/archive"]);
  });

  it("登録から経路を消すと 1 件", () => {
    const ops = fakeOperations();
    const routes = fakeGenerated(ops).routes.filter((r) => r.operation !== "teams.update");
    expect(routeTableIssues(ops, routes)).toEqual(["登録に無い操作の表の経路: POST /v1/teams/update"]);
  });
});

describe("照らすこと 8: 合成した経路が、除外を引いて経路の登録と揃う", () => {
  const synth = ["PUT /v1/users"];

  it("テンプレートから API Gateway の経路の RouteKey だけを取り出す", () => {
    expect(templateRoutes(fakeTemplate(["PUT /v1/users", "POST /v1/teams/list"]))).toEqual(["PUT /v1/users", "POST /v1/teams/list"]);
    expect(templateRoutes({ Resources: { Fn: { Type: "AWS::Lambda::Function", Properties: {} } } })).toEqual([]);
  });

  it("除外を引いて揃った組で 0 件", () => {
    expect(synthRouteIssues(templateRoutes(fakeTemplate(synth)), FAKE_REGISTRY, ROUTE_EXCLUSIONS)).toEqual([]);
  });

  it("除外の表が空で、合成と登録が完全に揃った組で 0 件", () => {
    const keys = FAKE_REGISTRY.map((r) => `${r.method} ${r.path}`);
    expect(synthRouteIssues(templateRoutes(fakeTemplate(keys)), FAKE_REGISTRY, [])).toEqual([]);
  });

  it("除外の表が空なら、旧経路は合成にだけある経路として 1 件", () => {
    const registry = FAKE_REGISTRY.filter((r) => r.endpoint === "user");
    const keys = [...synth, ...registry.map((r) => `${r.method} ${r.path}`)];
    expect(synthRouteIssues(keys, registry, [])).toEqual(["合成にだけある経路: PUT /v1/users"]);
  });

  it("登録にだけある反映済みの経路で 1 件", () => {
    const exclusions = ROUTE_EXCLUSIONS.filter((e) => !(e.kind === "endpoint" && e.endpoint === "runner"));
    expect(synthRouteIssues(synth, FAKE_REGISTRY, exclusions)).toEqual(["登録にだけある経路: POST /v1/runner/jobs/list"]);
  });

  it("合成にだけある除外に無い経路で 1 件", () => {
    expect(synthRouteIssues([...synth, "GET /v1/health"], FAKE_REGISTRY, ROUTE_EXCLUSIONS)).toEqual(["合成にだけある経路: GET /v1/health"]);
  });

  it("旧経路が合成に無いと、除外の行が要らないと 1 件", () => {
    expect(synthRouteIssues([], FAKE_REGISTRY, ROUTE_EXCLUSIONS)).toEqual([
      "除外の行が要らない（#4 が終えた。行を消す）: 旧経路 PUT /v1/users が合成に無い",
    ]);
  });

  it("除外の受け口の経路が合成にあると、除外の行が要らないと 1 件（その経路は合成にだけある経路にも数える）", () => {
    expect(synthRouteIssues([...synth, "POST /v1/runner/jobs/list"], FAKE_REGISTRY, ROUTE_EXCLUSIONS)).toEqual([
      "除外の行が要らない（#4 が終えた。行を消す）: 受け口 runner の経路 POST /v1/runner/jobs/list が合成にある",
      "合成にだけある経路: POST /v1/runner/jobs/list",
    ]);
  });

  it("除外の受け口が登録に無いと、除外の行が要らないと 1 件", () => {
    const registry = FAKE_REGISTRY.filter((r) => r.endpoint !== "db_prep");
    expect(synthRouteIssues(synth, registry, ROUTE_EXCLUSIONS)).toEqual([
      "除外の行が要らない（#13 が終えた。行を消す）: 受け口 db_prep の経路が登録に無い",
    ]);
  });

  it("経路の登録の形を読む。形が違えば止める", () => {
    expect(parseRegistry([...FAKE_REGISTRY])).toEqual(FAKE_REGISTRY);
    expect(() => parseRegistry([{ method: "POST", path: "/v1/teams/list" }])).toThrow(/経路の登録の形が違う/);
    expect(() => parseRegistry({})).toThrow(/経路の登録の形が違う/);
  });
});

// ---- リポジトリの入力のテスト ----

describe("リポジトリの形の正本", () => {
  it("照らすこと 1: 設定のファイルの見本と変形で、zod の形と生成した JSON Schema の通すか拒むかが揃う", () => {
    const schema = JSON.parse(readFileSync(join(ROOT, SETTINGS_SCHEMA), "utf8")) as JsonSchema;
    const example: unknown = JSON.parse(readFileSync(join(ROOT, SETTINGS_EXAMPLE), "utf8"));
    expect(schemaPairIssues(SETTINGS_SCHEMA, settingsSchema, schema, example)).toEqual([]);
  });

  const hasOperations = existsSync(join(ROOT, OPERATIONS));
  it.skipIf(!hasOperations)(
    hasOperations
      ? "照らすこと 1〜7: 操作の表と生成物を照らす"
      : `相手が無い: #2 の操作の表の書き出し（${OPERATIONS}）が無いので、照らすこと 1〜7 をリポジトリの表に打たない`,
    () => {
      // #2 の書き出しが入ったら、OperationView と GeneratedView へ写す繋ぎを書き、照らすこと 1〜7 を打つ。
      // 繋ぎが無いまま通さないよう、ここで落とす
      expect.fail(`${OPERATIONS} がある。#2 の書き出しを OperationView・GeneratedView へ写して照らすこと 1〜7 を打つ`);
    },
  );
});

describe("リポジトリの合成した API Gateway の経路（照らすこと 8）", () => {
  const temps: string[] = [];
  let synthRoutes: string[] = [];

  beforeAll(() => {
    const webDist = mkdtempSync(join(tmpdir(), "nd-web-dist-"));
    const outDir = mkdtempSync(join(tmpdir(), "nd-cdk-out-"));
    temps.push(webDist, outDir);
    writeFileSync(join(webDist, "index.html"), "<!doctype html><title>test</title>\n");
    synthRoutes = synthesize(webDist, outDir);
  }, SYNTH_TIMEOUT);

  afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  it("画面をビルドせずに合成でき、経路を 1 本以上取り出す", () => {
    expect(synthRoutes.length).toBeGreaterThan(0);
  });

  const hasRegistry = existsSync(join(ROOT, REGISTRY));
  it.skipIf(!hasRegistry)(
    hasRegistry
      ? "合成した経路から除外の旧経路を引いた集まりが、経路の登録から除外の受け口の経路を引いた集まりと等しい"
      : `相手が無い: 経路の登録（${REGISTRY}）が無いので、合成した経路と登録の比べを飛ばす`,
    () => {
      const registry = parseRegistry(JSON.parse(readFileSync(join(ROOT, REGISTRY), "utf8")));
      expect(synthRouteIssues(synthRoutes, registry, ROUTE_EXCLUSIONS)).toEqual([]);
    },
  );
});

/**
 * `infra` の合成の起点を子のプロセスで打ち、一時のディレクトリへ出したテンプレートから経路を読む（`tools` は `infra` を import しない）。
 * 画面のアセットは一時のディレクトリを `ND_WEB_DIST` で渡し、Lambda の束ねは文脈で飛ばす
 */
function synthesize(webDist: string, outDir: string): string[] {
  const result = spawnSync(process.execPath, [join(ROOT, SYNTH_ENTRY)], {
    cwd: join(ROOT, "infra"),
    encoding: "utf8",
    timeout: SYNTH_TIMEOUT,
    // 手元の AWS の profile や資格情報を合成へ渡さない。合成は lookup を使わず、作り物のアカウントとリージョンで足りる
    env: {
      PATH: process.env.PATH,
      ND_WEB_DIST: webDist,
      ND_SETTINGS: join(ROOT, SYNTH_SETTINGS),
      CDK_DEFAULT_ACCOUNT: "123456789012",
      CDK_DEFAULT_REGION: "us-west-2",
      CDK_OUTDIR: outDir,
      // Lambda の束ねを飛ばす。経路の比べに束ねは要らない
      CDK_CONTEXT_JSON: JSON.stringify({ "aws:cdk:bundling-stacks": [] }),
    },
  });
  if (result.status !== 0) {
    throw new Error(`合成が終了コード ${String(result.status)} で止まった（${SYNTH_ENTRY}）\n${result.error?.message ?? ""}${result.stderr}`);
  }
  const templates = readdirSync(outDir).filter((f) => f.endsWith(".template.json"));
  if (templates.length === 0) throw new Error(`合成の出力にテンプレートが無い: ${outDir}`);
  return templates.flatMap((f) => templateRoutes(JSON.parse(readFileSync(join(outDir, f), "utf8"))));
}
