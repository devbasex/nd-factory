// @vitest-environment node
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyRequest, nextConfigSeq, pickNewestConfig, saveConfig } from "../../src/sw/cache-rules.ts";
import { CONFIG, fakeCaches } from "./fake-caches.ts";

const ORIGIN = "https://app.example.invalid";
let stores: ReturnType<typeof fakeCaches>["stores"];

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  const fake = fakeCaches();
  stores = fake.stores;
  vi.stubGlobal("caches", fake.caches);
});

describe("保存から返すかの判定", () => {
  const precache = new Set(["/index.html", "/assets/index-abc.js"]);
  const classify = (path: string, o: Partial<{ mode: RequestMode; method: string; origin: string }> = {}) =>
    classifyRequest(
      { url: new URL(path, o.origin ?? ORIGIN), mode: o.mode ?? "cors", method: o.method ?? "GET" },
      precache,
      ORIGIN,
    );

  it("ナビゲーションは殻、一覧の資産は保存、設定は読み直す", () => {
    expect(classify("/p/prj_x/approvals/apr_y", { mode: "navigate" })).toBe("shell");
    expect(classify("/assets/index-abc.js")).toBe("asset");
    expect(classify("/config.json")).toBe("config");
  });

  it("サインアウトの戻り・API・一覧に無い URL・書き込みはネットワークへ渡す", () => {
    expect(classify("/signed-out", { mode: "navigate" })).toBe("network");
    expect(classify("/v1/projects/list", { origin: "https://api.example.invalid" })).toBe("network");
    expect(classify("/v1/users", { origin: "https://api.example.invalid", mode: "navigate" })).toBe("network");
    expect(classify("/assets/other.js")).toBe("network");
    expect(classify("/assets/index-abc.js", { method: "PUT" })).toBe("network");
  });
});

describe("設定の値の保存", () => {
  const read = async (name: string) => (await stores.get(name)?.get("/config.json")?.clone().json()) as { client_id: string };

  it("読み出しの番号の新しい値が残る（端末の時計を使わない）", async () => {
    const first = await nextConfigSeq();
    const second = await nextConfigSeq();
    expect(second).toBeGreaterThan(first);
    expect(await saveConfig("nd-shell-a", CONFIG("new"), second)).toBe(true);
    expect(await saveConfig("nd-shell-a", CONFIG("old"), first)).toBe(false);
    expect((await read("nd-shell-a")).client_id).toBe("new");
  });

  it("番号の無いページの値は、保存した値が無いときだけ書く", async () => {
    expect(await saveConfig("nd-shell-a", CONFIG("page"), null)).toBe(true);
    expect(await saveConfig("nd-shell-a", CONFIG("page-2"), null)).toBe(false);
    expect(await saveConfig("nd-shell-a", CONFIG("network"), 1)).toBe(true);
    expect((await read("nd-shell-a")).client_id).toBe("network");
  });

  it("形の合わない値は保存しない", async () => {
    expect(await saveConfig("nd-shell-a", { ...CONFIG("x"), extra: 1 }, 1)).toBe(false);
    expect(stores.get("nd-shell-a")?.has("/config.json") ?? false).toBe(false);
  });

  it("保存先の作られた順でなく番号で選び、形の合わない値を飛ばす", async () => {
    await saveConfig("nd-shell-running", CONFIG("running"), 5);
    await saveConfig("nd-shell-waiting", CONFIG("waiting"), 2);
    stores.set("nd-shell-broken", new Map([["/config.json", new Response("{", { headers: { "x-nd-config-seq": "9" } })]]));
    const best = await pickNewestConfig([...stores.keys()]);
    expect(best?.seq).toBe(5);
    expect(((await best!.response.json()) as { client_id: string }).client_id).toBe("running");
  });
});
