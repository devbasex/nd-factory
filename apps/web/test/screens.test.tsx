import { act } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, type AppDeps } from "../src/app/App.tsx";
import type { BootState } from "../src/app/boot.ts";
import { createI18n } from "../src/i18n/context.ts";
import { ROUTES } from "../src/routes/route-table.ts";
import { createAppRouter } from "../src/routes/router.tsx";
import { MeScreen } from "../src/screens/me.tsx";
import { type PlaceholderData, PlaceholderScreen } from "../src/screens/placeholder.tsx";
import { SigninScreen } from "../src/screens/signin.tsx";
import { DEVICE_PARTS } from "../src/app/device.ts";
import { CATALOG } from "../src/ui/catalog.ts";
import { buttonNamed, click, render, unmountAll } from "./support/render.tsx";

const ROW = { id: "sub-1", created_at: "2026-01-02T23:30:00.000Z" };

afterEach(unmountAll);

const route = (id: string) => ROUTES.find((r) => r.id === id)!;
const settle = () => act(async () => {});

function deps(over: Partial<AppDeps> = {}): AppDeps {
  return {
    i18n: createI18n("ja", "UTC", () => Date.parse("2026-01-03T00:00:00.000Z")),
    connectivity: { online: () => true, subscribe: () => () => {} },
    frame: { places: [], waiting: 0, stopped: 0, sprintsPath: null, pending: 0, held: 0 },
    placeholder: async () => ({ kind: "empty" }),
    reload: vi.fn(),
    components: CATALOG,
    device: DEVICE_PARTS,
    ...over,
  };
}

describe("仮の画面", () => {
  const screen = (data: () => Promise<PlaceholderData>, online = true, id = "R3") =>
    render(<PlaceholderScreen route={route(id)} load={data} online={online} />);
  const state = (host: HTMLElement) => host.querySelector("[data-state]")?.getAttribute("data-state");

  it.each([
    [{ kind: "rows", rows: [{ id: "1", title: "行1" }] }, "rows"],
    [{ kind: "empty" }, "empty"],
    [{ kind: "notFound" }, "notFound"],
    [{ kind: "error", reason: "unavailable" }, "error"],
  ] as const)("題と、表示データ %o の状態を出す", async (data, expected) => {
    const { host } = screen(async () => data as PlaceholderData);
    await settle();
    expect(host.querySelector("h1")?.textContent).toBe("スプリントの一覧");
    expect(state(host)).toBe(expected);
  });

  it("読み終わるまでは読み込み中", () => {
    expect(state(screen(() => new Promise(() => {})).host)).toBe("loading");
  });

  it("読み込みが失敗したらエラーと「もう一度」で、押すと読み直す", async () => {
    const load = vi.fn<() => Promise<PlaceholderData>>().mockRejectedValueOnce(new Error("x"));
    load.mockResolvedValue({ kind: "empty" });
    const { host } = screen(load);
    await settle();
    expect(state(host)).toBe("error");
    click(buttonNamed(host, "もう一度"));
    await settle();
    expect(state(host)).toBe("empty");
  });

  it("オフラインで、読めない画面や写しの無い画面は、つながると読める旨を出す", async () => {
    const rows = async (): Promise<PlaceholderData> => ({ kind: "rows", rows: [{ id: "1", title: "行1" }] });
    for (const view of [screen(rows, false, "R4"), screen(async () => ({ kind: "empty" }), false)]) {
      await settle();
      expect(state(view.host)).toBe("offlineNotCached");
    }
    const cached = screen(rows, false);
    await settle();
    expect(state(cached.host)).toBe("rows");
  });
});

describe("サインインの画面と自分の設定", () => {
  it("サインインのボタンは、オフラインでは押せず理由を出す", () => {
    const onSignin = vi.fn();
    click(buttonNamed(render(<SigninScreen onSignin={onSignin} offline={false} />).host, "サインインする"));
    expect(onSignin).toHaveBeenCalledTimes(1);
    const { host } = render(<SigninScreen onSignin={onSignin} offline />);
    expect(buttonNamed(host, "サインインする")?.disabled).toBe(true);
    expect(host.textContent).toContain("つながると使えます");
  });

  it("利用者の ID と、利用者の時刻帯の日時を出す", () => {
    const utc = render(<MeScreen user={{ kind: "ok", user: ROW }} />, { timeZone: "UTC" });
    const tokyo = render(<MeScreen user={{ kind: "ok", user: ROW }} />, { timeZone: "Asia/Tokyo" });
    expect(utc.host.textContent).toContain("sub-1");
    expect(utc.host.querySelector("time")?.getAttribute("datetime")).toBe(ROW.created_at);
    expect(utc.host.querySelector("time")?.textContent).toContain("2026/01/02");
    expect(tokyo.host.querySelector("time")?.textContent).toContain("2026/01/03");
  });

  it("読めなければ理由の文を出し、受けた値を HTML として読まない", () => {
    const { host } = render(<MeScreen user={{ kind: "error", reason: "store_unavailable" }} />);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("保存先を利用できません");
    const injected = render(<MeScreen user={{ kind: "ok", user: { ...ROW, id: "<img src=x>" } }} />);
    expect(injected.host.querySelector("img")).toBeNull();
  });
});

