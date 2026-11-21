import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { faker } from "@faker-js/faker";
import { settingsSchema } from "@nd-factory/contracts/settings";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { fake, seed, setFaker } from "zod-schema-faker/v4";

// 形の正本の往復のテスト（#1 の決定 8。中身は issues/issue-1-design-detail.md の「形の正本の往復のテスト」）。
// 照らしの関数はどれも作り物の入力を渡せる純粋な関数にし、壊れが無ければ空の配列、あれば 1 件 1 文字列の当たりを返す。
// リポジトリの入力に打つテストと、1 か所を壊した作り物の入力で落ちることを確かめるテストを分ける
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** #2 の書き出し（K2-3）の置き場。操作の表と、結果の zod を組む関数と、形の未定の判定 */
const OPERATIONS = "packages/contracts/src/operations/index.ts";
const OPERATION = "packages/contracts/src/operation.ts";
/** #2 の生成物（K2-3）。経路の登録が無い間は照らすこと 8 の比べを「相手が無い」で飛ばす */
const GENERATED = {
  jsonSchema: "packages/contracts/generated/operations.schema.json",
  openapi: "packages/contracts/generated/openapi.json",
  mcpTools: "packages/contracts/generated/mcp-tools.json",
  dummy: "packages/contracts/generated/dummy/index.json",
} as const;
const REGISTRY = "packages/contracts/generated/routes.json";
/** 設定のファイルの形の生成物と見本（packages/contracts/scripts/generate.ts が作る） */
const SETTINGS_SCHEMA = "packages/contracts/schema/settings.schema.json";
const SETTINGS_EXAMPLE = "infra/settings.example.json";
/** 合成の起点と、`npm run synth` と同じ作り物の設定 */
const SYNTH_ENTRY = "infra/bin/app.ts";
const SYNTH_SETTINGS = "infra/test/fixtures/settings.json";
// 合成の 1 回は手元で 2 秒ほど。CI の遅さを見込む
const SYNTH_TIMEOUT = 120_000;
/** 要素の見本の数（#2 の operations-roundtrip.test.ts と同じ）。種は操作の名前から決める */
const ITEM_SAMPLES = 3;

type JsonSchema = { [key: string]: unknown };
type Part = "item" | "result";
type Form = "zod" | "json-schema" | "openapi" | "mcp";
type HumanOnly = "always" | "per_item" | "never";

/** 形が確定した操作の形と見本。item は要素 1 つの形、result は成功と失敗の和（#2 の `resultSchemaOf`） */
type OperationShapes = { item: z.ZodType; result: z.ZodType; examples: Record<Part, unknown[]> };

/**
 * 照らしが読む操作の定義の部分（#2 の `OperationDef` のうち照らしに要る項目）。
 * 形が未定の操作は `shapes` が null で、名前・機能・経路の照らしには入り、見本の往復には入らない
 */
