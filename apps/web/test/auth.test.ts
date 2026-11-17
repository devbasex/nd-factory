import { WebStorageStateStore } from "oidc-client-ts";
import { describe, expect, it } from "vitest";
import { createAuth } from "../src/auth.ts";

const CONFIG = {
  api_url: "https://api.example.com",
  authority: "https://acme-test.auth.example.com",
  client_id: "example-app-client",
  login_ready: true,
};

describe("createAuth", () => {
  it("認可コードで、保管は session storage", () => {
    const mgr = createAuth(CONFIG);
    const s = mgr.settings;
    expect(s.response_type).toBe("code");
    expect(s.client_id).toBe("example-app-client");
    expect(s.userStore).toBeInstanceOf(WebStorageStateStore);
    expect((s.userStore as unknown as { _store: Storage })._store).toBe(window.sessionStorage);
    expect((s.stateStore as unknown as { _store: Storage })._store).toBe(window.sessionStorage);
  });

  it("戻り先は配信の頁の根", () => {
    const mgr = createAuth(CONFIG);
    expect(mgr.settings.redirect_uri).toBe(`${window.location.origin}/`);
  });

  it("端点を利用者プールのドメインから作り、発見の文書を読みに行かない", async () => {
    const mgr = createAuth({ ...CONFIG, authority: "https://acme-test.auth.example.com/" });
    expect(mgr.settings.metadata?.authorization_endpoint).toBe("https://acme-test.auth.example.com/oauth2/authorize");
    expect(mgr.settings.metadata?.token_endpoint).toBe("https://acme-test.auth.example.com/oauth2/token");
    expect(mgr.settings.disablePKCE).toBe(false);
  });
});
