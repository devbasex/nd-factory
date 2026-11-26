import { describe, expect, it, vi } from "vitest";
import { type AuthClient, boot, type BootDeps, REAUTH_KEY } from "../src/app/boot.ts";

const CONFIG = {
  api_url: "https://api.example.com",
  authority: "https://acme-test.auth.example.com",
  client_id: "example-app-client",
  login_ready: true,
};
const ROW = { id: "sub-1", created_at: "2026-01-02T03:04:05.000Z" };

type ApiReply = { status: number; body?: unknown };

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

function setup(opts: {
  config?: unknown;
  configStatus?: number;
  href?: string;
  user?: { access_token: string; expired?: boolean } | null;
  callback?: "ok" | "fail";
  returnTo?: unknown;
  api?: ApiReply[];
  storage?: ReturnType<typeof memoryStorage>;
}) {
  const apiReplies = [...(opts.api ?? [{ status: 200, body: [{ status: "ok", item: ROW }] }])];
  const apiCalls: string[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/config.json") {
      return new Response(JSON.stringify(opts.config ?? CONFIG), { status: opts.configStatus ?? 200 });
    }
    apiCalls.push(url);
    const r = apiReplies.shift() ?? { status: 500 };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  });
  const auth = {
    getUser: vi.fn(async () => (opts.user === undefined ? null : opts.user)),
    signinRedirect: vi.fn(async (_args?: unknown) => {}),
    signinRedirectCallback: vi.fn(async () => {
      if (opts.callback === "fail") throw new Error("state mismatch");
      return { access_token: "tok-from-callback", expired: false, state: { returnTo: opts.returnTo } };
    }),
    removeUser: vi.fn(async () => {}),
  };
  const storage = opts.storage ?? memoryStorage();
  const deps: BootDeps = {
    fetch: fetchFn as unknown as typeof fetch,
    location: { href: opts.href ?? "https://app.example.com/", reload: vi.fn() },
    history: { replaceState: vi.fn() },
    sessionStorage: storage,
    createAuth: vi.fn(() => auth as unknown as AuthClient),
  };
  return { deps, auth, apiCalls, storage };
}

