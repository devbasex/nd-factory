import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildDummy,
  buildMcpTools,
  buildOpenApi,
  buildOperationSchemas,
  buildPending,
  buildReasons,
  buildRoutes,
  checkExamples,
  edgeOf,
  examplesOf,
  fakeExamples,
} from "../scripts/artifacts.ts";
import { idOf } from "../src/ids.ts";
import { defineOperation, itemReasonsOf, okItem, okList, type OperationDef, pendingShape, resultSchemaOf } from "../src/operation.ts";
import { OPERATIONS } from "../src/operations/index.ts";
import { settingsSchema } from "../src/settings.ts";
import { awsAccountId, money } from "../src/values.ts";
import { FIXTURE_CREATE, FIXTURE_LIST, FIXTURE_OPERATIONS } from "./fixtures/operations.ts";

const ALL: readonly OperationDef[] = [...OPERATIONS, ...FIXTURE_OPERATIONS];

// JSON Schema の値が参照のキーワード $ref を持つか。列挙値・定数などの値と、properties などの名前の鍵は $ref と見ない
const DATA_KEYWORDS = new Set(["enum", "const", "default", "examples", "example"]);
const NAME_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
function hasRefKeyword(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(hasRefKeyword);
  if (schema === null || typeof schema !== "object") return false;
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$ref") return true;
    if (DATA_KEYWORDS.has(key)) continue;
    if (NAME_MAP_KEYWORDS.has(key) && value !== null && typeof value === "object") {
      if (Object.values(value).some(hasRefKeyword)) return true;
      continue;
    }
    if (hasRefKeyword(value)) return true;
  }
  return false;
}

// JSON Schema の値が持つ $ref の参照先の文字列を集める。列挙値・定数などの値と、properties などの名前の鍵は $ref と見ない
function refsOf(schema: unknown, out: string[] = []): string[] {
  if (Array.isArray(schema)) {
    for (const value of schema) refsOf(value, out);
    return out;
  }
  if (schema === null || typeof schema !== "object") return out;
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$ref") {
      if (typeof value === "string") out.push(value);
      continue;
    }
    if (DATA_KEYWORDS.has(key)) continue;
    if (NAME_MAP_KEYWORDS.has(key) && value !== null && typeof value === "object") {
      for (const inner of Object.values(value)) refsOf(inner, out);
      continue;
    }
    refsOf(value, out);
  }
  return out;
}

// components.schemas の roots から #/components/schemas/ の $ref をたどって届く名前（roots 自身は含めない）
const COMPONENT_REF = "#/components/schemas/";
function reachableComponents(schemas: Record<string, unknown>, roots: readonly string[]): Set<string> {
  const seen = new Set<string>(roots);
  const reached = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.shift()!;
    for (const ref of refsOf(schemas[name])) {
      if (!ref.startsWith(COMPONENT_REF)) continue;
      const target = decodeURIComponent(ref.slice(COMPONENT_REF.length)).replaceAll("~1", "/").replaceAll("~0", "~");
      if (seen.has(target)) continue;
      seen.add(target);
      reached.add(target);
      queue.push(target);
    }
  }
  return reached;
}

// buildOpenApi の components.schemas のうち、再帰しない形（$defs の値に $ref を持たない形。z.toJSONSchema は再帰だけを $ref で出す）が $defs と同じ値か。
// 再帰する形が無ければ components.schemas の名前は problem と操作の名前だけ。再帰する形があるときは、zod-openapi が再帰を切り出す __schemaN のうち、
// 再帰する形から $ref をたどって届くものだけを余分に許し、再帰する形の値は照らさない。schemas は混入を照らすテストが差し替えるためのもの
function expectFlatSchemasMatchDefs(
  ops: readonly OperationDef[],
  schemas: Record<string, unknown> = buildOpenApi(ops).components?.schemas ?? {},
): void {
  const defs = buildOperationSchemas(ops).$defs;
  const names = ops.filter((op) => op.endpoint === "user").flatMap((op) => [`${op.name}.item`, `${op.name}.result`]);
  expect(Object.keys(defs)).toEqual(expect.arrayContaining(names));
  const flat = names.filter((name) => !hasRefKeyword(defs[name]));
  expect(flat.length).toBeGreaterThan(0);
  const expected = ["problem", ...names].sort();
  if (flat.length === names.length) {
    expect(Object.keys(schemas).sort()).toEqual(expected);
  } else {
    expect(Object.keys(schemas)).toEqual(expect.arrayContaining(expected));
    const recursive = names.filter((name) => !flat.includes(name));
    const reachable = reachableComponents(schemas, recursive);
    const extra = Object.keys(schemas).filter((name) => !expected.includes(name));
    for (const name of extra) {
      expect(name).toMatch(/^__schema\d+$/);
      expect(reachable.has(name), `${name} は再帰する形から $ref で届かない`).toBe(true);
    }
  }
  for (const name of flat) expect(schemas[name], name).toEqual(defs[name]);
}

