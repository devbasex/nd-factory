// @vitest-environment node
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../../src/sw/cache-rules.ts";
import { CONFIG, fakeCaches } from "./fake-caches.ts";

type Handler = (event: unknown) => void;
const ORIGIN = "https://app.example.invalid";

async function load(network: (path: string) => Response | Error) {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  const fake = fakeCaches();
  const handlers = new Map<string, Handler>();
  vi.stubGlobal("caches", fake.caches);
  vi.stubGlobal("__PRECACHE__", ["/index.html", "/assets/index-abc.js"]);
  vi.stubGlobal("__VERSION__", "v2");
  // 相対の URL を受ける Request
  vi.stubGlobal(
    "Request",
    class extends Request {
      constructor(input: string, init?: RequestInit) {
        super(new URL(input, ORIGIN), init);
      }
    },
  );
  const fetched: string[] = [];
  vi.stubGlobal("self", {
    location: new URL(ORIGIN),
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    fetch: async (input: string | Request) => {
      const path = typeof input === "string" ? input : new URL(input.url).pathname;
      fetched.push(path);
      const answer = network(path);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  await import("../../src/sw/service-worker.ts");

  const lifecycle = async (type: string, extra: object = {}) => {
    let done: Promise<unknown> = Promise.resolve();
    handlers.get(type)!({ ...extra, waitUntil: (p: Promise<unknown>) => void (done = p) });
    await done;
  };
  const request = async (path: string, mode = "cors") => {
    let response: Promise<Response> | undefined;
    handlers.get("fetch")!({
      request: { url: `${ORIGIN}${path}`, mode, method: "GET" },
      respondWith: (p: Promise<Response>) => void (response = p),
    });
    return response === undefined ? null : await response;
  };
  const config = async (name: string) =>
    ((await fake.stores.get(name)?.get("/config.json")?.clone().json()) as { client_id: string } | undefined)?.client_id;
  return { ...fake, handlers, fetched, lifecycle, request, config };
}

const offline = () => new TypeError("offline");
const online = (clientId: string) => (path: string) =>
  path === "/config.json" ? Response.json(CONFIG(clientId)) : new Response(path);

beforeEach(() => void vi.unstubAllGlobals());

describe("Service Worker", () => {
  it("install で殻と設定の値だけを版の保存先に入れる", async () => {
    const sw = await load(online("first"));
    await sw.lifecycle("install");
    expect([...sw.stores.get("nd-shell-v2")!.keys()].sort()).toEqual(["/assets/index-abc.js", "/config.json", "/index.html"]);
  });

  it("オフラインでは画面の URL に保存した殻を返し、API は保存から返さない", async () => {
    let up = true;
    const sw = await load((path) => (up ? online("first")(path) : offline()));
    await sw.lifecycle("install");
    up = false;
    expect(await (await sw.request("/p/prj_x/approvals/apr_y", "navigate"))!.text()).toBe("/index.html");
    expect(await sw.request("/v1/projects/list")).toBeNull();
    expect(await sw.request("/signed-out", "navigate")).toBeNull();
    expect(((await (await sw.request("/config.json"))!.json()) as { client_id: string }).client_id).toBe("first");
  });

  it("設定の値はつながっていれば読み直し、形の合わない値は保存しない", async () => {
    let body: unknown = CONFIG("first");
    const sw = await load((path) => (path === "/config.json" ? Response.json(body) : new Response(path)));
    await sw.lifecycle("install");
    body = CONFIG("second");
    await sw.request("/config.json");
    expect(await sw.config("nd-shell-v2")).toBe("second");
    body = { broken: true };
    await sw.request("/config.json");
    expect(await sw.config("nd-shell-v2")).toBe("second");
  });

  it("旧い版の値がどれも形に合わず設定を読めなければ、install を失敗させる", async () => {
    const sw = await load(offline.bind(null) as never);
    sw.stores.set("nd-shell-v1", new Map([["/config.json", Response.json({ old: true })]]));
    // 殻は読めて設定だけ読めない
    await expect(sw.lifecycle("install")).rejects.toThrow();
  });

  it("activate で番号の最も大きい値を引き継いでから、旧い保存先を消す", async () => {
    const sw = await load((path) => (path === "/config.json" ? offline() : new Response(path)));
    await saveConfig("nd-shell-v1", CONFIG("running"), 3);
    sw.stores.set("other-app", new Map());
    await sw.lifecycle("install");
    await sw.lifecycle("activate");
    expect([...sw.stores.keys()].sort()).toEqual(["nd-shell-v2", "other-app"]);
    expect(await sw.config("nd-shell-v2")).toBe("running");
  });

  it("ページの値を保存してから応答する", async () => {
    const sw = await load((path) => (path === "/config.json" ? offline() : new Response(path)));
    await sw.lifecycle("install");
    const replies: unknown[] = [];
    await sw.lifecycle("message", {
      data: { type: "config", value: CONFIG("page") },
      ports: [{ postMessage: (m: unknown) => void replies.push(m) }],
    });
    expect(replies).toEqual(["saved"]);
    expect(await sw.config("nd-shell-v2")).toBe("page");
  });
});
