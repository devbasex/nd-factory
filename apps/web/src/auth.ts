import type { WebConfig } from "@nd-factory/contracts/web-config";
import { type StateStore, UserManager } from "oidc-client-ts";

// 認可コードと PKCE（S256）のログインの部品を作る。保存先は呼ぶ側が渡す。
// 利用者プールのドメインは発見の文書を出さないため、端点をドメインから組み立てて渡す
export function createAuth(config: WebConfig, stores: { userStore: StateStore; stateStore: StateStore }): UserManager {
  const domain = config.authority.replace(/\/+$/, "");
  return new UserManager({
    authority: domain,
    client_id: config.client_id,
    redirect_uri: `${window.location.origin}/`,
    response_type: "code",
    scope: "openid",
    metadata: {
      issuer: domain,
      authorization_endpoint: `${domain}/oauth2/authorize`,
      token_endpoint: `${domain}/oauth2/token`,
      revocation_endpoint: `${domain}/oauth2/revoke`,
      end_session_endpoint: `${domain}/logout`,
    },
    userStore: stores.userStore,
    stateStore: stores.stateStore,
    loadUserInfo: false,
    automaticSilentRenew: false,
    monitorSession: false,
  });
}