describe("hasRefKeyword", () => {
  it.each([
    ["列挙値の $ref", { type: "string", enum: ["$ref"] }, false],
    ["定数の $ref", { const: { $ref: "#" } }, false],
    ["$ref という名前の項目", { type: "object", properties: { $ref: { type: "string" } }, required: ["$ref"] }, false],
    ["項目の値の $ref", { type: "object", properties: { $ref: { $ref: "#/$defs/a" } } }, true],
    ["配列の要素の $ref", { type: "array", items: { $ref: "#" } }, true],
    ["anyOf の中の $ref", { anyOf: [{ type: "null" }, { $ref: "#/$defs/a" }] }, true],
  ] as const)("%s は %s", (_label, schema, expected) => {
    expect(hasRefKeyword(schema)).toBe(expected);
  });
});

const UUID_V7 = "01935b4e-7c2a-7d10-8f3e-2b6f0c9a1d42";

// 見本を書いた操作。値の形と作り物の値の決まりを照らす
function withExamples(value: Record<string, unknown>): OperationDef {
  return defineOperation({
    name: "fixture_bills.update",
    features: ["F1"],
    access: "write",
    delegationKind: "manage",
    item: z.strictObject({ bill_id: idOf("prj") }),
    result: okItem(z.strictObject({ bill_id: idOf("prj"), note: z.string(), budget: money })),
    examples: { normal: [{ ok: true, item: { bill_id: `prj_${UUID_V7}`, note: "ops@example.com 123456789012", budget: { amount_minor: 1, currency: "USD" }, ...value } }], edge: [] },
    owner: "#2",
  });
}

