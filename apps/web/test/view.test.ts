import { afterEach, describe, expect, it, vi } from "vitest";
import { type ViewState, render } from "../src/view.ts";

const ROW = { id: "sub-1", created_at: "2026-01-02T23:30:00.000Z" };
const originalTz = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTz;
});

function root(): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = "<p>前の表示</p><p>もう 1 つ</p>";
  return el;
}

const STATES: ViewState[] = [
  { kind: "redirecting" },
  { kind: "waiting" },
  { kind: "loading" },
  { kind: "shown", user: ROW },
  { kind: "error", reason: "store_unavailable" },
];

describe("render", () => {
  it.each(STATES)("状態 $kind はちょうど 1 つの表示になる", (state) => {
    const el = root();
    render(el, state, () => {});
    expect(el.children).toHaveLength(1);
    expect(el.firstElementChild?.getAttribute("data-state")).toBe(state.kind);
  });

  it("5 つの状態の表示はそれぞれ違う", () => {
    const texts = STATES.map((s) => {
      const el = root();
      render(el, s, () => {});
      return el.textContent;
    });
    expect(new Set(texts).size).toBe(5);
  });

  it("設定の待ちの文言を出す", () => {
    const el = root();
    render(el, { kind: "waiting" }, () => {});
    expect(el.textContent).toContain("ログインの設定を待っています");
  });

  it("表示は利用者の ID と、利用を始めた日時を出す", () => {
    const el = root();
    render(el, { kind: "shown", user: ROW }, () => {});
    expect(el.textContent).toContain("sub-1");
    expect(el.querySelector("time")?.getAttribute("datetime")).toBe(ROW.created_at);
  });

  it("日時は利用者の時刻帯で変わる", () => {
    process.env.TZ = "UTC";
    const a = root();
    render(a, { kind: "shown", user: ROW }, () => {});
    process.env.TZ = "Asia/Tokyo";
    const b = root();
    render(b, { kind: "shown", user: ROW }, () => {});
    const ta = a.querySelector("time")?.textContent ?? "";
    const tb = b.querySelector("time")?.textContent ?? "";
    expect(ta).not.toBe(tb);
    // UTC では 1 月 2 日、東京では翌日の 1 月 3 日になる
    expect(ta).toMatch(/\b02\b/);
    expect(tb).toMatch(/\b03\b/);
  });

  it("エラーは理由のコードともう一度読む操作を出す", () => {
    const el = root();
    const onRetry = vi.fn();
    render(el, { kind: "error", reason: "store_unavailable" }, onRetry);
    expect(el.textContent).toContain("store_unavailable");
    el.querySelector("button")?.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("理由のコードを文として埋め込まない", () => {
    const el = root();
    render(el, { kind: "error", reason: "<img src=x onerror=alert(1)>" }, () => {});
    expect(el.querySelector("img")).toBeNull();
  });
});
