import { WebStorageStateStore } from "oidc-client-ts";
import { describe, expect, it } from "vitest";
import { createAuth } from "../src/auth.ts";

const CONFIG = {
  api_url: "https://api.example.com",
  authority: "https://acme-test.auth.example.com",
  client_id: "example-app-client",
  login_ready: true,
};

const store = new WebStorageStateStore({ store: window.sessionStorage });
const state = new WebStorageStateStore({ store: window.sessionStorage, prefix: "state." });
const auth = (config = CONFIG) => createAuth(config, { userStore: store, stateStore: state });

describe("createAuth", () => {
  it("認可コードで、渡した保存に置く", () => {
    const mgr = auth();
    const s = mgr.settings;
    expect(s.response_type).toBe("code");
    expect(s.client_id).toBe("example-app-client");
    expect(s.userStore).toBe(store);
    expect(s.stateStore).toBe(state);
  });

  it("戻り先は配信の頁の根", () => {
    const mgr = auth();
    expect(mgr.settings.redirect_uri).toBe(`${window.location.origin}/`);
  });

  it("端点を利用者プールのドメインから作り、発見の文書を読みに行かない", async () => {
    const mgr = auth({ ...CONFIG, authority: "https://acme-test.auth.example.com/" });
    expect(mgr.settings.metadata?.authorization_endpoint).toBe("https://acme-test.auth.example.com/oauth2/authorize");
    expect(mgr.settings.metadata?.token_endpoint).toBe("https://acme-test.auth.example.com/oauth2/token");
    expect(mgr.settings.disablePKCE).toBe(false);
  });
});