describe("checkExamples", () => {
  it("作り物の値だけの見本と生成した見本は問題 0", () => {
    expect(checkExamples([withExamples({}), ...FIXTURE_OPERATIONS, ...OPERATIONS])).toEqual([]);
  });

  it.each([
    ["通貨の無い金額", { budget: { amount_minor: 1 } }, "結果の形に合わない"],
    ["ghs_ の値", { note: "ghs_abcdefABCDEF0123" }, "github_app_token"],
    ["作り物でないメール", { note: "ops@corp.test" }, "example.com"],
    ["12 桁の別の数", { note: "acct 210987654321" }, "123456789012"],
  ])("%s で問題が出る", (_label, value, needle) => {
    const problems = checkExamples([withExamples(value)]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ operation: "fixture_bills.update", scene: "normal", index: 0 });
    expect(problems[0]?.problem).toContain(needle);
  });

  it.each([
    ["最終の組がすべて数字の UUID", { note: `ntc_01935b4e-0000-7000-8000-123456789013` }],
    ["接頭辞の無い UUID", { note: "01935b4e-0000-7000-8000-210987654321" }],
    ["メンション", { note: "@acme/factory" }],
    ["版の付いた包み", { note: "pkg@1.2.3" }],
    ["末尾の句読点", { note: "ops@example.com." }],
    ["下位の域名", { note: "ops@mail.example.com" }],
    ["repo@ref", { note: "factory@main" }],
  ])("%s は作り物の値の決まりに当たらない", (_label, value) => {
    expect(checkExamples([withExamples(value)])).toEqual([]);
  });

  it.each([
    ["UUID の隣の 12 桁", { note: "01935b4e-0000-7000-8000-000000000000 acct 210987654321" }, "123456789012"],
    ["文の中の作り物でないメール", { note: "連絡は ops@corp.test まで。" }, "example.com"],
    ["作り物の域名に似た域名", { note: "ops@example.com.evil.test" }, "example.com"],
  ])("%s は問題が出る", (_label, value, needle) => {
    const problems = checkExamples([withExamples(value)]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.problem).toContain(needle);
  });

  it.each([
    ["作り物でないメール", { note: "someone@corp.test" }, ["someone", "corp.test"]],
    ["12 桁の別の数", { note: "acct 210987654321" }, ["210987654321"]],
    ["形に合わない値", { note: "a" + "1".repeat(3), budget: { amount_minor: "210987654321", currency: "USD" } }, ["210987654321"]],
  ])("%s の診断は当たった値を含めない", (_label, value, secrets) => {
    const problems = checkExamples([withExamples(value)]);
    expect(problems.length).toBeGreaterThan(0);
    for (const p of problems) for (const secret of secrets) expect(p.problem).not.toContain(secret);
  });

  it("空の場面の書いた見本も結果の形で照らす", () => {
    const op = defineOperation({ ...FIXTURE_LIST, name: "fixture_notes.list", examples: { empty: { ok: true, items: [] } }, owner: "#2" });
    expect(checkExamples([op])).toEqual([expect.objectContaining({ scene: "empty", index: 0 })]);
  });

  it("list・get でない操作に書いた empty も結果の形と作り物の値の決まりで照らす", () => {
    const written = (empty: unknown) => defineOperation({ ...FIXTURE_CREATE, name: "fixture_notes.create", examples: { empty }, owner: "#2" });
    const fine = { ok: true, item: { note_id: `ntc_${UUID_V7}`, version: 1, created_at: "2026-11-17T03:04:05Z" } };
    expect(checkExamples([written(fine)])).toEqual([]);
    expect(checkExamples([written({ ok: true, item: { version: 0 } })])).toEqual([expect.objectContaining({ scene: "empty", index: 0 })]);
    expect(checkExamples([written(null)])).toEqual([]);
  });

  it("見本のレコードのキーも照らし、診断にキーを含めない", () => {
    const op = (key: string) =>
      defineOperation({
        ...FIXTURE_CREATE,
        name: "fixture_flags.create",
        result: okItem(z.strictObject({ flags: z.record(z.string(), z.boolean()) })),
        examples: { normal: [{ ok: true, item: { flags: { [key]: true } } }], edge: [] },
        owner: "#2",
      });
    expect(checkExamples([op("ops@example.com")])).toEqual([]);
    for (const [key, needle] of [
      ["ops@corp.test", "example.com"],
      ["acct 210987654321", "123456789012"],
      ["ghs_abcdefABCDEF0123", "github_app_token"],
    ] as const) {
      const problems = checkExamples([op(key)]);
      expect(problems, key).toHaveLength(1);
      expect(problems[0]?.problem).toContain(needle);
      expect(problems[0]?.problem).not.toContain(key);
    }
  });
});

describe("fakeExamples", () => {
  it("同じ種で 2 回の生成が同じ値になり、どれも結果の形を通る", () => {
    const first = fakeExamples(FIXTURE_CREATE);
    expect(fakeExamples(FIXTURE_CREATE)).toEqual(first);
    expect(first.normal).toHaveLength(3);
    expect(first.edge).toHaveLength(2);
    for (const v of [...first.normal, ...first.edge]) expect(resultSchemaOf(FIXTURE_CREATE).safeParse(v).success).toBe(true);
  });

  it("境目の見本は文字列を上限の長さに、数を端に寄せる", () => {
    const edge = fakeExamples(FIXTURE_LIST).edge[0] as { items: Array<{ title: string }> };
    expect(edge.items.length).toBeGreaterThan(0);
    for (const it of edge.items) expect(it.title).toHaveLength(200);
    const [upper, lower] = fakeExamples(FIXTURE_CREATE).edge as Array<{ item: { version: number } }>;
    expect(upper?.item.version).toBe(Number.MAX_SAFE_INTEGER);
    expect(lower?.item.version).toBe(1);
    const [, shortest] = fakeExamples(FIXTURE_LIST).edge as Array<{ items: unknown[] }>;
    expect(shortest?.items).toEqual([]);
  });

  it("1024 字を超える上限の文字列も上限の長さにする", () => {
    const op = defineOperation({ ...FIXTURE_CREATE, name: "fixture_texts.create", result: okItem(z.strictObject({ body: z.string().max(2000), short: z.string().min(3).max(5) })), examples: null, owner: "#2" });
    const [upper, lower] = fakeExamples(op).edge as Array<{ item: { body: string; short: string } }>;
    expect(upper?.item.body).toHaveLength(2000);
    expect(upper?.item.short).toHaveLength(5);
    expect(lower?.item.body).toHaveLength(0);
    expect(lower?.item.short).toHaveLength(3);
    expect(checkExamples([op])).toEqual([]);
  });

  it("メール・アカウント ID・接頭辞は作り物の値だけを生成し、見本の上書きなしで照らしを通る", () => {
    const op = defineOperation({
      ...FIXTURE_CREATE,
      name: "fixture_accounts.create",
      result: okItem(
        z.strictObject({ mail: z.email(), mails: z.array(z.email()).max(3), account_id: awsAccountId, prefix: settingsSchema.shape.prefix, note: z.string().max(10).optional() }),
      ),
      examples: null,
      owner: "#2",
    });
    const { normal, edge } = fakeExamples(op);
    for (const v of [...normal, ...edge] as Array<{ item: { mail: string; mails: string[]; account_id: string; prefix: string } }>) {
      expect(v.item.mail).toBe("ops@example.com");
      for (const m of v.item.mails) expect(m).toBe("ops@example.com");
      expect(v.item.account_id).toBe("123456789012");
      expect(v.item.prefix).toBe("acme");
    }
    expect(checkExamples([op])).toEqual([]);
  });
});

