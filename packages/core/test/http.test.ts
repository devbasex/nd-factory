import { operationByName } from "@nd-factory/contracts/operations";
import { describe, expect, it } from "vitest";
import { bodyFaultOf } from "../src/dispatch/http.ts";
import { notesCreate } from "./fixtures/dispatch.ts";
import { readHttpCall, writeHttpResponse, type DispatchResult, type HttpEvent, type OperationCall } from "../src/dispatch/dispatch.ts";

// HTTP の要求の読みと応答の書き。経路は形の正本の操作の表で引く。AWS には触れない（要求は HTTP API のペイロードの形式 2.0 の作り物）

const P_A = "prj_01890a5d-ac96-774b-bcce-000000000014";
const JWT = "eyJhbGciOiJSUzI1NiJ9.e30.c2ln";

function event(over: { path?: string; body?: string | undefined; method?: string; base64?: boolean; headers?: Record<string, string> } = {}): HttpEvent {
  const body = "body" in over ? over.body : `[{"project_id":"${P_A}"}]`;
  return {
    rawPath: over.path ?? "/v1/projects/get",
    headers: over.headers ?? { authorization: `Bearer ${JWT}` },
    body: over.base64 === true && body !== undefined ? Buffer.from(body).toString("base64") : body,
    isBase64Encoded: over.base64 ?? false,
    requestContext: { requestId: "req-1", http: { method: over.method ?? "POST" } },
  };
}

const remaining = () => 4321;

const PROJECTS_CREATE_MAX_ITEMS = operationByName("projects.create")?.allOrNothing?.maxItems ?? 0;

function asCall(value: ReturnType<typeof readHttpCall>): OperationCall {
  if ("kind" in value) throw new Error(`呼び出しに読めない: ${value.status}`);
  return value;
}

const read = (over: Parameters<typeof event>[0] = {}) => asCall(readHttpCall(event(over), remaining));

const items = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ project_id: P_A, title: `t${i}` })));

