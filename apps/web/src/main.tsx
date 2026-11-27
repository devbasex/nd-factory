import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { boot } from "./app/boot.ts";
import { composeApp } from "./app/compose.ts";
import { createI18n, I18nContext } from "./i18n/context.ts";
import { pickLocale } from "./i18n/locales.ts";
import { ErrorNotice } from "./ui/error-notice.tsx";
import { Loading } from "./ui/loading.tsx";
import "./ui/ui.css";

// ページの起動。#app の無い文書では何もしない

async function start(element: HTMLElement): Promise<void> {
  const root = createRoot(element);
  const early = createI18n(pickLocale(null, window.navigator.languages), "UTC", () => 0);
  const shell = (node: ReactNode) => root.render(<I18nContext value={early}>{node}</I18nContext>);
  shell(<Loading />);
  try {
    const deps = await composeApp({ window });
    const state = await boot(deps);
    root.render(<App deps={deps} state={state} />);
  } catch {
    shell(<ErrorNotice code="unknown" onRetry={() => window.location.reload()} />);
  }
}

const element = document.getElementById("app");
if (element) void start(element);