describe("再帰する形の作り物の値", () => {
  type Node = { mail: string; account_id: string; children: Node[] };
  const byGetter: z.ZodType<Node> = z.strictObject({
    mail: z.email(),
    account_id: awsAccountId,
    get children() {
      return z.array(byGetter).max(1);
    },
  });
  const lazyNode: z.ZodType<Node> = z.lazy(() => z.strictObject({ mail: z.email(), account_id: awsAccountId, children: z.array(lazyNode).max(1) }));

  // 木をたどり、深さとメール・アカウント ID の値を集める
  function walk(n: Node, depth = 1, out = { depth: 0, mails: new Set<string>(), ids: new Set<string>() }) {
    out.depth = Math.max(out.depth, depth);
    out.mails.add(n.mail);
    out.ids.add(n.account_id);
    for (const c of n.children) walk(c, depth + 1, out);
    return out;
  }

  it.each([
    ["shape の getter", byGetter],
    ["z.lazy", lazyNode],
  ] as const)("%s で循環して戻った深い層もメールとアカウント ID が作り物の値", (_label, node) => {
    const op = defineOperation({ ...FIXTURE_CREATE, name: "fixture_trees.create", result: okItem(z.strictObject({ root: node })), examples: null, owner: "#2" });
    const { normal, edge } = fakeExamples(op);
    const seen = [...normal, ...edge].map((v) => walk((v as { item: { root: Node } }).item.root));
    expect(Math.max(...seen.map((s) => s.depth))).toBeGreaterThan(3);
    for (const s of seen) {
      expect([...s.mails]).toEqual(["ops@example.com"]);
      expect([...s.ids]).toEqual(["123456789012"]);
    }
    expect(checkExamples([op])).toEqual([]);
  });
});