describe("boot", () => {
  it("token があれば利用者を 1 回読んで ready", async () => {
    const s = setup({ user: { access_token: "tok", expired: false } });
    const state = await boot(s.deps);
    expect(state).toMatchObject({ kind: "ready", self: { kind: "ok", user: ROW } });
    expect(s.apiCalls).toEqual(["https://api.example.com/v1/users"]);
    expect(s.auth.signinRedirect).not.toHaveBeenCalled();
  });

  it("設定が読めなければ config_unavailable", async () => {
    expect(await boot(setup({ configStatus: 404 }).deps)).toEqual({ kind: "config_unavailable" });
  });

  it("login_ready が偽なら login_waiting で、認証を組まない", async () => {
    const s = setup({ config: { ...CONFIG, login_ready: false } });
    expect(await boot(s.deps)).toEqual({ kind: "login_waiting" });
    expect(s.deps.createAuth).not.toHaveBeenCalled();
    expect(s.apiCalls).toHaveLength(0);
  });

  it.each([[null], [{ access_token: "old", expired: true }]])("token が無いか期限切れ（%o）なら認可の頁へ送る", async (user) => {
    const s = setup({ user, href: "https://app.example.com/p/prj_1?x=1" });
    expect(await boot(s.deps)).toMatchObject({ kind: "signin" });
    expect(s.auth.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: "/p/prj_1?x=1" } });
    expect(s.apiCalls).toHaveLength(0);
  });

  it("サインインの戻りを処理して、前に開いていた画面の path へ履歴を置き換える", async () => {
    const href = "https://app.example.com/?code=abc&state=xyz";
    const s = setup({ href, returnTo: "/me" });
    expect(await boot(s.deps)).toMatchObject({ kind: "ready" });
    expect(s.auth.signinRedirectCallback).toHaveBeenCalledWith(href);
    expect(s.deps.history.replaceState).toHaveBeenCalledWith(null, "", "/me");
    expect(s.auth.getUser).not.toHaveBeenCalled();
    expect(s.apiCalls).toHaveLength(1);
  });

  it.each([[undefined], ["https://evil.example.com/"], ["//evil.example.com"], ["/nowhere"]])(
    "戻す先が画面マップの path でなければ（%s）/ にする",
    async (returnTo) => {
      const s = setup({ href: "https://app.example.com/?code=abc&state=xyz", returnTo });
      await boot(s.deps);
      expect(s.deps.history.replaceState).toHaveBeenCalledWith(null, "", "/");
    },
  );

  it("戻りの失敗は login_failed で、やり直すとログインへ送り直す", async () => {
    const s = setup({ href: "https://app.example.com/?code=abc&state=bad", callback: "fail" });
    const state = await boot(s.deps);
    expect(state).toMatchObject({ kind: "returning", target: "return:signin", error: "login_failed" });
    expect(s.deps.history.replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(s.apiCalls).toHaveLength(0);
    if (state.kind !== "returning") throw new Error("returning でない");
    await state.retry?.();
    expect(s.auth.signinRedirect).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["/me/logins/return?code=a&state=b", "return:link"],
    ["/signed-out?code=a&state=b", "return:signout"],
  ])("%s は URL を保ったまま専用の処理へ渡す", async (path, target) => {
    const s = setup({ href: `https://app.example.com${path}` });
    expect(await boot(s.deps)).toEqual({ kind: "returning", target });
    expect(s.auth.signinRedirectCallback).not.toHaveBeenCalled();
    expect(s.auth.signinRedirect).not.toHaveBeenCalled();
    expect(s.deps.history.replaceState).not.toHaveBeenCalled();
  });

  it("401 なら token を捨てて 1 回だけログインへ送り直す", async () => {
    const s = setup({ user: { access_token: "tok" }, api: [{ status: 401 }] });
    expect(await boot(s.deps)).toMatchObject({ kind: "signin" });
    expect(s.auth.removeUser).toHaveBeenCalledTimes(1);
    expect(s.auth.signinRedirect).toHaveBeenCalledTimes(1);
    expect(s.storage.getItem(REAUTH_KEY)).not.toBeNull();
  });

  it("送り直した後にまた 401 なら送り直しを繰り返さず、やり直しで送り直せる", async () => {
    const storage = memoryStorage();
    storage.setItem(REAUTH_KEY, "1");
    const s = setup({ user: { access_token: "tok" }, api: [{ status: 401 }], storage });
    const state = await boot(s.deps);
    expect(state).toMatchObject({ kind: "ready", self: { kind: "unauthorized" } });
    expect(s.auth.signinRedirect).not.toHaveBeenCalled();
    if (state.kind !== "ready") throw new Error("ready でない");
    await state.relogin();
    expect(storage.getItem(REAUTH_KEY)).toBeNull();
    expect(s.auth.removeUser).toHaveBeenCalledTimes(1);
    expect(s.auth.signinRedirect).toHaveBeenCalledTimes(1);
  });

  it("読めたら送り直しの印を消す", async () => {
    const storage = memoryStorage();
    storage.setItem(REAUTH_KEY, "1");
    await boot(setup({ user: { access_token: "tok" }, storage }).deps);
    expect(storage.getItem(REAUTH_KEY)).toBeNull();
  });

  it("ほかの失敗は理由のコードを持つ ready で、呼び出しは 1 回だけ", async () => {
    const s = setup({ user: { access_token: "tok" }, api: [{ status: 503, body: { reason: "store_unavailable" } }] });
    expect(await boot(s.deps)).toMatchObject({ kind: "ready", self: { kind: "error", reason: "store_unavailable" } });
    expect(s.apiCalls).toHaveLength(1);
  });
});