type OperationView = {
  name: string;
  entity: string;
  endpoint: string;
  method: string;
  route: string;
  access: "read" | "write";
  humanOnly: HumanOnly;
  mcpRead: string | null;
  features: readonly string[];
  /** 要求の要素の数の上限。全部か無かの操作は `allOrNothing.maxItems`、ほかは #2 の既定の `MAX_ITEMS`（#2 の生成物の `maxItemsOf` と同じ） */
  maxItems: number;
  shapes: OperationShapes | null;
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
  | { kind: "endpoint"; endpoint: string; until: string; why: string }
  | { kind: "receiver"; receiver: string; until: string; why: string };

/** 操作でない受け口の経路の 1 本。操作の表に無く、経路の登録（`routes.json`）にも載らないが、API の設計で要る */
type NonOperationRoute = { receiver: string; route: string; why: string };

const PARTS: readonly Part[] = ["item", "result"];
const PART_LABEL: Record<Part, string> = { item: "要素", result: "結果" };
const FEATURES = Array.from({ length: 20 }, (_, i) => `F${i + 1}`);

/**
 * 照らすこと 8 の操作でない受け口の経路（docs/design/api.md）。操作の表と経路の登録に無いので、照らすこと 7 の外に置き、
 * 照らすこと 8 で合成の経路の期待に足す（反映した後は、ここの経路がすべて合成にあることも確かめる）
 */
const NON_OPERATION_ROUTES: readonly NonOperationRoute[] = [
  { receiver: "mcp", route: "POST /mcp", why: "MCP の受け口（docs/design/api.md の MCP の「HTTP の経路」）" },
  { receiver: "mcp", route: "GET /mcp", why: "readMcpCall が 405 を返す（経路が無いと API Gateway が 404 を返し、Lambda に届かない）" },
  { receiver: "mcp", route: "DELETE /mcp", why: "readMcpCall が 405 を返す（経路が無いと API Gateway が 404 を返し、Lambda に届かない）" },
  { receiver: "github", route: "POST /v1/github/webhooks", why: "GitHub の Webhook の受け口（docs/design/api.md の操作の表の外の経路）" },
];

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
  { kind: "receiver", receiver: "mcp", until: "#4", why: "#2 は api-fn と ApiRoutes をスタックへ入れない（#2 の決定 11）。#4 が api-fn を反映し、F1〜F3 の MCP の道具を出す" },
  { kind: "receiver", receiver: "github", until: "#4", why: "#2 は api-fn と ApiRoutes をスタックへ入れない（#2 の決定 11）" },
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
 * 見本の中のオブジェクトと配列の最初の 1 件を辿って同じ変形を掛け、ラベルを `.` で結ぶ。
 * 形を辿らないので、和（`oneOf`・`anyOf`）や参照（`$ref`）を含む形でも、内側の項目の変形が作られる
 */
function mutate(value: unknown): Mutation[] {
  const out: Mutation[] = [];
  if (Array.isArray(value)) {
    if (value.length === 0) return out;
    out.push({ label: "配列を最初の 1 件の値にする", value: value[0] });
    for (const m of mutate(value[0])) out.push({ label: `[0].${m.label}`, value: [m.value, ...value.slice(1)] });
    return out;
  }
  if (!isRecord(value)) return out;
  for (const [key, child] of Object.entries(value)) {
    // 必須かは照らす相手の形が決めるので、生成物の required に頼らず見本にある項目をどれも 1 つずつ消す
    const rest = { ...value };
    delete rest[key];
    out.push({ label: `${key} を消す`, value: rest });
    out.push({ label: `${key} の型を変える`, value: { ...value, [key]: otherType(child) } });
    for (const m of mutate(child)) out.push({ label: `${key}.${m.label}`, value: { ...value, [key]: m.value } });
  }
  out.push({ label: "知らない項目を足す", value: { ...value, [UNKNOWN_KEY]: 1 } });
  return out;
}

/** OpenAPI の `#/components/schemas/` の参照を、同じ形を `$defs` に置いた JSON Schema の参照へ書き換える */
function openApiSchema(schema: JsonSchema, components: Record<string, JsonSchema>): JsonSchema {
  const rewrite = (v: unknown): JsonSchema => JSON.parse(JSON.stringify(v).replaceAll('"#/components/schemas/', '"#/$defs/')) as JsonSchema;
  return { ...rewrite(schema), $defs: rewrite(components) };
}

function defKey(name: string, part: Part): string {
  return `${name}.${part}`;
}

/** MCP の道具を持つ操作。利用者向けの、人だけでない操作 */
function hasMcp(op: OperationView): boolean {
  return op.endpoint === "user" && op.humanOnly !== "always";
}

/** OpenAPI に載る操作。#2 の OpenAPI は受け口 user の操作だけを公開する */
function hasOpenApi(op: OperationView): boolean {
  return op.endpoint === "user";
}

function openApiOf(op: OperationView, generated: GeneratedView): OpenApiOperation | undefined {
  return generated.openapi.paths[op.route]?.[op.method.toLowerCase()];
}

function bodySchema(body: JsonBody): JsonSchema {
  return body.content["application/json"].schema;
}

/**
 * 1 つの操作の要素と結果の形を、zod・JSON Schema・OpenAPI の要素の形・MCP の道具の入力と出力の形の検証の関数として返す。
 * 要素の関数は要素 1 つを受け、形ごとの包み方で包んで検証する（OpenAPI は配列。MCP の入力は `{"items": [...]}` を道具の入力の形に通し、
 * 包みが受けた要素を dispatch と同じ要素の zod で検証する。MCP の入力の形は配列の包みと件数だけを持ち、要素の検査は dispatch が担う）。
 * 結果の関数は OpenAPI と MCP の出力で配列に包む。OpenAPI の形は受け口 user の操作だけ、MCP の形は人だけでない受け口 user の操作だけが持つ
 */
function representationsOf(op: OperationView, shapes: OperationShapes, generated: GeneratedView): Representation[] {
  const reps: Representation[] = [];
  const openapi = hasOpenApi(op) ? openApiOf(op, generated) : undefined;
  if (hasOpenApi(op) && openapi === undefined) throw new Error(`OpenAPI に ${op.method} ${op.route} が無い`);
  const tool = hasMcp(op) ? generated.mcpTools.find((t) => t.name === op.name) : undefined;
  if (hasMcp(op) && tool === undefined) throw new Error("MCP の道具が無い");
  const { schemas } = generated.openapi.components;
  for (const part of PARTS) {
    const key = defKey(op.name, part);
    if (generated.jsonSchema.$defs[key] === undefined) throw new Error(`JSON Schema に ${key} が無い`);
    const zodSchema = shapes[part];
    const byZod = (v: unknown) => zodSchema.safeParse(v).success;
    reps.push({ form: "zod", part, accepts: byZod });
    reps.push({ form: "json-schema", part, accepts: jsonValidator({ $ref: `#/$defs/${key}`, $defs: generated.jsonSchema.$defs }) });
    if (openapi !== undefined) {
      const api = jsonValidator(openApiSchema(bodySchema(part === "item" ? openapi.requestBody : openapi.responses["200"]), schemas));
      reps.push({ form: "openapi", part, accepts: (v) => api([v]) });
    }
    if (tool === undefined) continue;
    if (part === "item") {
      const wrapper = jsonValidator(tool.inputSchema);
      reps.push({ form: "mcp", part, accepts: (v) => wrapper({ items: [v] }) && byZod(v) });
    } else {
      const output = jsonValidator(tool.outputSchema);
      reps.push({ form: "mcp", part, accepts: (v) => output([v]) });
    }
  }
  return reps;
}

/** 見本がすべての形で通ることと、変形ごとに通すか拒むかが形の間で揃うことを照らす */
function agreementIssues(label: string, reps: readonly Representation[], example: unknown): string[] {
  const issues: string[] = [];
  const rejecting = reps.filter((r) => !r.accepts(example)).map((r) => r.form);
  if (rejecting.length > 0) issues.push(`${label}: 見本を ${rejecting.join("・")} が拒む`);
  for (const m of mutate(example)) {
    const passed = reps.filter((r) => r.accepts(m.value)).map((r) => r.form);
    const rejected = reps.filter((r) => !passed.includes(r.form)).map((r) => r.form);
    if (passed.length > 0 && rejected.length > 0) issues.push(`${label}（${m.label}）: ${passed.join("・")} は通し ${rejected.join("・")} は拒む`);
  }
  return issues;
}

/**
 * OpenAPI の要求の配列と MCP の道具の入力の包み（道具がある操作だけ）を、操作の定義の上限（`maxItems`）の件数の境目で照らす。
 * 基準を生成物に置かないので、どちらかの形から上限が欠けても上限ちょうどと上限超過を並べて食い違いを見つける（人だけの操作の OpenAPI も照らす）。
 * 要素は通る見本だけを並べ、件数と包みの形だけを違える。MCP の包みは `items` の無い入力と、`items` が配列でない入力を拒む
 */
function requestCountIssues(op: OperationView, generated: GeneratedView, element: unknown): string[] {
  const openapi = openApiOf(op, generated);
  if (openapi === undefined) return [];
  const tool = hasMcp(op) ? generated.mcpTools.find((t) => t.name === op.name) : undefined;
  const api = jsonValidator(openApiSchema(bodySchema(openapi.requestBody), generated.openapi.components.schemas));
  const wrapper = tool === undefined ? undefined : jsonValidator(tool.inputSchema);
  const forms: { form: Form; accepts: (items: unknown[]) => boolean }[] = [
    { form: "openapi", accepts: api },
    ...(wrapper === undefined ? [] : [{ form: "mcp" as const, accepts: (items: unknown[]) => wrapper({ items }) }]),
  ];
  const label = `${op.name} の要求の件数`;
  const max = op.maxItems;
  const issues: string[] = [];
  for (const n of [0, 1, max, max + 1]) {
    const items = Array.from({ length: n }, () => element);
    const expected = n >= 1 && n <= max;
    const wrong = forms.filter((f) => f.accepts(items) !== expected).map((f) => f.form);
    if (wrong.length > 0) issues.push(`${label}（${n} 件、上限 ${max}）: ${wrong.join("・")} が${expected ? "拒む" : "通す"}`);
  }
  if (wrapper === undefined) return issues;
  if (wrapper({})) issues.push(`${op.name} の MCP の包み: items の無い入力を通す`);
  if (wrapper({ items: element })) issues.push(`${op.name} の MCP の包み: items が配列でない入力を通す`);
  return issues;
}

/**
 * 照らすこと 1: 形が確定した操作の見本と変形を 4 つの形で検証し、通るか拒むかが違う組と、見本を拒む形を返す。
 * 要素の検査を通る見本で MCP の道具の入力の包みも照らす。形が未定の操作は飛ばす
 */
function roundTripIssues(ops: readonly OperationView[], generated: GeneratedView): string[] {
  const issues: string[] = [];
  for (const op of ops) {
    const { shapes } = op;
    if (shapes === null) continue;
    let reps: Representation[];
    try {
      reps = representationsOf(op, shapes, generated);
    } catch (e) {
      issues.push(`${op.name}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (const part of PARTS) {
      const examples = shapes.examples[part];
      if (examples.length === 0) issues.push(`${op.name} の${PART_LABEL[part]}: 見本が無い`);
      examples.forEach((example, i) => {
        const label = `${op.name} の${PART_LABEL[part]}${examples.length > 1 ? ` ${String(i)}` : ""}`;
        issues.push(...agreementIssues(label, reps.filter((r) => r.part === part), example));
      });
    }
    // 要求の件数の境目は、要素の検査を通る見本だけを並べて照らす（見本を拒む形は上で当たりにしている）
    const valid = shapes.examples.item.find((e) => shapes.item.safeParse(e).success);
    if (hasOpenApi(op) && valid !== undefined) issues.push(...requestCountIssues(op, generated, valid));
  }
  return issues;
}

/** 照らすこと 1 を、操作でない形（設定のファイル）の zod と JSON Schema の 2 つの形に打つ */
function schemaPairIssues(name: string, zodSchema: z.ZodType, jsonSchema: JsonSchema, example: unknown): string[] {
  const reps: Representation[] = [
    { form: "zod", part: "item", accepts: (v) => zodSchema.safeParse(v).success },
    { form: "json-schema", part: "item", accepts: jsonValidator(jsonSchema) },
  ];
  return agreementIssues(name, reps, example);
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

/**
 * 照らすこと 3: 人だけの操作ごとに、`mcpRead` が指す読み出しが操作の表にあり、利用者向けの人だけでない読む操作で、
 * MCP の道具として公開されている。読み出しのエンティティは問わない（`sessions.create` → `users.get` のように別のエンティティを読む）
 */
function humanOnlyReadIssues(ops: readonly OperationView[], generated: GeneratedView): string[] {
  const issues: string[] = [];
  const tools = new Set(generated.mcpTools.map((t) => t.name));
  for (const op of ops.filter((o) => o.humanOnly === "always")) {
    const label = `人だけの操作 ${op.name}`;
    if (op.mcpRead === null) {
      issues.push(`${label} に読み出しの指定（mcpRead）が無い`);
      continue;
    }
    const read = ops.find((r) => r.name === op.mcpRead);
    if (read === undefined) {
      issues.push(`${label} の読み出し ${op.mcpRead} が操作の表に無い`);
      continue;
    }
    if (read.endpoint !== "user") issues.push(`${label} の読み出し ${read.name} が利用者向けでない`);
    if (read.humanOnly === "always") issues.push(`${label} の読み出し ${read.name} が人だけの操作`);
    if (read.access !== "read") issues.push(`${label} の読み出し ${read.name} が読む操作でない`);
    if (!tools.has(read.name)) issues.push(`${label} の読み出し ${read.name} が MCP の道具に無い`);
  }
  return issues;
}

/** 照らすこと 4: F1〜F20 がどれかの操作の機能にある */
function featureIssues(ops: readonly OperationView[], features: readonly string[] = FEATURES): string[] {
  const used = new Set(ops.flatMap((o) => o.features));
  return features.filter((f) => !used.has(f)).map((f) => `どの操作の機能にも無い: ${f}`);
}

/** 配列の形が持つ件数の下限と上限が、1 件と操作の定義の上限に等しいか。違えば当たりを返す */
function countLimitIssues(label: string, schema: JsonSchema | undefined, max: number): string[] {
  if (schema?.minItems === 1 && schema.maxItems === max) return [];
  return [`${label}の件数の範囲が操作の定義（1〜${String(max)} 件）と違う: ${String(schema?.minItems)}〜${String(schema?.maxItems)}`];
}

/**
 * 照らすこと 5（I12）: 利用者向けの操作の要求と応答の形が配列で、要求の配列と MCP の道具の入力の `items` の件数の範囲が
 * 操作の定義の上限（`allOrNothing.maxItems` か `MAX_ITEMS`）と等しい。形が未定の操作も照らす（件数の境目の往復は形が確定した操作だけ）
 */
function arrayShapeIssues(ops: readonly OperationView[], generated: GeneratedView): string[] {
  const issues: string[] = [];
  for (const op of ops.filter(hasOpenApi)) {
    const openapi = openApiOf(op, generated);
    if (openapi === undefined) {
      issues.push(`${op.name} の形が OpenAPI に無い`);
      continue;
    }
    const request = bodySchema(openapi.requestBody);
    if (request.type !== "array") issues.push(`${op.name} の要求の形が配列でない`);
    if (bodySchema(openapi.responses["200"]).type !== "array") issues.push(`${op.name} の応答の形が配列でない`);
    issues.push(...countLimitIssues(`${op.name} の OpenAPI の要求`, request, op.maxItems));
    const tool = hasMcp(op) ? generated.mcpTools.find((t) => t.name === op.name) : undefined;
    if (tool !== undefined) {
      issues.push(...countLimitIssues(`${op.name} の MCP の道具の入力の items `, asSchema(asSchema(tool.inputSchema.properties)?.items), op.maxItems));
    }
  }
  return issues;
}

/** UTC の日時だけを通す形か。時刻帯の無い日時と UTC でない時刻帯の日時を拒み、UTC の日時を通す */
const UTC_SAMPLES = { accept: "2026-01-02T03:04:05Z", reject: ["2026-01-02T03:04:05", "2026-01-02T03:04:05+09:00"] } as const;

function isUtcDateTime(schema: JsonSchema, defs: Record<string, JsonSchema>): boolean {
  const validate = jsonValidator({ ...schema, $defs: defs });
  return validate(UTC_SAMPLES.accept) && UTC_SAMPLES.reject.every((v) => !validate(v));
}

/** 形の木を辿り、プロパティを持つオブジェクトの形ごとに `visit` を呼ぶ。パスはプロパティの名前を `.` で結ぶ。形の中の `$defs` も辿る */
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
  for (const [name, sub] of Object.entries(asSchema(schema.$defs) ?? {})) {
    const def = asSchema(sub);
    if (def !== undefined) walkObjects(def, `${path}.$defs.${name}`, visit);
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

/** 照らすこと 1〜7 をまとめて打つ（リポジトリの入力のテストが使う） */
function operationIssues(ops: readonly OperationView[], generated: GeneratedView): string[] {
  return [
    ...roundTripIssues(ops, generated),
    ...mcpToolIssues(ops, generated),
    ...humanOnlyReadIssues(ops, generated),
    ...featureIssues(ops),
    ...arrayShapeIssues(ops, generated),
    ...timeAndMoneyIssues(generated),
    ...routeTableIssues(ops, generated.routes),
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
 * 照らすこと 8: 合成の経路から除外の旧経路を引いた集まりと、期待の集まり（登録から除外の受け口の経路を引いた反映済みの操作の経路に、
 * 除外していない操作でない受け口の経路を足したもの）の食い違いと、要らなくなった除外の行（旧経路が合成に無い・受け口の経路が合成に
 * 1 本でもある・受け口が登録に無い・操作でない受け口の経路が合成に 1 本でもある）を返す。操作でない受け口の経路が登録にあれば、
 * 照らすこと 7 と二重に数えるので当たりにする
 */
function synthRouteIssues(
  synth: readonly string[],
  registry: readonly RouteEntry[],
  exclusions: readonly RouteExclusion[],
  nonOperation: readonly NonOperationRoute[] = NON_OPERATION_ROUTES,
): string[] {
  const issues: string[] = [];
  const synthSet = new Set(synth);
  const legacy = new Set<string>();
  const endpoints = new Set<string>();
  const receivers = new Set<string>();
  for (const ex of exclusions) {
    const stale = `除外の行が要らない（${ex.until} が終えた。行を消す）`;
    if (ex.kind === "legacy") {
      legacy.add(ex.route);
      if (!synthSet.has(ex.route)) issues.push(`${stale}: 旧経路 ${ex.route} が合成に無い`);
      continue;
    }
    if (ex.kind === "receiver") {
      receivers.add(ex.receiver);
      const routes = nonOperation.filter((r) => r.receiver === ex.receiver).map((r) => r.route);
      if (routes.length === 0) issues.push(`${stale}: 操作でない受け口 ${ex.receiver} の経路が表に無い`);
      for (const k of routes.filter((k) => synthSet.has(k))) issues.push(`${stale}: 操作でない受け口 ${ex.receiver} の経路 ${k} が合成にある`);
      continue;
    }
    endpoints.add(ex.endpoint);
    const routes = registry.filter((r) => r.endpoint === ex.endpoint).map(routeKey);
    if (routes.length === 0) issues.push(`${stale}: 受け口 ${ex.endpoint} の経路が登録に無い`);
    for (const k of routes.filter((k) => synthSet.has(k))) issues.push(`${stale}: 受け口 ${ex.endpoint} の経路 ${k} が合成にある`);
  }
  const registryKeys = new Set(registry.map(routeKey));
  for (const r of nonOperation.filter((r) => registryKeys.has(r.route))) issues.push(`操作でない受け口の経路が登録にある: ${r.route}`);
  const deployedSynth = synth.filter((k) => !legacy.has(k));
  const deployedRegistry = registry.filter((r) => !endpoints.has(r.endpoint)).map(routeKey);
  const deployedReceivers = nonOperation.filter((r) => !receivers.has(r.receiver)).map((r) => r.route);
  issues.push(...difference(deployedRegistry, deployedSynth).map((k) => `登録にだけある経路: ${k}`));
  issues.push(...difference(deployedReceivers, deployedSynth).map((k) => `合成に無い操作でない受け口の経路: ${k}`));
  issues.push(...difference(deployedSynth, [...deployedRegistry, ...deployedReceivers]).map((k) => `合成にだけある経路: ${k}`));
  return issues;
}

/** 経路の登録（#2 の `generated/routes.json`）を読む。形が違えば止める */
function parseRegistry(raw: unknown): RouteEntry[] {
  const isEntry = (v: unknown): v is RouteEntry =>
    isRecord(v) && ["method", "path", "operation", "endpoint"].every((k) => typeof v[k] === "string");
  if (!Array.isArray(raw) || !raw.every(isEntry)) throw new Error(`経路の登録の形が違う（${REGISTRY}）`);
  return raw.map(({ method, path, operation, endpoint }) => ({ method, path, operation, endpoint }));
}

// ---- #2 の書き出しと生成物を照らしの入力へ写す ----

/** #2 の `OperationDef` のうち、写すのに読む項目。item と result は zod の形か、形の未定（`PendingShape`） */
type ContractOperation = {
  name: string;
  entity: string;
  endpoint: string;
  route: string;
  access: "read" | "write";
  humanOnly: HumanOnly;
  mcpRead: string | null;
  features: readonly string[];
  allOrNothing: { maxItems: number } | null;
  item: unknown;
  result: unknown;
};

/** #2 の `generated/dummy/index.json` の 1 行（`DummyDoc`）。形が未定の操作は null */
type DummyEntry = { normal: unknown[]; edge: unknown[]; empty: unknown; failures: unknown[] };

/** 写すのに要る #2 の書き出し。`resultSchemaOf` は成功と失敗の和の zod を返し、`isPending` は形の未定を見分ける */
type ContractsInput = {
  operations: readonly ContractOperation[];
  resultSchemaOf: (op: ContractOperation) => z.ZodType;
  isPending: (shape: unknown) => boolean;
  /** #2 の既定の要素の数の上限（`operation.ts` の `MAX_ITEMS`） */
  maxItems: number;
  dummy: Record<string, DummyEntry | null>;
  itemExamples: (item: z.ZodType, name: string) => unknown[];
};

/**
 * #2 の操作の表を照らしの入力へ写す。要素と結果のどちらも形が確定した操作だけが `shapes` を持つ。
 * 要素の見本は `itemExamples`、結果の見本はダミーの成功（正常・境目・空）と失敗の見本。確定した操作にダミーが無ければ当たりにする
 */
function operationViews(input: ContractsInput): { views: OperationView[]; issues: string[] } {
  const issues: string[] = [];
  const views = input.operations.map((op): OperationView => {
    const base = {
      name: op.name,
      entity: op.entity,
      endpoint: op.endpoint,
      method: "POST",
      route: op.route,
      access: op.access,
      humanOnly: op.humanOnly,
      mcpRead: op.mcpRead,
      features: op.features,
      maxItems: op.allOrNothing?.maxItems ?? input.maxItems,
    };
    if (input.isPending(op.item) || input.isPending(op.result)) return { ...base, shapes: null };
    const item = op.item as z.ZodType;
    const dummy = input.dummy[op.name];
    if (dummy === undefined || dummy === null) issues.push(`${op.name}: 形が確定しているが、ダミーの見本が無い`);
    const successes = dummy ? [...dummy.normal, ...dummy.edge, ...(dummy.empty === null ? [] : [dummy.empty])] : [];
    const failures = dummy?.failures ?? [];
    return {
      ...base,
      shapes: { item, result: input.resultSchemaOf(op), examples: { item: input.itemExamples(item, op.name), result: [...successes, ...failures] } },
    };
  });
  return { views, issues };
}

const ENDPOINTS = new Set(["user", "runner", "machine", "db_prep"]);
const HUMAN_ONLY = new Set(["always", "per_item", "never"]);

/** 読み込んだ操作の表の形を照らす。形が違えば止める（#2 の `OperationDef` の項目が変わったら写しを直す） */
function parseOperations(raw: unknown): ContractOperation[] {
  const isOperation = (v: unknown): v is ContractOperation =>
    isRecord(v) &&
    ["name", "entity", "route"].every((k) => typeof v[k] === "string") &&
    typeof v.endpoint === "string" &&
    ENDPOINTS.has(v.endpoint) &&
    (v.access === "read" || v.access === "write") &&
    typeof v.humanOnly === "string" &&
    HUMAN_ONLY.has(v.humanOnly) &&
    (v.mcpRead === null || typeof v.mcpRead === "string") &&
    Array.isArray(v.features) &&
    v.features.every((f) => typeof f === "string") &&
    (v.allOrNothing === null || (isRecord(v.allOrNothing) && Number.isInteger(v.allOrNothing.maxItems))) &&
    "item" in v &&
    "result" in v;
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(isOperation)) throw new Error(`操作の表の形が違う（${OPERATIONS} の OPERATIONS）`);
  return raw;
}

function parseDummy(raw: unknown): Record<string, DummyEntry | null> {
  const isEntry = (v: unknown): v is DummyEntry =>
    isRecord(v) && Array.isArray(v.normal) && Array.isArray(v.edge) && "empty" in v && Array.isArray(v.failures);
  if (!isRecord(raw) || !Object.values(raw).every((v) => v === null || isEntry(v))) throw new Error(`ダミーの見本の形が違う（${GENERATED.dummy}）`);
  return raw as Record<string, DummyEntry | null>;
}

function seedOf(name: string): number {
  return Number.parseInt(createHash("sha256").update(name).digest("hex").slice(0, 8), 16);
}

/** 要素の見本を zod の形から作る（#2 の operations-roundtrip.test.ts と同じ zod-schema-faker）。種は操作の名前から決める */
function fakeItems(item: z.ZodType, name: string): unknown[] {
  setFaker(faker);
  seed(seedOf(name));
  return Array.from({ length: ITEM_SAMPLES }, () => fake(item));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8"));
}

/**
 * #2 の書き出しを読む。`tools` は #2 の書き出しが入る前も型の検査を通るよう、置き場のファイルを実行の時に import し、形はここで照らす
 */
async function loadContracts(): Promise<ContractsInput> {
  const operations = (await import(pathToFileURL(join(ROOT, OPERATIONS)).href)) as { OPERATIONS?: unknown };
  const operation = (await import(pathToFileURL(join(ROOT, OPERATION)).href)) as { resultSchemaOf?: unknown; isPending?: unknown; MAX_ITEMS?: unknown };
  const { resultSchemaOf, isPending, MAX_ITEMS: maxItems } = operation;
  if (typeof resultSchemaOf !== "function" || typeof isPending !== "function" || typeof maxItems !== "number") {
    throw new Error(`${OPERATION} に resultSchemaOf・isPending・MAX_ITEMS が無い`);
  }
  return {
    operations: parseOperations(operations.OPERATIONS),
    resultSchemaOf: (op) => (resultSchemaOf as (op: unknown) => z.ZodType)(op),
    isPending: (shape) => (isPending as (shape: unknown) => boolean)(shape),
    maxItems,
    dummy: parseDummy(readJson(GENERATED.dummy)),
    itemExamples: fakeItems,
  };
}

function loadGenerated(): GeneratedView {
  const jsonSchema = readJson(GENERATED.jsonSchema) as GeneratedView["jsonSchema"];
  const openapi = readJson(GENERATED.openapi) as GeneratedView["openapi"];
  const mcpTools = readJson(GENERATED.mcpTools) as McpTool[];
  if (!isRecord(jsonSchema.$defs) || !isRecord(openapi.paths) || !isRecord(openapi.components.schemas) || !Array.isArray(mcpTools)) {
    throw new Error("生成物の形が違う（operations.schema.json・openapi.json・mcp-tools.json）");
  }
  return { jsonSchema, openapi, mcpTools, routes: parseRegistry(readJson(REGISTRY)) };
}

// ---- 作り物の操作の表と生成物（#2 の生成物と同じ包み方） ----

const MAX_ITEMS = 100;
const ALL_OR_NOTHING_MAX_ITEMS = 25;
const teamRef = z.strictObject({ team_id: z.string().min(1) });
/** 結果の中で 2 か所から使う形。JSON Schema では `$defs` に出て `$ref` で指される */
const member = z.strictObject({ user_id: z.string().min(1) });
const NOT_FOUND = { ok: false, status: 404, reason: "not_found" } as const;

/** #2 の `resultSchemaOf` と同じく、成功の封筒と失敗の要素を `ok` で分けた和にする */
function resultOf(success: z.ZodObject): z.ZodType {
  const failure = z.strictObject({
    ok: z.literal(false),
    status: z.literal(404),
    reason: z.literal("not_found"),
    fields: z.array(z.string()).optional(),
  });
  return z.discriminatedUnion("ok", [success as z.ZodObject<{ ok: z.ZodLiteral<true> }>, failure]);
}

type FakeInput = Omit<OperationView, "entity" | "method" | "route" | "mcpRead" | "maxItems" | "shapes"> & {
  mcpRead?: string;
  maxItems?: number;
  item: z.ZodType;
  success: z.ZodObject;
  examples: Record<Part, unknown>;
};

function fakeOperations(): OperationView[] {
  const op = ({ item, success, examples, mcpRead, maxItems, ...o }: FakeInput): OperationView => {
    const parts = o.name.split(".");
    return {
      ...o,
      entity: parts.at(-2) ?? "",
      method: "POST",
      route: `/v1/${parts.join("/")}`,
      mcpRead: mcpRead ?? null,
      maxItems: maxItems ?? MAX_ITEMS,
      shapes: { item, result: resultOf(success), examples: { item: [examples.item], result: [examples.result, { ...NOT_FOUND }] } },
    };
  };
  return [
    op({
      name: "teams.list",
      endpoint: "user",
      access: "read",
      humanOnly: "never",
      features: FEATURES.slice(0, 10),
      item: teamRef,
      success: z.strictObject({
        ok: z.literal(true),
        item: z.strictObject({
          team_id: z.string(),
          name: z.string(),
          created_at: z.iso.datetime(),
          tags: z.array(z.string()),
          owner: member,
          creator: member,
        }),
      }),
      examples: {
        item: { team_id: "team-1" },
        result: {
          ok: true,
          item: {
            team_id: "team-1",
            name: "acme",
            created_at: "2026-01-02T03:04:05Z",
            tags: ["a", "b"],
            owner: { user_id: "usr-1" },
            creator: { user_id: "usr-2" },
          },
        },
      },
    }),
    op({
      name: "teams.update",
      endpoint: "user",
      access: "write",
      humanOnly: "never",
      // 全部か無かの操作の上限（#2 の `allOrNothing.maxItems`）。既定の MAX_ITEMS と違う上限でも照らす
      maxItems: ALL_OR_NOTHING_MAX_ITEMS,
      features: FEATURES.slice(10, 15),
      item: z.strictObject({ team_id: z.string().min(1), name: z.string().min(1) }),
      success: z.strictObject({ ok: z.literal(true), item: z.strictObject({ team_id: z.string(), updated_at: z.iso.datetime() }) }),
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
      mcpRead: "teams.list",
      features: FEATURES.slice(15, 18),
      item: teamRef,
      success: z.strictObject({ ok: z.literal(true), item: teamRef }),
      examples: { item: { team_id: "team-1" }, result: { ok: true, item: { team_id: "team-1" } } },
    }),
    op({
      name: "invoices.get",
      endpoint: "user",
      access: "read",
      humanOnly: "per_item",
      features: FEATURES.slice(18),
      item: z.strictObject({ invoice_id: z.string().min(1) }),
      success: z.strictObject({
        ok: z.literal(true),
        item: z.strictObject({ amount_minor: z.number().int(), currency: z.string().length(3), issued_at: z.iso.datetime() }),
      }),
      examples: {
        item: { invoice_id: "inv-1" },
        result: { ok: true, item: { amount_minor: 1200, currency: "USD", issued_at: "2026-01-02T03:04:05Z" } },
      },
    }),
    op({
      name: "users.get",
      endpoint: "user",
      access: "read",
      humanOnly: "never",
      features: ["F1"],
      item: z.strictObject({ user_id: z.string().min(1) }),
      success: z.strictObject({ ok: z.literal(true), item: member }),
      examples: { item: { user_id: "usr-1" }, result: { ok: true, item: { user_id: "usr-1" } } },
    }),
    // 人だけの操作が、別のエンティティの読み出しを指す（#2 の sessions.create → users.get）
    op({
      name: "sessions.create",
      endpoint: "user",
      access: "write",
      humanOnly: "always",
      mcpRead: "users.get",
      features: ["F1"],
      item: z.strictObject({ code: z.string().min(1) }),
      success: z.strictObject({ ok: z.literal(true), item: member }),
      examples: { item: { code: "code-1" }, result: { ok: true, item: { user_id: "usr-1" } } },
    }),
    op({
      name: "runner.jobs.list",
      endpoint: "runner",
      access: "read",
      humanOnly: "never",
      features: [],
      item: z.strictObject({ job_id: z.string().min(1) }),
      success: z.strictObject({ ok: z.literal(true), item: z.strictObject({ job_id: z.string() }) }),
      examples: { item: { job_id: "job-1" }, result: { ok: true, item: { job_id: "job-1" } } },
    }),
  ];
}

/** zod の形の JSON Schema（最上位の `$schema` を外す）。2 か所から使う形は `$defs` に出して `$ref` で指す */
function toSchema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  const out: JsonSchema = { ...(z.toJSONSchema(schema, { io, reused: "ref" }) as JsonSchema) };
  delete out.$schema;
  return out;
}

/** 別の文書の中へ埋め込む形の `$ref` を付け替える。from を指す参照とその下を指す参照を、to の下へ移す（#2 の `rebaseRefs` と同じ） */
function rebaseRefs(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) return value.map((v) => rebaseRefs(v, from, to));
  if (!isRecord(value)) return value;
  const prefix = from === "#" ? "#/" : `${from}/`;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      k === "$ref" && typeof v === "string" && (v === from || v.startsWith(prefix)) ? `${to}${v.slice(from.length)}` : rebaseRefs(v, from, to),
    ]),
  );
}

function jsonBody(schema: JsonSchema): JsonBody {
  return { content: { "application/json": { schema } } };
}

/**
 * 作り物の操作の表から、揃った生成物を作る（#2 の生成物と同じ包み方）。JSON Schema はすべての操作、OpenAPI は受け口 user の操作だけ、
 * MCP の道具は人だけでない受け口 user の操作だけを持つ。MCP の入力は配列の包みと件数だけを持ち、要素の形を持たない
 */
function fakeGenerated(ops: readonly OperationView[]): GeneratedView {
  const defs: Record<string, JsonSchema> = {};
  for (const op of ops) {
    if (op.shapes === null) {
      for (const part of PARTS) defs[defKey(op.name, part)] = { not: {} };
      continue;
    }
    for (const part of PARTS) {
      const key = defKey(op.name, part);
      defs[key] = rebaseRefs(toSchema(op.shapes[part], part === "item" ? "input" : "output"), "#", `#/$defs/${key}`) as JsonSchema;
    }
  }
  const components = JSON.parse(JSON.stringify(defs).replaceAll('"#/$defs/', '"#/components/schemas/')) as Record<string, JsonSchema>;
  const ref = (key: string): JsonSchema => ({ $ref: `#/components/schemas/${key}` });
  const paths: GeneratedView["openapi"]["paths"] = {};
  for (const op of ops.filter(hasOpenApi)) {
    paths[op.route] = {
      [op.method.toLowerCase()]: {
        operationId: op.name,
        requestBody: jsonBody({ type: "array", minItems: 1, maxItems: op.maxItems, items: ref(defKey(op.name, "item")) }),
        responses: { "200": jsonBody({ type: "array", items: ref(defKey(op.name, "result")) }) },
      },
    };
  }
  const mcpTools = ops.filter(hasMcp).map((op) => {
    const key = defKey(op.name, "result");
    return {
      name: op.name,
      inputSchema: {
        type: "object",
        properties: { items: { type: "array", minItems: 1, maxItems: op.maxItems } },
        required: ["items"],
      },
      outputSchema: { type: "array", items: rebaseRefs(defs[key], `#/$defs/${key}`, "#/items") as JsonSchema },
    };
  });
  return {
    jsonSchema: { $defs: defs },
    openapi: { paths, components: { schemas: components } },
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

/** 結果の和のうち、成功の封筒の `item` の形（`ok` が true の選択肢） */
function successItem(defs: Record<string, JsonSchema>, key: string): JsonSchema {
  const branches = schemaAt(defs, [key, "oneOf"]) as unknown as JsonSchema[];
  const success = branches.find((b) => schemaAt(b, ["properties", "ok"]).const === true);
  if (success === undefined) throw new Error(`${key} に成功の選択肢が無い`);
  return schemaAt(success, ["properties", "item"]);
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

function find(ops: readonly OperationView[], name: string): OperationView {
  const op = ops.find((o) => o.name === name);
  if (op === undefined) throw new Error(`作り物の表に ${name} が無い`);
  return op;
}

function shapesOf(op: OperationView): OperationShapes {
  if (op.shapes === null) throw new Error(`${op.name} の形が未定`);
  return op.shapes;
}

// ---- 作り物の入力のテスト ----

describe("照らすこと 1: 見本と変形を 4 つの形で検証し、通るか拒むかが揃う", () => {
  it("揃った表で当たりが 0 件", () => {
    const ops = fakeOperations();
    expect(roundTripIssues(ops, fakeGenerated(ops))).toEqual([]);
  });

  it("変形は見本を辿り、項目（必須の項目を含む）を 1 つずつ消し、型を変え、知らない項目を足し、配列を最初の 1 件の値にする", () => {
    const [example] = shapesOf(find(fakeOperations(), "teams.list")).examples.result;
    const labels = mutate(example).map((m) => m.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        "ok を消す",
        "item.team_id を消す",
        "item.owner.user_id を消す",
        "ok の型を変える",
        "知らない項目を足す",
        "item.tags.配列を最初の 1 件の値にする",
      ]),
    );
  });

  it("人だけでない利用者向けの操作は 4 つの形、人だけの操作は MCP を除く 3 つの形、機械向けの操作は zod と JSON Schema の 2 つの形で比べる", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    const forms = (name: string) => {
      const op = find(ops, name);
      return [...new Set(representationsOf(op, shapesOf(op), generated).map((r) => r.form))];
    };
    expect(forms("teams.list")).toEqual(["zod", "json-schema", "openapi", "mcp"]);
    expect(forms("teams.delete")).toEqual(["zod", "json-schema", "openapi"]);
    expect(forms("runner.jobs.list")).toEqual(["zod", "json-schema"]);
  });

  it("形が未定の操作は見本の往復に入れない", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    find(ops, "teams.update").shapes = null;
    expect(roundTripIssues(ops, generated)).toEqual([]);
  });

  it("空の配列の見本は、配列の変形を作らずに通る", () => {
    const ops = fakeOperations();
    const [result] = shapesOf(find(ops, "teams.list")).examples.result as [{ item: { tags: string[] } }];
    result.item.tags = [];
    expect(roundTripIssues(ops, fakeGenerated(ops))).toEqual([]);
  });

  it("JSON Schema だけ要素の必須の項目を外すと、食い違いが 1 件", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    const item = schemaAt(generated.jsonSchema.$defs, ["teams.update.item"]);
    item.required = (item.required as string[]).filter((k) => k !== "team_id");
    const issues = roundTripIssues(ops, generated);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("teams.update の要素（team_id を消す）");
    expect(issues[0]).toContain("json-schema");
  });

  it("成功と失敗の和の結果で、JSON Schema だけ成功の item の内側の必須の項目を外すと、食い違いが 1 件", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    const item = successItem(generated.jsonSchema.$defs, "teams.update.result");
    item.required = (item.required as string[]).filter((k) => k !== "updated_at");
    const issues = roundTripIssues(ops, generated);
    expect(issues).toEqual(["teams.update の結果 0（item.updated_at を消す）: json-schema は通し zod・openapi・mcp は拒む"]);
  });

  it("参照（$ref）の先の形で、JSON Schema だけ必須の項目を外すと、参照する 2 か所で食い違う", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    const shared = Object.values(schemaAt(generated.jsonSchema.$defs, ["teams.list.result", "$defs"])) as JsonSchema[];
    expect(shared).toHaveLength(1);
    for (const s of shared) s.required = [];
    expect(roundTripIssues(ops, generated)).toEqual([
      "teams.list の結果 0（item.owner.user_id を消す）: json-schema は通し zod・openapi・mcp は拒む",
      "teams.list の結果 0（item.creator.user_id を消す）: json-schema は通し zod・openapi・mcp は拒む",
    ]);
  });

  it("失敗の見本を形が拒むと、見本が拒まれたことが 1 件", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    shapesOf(find(ops, "teams.update")).examples.result[1] = { ok: false, status: 409, reason: "not_found" };
    expect(roundTripIssues(ops, generated)).toEqual(["teams.update の結果 1: 見本を zod・json-schema・openapi・mcp が拒む"]);
  });

  it("4 つの形がそろって見本を拒むと、見本が拒まれたことが 1 件", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    shapesOf(find(ops, "teams.update")).examples.item = [{}];
    expect(roundTripIssues(ops, generated)).toEqual(["teams.update の要素: 見本を zod・json-schema・openapi・mcp が拒む"]);
  });

  it("MCP の入力が要素の形を持たず、包みが必須の項目を消した要素を受けても、dispatch の要素の検査が拒むので食い違わない", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    const tool = generated.mcpTools.find((t) => t.name === "teams.update") as McpTool;
    expect(jsonValidator(tool.inputSchema)({ items: [{ name: "acme" }] })).toBe(true);
    expect(roundTripIssues(ops, generated)).toEqual([]);
  });

  it("MCP の包みの件数の上限が OpenAPI の要求と違うと、食い違いが 1 件", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    const tool = generated.mcpTools.find((t) => t.name === "teams.update") as McpTool;
    delete schemaAt(tool.inputSchema, ["properties", "items"]).maxItems;
    const n = ALL_OR_NOTHING_MAX_ITEMS + 1;
    expect(roundTripIssues(ops, generated)).toEqual([`teams.update の要求の件数（${String(n)} 件、上限 ${String(ALL_OR_NOTHING_MAX_ITEMS)}）: mcp が通す`]);
  });

  it("OpenAPI の要求の maxItems だけが欠けると、MCP に上限が残っていても、上限を越える件数で 1 件", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    const post = generated.openapi.paths["/v1/teams/list"]?.post as OpenApiOperation;
    delete bodySchema(post.requestBody).maxItems;
    expect(roundTripIssues(ops, generated)).toEqual([`teams.list の要求の件数（${String(MAX_ITEMS + 1)} 件、上限 ${String(MAX_ITEMS)}）: openapi が通す`]);
  });

  it("人だけの操作（MCP の道具が無い）の OpenAPI の要求の maxItems が欠けても 1 件", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    const post = generated.openapi.paths["/v1/teams/delete"]?.post as OpenApiOperation;
    delete bodySchema(post.requestBody).maxItems;
    expect(roundTripIssues(ops, generated)).toEqual([`teams.delete の要求の件数（${String(MAX_ITEMS + 1)} 件、上限 ${String(MAX_ITEMS)}）: openapi が通す`]);
  });

  it("生成物の上限が両方とも操作の定義の上限と違うと、形どうしが揃っていても 1 件", () => {
    const ops = fakeOperations();
    find(ops, "teams.update").maxItems = MAX_ITEMS;
    const generated = fakeGenerated(ops);
    find(ops, "teams.update").maxItems = ALL_OR_NOTHING_MAX_ITEMS;
    expect(roundTripIssues(ops, generated)).toEqual([
      `teams.update の要求の件数（${String(ALL_OR_NOTHING_MAX_ITEMS + 1)} 件、上限 ${String(ALL_OR_NOTHING_MAX_ITEMS)}）: openapi・mcp が通す`,
    ]);
  });

  it("MCP の包みが items を必須にしないと 1 件", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    const tool = generated.mcpTools.find((t) => t.name === "teams.update") as McpTool;
    delete tool.inputSchema.required;
    expect(roundTripIssues(ops, generated)).toEqual(["teams.update の MCP の包み: items の無い入力を通す"]);
  });

  it("形が生成物に無い操作は、無いことが 1 件", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    generated.mcpTools = generated.mcpTools.filter((t) => t.name !== "invoices.get");
    expect(roundTripIssues(ops, generated)).toEqual(["invoices.get: MCP の道具が無い"]);
  });

  it("利用者向けの操作が OpenAPI に無いと 1 件。機械向けの操作は OpenAPI に無くても当たらない", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    expect(generated.openapi.paths["/v1/runner/jobs/list"]).toBeUndefined();
    delete generated.openapi.paths["/v1/teams/update"];
    expect(roundTripIssues(ops, generated)).toEqual(["teams.update: OpenAPI に POST /v1/teams/update が無い"]);
  });
});