describe("edgeOf", () => {
  const never = () => {
    throw new Error("fallback を呼ばない");
  };
  it.each([
    [{ min: 5, multipleOf: 3 }, "upper", 6],
    [{ min: 5, multipleOf: 3 }, "lower", 6],
    [{ max: 10, multipleOf: 3 }, "upper", 9],
    [{ max: 10, multipleOf: 3 }, "lower", 9],
    [{ min: 5, max: 10, multipleOf: 3 }, "upper", 9],
    [{ min: 5, max: 10, multipleOf: 3 }, "lower", 6],
    [{ min: -7, max: 7 }, "upper", 7],
    [{ min: -7, max: 7 }, "lower", -7],
  ] as const)("%o の %s の端は %d で、範囲と倍数を守る", (opts, side, expected) => {
    expect(edgeOf(opts, side, never)).toBe(expected);
  });

  it("端の無いときは fallback", () => {
    expect(edgeOf(undefined, "upper", () => 42)).toBe(42);
  });

  it.each([
    [{ min: 0.1, max: 0.3, multipleOf: 0.1 }, "upper", 0.3],
    [{ min: 0.1, max: 0.3, multipleOf: 0.1 }, "lower", 0.1],
    [{ min: 0.15, max: 0.35, multipleOf: 0.1 }, "upper", 0.3],
    [{ min: 0.15, max: 0.35, multipleOf: 0.1 }, "lower", 0.2],
    [{ min: 0, max: 0.7, multipleOf: 0.01 }, "upper", 0.7],
    [{ max: 1.1, multipleOf: 0.2 }, "upper", 1],
    [{ min: 1.5e-101, max: 3.5e-101, multipleOf: 1e-101 }, "upper", 3e-101],
    [{ min: 1.5e-101, max: 3.5e-101, multipleOf: 1e-101 }, "lower", 2e-101],
  ] as const)("小数の倍数 %o の %s の端は %d（端そのものが倍数なら端）", (opts, side, expected) => {
    const v = edgeOf(opts, side, never);
    expect(v).toBe(expected);
    expect(z.number().multipleOf(opts.multipleOf).safeParse(v).success).toBe(true);
  });

  it.each(["upper", "lower"] as const)("非正規化数の倍数の %s の端も範囲と倍数を守る", (side) => {
    const step = 1.5e-323;
    const opts = { min: 99 * step, max: 100 * step + Number.MIN_VALUE, multipleOf: step };
    const v = edgeOf(opts, side, never);
    expect(v).toBeGreaterThanOrEqual(opts.min);
    expect(v).toBeLessThanOrEqual(opts.max);
    expect(z.number().multipleOf(step).safeParse(v).success).toBe(true);
  });

  it("小数の倍数の数の形は、上の端と下の端が上限・下限そのもの", () => {
    const op = defineOperation({ ...FIXTURE_CREATE, name: "fixture_ratios.create", result: okItem(z.strictObject({ r: z.number().min(0.1).max(0.3).multipleOf(0.1) })), examples: null, owner: "#2" });
    const [upper, lower] = fakeExamples(op).edge as Array<{ item: { r: number } }>;
    expect(upper?.item.r).toBe(0.3);
    expect(lower?.item.r).toBe(0.1);
    expect(checkExamples([op])).toEqual([]);
  });

  it("下限と倍数だけの数の形は、下の端の見本が形を通る", () => {
    const op = defineOperation({ ...FIXTURE_CREATE, name: "fixture_steps.create", result: okItem(z.strictObject({ n: z.int().min(5).multipleOf(3) })), examples: null, owner: "#2" });
    const [, lower] = fakeExamples(op).edge as Array<{ item: { n: number } }>;
    expect(lower?.item.n).toBe(6);
    expect(checkExamples([op])).toEqual([]);
  });
});

describe("要素の追加の項目", () => {
  const op = (item: z.ZodObject, name: string) =>
    defineOperation({ ...FIXTURE_CREATE, name, item, result: okItem(z.strictObject({ a: z.string() })), examples: null, owner: "#2" });
  const loose = op(z.object({ a: z.string() }), "fixture_loose.create");
  const strict = op(z.strictObject({ a: z.string() }), "fixture_strict.create");
  const ops = [loose, strict];
  const ajv = new Ajv2020({ strict: true, validateFormats: false });
  ajv.addSchema(buildOperationSchemas(ops), "ops");
  const openapi = buildOpenApi(ops).components?.schemas ?? {};

  it.each([
    [loose, true],
    [strict, false],
  ] as const)("%s は Zod・operations.schema.json・OpenAPI で合否が同じ", (target, accepts) => {
    const value = { a: "x", extra: 1 };
    const byJsonSchema = ajv.getSchema(`ops#/$defs/${target.name}.item`);
    const byOpenApi = new Ajv2020({ strict: false, validateFormats: false }).compile(openapi[`${target.name}.item`] as object);
    expect((target.item as z.ZodType).safeParse(value).success).toBe(accepts);
    expect(byJsonSchema?.(value)).toBe(accepts);
    expect(byOpenApi(value)).toBe(accepts);
  });
});

