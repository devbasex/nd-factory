// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { registerServiceWorker } from "../../src/sw/register.ts";
import { CONFIG } from "./fake-caches.ts";

describe("Service Worker の登録", () => {
  it("ready の後に設定の値を渡し、保存の応答を待つ", async () => {
    const sent: unknown[] = [];
    const registered: unknown[] = [];
    vi.stubGlobal("navigator", {
      serviceWorker: {
        register: async (...args: unknown[]) => void registered.push(args),
        ready: Promise.resolve({
          active: {
            postMessage: (message: unknown, ports: MessagePort[]) => {
              sent.push(message);
              ports[0]!.postMessage("saved");
            },
          },
        }),
      },
    });
    await registerServiceWorker(CONFIG("page"));
    expect(registered).toEqual([["/sw.js", { scope: "/" }]]);
    expect(sent).toEqual([{ type: "config", value: CONFIG("page") }]);
    vi.unstubAllGlobals();
  });

  it("対応しないブラウザーでは失敗を返す", async () => {
    vi.stubGlobal("navigator", {});
    await expect(registerServiceWorker(CONFIG("page"))).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});