describe("照らすこと 1: 設定のファイルの見本と変形を zod と JSON Schema で検証する", () => {
  const example = { prefix: "acme", environment: "test", login: { google: {} } };

  it("揃った形で当たりが 0 件", () => {
    expect(schemaPairIssues("設定のファイル", settingsSchema, toSchema(settingsSchema, "output"), example)).toEqual([]);
  });

  it("JSON Schema だけ必須の項目を外すと、食い違いが 1 件", () => {
    const schema = toSchema(settingsSchema, "output");
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

describe("照らすこと 3: 人だけの操作ごとに、mcpRead が指す読み出しが実在し、MCP の道具として公開される", () => {
  it("揃った表で 0 件（別のエンティティの読み出しを指す sessions.create → users.get を含む）", () => {
    const ops = fakeOperations();
    expect(humanOnlyReadIssues(ops, fakeGenerated(ops))).toEqual([]);
  });

  it("指す読み出しを表から消すと、同じエンティティの読む操作が残っても 1 件", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    find(ops, "teams.delete").mcpRead = "teams.get";
    expect(ops.some((o) => o.entity === "teams" && o.access === "read" && o.humanOnly !== "always")).toBe(true);
    expect(humanOnlyReadIssues(ops, generated)).toEqual(["人だけの操作 teams.delete の読み出し teams.get が操作の表に無い"]);
  });

  it("指す読み出しの MCP の道具が無いと 1 件", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    generated.mcpTools = generated.mcpTools.filter((t) => t.name !== "users.get");
    expect(humanOnlyReadIssues(ops, generated)).toEqual(["人だけの操作 sessions.create の読み出し users.get が MCP の道具に無い"]);
  });

  it("指す操作が読む操作でない・人だけ・機械向けだとそれぞれ当たる。指定が無いと 1 件", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    find(ops, "teams.delete").mcpRead = "teams.update";
    find(ops, "sessions.create").mcpRead = "runner.jobs.list";
    expect(humanOnlyReadIssues(ops, generated)).toEqual([
      "人だけの操作 teams.delete の読み出し teams.update が読む操作でない",
      "人だけの操作 sessions.create の読み出し runner.jobs.list が利用者向けでない",
      "人だけの操作 sessions.create の読み出し runner.jobs.list が MCP の道具に無い",
    ]);
    find(ops, "teams.delete").mcpRead = "sessions.create";
    find(ops, "sessions.create").mcpRead = null;
    expect(humanOnlyReadIssues(ops, generated)).toEqual([
      "人だけの操作 teams.delete の読み出し sessions.create が人だけの操作",
      "人だけの操作 teams.delete の読み出し sessions.create が読む操作でない",
      "人だけの操作 teams.delete の読み出し sessions.create が MCP の道具に無い",
      "人だけの操作 sessions.create に読み出しの指定（mcpRead）が無い",
    ]);
  });
});

describe("照らすこと 4: F1〜F20 がどれかの操作の機能にある", () => {
  it("揃った表で 0 件", () => {
    expect(featureIssues(fakeOperations())).toEqual([]);
  });

  it("機能を 1 つ消すと 1 件", () => {
    const ops = fakeOperations();
    const teamsUpdate = find(ops, "teams.update");
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
    expect(arrayShapeIssues(ops, generated)).toEqual([
      "teams.update の要求の形が配列でない",
      `teams.update の OpenAPI の要求の件数の範囲が操作の定義（1〜${String(ALL_OR_NOTHING_MAX_ITEMS)} 件）と違う: undefined〜undefined`,
    ]);
  });

  it("形が未定の操作でも、OpenAPI の要求の maxItems が欠けると 1 件", () => {
    const ops = fakeOperations();
    find(ops, "teams.delete").shapes = null;
    const generated = fakeGenerated(ops);
    const post = generated.openapi.paths["/v1/teams/delete"]?.post as OpenApiOperation;
    delete bodySchema(post.requestBody).maxItems;
    expect(arrayShapeIssues(ops, generated)).toEqual(["teams.delete の OpenAPI の要求の件数の範囲が操作の定義（1〜100 件）と違う: 1〜undefined"]);
  });

  it("MCP の道具の入力の上限が全部か無かの上限と違うと 1 件", () => {
    const ops = fakeOperations();
    const generated = fakeGenerated(ops);
    const tool = generated.mcpTools.find((t) => t.name === "teams.update") as McpTool;
    schemaAt(tool.inputSchema, ["properties", "items"]).maxItems = MAX_ITEMS;
    expect(arrayShapeIssues(ops, generated)).toEqual([
      `teams.update の MCP の道具の入力の items の件数の範囲が操作の定義（1〜${String(ALL_OR_NOTHING_MAX_ITEMS)} 件）と違う: 1〜100`,
    ]);
  });
});

describe("照らすこと 6: `_at` の項目は UTC の日時、`amount_minor` を持つ要素は `currency` を必須にする（I15）", () => {
  it("揃った表で 0 件", () => {
    expect(timeAndMoneyIssues(fakeGenerated(fakeOperations()))).toEqual([]);
  });

  it("時刻帯の無い日時を通す形にすると 1 件", () => {
    const generated = fakeGenerated(fakeOperations());
    schemaAt(successItem(generated.jsonSchema.$defs, "teams.list.result"), ["properties"]).created_at = { type: "string" };
    expect(timeAndMoneyIssues(generated)).toEqual(["teams.list.result.item.created_at: UTC の日時の形でない"]);
  });

  it("UTC でない時刻帯の日時を通す形にすると 1 件", () => {
    const generated = fakeGenerated(fakeOperations());
    schemaAt(successItem(generated.jsonSchema.$defs, "teams.update.result"), ["properties"]).updated_at = { type: "string", format: "date-time" };
    expect(timeAndMoneyIssues(generated)).toEqual(["teams.update.result.item.updated_at: UTC の日時の形でない"]);
  });

  it("参照（$ref）の先の形の日時も照らす", () => {
    const generated = fakeGenerated(fakeOperations());
    const shared = Object.entries(schemaAt(generated.jsonSchema.$defs, ["teams.list.result", "$defs"]));
    const [name, schema] = shared[0] as [string, JsonSchema];
    schemaAt(schema, ["properties"]).joined_at = { type: "string" };
    expect(timeAndMoneyIssues(generated)).toEqual([`teams.list.result.$defs.${name}.joined_at: UTC の日時の形でない`]);
  });

  it("通貨の無い金額を通す形にすると 1 件", () => {
    const generated = fakeGenerated(fakeOperations());
    const item = successItem(generated.jsonSchema.$defs, "invoices.get.result");
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

describe("#2 の書き出しと生成物を照らしの入力へ写す", () => {
  const PENDING = { kind: "pending" } as const;
  const isPending = (shape: unknown) => isRecord(shape) && shape.kind === "pending";
  const contract = (name: string, endpoint: string, shaped: boolean): ContractOperation => {
    const parts = name.split(".");
    return {
      name,
      entity: parts.at(-2) ?? "",
      endpoint,
      route: `/v1/${parts.join("/")}`,
      access: "read",
      humanOnly: "never",
      mcpRead: null,
      features: endpoint === "user" ? ["F1"] : [],
      allOrNothing: null,
      item: shaped ? teamRef : PENDING,
      result: shaped ? z.strictObject({ ok: z.literal(true), item: teamRef }) : PENDING,
    };
  };
  const dummy: DummyEntry = { normal: [{ ok: true, item: { team_id: "team-1" } }], edge: [], empty: { ...NOT_FOUND }, failures: [{ ...NOT_FOUND }] };
  const input = (ops: ContractOperation[], entries: Record<string, DummyEntry | null>): ContractsInput => ({
    operations: ops,
    resultSchemaOf: (op) => resultOf(op.result as z.ZodObject),
    isPending,
    maxItems: MAX_ITEMS,
    dummy: entries,
    itemExamples: fakeItems,
  });

  it("形が未定の操作は shapes を持たず、確定した操作は要素の見本と成功・失敗の見本を持つ", () => {
    const { views, issues } = operationViews(input([contract("teams.get", "user", true), contract("runner.jobs.list", "runner", false)], { "teams.get": dummy }));
    expect(issues).toEqual([]);
    expect(views.map((v) => [v.name, v.method, v.route, v.shapes === null])).toEqual([
      ["teams.get", "POST", "/v1/teams/get", false],
      ["runner.jobs.list", "POST", "/v1/runner/jobs/list", true],
    ]);
    const shapes = shapesOf(views[0] as OperationView);
    expect(shapes.examples.result).toEqual([...dummy.normal, dummy.empty, ...dummy.failures]);
    expect(shapes.examples.item).toHaveLength(ITEM_SAMPLES);
    for (const v of shapes.examples.item) expect(teamRef.safeParse(v).success).toBe(true);
    expect(shapes.result.safeParse(NOT_FOUND).success).toBe(true);
  });

  it("写した表と、#2 と同じ包み方の生成物で、照らすこと 1〜7 の当たりが 0 件（F1 のほかの機能だけが欠ける）", () => {
    const { views } = operationViews(input([contract("teams.get", "user", true), contract("runner.jobs.list", "runner", false)], { "teams.get": dummy }));
    const issues = operationIssues(views, fakeGenerated(views));
    expect(issues).toEqual(FEATURES.slice(1).map((f) => `どの操作の機能にも無い: ${f}`));
  });

  it("要素の数の上限は、全部か無かの操作は allOrNothing.maxItems、ほかは既定の MAX_ITEMS", () => {
    const allOrNothing = { ...contract("teams.update", "user", false), access: "write" as const, allOrNothing: { maxItems: 7 } };
    const { views } = operationViews(input([contract("teams.get", "user", false), allOrNothing], {}));
    expect(views.map((v) => [v.name, v.maxItems])).toEqual([
      ["teams.get", MAX_ITEMS],
      ["teams.update", 7],
    ]);
  });

  it("形が確定した操作にダミーの見本が無いと 1 件", () => {
    const { issues } = operationViews(input([contract("teams.get", "user", true)], { "teams.get": null }));
    expect(issues).toEqual(["teams.get: 形が確定しているが、ダミーの見本が無い"]);
  });

  it("操作の表とダミーの見本の形を読む。形が違えば止める", () => {
    expect(parseOperations([contract("teams.get", "user", false)])).toHaveLength(1);
    expect(() => parseOperations([{ ...contract("teams.get", "user", false), endpoint: "admin" }])).toThrow(/操作の表の形が違う/);
    expect(() => parseOperations([])).toThrow(/操作の表の形が違う/);
    expect(() => parseOperations([{ ...contract("teams.get", "user", false), allOrNothing: undefined }])).toThrow(/操作の表の形が違う/);
    expect(parseDummy({ "teams.get": dummy, "teams.list": null })).toEqual({ "teams.get": dummy, "teams.list": null });
    expect(() => parseDummy({ "teams.get": { normal: [] } })).toThrow(/ダミーの見本の形が違う/);
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

  it("除外の表が空で、合成が登録の経路と操作でない受け口の経路に完全に揃った組で 0 件", () => {
    const keys = [...FAKE_REGISTRY.map((r) => `${r.method} ${r.path}`), ...NON_OPERATION_ROUTES.map((r) => r.route)];
    expect(synthRouteIssues(templateRoutes(fakeTemplate(keys)), FAKE_REGISTRY, [])).toEqual([]);
  });

  it("操作でない受け口（POST /mcp・POST /v1/github/webhooks）は登録に無くても、反映した後の比べで登録にだけある経路にも合成にだけある経路にもならない", () => {
    const keys = [...FAKE_REGISTRY.map((r) => `${r.method} ${r.path}`), ...NON_OPERATION_ROUTES.map((r) => r.route)];
    expect(NON_OPERATION_ROUTES.map((r) => r.route)).toEqual(expect.arrayContaining(["POST /mcp", "POST /v1/github/webhooks"]));
    expect(FAKE_REGISTRY.map(routeKey)).not.toContain("POST /mcp");
    expect(synthRouteIssues(keys, FAKE_REGISTRY, [])).toEqual([]);
  });

  it("除外を外した操作でない受け口の経路が合成に無いと 1 件", () => {
    const keys = [...synth, ...NON_OPERATION_ROUTES.filter((r) => r.route !== "POST /v1/github/webhooks").map((r) => r.route)];
    const exclusions = ROUTE_EXCLUSIONS.filter((e) => e.kind !== "receiver");
    expect(synthRouteIssues(keys, FAKE_REGISTRY, exclusions)).toEqual(["合成に無い操作でない受け口の経路: POST /v1/github/webhooks"]);
  });

  it("除外した操作でない受け口の経路が合成にあると、除外の行が要らないと 1 件", () => {
    expect(synthRouteIssues([...synth, "POST /mcp"], FAKE_REGISTRY, ROUTE_EXCLUSIONS)).toEqual([
      "除外の行が要らない（#4 が終えた。行を消す）: 操作でない受け口 mcp の経路 POST /mcp が合成にある",
      "合成にだけある経路: POST /mcp",
    ]);
  });

  it("操作でない受け口の経路が登録にもあると 1 件", () => {
    const registry = [...FAKE_REGISTRY, { method: "POST", path: "/mcp", operation: "mcp", endpoint: "user" }];
    expect(synthRouteIssues(synth, registry, ROUTE_EXCLUSIONS)).toContain("操作でない受け口の経路が登録にある: POST /mcp");
  });

  it("除外の表が空なら、旧経路は合成にだけある経路として 1 件", () => {
    const registry = FAKE_REGISTRY.filter((r) => r.endpoint === "user");
    const keys = [...synth, ...registry.map((r) => `${r.method} ${r.path}`)];
    expect(synthRouteIssues([...keys, ...NON_OPERATION_ROUTES.map((r) => r.route)], registry, [])).toEqual(["合成にだけある経路: PUT /v1/users"]);
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
    const schema = readJson(SETTINGS_SCHEMA) as JsonSchema;
    const example = readJson(SETTINGS_EXAMPLE);
    expect(schemaPairIssues(SETTINGS_SCHEMA, settingsSchema, schema, example)).toEqual([]);
  });

  const hasOperations = existsSync(join(ROOT, OPERATIONS));
  it.skipIf(!hasOperations)(
    hasOperations
      ? "照らすこと 1〜7: #2 の操作の表と生成物を照らす（見本の往復は形が確定した操作だけ）"
      : `相手が無い: #2 の操作の表の書き出し（${OPERATIONS}）が無いので、照らすこと 1〜7 をリポジトリの表に打たない`,
    async () => {
      const { views, issues } = operationViews(await loadContracts());
      expect(views.length).toBeGreaterThan(0);
      expect([...issues, ...operationIssues(views, loadGenerated())]).toEqual([]);
    },
    SYNTH_TIMEOUT,
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
      ? "合成した経路から除外の旧経路を引いた集まりが、経路の登録から除外の受け口の経路を引き、除外していない操作でない受け口の経路を足した集まりと等しい"
      : `相手が無い: 経路の登録（${REGISTRY}）が無いので、合成した経路と登録の比べを飛ばす`,
    () => {
      const registry = parseRegistry(readJson(REGISTRY));
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
