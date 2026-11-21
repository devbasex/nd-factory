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
  fakeExamples,
} from "../scripts/artifacts.ts";
import { idOf } from "../src/ids.ts";
import { defineOperation, itemReasonsOf, okItem, type OperationDef, pendingShape, resultSchemaOf } from "../src/operation.ts";
import { OPERATIONS } from "../src/operations/index.ts";
import { money } from "../src/values.ts";
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
});

describe("fakeExamples", () => {
  it("同じ種で 2 回の生成が同じ値になり、どれも結果の形を通る", () => {
    const first = fakeExamples(FIXTURE_CREATE);
    expect(fakeExamples(FIXTURE_CREATE)).toEqual(first);
    expect(first.normal).toHaveLength(3);
    expect(first.edge).toHaveLength(1);
    for (const v of [...first.normal, ...first.edge]) expect(resultSchemaOf(FIXTURE_CREATE).safeParse(v).success).toBe(true);
  });

  it("境目の見本は文字列を上限の長さに、数を端に寄せる", () => {
    const edge = fakeExamples(FIXTURE_LIST).edge[0] as { items: Array<{ title: string }> };
    expect(edge.items.length).toBeGreaterThan(0);
    for (const it of edge.items) expect(it.title).toHaveLength(200);
    const created = fakeExamples(FIXTURE_CREATE).edge[0] as { item: { version: number } };
    expect(created.item.version).toBe(Number.MAX_SAFE_INTEGER);
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
