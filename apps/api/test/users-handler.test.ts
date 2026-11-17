import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { answerItems, createHandler } from "../src/users-handler.ts";
import { FakeStore } from "./fake-store.ts";

const NOW = new Date("2026-01-02T03:04:05.000Z");
const ROW = { id: "sub-1", created_at: NOW.toISOString() };

function event(body: string | undefined, opts: { sub?: string | null; base64?: boolean } = {}): APIGatewayProxyEventV2WithJWTAuthorizer {
  const sub = opts.sub === undefined ? "sub-1" : opts.sub;
  const claims: Record<string, string> = sub === null ? {} : { sub };
  return {
    version: "2.0",
    routeKey: "PUT /v1/users",
    rawPath: "/v1/users",
    rawQueryString: "",
    headers: { authorization: "Bearer secret-token" },
    isBase64Encoded: opts.base64 ?? false,
    body: opts.base64 && body !== undefined ? Buffer.from(body).toString("base64") : body,
    requestContext: {
      requestId: "req-1",
      authorizer: { principalId: "", integrationLatency: 0, jwt: { claims, scopes: [] } },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function setup() {
  const store = new FakeStore();
  const lines: string[] = [];
  const handler = createHandler({
    client: () => store.asClient(),
    table: () => "acme-test-accounts",
    now: () => NOW,
    log: (line) => lines.push(line),
  });
  return { store, lines, handler };
}

describe("handler", () => {
  it("self は 200 と自分の行", async () => {
    const { handler, lines } = setup();
    const res = await handler(event('[{"id":"self"}]'));
    expect(res.statusCode).toBe(200);
    expect(res.headers?.["content-type"]).toBe("application/json");
    expect(JSON.parse(res.body ?? "")).toEqual([{ status: "ok", item: ROW }]);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "info", request_id: "req-1", status: 200, items: 1 });
  });

  it("自分の sub の ID も ok", async () => {
    const { handler } = setup();
    const res = await handler(event('[{"id":"sub-1"}]'));
    expect(JSON.parse(res.body ?? "")).toEqual([{ status: "ok", item: ROW }]);
  });

  it("Base64 の本文を解いて読む", async () => {
    const { handler } = setup();
    const res = await handler(event('[{"id":"self"}]', { base64: true }));
    expect(res.statusCode).toBe(200);
  });

  it("ほかの ID には表を読まずに not_found", async () => {
    const { handler, store } = setup();
    const res = await handler(event('[{"id":"sub-2"}]'));
    expect(JSON.parse(res.body ?? "")).toEqual([{ status: "not_found" }]);
    expect(store.calls).toHaveLength(0);
  });

  it.each([
    [undefined, "body_not_json"],
    ["{", "body_not_json"],
    ['{"id":"self"}', "body_not_array"],
    ["[]", "body_empty"],
    [JSON.stringify(Array.from({ length: 11 }, () => ({ id: "self" }))), "too_many_items"],
    ['[{"id":""}]', "item_invalid"],
  ])("形に合わない本文は 400 と理由（%s）", async (body, reason) => {
    const { handler, store, lines } = setup();
    const res = await handler(event(body));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body ?? "")).toEqual({ reason });
    expect(store.calls).toHaveLength(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "info", status: 400, reason });
  });

  it("表の失敗は 503 で、500 を返さない", async () => {
    const { handler, store, lines } = setup();
    const failure = new Error("denied");
    failure.name = "AccessDeniedException";
    store.failWith = failure;
    const res = await handler(event('[{"id":"self"}]'));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body ?? "")).toEqual({ reason: "store_unavailable" });
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: "error",
      status: 503,
      operation: "put",
      error: "AccessDeniedException",
    });
  });

  it("sub が無ければ本文なしの 401", async () => {
    const { handler, store } = setup();
    const res = await handler(event('[{"id":"self"}]', { sub: null }));
    expect(res.statusCode).toBe(401);
    expect(res.body).toBeUndefined();
    expect(store.calls).toHaveLength(0);
  });

  it("ログに token・本文・利用者の ID を出さない", async () => {
    const { handler, lines } = setup();
    await handler(event('[{"id":"self"},{"id":"sub-2"}]'));
    await handler(event("{"));
    for (const line of lines) {
      expect(line).not.toContain("secret-token");
      expect(line).not.toContain("sub-1");
      expect(line).not.toContain("sub-2");
      expect(line).not.toContain("self");
      expect(line.includes("\n")).toBe(false);
    }
  });

  it("表の名前が無いと 503 にする", async () => {
    const lines: string[] = [];
    const handler = createHandler({
      client: () => new FakeStore().asClient(),
      table: () => undefined,
      now: () => NOW,
      log: (l) => lines.push(l),
    });
    const res = await handler(event('[{"id":"self"}]'));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "error", status: 503 });
  });
});

describe("answerItems", () => {
  it("self と他人の ID の混在で順と数を保つ", async () => {
    const self = vi.fn(async () => ROW);
    const out = await answerItems("sub-1", [{ id: "sub-2" }, { id: "self" }, { id: "sub-3" }, { id: "sub-1" }], self);
    expect(out).toEqual([{ status: "not_found" }, { status: "ok", item: ROW }, { status: "not_found" }, { status: "ok", item: ROW }]);
    expect(self).toHaveBeenCalledTimes(1);
  });

  it("self が 2 つでも self の呼び出しは 1 回", async () => {
    const self = vi.fn(async () => ROW);
    await answerItems("sub-1", [{ id: "self" }, { id: "self" }], self);
    expect(self).toHaveBeenCalledTimes(1);
  });

  it("他人の ID だけなら self を呼ばない", async () => {
    const self = vi.fn(async () => ROW);
    const out = await answerItems("sub-1", [{ id: "sub-2" }], self);
    expect(out).toEqual([{ status: "not_found" }]);
    expect(self).not.toHaveBeenCalled();
  });
});
