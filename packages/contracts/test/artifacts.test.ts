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

describe("buildOpenApi", () => {
  const doc = buildOpenApi(ALL);
  const defs = buildOperationSchemas(ALL).$defs;

  it("OpenAPI 3.1.1 で、components.schemas の各値が operations.schema.json の同じ名前の $defs と一致する（zod-openapi と z.toJSONSchema の差を拾う）", () => {
    expect(doc.openapi).toBe("3.1.1");
    const schemas = doc.components?.schemas ?? {};
    const names = Object.keys(schemas).filter((n) => n !== "problem");
    expect(names.length).toBe(ALL.filter((op) => op.endpoint === "user").length * 2);
    for (const name of names) expect(schemas[name], name).toEqual(defs[name]);
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