describe("ルーター", () => {
  const router = (path: string) =>
    createAppRouter(
      (r) => <p data-route={r.id}>{r.id}</p>,
      (routes) => createMemoryRouter(routes, { initialEntries: [path] }),
    );

  it.each(ROUTES.map((r) => [r.path.replace(/:\w+/g, "x_1"), r.id]))("%s は %s", async (path, id) => {
    const { host } = render(null);
    const target = router(path);
    const host2 = document.createElement("div");
    host.append(host2);
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(host2);
    await act(async () => root.render(<RouterProvider router={target} />));
    expect(host2.querySelector("[data-route]")?.getAttribute("data-route")).toBe(id);
    act(() => root.unmount());
  });

  it("表に無い path は、履歴を置き換えて / へ移る", async () => {
    const target = router("/nowhere");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<RouterProvider router={target} />));
    expect(target.state.location.pathname).toBe("/");
    expect(target.state.historyAction).toBe("REPLACE");
    act(() => root.unmount());
  });
});

describe("App", () => {
  const draw = async (state: BootState, over: Partial<AppDeps> = {}) => {
    const host = document.createElement("div");
    document.body.append(host);
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(host);
    await act(async () => root.render(<App deps={deps(over)} state={state} />));
    await settle();
    return { host, done: () => (act(() => root.unmount()), host.remove()) };
  };
  const noop = async () => {};

  it("起動の途中の状態を描き分け、html の lang を決まった言語にする", async () => {
    const reload = vi.fn();
    const unavailable = await draw({ kind: "config_unavailable" }, { reload });
    expect(unavailable.host.querySelector('[data-reason="config_unavailable"]')).not.toBeNull();
    click(buttonNamed(unavailable.host, "もう一度"));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(document.documentElement.lang).toBe("ja");
    unavailable.done();

    const waiting = await draw({ kind: "login_waiting" });
    expect(waiting.host.textContent).toContain("ログインの設定を待っています");
    waiting.done();

    const signin = await draw({ kind: "signin", signin: noop });
    expect(buttonNamed(signin.host, "サインインする")).toBeDefined();
    signin.done();

    const returning = await draw({ kind: "returning", target: "return:link" });
    expect(returning.host.textContent).toContain("戻り先を処理しています");
    returning.done();

    const failed = await draw({ kind: "returning", target: "return:signin", error: "login_failed", retry: noop });
    expect(failed.host.querySelector('[data-reason="login_failed"]')).not.toBeNull();
    failed.done();
  });

  it("ready は枠の中に画面を出し、2 回目の 401 はエラーと「もう一度」", async () => {
    window.history.replaceState(null, "", "/me");
    const ready = await draw({ kind: "ready", self: { kind: "ok", user: ROW }, relogin: noop });
    expect(ready.host.querySelector("nav [aria-current]")?.getAttribute("data-nav")).toBe("settings");
    await vi.waitFor(() => expect(ready.host.textContent).toContain("sub-1"));
    ready.done();
    window.history.replaceState(null, "", "/");

    const relogin = vi.fn(noop);
    const denied = await draw({ kind: "ready", self: { kind: "unauthorized" }, relogin });
    click(buttonNamed(denied.host, "もう一度"));
    expect(relogin).toHaveBeenCalledTimes(1);
    denied.done();
  });

  it("言語を替えると、画面の文言が翻訳のファイルの文に変わる", async () => {
    const view = await draw({ kind: "login_waiting" }, { i18n: createI18n("en", "UTC", () => 0) });
    expect(view.host.textContent).toContain("Waiting for sign-in");
    expect(document.documentElement.lang).toBe("en");
    view.done();
  });
});
