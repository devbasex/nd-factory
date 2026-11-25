import { createClock } from "@nd-factory/core/clock";
import { createLogger } from "@nd-factory/core/log";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { answerItems, createHandler } from "../src/users-handler.ts";
import { StoreError } from "../src/user-store.ts";
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

const clock = createClock(() => NOW.getTime());
const loggerTo = (lines: string[]) => (requestId: string) => createLogger({ request_id: requestId, fn: "users-api", endpoint: "user" }, (line) => lines.push(line));

function setup() {
  const store = new FakeStore();
  const lines: string[] = [];
  const tables: string[] = [];
  const handler = createHandler({
    db: (table) => {
      tables.push(table);
      return store.asDb(table);
    },
    table: () => "acme-test-accounts",
    clock,
    log: loggerTo(lines),
  });
  return { store, lines, tables, handler };
}

describe("handler", () => {
  it("self は 200 と自分の行", async () => {
    const { handler, lines, tables } = setup();
    const res = await handler(event('[{"id":"self"}]'));
    expect(tables).toEqual(["acme-test-accounts"]);
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
    const store = new FakeStore();
    const handler = createHandler({
      db: (table) => store.asDb(table),
      table: () => undefined,
      clock,
      log: loggerTo(lines),
    });
    const res = await handler(event('[{"id":"self"}]'));
    expect(res.statusCode).toBe(503);
    expect(store.calls).toHaveLength(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "error", status: 503 });
  });
});

// 503 のログの operation と error の分け方を固定する（I-005 の切り出しの前の振る舞い）
describe("handler の 503 の失敗の分け方", () => {
  function failing(thrown: () => unknown, opts: { noTable?: boolean } = {}) {
    const lines: string[] = [];
    const handler = createHandler({
      db: () => {
        throw thrown();
      },
      table: () => (opts.noTable ? undefined : "acme-test-accounts"),
      clock,
      log: loggerTo(lines),
    });
    return { handler, lines };
  }

  async function failureLog(handler: ReturnType<typeof createHandler>, lines: string[]) {
    const res = await handler(event('[{"id":"self"}]'));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body ?? "")).toEqual({ reason: "store_unavailable" });
    expect(lines).toHaveLength(1);
    const log = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(log).toMatchObject({ level: "error", request_id: "req-1", status: 503 });
    return { operation: log.operation, error: log.error };
  }

  it("表の名前が無いときは put と Error", async () => {
    const { handler, lines } = failing(() => new Error("呼ばれない"), { noTable: true });
    expect(await failureLog(handler, lines)).toEqual({ operation: "put", error: "Error" });
  });

  it("StoreError の get はその操作と元の例外の名前", async () => {
    const cause = new Error("throttled");
    cause.name = "ProvisionedThroughputExceededException";
    const { handler, lines } = failing(() => new StoreError("get", cause));
    expect(await failureLog(handler, lines)).toEqual({ operation: "get", error: "ProvisionedThroughputExceededException" });
  });

  it("StoreError の元が Error でなければ error は Unknown", async () => {
    const { handler, lines } = failing(() => new StoreError("put", "文字列"));
    expect(await failureLog(handler, lines)).toEqual({ operation: "put", error: "Unknown" });
  });

  it("StoreError でない Error は unknown とその名前", async () => {
    const { handler, lines } = failing(() => new TypeError("壊れた"));
    expect(await failureLog(handler, lines)).toEqual({ operation: "unknown", error: "TypeError" });
  });

  it("Error でない値が投げられたら unknown と Unknown", async () => {
    const { handler, lines } = failing(() => "文字列");
    expect(await failureLog(handler, lines)).toEqual({ operation: "unknown", error: "Unknown" });
  });

  it("ログは status・operation・error のほかに失敗の中身を出さない", async () => {
    const { handler, lines } = failing(() => new TypeError("秘密の文言"));
    await failureLog(handler, lines);
    expect(lines[0]).not.toContain("秘密の文言");
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