describe("readHttpCall", () => {
  it("HTTP の経路から操作の名前・受け口・入口・token・要素・残り時間の読み手を読む", () => {
    const call = read();
    expect(call).toMatchObject({ endpoint: "user", channel: "screen", operation: "projects.get", token: JWT, items: [{ project_id: P_A }], requestId: "req-1" });
    expect(call.fault).toBeUndefined();
    expect(call.remainingMs()).toBe(4321);
  });

  it("委任の token の入口は API で、頭書きの名前の大小を問わない", () => {
    expect(read({ headers: { Authorization: "Bearer ndfd_x" } })).toMatchObject({ channel: "api", token: "ndfd_x" });
  });

  it("ランナーの経路は受け口 runner で、入口も runner", () => {
    expect(read({ path: "/v1/runner/events/create" })).toMatchObject({ endpoint: "runner", channel: "runner", operation: "runner.events.create" });
  });

  it("base64 の本文を解いて読む", () => {
    expect(read({ base64: true }).items).toEqual([{ project_id: P_A }]);
  });

  it("要素 1 個と 100 個は通り、101 個は too_many_items", () => {
    expect(read({ path: "/v1/projects/update", body: items(1) }).fault).toBeUndefined();
    expect(read({ path: "/v1/projects/update", body: items(100) }).items).toHaveLength(100);
    expect(read({ path: "/v1/projects/update", body: items(101) }).fault).toEqual({ status: 400, reason: "too_many_items" });
  });

  it("全部か無かの操作は操作の定義の上限で数える", () => {
    expect(read({ path: "/v1/projects/create", body: items(PROJECTS_CREATE_MAX_ITEMS) }).fault).toBeUndefined();
    expect(read({ path: "/v1/projects/create", body: items(PROJECTS_CREATE_MAX_ITEMS + 1) }).fault).toEqual({ status: 400, reason: "too_many_items" });
  });

  it.each([
    [undefined, "body_not_json"],
    ["{", "body_not_json"],
    ['{"a": 1}', "body_not_array"],
    ['"text"', "body_not_array"],
    ["[]", "body_empty"],
    [`[{"project_id":"${P_A}"},{"project_id":"${P_A}"}]`, "duplicate_item"],
  ])("本文の誤り（%s）は %s を fault に持ち、要素を空にする", (body, reason) => {
    const call = read({ body });
    expect(call.fault).toEqual({ status: 400, reason });
    expect(call.items).toEqual([]);
  });

  it("検査は JSON でない → 配列でない → 空 → 数の上限 → 重なり の順で、最初に当たった理由にする", () => {
    const duplicatedAndTooMany = JSON.stringify(Array.from({ length: 101 }, () => ({ project_id: P_A })));
    expect(read({ body: duplicatedAndTooMany }).fault).toEqual({ status: 400, reason: "too_many_items" });
  });

  it("キーの順だけが違う要素も同じ対象の重なり", () => {
    const body = JSON.stringify([
      { project_id: P_A, title: "a" },
      { title: "a", project_id: P_A },
    ]);
    expect(read({ body }).fault).toEqual({ status: 400, reason: "duplicate_item" });
  });

  it("冪等の鍵を持つ操作は、冪等の鍵だけが違う要素を同じ対象の重なりにする", () => {
    const one = { project_id: P_A, title: "a", idempotency_key: "0193a1b2-0000-7000-8000-000000000001" };
    expect(bodyFaultOf([one, { ...one, idempotency_key: "0193a1b2-0000-7000-8000-000000000002" }], notesCreate)).toBe("duplicate_item");
    expect(bodyFaultOf([one, { ...one, title: "b", idempotency_key: "0193a1b2-0000-7000-8000-000000000002" }], notesCreate)).toBeNull();
  });

  it("POST でない方法は 405 を fault に持つ（dispatch が記録の行とともに返す）", () => {
    expect(read({ method: "GET" }).fault).toEqual({ status: 405, reason: null });
  });

  it("操作の表に無い経路は操作の名前を空にして 404 を fault に持つ（dispatch が記録の行とともに返す）", () => {
    expect(read({ path: "/v1/projects" })).toMatchObject({ operation: "", items: [], fault: { status: 404, reason: null } });
    expect(read({ path: "/v1/runner/projects/get" })).toMatchObject({ endpoint: "runner", operation: "", fault: { status: 404, reason: null } });
  });

  it("深く入れ子の本文でも投げずに読む", () => {
    const deep = `[${"[".repeat(20_000)}${"]".repeat(20_000)}]`;
    expect(read({ body: deep }).fault).toBeUndefined();
    expect(read({ body: `[${deep.slice(1, -1)},${deep.slice(1, -1)}]` }).fault).toEqual({ status: 400, reason: "duplicate_item" });
  });

  it("Authorization の無い要求は token を null で読む", () => {
    expect(read({ headers: {} }).token).toBeNull();
  });
});

describe("writeHttpResponse", () => {
  it("要素の結果は 200 と配列で、no-store", () => {
    const res = writeHttpResponse({ kind: "items", items: [{ ok: true, item: { title: "a" } }, { ok: false, status: 404, reason: "not_found" }] });
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({ "content-type": "application/json", "cache-control": "no-store" });
    expect(JSON.parse(res.body)).toEqual([{ ok: true, item: { title: "a" } }, { ok: false, status: 404, reason: "not_found" }]);
  });

  it("要求全体の誤りは problem の形で、title と detail を持たず、no-store", () => {
    const res = writeHttpResponse({ kind: "problem", status: 400, reason: "body_not_array" });
    expect(res.statusCode).toBe(400);
    expect(res.headers).toMatchObject({ "content-type": "application/problem+json", "cache-control": "no-store" });
    expect(JSON.parse(res.body)).toEqual({ type: "about:blank", status: 400, reason: "body_not_array" });
  });

  it("理由のコードを持たない 404・405 は reason を書かない", () => {
    expect(JSON.parse(writeHttpResponse({ kind: "problem", status: 405, reason: null }).body)).toEqual({ type: "about:blank", status: 405 });
  });

  it("想定しない結果の形でも 500 を返さず 503 unavailable", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    for (const result of [{ kind: "problem", status: 500, reason: "x" }, { kind: "items", items: [cyclic] }, { kind: "other" }, null] as unknown as DispatchResult[]) {
      const res = writeHttpResponse(result);
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toEqual({ type: "about:blank", status: 503, reason: "unavailable" });
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });
});
