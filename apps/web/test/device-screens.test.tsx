import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, type AppDeps } from "../src/app/App.tsx";
import { DEVICE_PARTS } from "../src/app/device.ts";
import { type DeviceSnapshot, type DeviceView, EMPTY_DEVICE } from "../src/app/device-view.ts";
import { createI18n } from "../src/i18n/context.ts";
import { ROUTES } from "../src/routes/route-table.ts";
import { type PlaceholderAction, PlaceholderScreen } from "../src/screens/placeholder.tsx";
import { CATALOG } from "../src/ui/catalog.ts";
import { buttonNamed, click, render, unmountAll } from "./support/render.tsx";

// 仮の画面の操作と、帯の件数・保留の一覧を端末のデータの値から描く

afterEach(unmountAll);

const settle = () => act(async () => {});

const ACTIONS: PlaceholderAction[] = [
  { label: "承認する", operation: "approvals.answer", targetId: "apr_1", projectId: "prj_1", input: {} },
  { label: "既読にする", operation: "notices.mark_read", targetId: "ntc_1", projectId: null, input: {} },
  { label: "チームを作る", operation: "teams.create", targetId: "new", projectId: null, input: {} },
];

function fakeView(initial: Partial<DeviceSnapshot> = {}) {
  let state: DeviceSnapshot = { ...EMPTY_DEVICE, ...initial };
  const listeners = new Set<() => void>();
  const view: DeviceView = {
    snapshot: () => state,
    subscribe: (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
    start: vi.fn(() => () => {}),
    refresh: vi.fn(async () => {}),
    press: vi.fn(async () => {}),
    withdraw: vi.fn(async () => {}),
    heldStore: { count: async () => 0, list: async () => [], discard: async () => "kept" },
    readHeld: async () => [],
    stale: vi.fn(),
    idle: async () => {},
  };
  const publish = (next: Partial<DeviceSnapshot>) =>
    act(() => {
      state = { ...state, ...next };
      for (const fn of listeners) fn();
    });
  return { view, publish };
}

const rows = async () => ({ kind: "rows" as const, rows: [{ id: "1", title: "行1" }] });
const route = ROUTES.find((r) => r.id === "R3")!;

async function screen(online: boolean, initial: Partial<DeviceSnapshot> = {}) {
  const fake = fakeView(initial);
  const rendered = render(
    <PlaceholderScreen route={route} load={rows} online={online} device={{ view: fake.view, actions: ACTIONS }} />,
  );
  await settle();
  return { ...rendered, ...fake };
}

describe("仮の画面の操作", () => {
  it("つながっていないとき、つながってから押す操作は押せず理由を出し、ほかの 2 区分は押せる", async () => {
    const { host, view } = await screen(false);
    expect(buttonNamed(host, "チームを作る")?.disabled).toBe(true);
    expect(host.textContent).toContain("つながると使えます");
    expect(buttonNamed(host, "承認する")?.disabled).toBe(false);
    click(buttonNamed(host, "既読にする"));
    expect(view.press).toHaveBeenCalledWith({ operation: "notices.mark_read", targetId: "ntc_1", projectId: null, input: {} });
  });

  it("つながっていれば、つながってから押す操作は押せる（送る列には入れない）", async () => {
    const { host, view } = await screen(true);
    expect(buttonNamed(host, "チームを作る")?.disabled).toBe(false);
    click(buttonNamed(host, "チームを作る"));
    expect(view.press).not.toHaveBeenCalled();
  });

  it("確定待ちの対象はバッジを出して押せなくし、取り下げへ渡す。確定とは出さない", async () => {
    const { host, view } = await screen(false, {
      pending: [{ answerTag: "tag", operation: "approvals.answer", targetId: "apr_1", deadline: "2026-01-02T00:00:00.000Z" }],
    });
    expect(host.textContent).toContain("つながってから確定");
    expect(host.textContent).not.toContain("確定しました");
    expect(buttonNamed(host, "承認する")).toBeUndefined();
    click(buttonNamed(host, "取り下げる"));
    expect(view.withdraw).toHaveBeenCalledWith("tag");
  });

  it("結果は対象の名前と、食い違いの理由と一緒に出す", async () => {
    const { host, publish } = await screen(true);
    publish({
      results: [
        { key: 2, kind: "rejected", operation: "approvals.answer", targetId: "apr_1", reason: "state_mismatch" },
        { key: 1, kind: "confirmed", operation: "approvals.answer", targetId: "apr_2" },
      ],
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("食い違いがあり、確定していません");
    expect(host.textContent).toContain("状態が変わりました");
    expect(host.textContent).toContain("確定しました");
  });
});

describe("枠と端末のデータ", () => {
  it("帯の件数は端末のデータから出し、「内容を確認する」で保留の一覧を開く", async () => {
    window.history.replaceState(null, "", "/p/prj_1");
    const fake = fakeView({
      pending: [{ answerTag: "tag", operation: "approvals.answer", targetId: "apr_1", deadline: "2026-01-02T00:00:00.000Z" }],
      held: 2,
    });
    const deps: AppDeps = {
      i18n: createI18n("ja", "UTC", () => 0),
      connectivity: { online: () => true, subscribe: () => () => {} },
      frame: { places: [], waiting: 0, stopped: 0, sprintsPath: null, pending: 0, held: 0 },
      placeholder: rows,
      reload: vi.fn(),
      components: CATALOG,
      device: DEVICE_PARTS,
      offlineData: { open: async () => fake.view, actions: ACTIONS },
    };
    const state = { kind: "ready" as const, self: { kind: "error" as const, reason: "unavailable" }, relogin: async () => {} };
    const outer = document.createElement("div");
    document.body.append(outer);
    const root = createRoot(outer);
    await act(async () => root.render(<App deps={deps} state={state} />));
    await vi.waitFor(async () => {
      await settle();
      expect(outer.textContent).toContain("確定待ち 1 件");
    });
    expect(fake.view.start).toHaveBeenCalled();
    expect(outer.textContent).toContain("送れなかった操作が 2 件あります");
    click(buttonNamed(outer, "内容を確認する"));
    await settle();
    expect(outer.querySelector('[role="dialog"]')?.textContent).toContain("送れなかった操作");
    act(() => root.unmount());
    outer.remove();
    window.history.replaceState(null, "", "/");
  });
});
