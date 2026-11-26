import { createClock } from "@nd-factory/core/clock";
import { WebStorageStateStore } from "oidc-client-ts";
import { createAuth } from "../auth.ts";
import { createI18n } from "../i18n/context.ts";
import { pickLocale } from "../i18n/locales.ts";
import { createConnectivity } from "../offline/connectivity.ts";
import { CATALOG } from "../ui/catalog.ts";
import type { AppDeps } from "./App.tsx";
import type { BootDeps } from "./boot.ts";
import { DEVICE_PARTS } from "./device.ts";

// 本物かダミーを選び、各要素を 1 度だけ組む

export type BrowserEnv = { window: Window & typeof globalThis };

export async function composeApp({ window: win }: BrowserEnv): Promise<AppDeps & BootDeps> {
  const i18n = createI18n(
    pickLocale(null, win.navigator.languages),
    new Intl.DateTimeFormat().resolvedOptions().timeZone,
    // 戻った時刻を丸めないよう、読むたびに新しい時計を作る
    () => createClock().epochMs(),
  );
  const base = {
    i18n,
    components: CATALOG,
    device: DEVICE_PARTS,
    location: win.location,
    history: win.history,
    sessionStorage: win.sessionStorage,
    reload: () => win.location.reload(),
  };

  // 本番のビルドでは分岐が偽と決まり、ダミーのモジュールは成果物に入らない
  if (import.meta.env.MODE === "dummy") {
    const { createDummyApp } = await import("../dummy/dummy-client.ts");
    const dummy = createDummyApp(new URL(win.location.href));
    return {
      ...base,
      fetch: dummy.fetch,
      createAuth: dummy.createAuth,
      connectivity: dummy.connectivity,
      placeholder: dummy.placeholder,
      frame: dummy.frame,
    };
  }

  return {
    ...base,
    // 大域の fetch を呼ぶのは起動の組み立ての 1 か所だけ
    fetch: (input, init) => win.fetch(input, init),
    // #4 の「サインインを確定する」呼び出しを有効にするまで、token はタブを閉じれば消える session storage にだけ置く
    createAuth: (config) => {
      const store = new WebStorageStateStore({ store: win.sessionStorage });
      return createAuth(config, { userStore: store, stateStore: store });
    },
    connectivity: createConnectivity(win),
    placeholder: async () => ({ kind: "empty" }),
    frame: { places: [], waiting: 0, stopped: 0, sprintsPath: null, pending: 0, held: 0 },
  };
}
