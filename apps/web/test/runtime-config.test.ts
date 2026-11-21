import { describe, expect, it, vi } from "vitest";
import { RuntimeConfigError, loadRuntimeConfig } from "../src/runtime-config.ts";

const CONFIG = {
  api_url: "https://api.example.com",
  authority: "https://acme-test.auth.example.com",
  client_id: "example-app-client",
  login_ready: true,
};

function respond(status: number, body: string) {
  return vi.fn(async () => new Response(body, { status, headers: { "content-type": "application/json" } }));
}

describe("loadRuntimeConfig", () => {
  it("形に合う値を返し、同じ配信元の /config.json を読む", async () => {
    const fetchFn = respond(200, JSON.stringify(CONFIG));
    expect(await loadRuntimeConfig(fetchFn)).toEqual(CONFIG);
    expect(fetchFn).toHaveBeenCalledWith("/config.json", expect.objectContaining({ cache: "no-store" }));
  });

  it("404 は例外", async () => {
    await expect(loadRuntimeConfig(respond(404, "not found"))).rejects.toBeInstanceOf(RuntimeConfigError);
  });

  it("JSON でない・形の誤りは例外", async () => {
    await expect(loadRuntimeConfig(respond(200, "<html>"))).rejects.toBeInstanceOf(RuntimeConfigError);
    await expect(loadRuntimeConfig(respond(200, JSON.stringify({ ...CONFIG, login_ready: "yes" })))).rejects.toBeInstanceOf(
      RuntimeConfigError,
    );
  });

  it("ネットワークの失敗は例外", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("network");
    });
    await expect(loadRuntimeConfig(fetchFn)).rejects.toBeInstanceOf(RuntimeConfigError);
  });
});
