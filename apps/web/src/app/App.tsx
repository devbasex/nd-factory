import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { RouterProvider } from "react-router";
import { type I18n, I18nContext } from "../i18n/context.ts";
import type { Connectivity } from "../offline/connectivity.ts";
import type { RouteDef } from "../routes/route-table.ts";
import { createAppRouter } from "../routes/router.tsx";
import { MeScreen } from "../screens/me.tsx";
import type { PlaceholderData } from "../screens/placeholder.tsx";
import { SigninScreen } from "../screens/signin.tsx";
import type { CATALOG } from "../ui/catalog.ts";
import { AppFrame, type Place } from "../ui/app-frame.tsx";
import { ErrorNotice } from "../ui/error-notice.tsx";
import { Loading } from "../ui/loading.tsx";
import { OfflineBanner } from "../ui/offline-banner.tsx";
import type { BootState } from "./boot.ts";
import type { DEVICE_PARTS } from "./device.ts";

const PlaceholderScreen = lazy(async () => ({ default: (await import("../screens/placeholder.tsx")).PlaceholderScreen }));

export type FrameData = {
  places: readonly Place[];
  waiting: number;
  stopped: number;
  sprintsPath: string | null;
  // 帯に出す確定待ちと保留の数
  pending: number;
  held: number;
};

export type AppDeps = {
  i18n: I18n;
  connectivity: Connectivity;
  frame: FrameData;
  // 仮の画面の表示データ。本番の組み立ては行の無いデータを渡す
  placeholder: () => Promise<PlaceholderData>;
  reload: () => void;
  // 共通の部品の一覧。機能の画面（#28）がまだ使わない部品も、起動の組み立てから届くようにする
  components: typeof CATALOG;
  // 端末のデータの部品。ログインの切り替えと、#4 のサインインとサインアウトが呼ぶ
  device: typeof DEVICE_PARTS;
};

type ReadyState = Extract<BootState, { kind: "ready" }>;

function useOnline(connectivity: Connectivity): boolean {
  return useSyncExternalStore(
    (listener) => connectivity.subscribe(listener),
    () => connectivity.online(),
  );
}

function Screen({ route, deps, state }: { route: RouteDef; deps: AppDeps; state: ReadyState }) {
  const online = useOnline(deps.connectivity);
  if (route.id === "R1") return <SigninScreen offline={!online} onSignin={() => void state.relogin()} />;
  const { places, waiting, stopped, sprintsPath, pending, held } = deps.frame;
  return (
    <AppFrame
      current={route.nav}
      places={places}
      waiting={waiting}
      stopped={stopped}
      sprintsPath={sprintsPath}
      banner={<OfflineBanner online={online} pending={pending} held={held} />}
    >
      {route.id === "R14" ? (
        <MeScreen user={state.self} onRetry={deps.reload} />
      ) : (
        <Suspense fallback={<Loading />}>
          <PlaceholderScreen key={route.id} route={route} load={deps.placeholder} online={online} />
        </Suspense>
      )}
    </AppFrame>
  );
}

function Ready({ deps, state }: { deps: AppDeps; state: ReadyState }) {
  const [router] = useState(() => createAppRouter((route) => <Screen route={route} deps={deps} state={state} />));
  return <RouterProvider router={router} />;
}

function Content({ deps, state }: { deps: AppDeps; state: BootState }) {
  const online = useOnline(deps.connectivity);
  const { t } = deps.i18n;
  switch (state.kind) {
    case "config_unavailable":
      return <ErrorNotice code="config_unavailable" onRetry={deps.reload} />;
    case "login_waiting":
      return <p data-state="login_waiting">{t("boot.loginWaiting")}</p>;
    case "signin":
      return (
        <>
          <p role="status">{t("boot.redirecting")}</p>
          <SigninScreen offline={!online} onSignin={() => void state.signin()} />
        </>
      );
    case "returning": {
      const { retry } = state;
      if (state.error === undefined) return <p data-state="returning">{t("boot.returning")}</p>;
      return <ErrorNotice code={state.error} onRetry={retry && (() => void retry())} />;
    }
    case "ready":
      // 送り直した後の 401 は、画面を出さずにサインインのやり直しを待つ
      if (state.self.kind === "unauthorized") {
        return <ErrorNotice code="unauthorized" onRetry={() => void state.relogin()} />;
      }
      return <Ready deps={deps} state={state} />;
  }
}

export function App({ deps, state }: { deps: AppDeps; state: BootState }) {
  useEffect(() => {
    document.documentElement.lang = deps.i18n.locale;
  }, [deps.i18n.locale]);
  return (
    <I18nContext value={deps.i18n}>
      <Content deps={deps} state={state} />
    </I18nContext>
  );
}