describe("buildMcpTools", () => {
  const tools = buildMcpTools(ALL, buildOperationSchemas(ALL));

  it("人だけの操作と受け口 user でない操作が無く、道具の順が操作の表の順", () => {
    const expected = ALL.filter((op) => op.endpoint === "user" && op.humanOnly !== "always").map((op) => op.name);
    expect(tools.map((t) => t.name)).toEqual(expected);
    expect(tools.some((t) => t.name === "projects.create")).toBe(false);
    expect(tools.some((t) => t.name.startsWith("runner."))).toBe(false);
  });

  it("全部か無かの操作の maxItems と注記", () => {
    const create = tools.find((t) => t.name === "fixture_notes.create");
    expect(create?.inputSchema).toEqual({ type: "object", properties: { items: { type: "array", minItems: 1, maxItems: 2 } }, required: ["items"] });
    expect(create?.annotations).toEqual({ readOnlyHint: false, idempotentHint: true, destructiveHint: false });
    const list = tools.find((t) => t.name === "fixture_notes.list");
    expect(list?.inputSchema).toMatchObject({ properties: { items: { maxItems: 100 } } });
    expect(list?.annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "repositories.remove")?.annotations.destructiveHint).toBe(true);
    expect(list?.outputSchema).toEqual({ type: "array", items: buildOperationSchemas(ALL).$defs["fixture_notes.list.result"] });
  });
});

describe("自分へ戻る形の $ref", () => {
  type Node = { name: string; children: Node[] };
  const node: z.ZodType<Node> = z.strictObject({
    name: z.string(),
    get children() {
      return z.array(node);
    },
  });
  // 要素は自分へ戻る形（"#"）、結果は共有した形（"#/$defs/__schema0"）を参照する
  const tree = z.strictObject({ root: node, again: node.optional() });
  const op = defineOperation({
    ...FIXTURE_CREATE,
    name: "fixture_trees.create",
    item: node as unknown as z.ZodObject,
    result: okItem(tree),
    examples: null,
    owner: "#2",
  });
  const doc = buildOperationSchemas([op]);
  const good = { name: "a", children: [{ name: "b", children: [] }] };
  const bad = { name: "a", children: [{ name: "b", children: [{ name: 1, children: [] }] }] };

  it("operations.schema.json の要素と結果が自分の $defs の場所を根に参照し、深い層まで照らす", () => {
    const ajv = new Ajv2020({ strict: true, validateFormats: false });
    ajv.addSchema(doc, "ops");
    const item = ajv.getSchema("ops#/$defs/fixture_trees.create.item");
    const result = ajv.getSchema("ops#/$defs/fixture_trees.create.result");
    expect(item?.(good)).toBe(true);
    expect(item?.(bad)).toBe(false);
    expect(result?.({ ok: true, item: { root: good, again: good } })).toBe(true);
    expect(result?.({ ok: true, item: { root: good, again: bad } })).toBe(false);
    expect(JSON.stringify(doc)).not.toContain('"$ref":"#"');
  });

  // zod-openapi は再帰を components.schemas の __schemaN へ切り出すため、値は $defs と一致しない。一致の照らしは再帰しない形に限り、ここでは参照が解けて合否が Zod と同じことを照らす
  it("openapi.json の components.schemas は参照が解け、要素と結果を深い層まで Zod と同じ合否で照らす", () => {
    const schemas = buildOpenApi([op]).components?.schemas ?? {};
    expect(JSON.stringify(schemas)).toContain('"$ref":"#/components/schemas/');
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    ajv.addSchema({ components: { schemas } }, "oa");
    const item = ajv.getSchema("oa#/components/schemas/fixture_trees.create.item");
    const result = ajv.getSchema("oa#/components/schemas/fixture_trees.create.result");
    expect(item?.(good)).toBe(true);
    expect(item?.(bad)).toBe(false);
    expect(result?.({ ok: true, item: { root: good, again: good } })).toBe(true);
    expect(result?.({ ok: true, item: { root: good, again: bad } })).toBe(false);
    expect((node as z.ZodType).safeParse(bad).success).toBe(false);
  });

  it("再帰する形を操作の表に足しても、再帰しない形の $defs との一致の照らしは通る", () => {
    expectFlatSchemasMatchDefs([...ALL, op]);
  });

  it("再帰する形から $ref で届かない __schemaN が混じると、一致の照らしが落ちる", () => {
    const schemas = buildOpenApi([...ALL, op]).components?.schemas ?? {};
    expect(Object.keys(schemas).some((name) => /^__schema\d+$/.test(name))).toBe(true);
    expect(() => expectFlatSchemasMatchDefs([...ALL, op], { ...schemas, __schema999: { type: "string" } })).toThrow(/__schema999/);
  });

  it("MCP の道具の outputSchema は単独の文書として参照が解ける", () => {
    const [tool] = buildMcpTools([op], doc);
    const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(tool!.outputSchema);
    expect(validate([{ ok: true, item: { root: good } }])).toBe(true);
    expect(validate([{ ok: true, item: { root: bad } }])).toBe(false);
  });
});

