import { describe, expect, it, vi } from "vitest";
import { fetchSelf } from "../src/users-client.ts";

const ROW = { id: "sub-1", created_at: "2026-01-02T03:04:05.000Z" };

function respond(status: number, body?: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status }),
  );
}

describe("fetchSelf", () => {
  it("200 で先頭が ok なら行を返す。経路を self の 1 要素で 1 回呼ぶ", async () => {
    const fetchFn = respond(200, [{ status: "ok", item: ROW }]);
    expect(await fetchSelf("https://api.example.com/", "tok", fetchFn)).toEqual({ kind: "ok", user: ROW });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.example.com/v1/users");
    expect(init?.method).toBe("PUT");
    expect(init?.body).toBe('[{"id":"self"}]');
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok");
  });

  it("401 は unauthorized", async () => {
    expect(await fetchSelf("https://api.example.com", "tok", respond(401))).toEqual({ kind: "unauthorized" });
  });

  it("503 は理由のコード", async () => {
    expect(await fetchSelf("https://api.example.com", "tok", respond(503, { reason: "store_unavailable" }))).toEqual({
      kind: "error",
      reason: "store_unavailable",
    });
  });

  it("400 は理由のコード", async () => {
    expect(await fetchSelf("https://api.example.com", "tok", respond(400, { reason: "body_empty" }))).toEqual({
      kind: "error",
      reason: "body_empty",
    });
  });

  it("理由の無い失敗は状態コードから理由を作る", async () => {
    expect(await fetchSelf("https://api.example.com", "tok", respond(502))).toEqual({ kind: "error", reason: "http_502" });
  });

  it("200 でも形が違えば unexpected_response", async () => {
    expect(await fetchSelf("https://api.example.com", "tok", respond(200, [{ status: "not_found" }]))).toEqual({
      kind: "error",
      reason: "unexpected_response",
    });
    expect(await fetchSelf("https://api.example.com", "tok", respond(200, { x: 1 }))).toEqual({
      kind: "error",
      reason: "unexpected_response",
    });
  });

  it("網の失敗は network_error で、再試行しない", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("failed");
    });
    expect(await fetchSelf("https://api.example.com", "tok", fetchFn)).toEqual({ kind: "error", reason: "network_error" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
