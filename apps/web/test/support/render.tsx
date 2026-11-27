import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { createI18n, I18nContext, type I18n } from "../../src/i18n/context.ts";

// 部品のテストの共通の準備。ルーターと翻訳の文脈の中に描き、後始末を unmountAll にまとめる

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: { root: Root; host: HTMLElement }[] = [];

export const NOW = Date.parse("2026-01-03T00:00:00.000Z");

export function render(node: ReactNode, i18n: Partial<I18n> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push({ root, host });
  const value = { ...createI18n("ja", "UTC", () => NOW), ...i18n };
  const draw = (next: ReactNode) =>
    act(() => {
      root.render(
        <I18nContext value={value}>
          <MemoryRouter>{next}</MemoryRouter>
        </I18nContext>,
      );
    });
  draw(node);
  return { host, rerender: draw };
}

export function click(element: Element | null | undefined): void {
  if (!element) throw new Error("押す要素が無い");
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

export function buttonNamed(host: HTMLElement, name: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(name));
}

export function unmountAll(): void {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
}
