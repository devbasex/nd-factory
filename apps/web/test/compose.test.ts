import { afterEach, describe, expect, it, vi } from "vitest";
import { composeApp } from "../src/app/compose.ts";
import { createConnectivity } from "../src/offline/connectivity.ts";

afterEach(() => vi.unstubAllEnvs());

describe("createConnectivity", () => {
  it("online と offline のイベントで値と購読者が変わり、解除の後は呼ばれない", () => {
    let online = true;
    const target = new EventTarget();
    const win = Object.assign(target, { navigator: { get onLine() {
      return online;
    } } }) as unknown as Window;
    const connectivity = createConnectivity(win);
    const seen: boolean[] = [];
    const stop = connectivity.subscribe(() => seen.push(connectivity.online()));
    online = false;
    target.dispatchEvent(new Event("offline"));
    online = true;
    target.dispatchEvent(new Event("online"));
    stop();
    target.dispatchEvent(new Event("offline"));
    expect(seen).toEqual([false, true]);
  });
});

describe("composeApp", () => {
  it("本番の mode では仮の画面に行の無いデータを渡し、ダミーを読まない", async () => {
    const deps = await composeApp({ window });
    expect(await deps.placeholder()).toEqual({ kind: "empty" });
    expect(document.documentElement.dataset["nd"]).toBeUndefined();
    expect(deps.frame.pending).toBe(0);
  });

  it("dummy の mode ではダミーの表示データとつながりに替わる", async () => {
    vi.stubEnv("MODE", "dummy");
    window.history.replaceState(null, "", "/?connection=offline");
    const deps = await composeApp({ window });
    expect(deps.connectivity.online()).toBe(false);
    expect((await deps.placeholder()).kind).toBe("rows");
    window.history.replaceState(null, "", "/");
  });
});
