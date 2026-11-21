import type { WebConfig } from "@nd-factory/contracts/web-config";
import type { UserManager } from "oidc-client-ts";
import { createAuth } from "./auth.ts";
import { loadRuntimeConfig } from "./runtime-config.ts";
import { fetchSelf } from "./users-client.ts";
import { render } from "./view.ts";

// 画面の状態を 1 周回す。ブラウザーの部品は deps から受け、試験でも本番でも同じ道を通る

export type AuthClient = Pick<UserManager, "getUser" | "signinRedirect" | "signinRedirectCallback" | "removeUser">;

export type WebDeps = {
  fetch: typeof fetch;
  location: Pick<Location, "href" | "reload">;
  history: Pick<History, "replaceState">;
  sessionStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  createAuth: (config: WebConfig) => AuthClient;
};

// 401 でログインへ送り直したことの印。送り直しは頁の移動をまたぐので、タブの保管に置いて繰り返しを止める
export const REAUTH_KEY = "nd.reauth";

function isLoginReturn(href: string): URL | null {
  const url = new URL(href);
  return url.searchParams.has("code") && url.searchParams.has("state") ? url : null;
}

export async function startApp(root: HTMLElement, deps: WebDeps): Promise<void> {
  const reload = () => deps.location.reload();

  let config: WebConfig;
  try {
    config = await loadRuntimeConfig(deps.fetch);
  } catch {
    render(root, { kind: "error", reason: "config_unavailable" }, reload);
    return;
  }

  if (!config.login_ready) {
    render(root, { kind: "waiting" }, reload);
    return;
  }

  const auth = deps.createAuth(config);
  const toLogin = async () => {
    render(root, { kind: "redirecting" }, reload);
    await auth.signinRedirect();
  };

  let token: string | undefined;
  const returned = isLoginReturn(deps.location.href);
  if (returned) {
    try {
      const user = await auth.signinRedirectCallback(deps.location.href);
      token = user.access_token;
    } catch {
      render(root, { kind: "error", reason: "login_failed" }, () => void toLogin());
      return;
    } finally {
      // 認可コードを履歴と再読み込みに残さない
      deps.history.replaceState(null, "", returned.pathname);
    }
  } else {
    const user = await auth.getUser();
    if (user && !user.expired) token = user.access_token;
  }

  if (!token) {
    await toLogin();
    return;
  }

  render(root, { kind: "loading" }, reload);
  const result = await fetchSelf(config.api_url, token, deps.fetch);
  switch (result.kind) {
    case "ok":
      deps.sessionStorage.removeItem(REAUTH_KEY);
      render(root, { kind: "shown", user: result.user }, reload);
      return;
    case "unauthorized":
      if (deps.sessionStorage.getItem(REAUTH_KEY) === null) {
        deps.sessionStorage.setItem(REAUTH_KEY, "1");
        await auth.removeUser();
        await toLogin();
        return;
      }
      render(root, { kind: "error", reason: "unauthorized" }, () => {
        deps.sessionStorage.removeItem(REAUTH_KEY);
        void auth.removeUser().then(toLogin);
      });
      return;
    case "error":
      render(root, { kind: "error", reason: result.reason }, reload);
      return;
  }
}

// 頁の起動。#app の無い文書（読み込んだだけのとき）では何もしない
const appRoot = typeof document === "undefined" ? null : document.getElementById("app");
if (appRoot) {
  void startApp(appRoot, {
    // eslint-disable-next-line no-restricted-globals -- #2 が横断の部品へ移す
    fetch: (input, init) => window.fetch(input, init),
    location: window.location,
    history: window.history,
    sessionStorage: window.sessionStorage,
    createAuth,
  });
}
