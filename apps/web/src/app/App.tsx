import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { RouterProvider } from "react-router";
import { type I18n, I18nContext } from "../i18n/context.ts";
import type { Connectivity } from "../offline/connectivity.ts";
import type { RouteDef } from "../routes/route-table.ts";
import { createAppRouter } from "../routes/router.tsx";
import { MeScreen } from "../screens/me.tsx";
import { HeldListDialog } from "../screens/held-list.tsx";
import type { PlaceholderAction, PlaceholderData, PlaceholderDevice } from "../screens/placeholder.tsx";
import { SigninScreen } from "../screens/signin.tsx";
import type { CATALOG } from "../ui/catalog.ts";
import { AppFrame, type Place } from "../ui/app-frame.tsx";
import { ErrorNotice } from "../ui/error-notice.tsx";
import { Loading } from "../ui/loading.tsx";
import { OfflineBanner } from "../ui/offline-banner.tsx";
import type { BootState } from "./boot.ts";
import type { DEVICE_PARTS } from "./device.ts";
import { type DeviceView, EMPTY_DEVICE } from "./device-view.ts";

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
  // 端末のデータにつないだ画面。ログインの切り替えまで、本番の組み立ては渡さない
  offlineData?: { open: () => Promise<DeviceView>; actions: readonly PlaceholderAction[] };
};

type ReadyState = Extract<BootState, { kind: "ready" }>;

function useOnline(connectivity: Connectivity): boolean {
  return useSyncExternalStore(
    (listener) => connectivity.subscribe(listener),
    () => connectivity.online(),
  );
}

// ルーターは 1 度だけ作るので、後から開く端末のデータは文脈で渡す
const DeviceContext = createContext<PlaceholderDevice | undefined>(undefined);

const noSubscribe = () => () => {};
const noSnapshot = () => EMPTY_DEVICE;

// 帯の件数と保留の一覧。端末のデータを開いていなければ、組み立てが渡した数を出す
function Banner({ online, frame }: { online: boolean; frame: FrameData }) {
  const view = useContext(DeviceContext)?.view;
  const state = useSyncExternalStore(view?.subscribe ?? noSubscribe, view?.snapshot ?? noSnapshot);
  const [open, setOpen] = useState(false);
  const changed = useCallback(() => void view?.refresh(), [view]);
  return (
    <>
      <OfflineBanner
        online={online}
        pending={view === undefined ? frame.pending : state.pending.length}
        held={view === undefined ? frame.held : state.held}
        onShowHeld={view === undefined ? undefined : () => setOpen(true)}
      />
      {view === undefined ? null : (
        <HeldListDialog
          store={view.heldStore}
          quarantined={state.quarantined}
          open={open}
          record={view.readRecord}
          onClose={() => setOpen(false)}
          onChanged={changed}
          onStale={view.stale}
        />
      )}
    </>
  );
}

function Screen({ route, deps, state }: { route: RouteDef; deps: AppDeps; state: ReadyState }) {
  const online = useOnline(deps.connectivity);
  const device = useContext(DeviceContext);
  if (route.id === "R1") return <SigninScreen offline={!online} onSignin={() => void state.relogin()} />;
  const { places, waiting, stopped, sprintsPath } = deps.frame;
  return (
    <AppFrame
      current={route.nav}
      places={places}
      waiting={waiting}
      stopped={stopped}
      sprintsPath={sprintsPath}
      banner={<Banner online={online} frame={deps.frame} />}
    >
      {route.id === "R14" ? (
        <MeScreen user={state.self} onRetry={deps.reload} />
      ) : (
        <Suspense fallback={<Loading />}>
          <PlaceholderScreen key={route.id} route={route} load={deps.placeholder} online={online} device={device} />
        </Suspense>
      )}
    </AppFrame>
  );
}

function Ready({ deps, state }: { deps: AppDeps; state: ReadyState }) {
  const [router] = useState(() => createAppRouter((route) => <Screen route={route} deps={deps} state={state} />));
  const [device, setDevice] = useState<PlaceholderDevice>();
  const offlineData = deps.offlineData;
  useEffect(() => {
    if (offlineData === undefined) return;
    let stop: (() => void) | undefined;
    let closed = false;
    // 開けない端末では、端末のデータを使わずに続ける
    void offlineData.open().then(
      (view) => {
        if (closed) return;
        stop = view.start();
        setDevice({ view, actions: offlineData.actions });
      },
      () => {},
    );
    return () => {
      closed = true;
      stop?.();
    };
  }, [offlineData]);
  return (
    <DeviceContext value={device}>
      <RouterProvider router={router} />
    </DeviceContext>
  );
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
