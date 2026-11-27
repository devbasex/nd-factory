import type { WebConfig } from "@nd-factory/contracts/web-config";
import type { UserManager } from "oidc-client-ts";
import { isMapPath, matchReturn, type ReturnKind } from "../routes/route-table.ts";
import { loadRuntimeConfig } from "../runtime-config.ts";
import { fetchSelf, type SelfResult } from "../users-client.ts";

// 起動の順序を 1 周回して、最初の画面の状態を返す。ブラウザーの部品は deps から受ける

export type AuthClient = Pick<UserManager, "getUser" | "signinRedirect" | "signinRedirectCallback" | "removeUser">;

export type BootDeps = {
  fetch: typeof fetch;
  location: Pick<Location, "href" | "reload">;
  history: Pick<History, "replaceState">;
  sessionStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  createAuth: (config: WebConfig) => AuthClient;
  // 本番の配信でだけ渡す。登録の失敗は起動を止めない
  serviceWorker?: { register: (config: WebConfig) => Promise<void>; failed: (error: unknown) => void };
};

export type BootState =
  | { kind: "config_unavailable" }
  | { kind: "login_waiting" }
  | { kind: "signin"; signin: () => Promise<void> }
  // 戻り先の処理。return:link と return:signout の処理は #4 が持つため、URL を保ったまま渡す
  | { kind: "returning"; target: ReturnKind; error?: string; retry?: () => Promise<void> }
  | { kind: "ready"; self: SelfResult; relogin: () => Promise<void> };

/** 401 でログインへ送り直したことの印。送り直しは頁の移動をまたぐので、タブの保管に置いて繰り返しを止める @internal */
export const REAUTH_KEY = "nd.reauth";

const BASE = "https://base.invalid";

// サインインの後に戻す先は、同じ配信元の画面マップの path だけにする
function returnPath(state: unknown): string {
  const to = typeof state === "object" && state !== null && "returnTo" in state ? state.returnTo : undefined;
  if (typeof to !== "string" || !to.startsWith("/") || to.includes("\\")) return "/";
  const url = new URL(to, BASE);
  return url.origin === BASE && isMapPath(url.pathname) ? `${url.pathname}${url.search}` : "/";
}

export async function boot(deps: BootDeps): Promise<BootState> {
  let config: WebConfig;
  try {
    config = await loadRuntimeConfig(deps.fetch);
  } catch {
    return { kind: "config_unavailable" };
  }
  const worker = deps.serviceWorker;
  // 保存の完了を待つと最初の画面が遅れるので、待たない
  if (worker !== undefined) void worker.register(config).catch(worker.failed);
  if (!config.login_ready) return { kind: "login_waiting" };

  const url = new URL(deps.location.href);
  const target = matchReturn(url);
  if (target !== null && target !== "return:signin") return { kind: "returning", target };

  const auth = deps.createAuth(config);
  let here = returnPath({ returnTo: `${url.pathname}${url.search}` });
  const signin = () => auth.signinRedirect({ state: { returnTo: here } });
  const toLogin = async (): Promise<BootState> => {
    await signin();
    return { kind: "signin", signin };
  };

  let token: string | undefined;
  if (target === "return:signin") {
    here = "/";
    try {
      const user = await auth.signinRedirectCallback(url.href);
      token = user.access_token;
      here = returnPath(user.state);
    } catch {
      return { kind: "returning", target, error: "login_failed", retry: signin };
    } finally {
      // 認可コードを履歴と再読み込みに残さない
      deps.history.replaceState(null, "", here);
    }
  } else {
    const user = await auth.getUser();
    if (user && !user.expired) token = user.access_token;
  }
  if (!token) return toLogin();

  const relogin = async () => {
    deps.sessionStorage.removeItem(REAUTH_KEY);
    await auth.removeUser();
    await signin();
  };
  const self = await fetchSelf(config.api_url, token, deps.fetch);
  if (self.kind === "ok") deps.sessionStorage.removeItem(REAUTH_KEY);
  if (self.kind === "unauthorized" && deps.sessionStorage.getItem(REAUTH_KEY) === null) {
    deps.sessionStorage.setItem(REAUTH_KEY, "1");
    await auth.removeUser();
    return toLogin();
  }
  return { kind: "ready", self, relogin };
}
