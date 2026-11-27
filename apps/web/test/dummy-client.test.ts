import { afterEach, describe, expect, it, vi } from "vitest";
import { boot } from "../src/app/boot.ts";
import { createDummyApp, DUMMY_MARK } from "../src/dummy/dummy-client.ts";

afterEach(() => vi.useRealTimers());

const app = (query: string) => createDummyApp(new URL(`https://app.example.com/${query}`));

describe("createDummyApp", () => {
  it.each([
    ["normal", "rows"],
    ["empty", "empty"],
    ["error", "error"],
    ["notFound", "notFound"],
  ])("scenario=%s は %s", async (scenario, kind) => {
    expect((await app(`?scenario=${scenario}`).placeholder()).kind).toBe(kind);
  });

  it("slow は 2,000 ミリ秒の後に行を返す", async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    void app("?scenario=slow").placeholder().then(done);
    await vi.advanceTimersByTimeAsync(1999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ kind: "rows" }));
  });

  it.each([
    ["online", true, false],
    ["offline", false, false],
    ["pending", true, true],
  ])("connection=%s", (connection, online, seedPending) => {
    const dummy = app(`?connection=${connection}`);
    expect(dummy.connectivity.online()).toBe(online);
    expect(dummy.seedPending).toBe(seedPending);
  });

  it("知らない値は normal と online にする", async () => {
    const dummy = app("?scenario=bogus&connection=bogus");
    expect(dummy.connectivity.online()).toBe(true);
    expect((await dummy.placeholder()).kind).toBe("rows");
  });

  it("目印を document へ書き、サインインの無いまま ready まで起動できる", async () => {
    const dummy = app("");
    expect(document.documentElement.dataset["nd"]).toBe(DUMMY_MARK);
    const state = await boot({
      fetch: dummy.fetch,
      createAuth: dummy.createAuth,
      location: { href: "https://app.example.com/", reload: () => {} },
      history: { replaceState: () => {} },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });
    expect(state).toMatchObject({ kind: "ready", self: { kind: "ok" } });
  });
});