describe("buildOpenApi", () => {
  const doc = buildOpenApi(ALL);

  // 再帰する形は zod-openapi が components.schemas の __schemaN へ切り出し一致しないため、「自分へ戻る形の $ref」で参照の解けと合否を照らす
  it("OpenAPI 3.1.1 で、再帰しない形の components.schemas の各値が operations.schema.json の同じ名前の $defs と一致する（zod-openapi と z.toJSONSchema の差を拾う）", () => {
    expect(doc.openapi).toBe("3.1.1");
    expectFlatSchemasMatchDefs(ALL);
  });

  it("受け口 user の操作だけを POST で持ち、形の未定は not の形", () => {
    expect(Object.keys(doc.paths ?? {})).toEqual(ALL.filter((op) => op.endpoint === "user").map((op) => op.route));
    expect(doc.paths?.["/v1/projects/get"]?.post?.operationId).toBe("projects.get");
    expect(doc.components?.schemas?.["projects.get.item"]).toEqual({ not: {} });
    expect(doc.components?.securitySchemes?.bearer).toEqual({ type: "http", scheme: "bearer" });
  });
});

describe("buildDummy", () => {
  it("list の空・get の 404・理由のコードごとの失敗。どの値も結果の zod を通る", () => {
    for (const op of FIXTURE_OPERATIONS) {
      const doc = buildDummy(op);
      expect(doc).not.toBeNull();
      if (doc === null) continue;
      expect(doc.failures.map((f) => [f.reason, f.status])).toEqual(itemReasonsOf(op).map((r) => [r.code, r.status]));
      const schema = resultSchemaOf(op);
      for (const v of [...doc.normal, ...doc.edge, ...doc.failures]) expect(schema.safeParse(v).success).toBe(true);
      if (doc.empty !== null) expect(schema.safeParse(doc.empty).success).toBe(true);
    }
    expect(buildDummy(FIXTURE_LIST)?.empty).toEqual({ ok: true, items: [], next_cursor: null });
    expect(buildDummy(FIXTURE_CREATE)?.empty).toBeNull();
    const get = defineOperation({
      ...FIXTURE_LIST,
      name: "fixture_notes.get",
      order: null,
      result: okItem(z.strictObject({ note_id: idOf("ntc"), title: z.string().min(1).max(200) })),
      examples: null,
      owner: "#2",
    });
    expect(buildDummy(get)?.empty).toEqual({ ok: false, status: 404, reason: "not_found" });
  });

  it("封筒が items・next_cursor のほかに必須の項目を持つ list は、examples.empty を書かなければ問題になり、書けばそれを使う", () => {
    const answers = defineOperation({
      name: "runner.fixture_answers.list",
      endpoint: "runner",
      access: "write",
      item: z.strictObject({ lane_id: z.string() }),
      result: okList(z.strictObject({ answer_id: z.string() })).extend({ total: z.int().min(0), delivered_seqs: z.array(z.int().min(0)) }),
      owner: "#2",
    });
    // 正常の見本の total や delivered_seqs を写さない（items: [] と食い違う値を空の見本に入れない）
    expect(buildDummy(answers)?.empty).toEqual({ ok: true, items: [], next_cursor: null });
    const problems = checkExamples([answers]);
    expect(problems.some((p) => p.scene === "empty" && p.problem.includes("examples.empty"))).toBe(true);
    const written = defineOperation({ ...answers, examples: { empty: { ok: true, items: [], next_cursor: null, total: 0, delivered_seqs: [3] } }, owner: "#2" });
    expect(examplesOf(written).empty).toEqual({ ok: true, items: [], next_cursor: null, total: 0, delivered_seqs: [3] });
    expect(checkExamples([written])).toEqual([]);
  });

  it("examples.empty を求める診断は、足した必須の項目の名前を含めない", () => {
    const op = defineOperation({
      name: "runner.fixture_contacts.list",
      endpoint: "runner",
      access: "write",
      item: z.strictObject({ lane_id: z.string() }),
      result: okList(z.strictObject({ contact_id: z.string() })).extend({ "ops@corp.test": z.int().min(0) }),
      owner: "#2",
    });
    const problems = checkExamples([op]);
    expect(problems.some((p) => p.scene === "empty" && p.problem.includes("examples.empty"))).toBe(true);
    for (const p of problems) expect(p.problem).not.toContain("corp.test");
  });

  it("省ける項目だけを足した list の封筒は、examples.empty なしで空の一覧が形を通る", () => {
    const list = defineOperation({
      name: "runner.fixture_pages.list",
      endpoint: "runner",
      access: "write",
      item: z.strictObject({ lane_id: z.string() }),
      result: okList(z.strictObject({ page_id: z.string() })).extend({ total: z.int().min(0).optional() }),
      owner: "#2",
    });
    expect(buildDummy(list)?.empty).toEqual({ ok: true, items: [], next_cursor: null });
    expect(checkExamples([list])).toEqual([]);
  });

  it("list・get でない操作に書いた empty は、その値をダミーの空の場面に置く", () => {
    const empty = { ok: true, item: { note_id: `ntc_${UUID_V7}`, version: 1, created_at: "2026-11-17T03:04:05Z" } };
    const op = defineOperation({ ...FIXTURE_CREATE, name: "fixture_notes.create", examples: { empty }, owner: "#2" });
    expect(buildDummy(op)?.empty).toEqual(empty);
  });

  it("読む操作の失敗は書く操作の理由を含めない", () => {
    const reasons = buildDummy(FIXTURE_LIST)?.failures.map((f) => f.reason);
    expect(reasons).toEqual(["item_invalid", "not_found", "role_insufficient"]);
  });

  it("形の未定は null", () => {
    expect(buildDummy(OPERATIONS[0])).toBeNull();
  });
});

