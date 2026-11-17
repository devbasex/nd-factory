import { describe, expect, it, vi } from "vitest";
import { type AuthClient, REAUTH_KEY, type WebDeps, startApp } from "../src/main.ts";

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
    map: m,
  };
}

function setup(opts: {
  config?: unknown;
  configStatus?: number;
  href?: string;
  user?: { access_token: string; expired?: boolean } | null;
  callback?: "ok" | "fail";
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
    signinRedirect: vi.fn(async () => {}),
    signinRedirectCallback: vi.fn(async () => {
      if (opts.callback === "fail") throw new Error("state mismatch");
      return { access_token: "tok-from-callback", expired: false };
    }),
    removeUser: vi.fn(async () => {}),
  };
  const storage = opts.storage ?? memoryStorage();
  const deps: WebDeps = {
    fetch: fetchFn as unknown as typeof fetch,
    location: { href: opts.href ?? "https://app.example.com/", reload: vi.fn() },
    history: { replaceState: vi.fn() },
    sessionStorage: storage,
    createAuth: vi.fn(() => auth as unknown as AuthClient),
  };
  const root = document.createElement("div");
  return { deps, auth, root, apiCalls, storage };
}

function stateOf(root: HTMLElement): string | null | undefined {
  return root.firstElementChild?.getAttribute("data-state");
}

describe("startApp", () => {
  it("token があれば経路を 1 回呼んで表示する", async () => {
    const s = setup({ user: { access_token: "tok", expired: false } });
    await startApp(s.root, s.deps);
    expect(s.apiCalls).toEqual(["https://api.example.com/v1/users"]);
    expect(stateOf(s.root)).toBe("shown");
    expect(s.root.textContent).toContain("sub-1");
    expect(s.auth.signinRedirect).not.toHaveBeenCalled();
  });

  it("login_ready が偽なら設定の待ちで、ログインへ送らない", async () => {
    const s = setup({ config: { ...CONFIG, login_ready: false } });
    await startApp(s.root, s.deps);
    expect(stateOf(s.root)).toBe("waiting");
    expect(s.deps.createAuth).not.toHaveBeenCalled();
    expect(s.apiCalls).toHaveLength(0);
  });

  it("token が無ければ認可の頁へ送る", async () => {
    const s = setup({ user: null });
    await startApp(s.root, s.deps);
    expect(s.auth.signinRedirect).toHaveBeenCalledTimes(1);
    expect(stateOf(s.root)).toBe("redirecting");
    expect(s.apiCalls).toHaveLength(0);
  });

  it("token が期限切れなら認可の頁へ送る", async () => {
    const s = setup({ user: { access_token: "old", expired: true } });
    await startApp(s.root, s.deps);
    expect(s.auth.signinRedirect).toHaveBeenCalledTimes(1);
    expect(s.apiCalls).toHaveLength(0);
  });

  it("ログインの戻りを処理して URL から消し、経路を 1 回呼ぶ", async () => {
    const s = setup({ href: "https://app.example.com/?code=abc&state=xyz" });
    await startApp(s.root, s.deps);
    expect(s.auth.signinRedirectCallback).toHaveBeenCalledWith("https://app.example.com/?code=abc&state=xyz");
    expect(s.deps.history.replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(s.auth.getUser).not.toHaveBeenCalled();
    expect(s.apiCalls).toHaveLength(1);
    expect(stateOf(s.root)).toBe("shown");
  });

  it("設定が読めなければエラー config_unavailable で、もう一度読むと頁を読み直す", async () => {
    const s = setup({ configStatus: 404 });
    await startApp(s.root, s.deps);
    expect(stateOf(s.root)).toBe("error");
    expect(s.root.textContent).toContain("config_unavailable");
    s.root.querySelector("button")?.click();
    expect(s.deps.location.reload).toHaveBeenCalledTimes(1);
  });

  it("戻りの失敗はエラー login_failed で、もう一度読むとログインへ送り直す", async () => {
    const s = setup({ href: "https://app.example.com/?code=abc&state=bad", callback: "fail" });
    await startApp(s.root, s.deps);
    expect(stateOf(s.root)).toBe("error");
    expect(s.root.textContent).toContain("login_failed");
    expect(s.apiCalls).toHaveLength(0);
    s.root.querySelector("button")?.click();
    await vi.waitFor(() => expect(s.auth.signinRedirect).toHaveBeenCalledTimes(1));
  });

  it("経路が 401 なら token を捨てて 1 回だけログインへ送り直す", async () => {
    const s = setup({ user: { access_token: "tok" }, api: [{ status: 401 }] });
    await startApp(s.root, s.deps);
    expect(s.auth.removeUser).toHaveBeenCalledTimes(1);
    expect(s.auth.signinRedirect).toHaveBeenCalledTimes(1);
    expect(s.storage.getItem(REAUTH_KEY)).not.toBeNull();
    expect(stateOf(s.root)).toBe("redirecting");
  });

  it("送り直した後にまた 401 ならエラー unauthorized で、送り直しを繰り返さない", async () => {
    const storage = memoryStorage();
    const first = setup({ user: { access_token: "tok" }, api: [{ status: 401 }], storage });
    await startApp(first.root, first.deps);
    const second = setup({ href: "https://app.example.com/?code=abc&state=xyz", api: [{ status: 401 }], storage });
    await startApp(second.root, second.deps);
    expect(second.auth.signinRedirect).not.toHaveBeenCalled();
    expect(stateOf(second.root)).toBe("error");
    expect(second.root.textContent).toContain("unauthorized");
  });

  it("表示できたら送り直しの印を消す", async () => {
    const storage = memoryStorage();
    storage.setItem(REAUTH_KEY, "1");
    const s = setup({ user: { access_token: "tok" }, storage });
    await startApp(s.root, s.deps);
    expect(stateOf(s.root)).toBe("shown");
    expect(storage.getItem(REAUTH_KEY)).toBeNull();
  });

  it("経路のほかの失敗はエラーと理由のコードで、経路は 1 回だけ", async () => {
    const s = setup({ user: { access_token: "tok" }, api: [{ status: 503, body: { reason: "store_unavailable" } }] });
    await startApp(s.root, s.deps);
    expect(stateOf(s.root)).toBe("error");
    expect(s.root.textContent).toContain("store_unavailable");
    expect(s.apiCalls).toHaveLength(1);
  });
});