describe("buildReasons・buildRoutes・buildPending", () => {
  it("書く操作は version_mismatch を含み、操作ごとのコードが後ろに続く。冪等の鍵の無い操作は in_progress を含まない", () => {
    const doc = buildReasons(ALL);
    const create = doc.operations["fixture_notes.create"]?.map((r) => r.code) ?? [];
    expect(create).toContain("version_mismatch");
    expect(create.at(-1)).toBe("fixture_limit");
    expect(doc.operations["projects.update"]?.map((r) => r.code)).not.toContain("in_progress");
    expect(doc.request.map((r) => r.code)).toContain("body_not_array");
  });

  it("経路は操作の表の順の POST", () => {
    const routes = buildRoutes(OPERATIONS);
    expect(routes).toHaveLength(OPERATIONS.length);
    expect(routes[0]).toEqual({ method: "POST", path: OPERATIONS[0].route, operation: OPERATIONS[0].name, endpoint: "user" });
  });

  it("形の未定の操作と受け持つ子", () => {
    const pending = buildPending(ALL);
    expect(pending).toHaveLength(OPERATIONS.length);
    expect(pending.find((p) => p.operation === "projects.get")).toEqual({ operation: "projects.get", owner: "#5" });
    const half = defineOperation({ ...FIXTURE_LIST, name: "fixture_notes.find", order: null, result: pendingShape("#9"), owner: "#9" });
    expect(buildPending([half])).toEqual([{ operation: "fixture_notes.find", owner: "#9" }]);
  });
});

describe("__proto__ という名前の項目", () => {
  // 計算した鍵で書くと、__proto__ は原型でなく自身の項目になる
  const shape = z.strictObject({ ["__proto__"]: z.string(), name: z.string() });
  const op = defineOperation({
    ...FIXTURE_CREATE,
    name: "fixture_protos.create",
    item: shape,
    result: okItem(shape),
    examples: null,
    owner: "#2",
  });
  const doc = buildOperationSchemas([op]);

  // Ajv は properties の __proto__ を自身の項目として扱わず、正しい Schema でもこの項目を余分と見るため、Zod の出力と照らす
  it("operations.schema.json の properties に Zod の出力と同じく残る（required だけに名前が残らない）", () => {
    const item = doc.$defs["fixture_protos.create.item"] as { properties: Record<string, unknown>; required: string[] };
    expect(Object.hasOwn(item.properties, "__proto__")).toBe(true);
    expect(item.required).toContain("__proto__");
    const zod = z.toJSONSchema(shape, { io: "input" }) as { properties: Record<string, unknown> };
    expect(JSON.stringify(item.properties)).toBe(JSON.stringify(zod.properties));
  });
});
