import { type Page, type Request, type Route, expect, test } from "@playwright/test";

// 利用者プールの認可と token、API、画面の設定の値をブラウザーのネットワークの手前で差し替える。
// 製品のコードは本物の URL を /config.json から読むだけで、試験のための分岐を持たない

const AUTH = "https://acme-test.auth.example.com";
const API = "https://api.example.com";
const CLIENT_ID = "example-app-client";
const SUB = "example-user-sub";
const CREATED_AT = "2026-01-02T03:04:05.000Z";

function config(loginReady: boolean) {
  return { api_url: API, authority: AUTH, client_id: CLIENT_ID, login_ready: loginReady };
}

function cors(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
  };
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// 署名を照らさない部品なので、形だけの JWT で足りる
function fakeJwt(claims: Record<string, unknown>): string {
  return `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url(claims)}.c2lnbmF0dXJl`;
}

type Recorder = { authorize: URL[]; token: Request[]; api: Request[]; other: string[] };

type StubOptions = {
  loginReady: boolean;
  finishLogin: boolean;
  // API が順に返す状態コード。尽きた後は 200
  apiStatus?: number[];
  configStatus?: number;
  tokenStatus?: number;
};

async function stubNetwork(page: Page, opts: StubOptions): Promise<Recorder> {
  const apiStatus = [...(opts.apiStatus ?? [])];
  const rec: Recorder = { authorize: [], token: [], api: [], other: [] };

  await page.route("**/config.json", (route) =>
    route.fulfill({ status: opts.configStatus ?? 200, json: config(opts.loginReady) }),
  );

  await page.route(`${AUTH}/**`, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const origin = req.headers()["origin"] ?? "*";
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors(origin) });

    if (url.pathname === "/oauth2/authorize") {
      rec.authorize.push(url);
      if (!opts.finishLogin) {
        return route.fulfill({ status: 200, contentType: "text/html", body: "<p>sign in</p>" });
      }
      // Google でのログインを終えた体で、認可コードを持たせて戻り先へ返す
      const back = new URL(url.searchParams.get("redirect_uri") ?? "/");
      back.searchParams.set("code", "example-code");
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<script>location.replace(${JSON.stringify(back.toString())})</script>`,
      });
    }

    if (url.pathname === "/oauth2/token") {
      rec.token.push(req);
      if (opts.tokenStatus !== undefined) {
        return route.fulfill({ status: opts.tokenStatus, headers: cors(origin), json: { error: "invalid_grant" } });
      }
      const authorizeUrl = rec.authorize.at(-1);
      const nonce = authorizeUrl?.searchParams.get("nonce");
      const now = Math.floor(Date.now() / 1000);
      const claims = { sub: SUB, iss: AUTH, aud: CLIENT_ID, iat: now, exp: now + 3600, ...(nonce ? { nonce } : {}) };
      return route.fulfill({
        status: 200,
        headers: cors(origin),
        json: {
          access_token: fakeJwt({ sub: SUB, client_id: CLIENT_ID, iat: now, exp: now + 3600 }),
          id_token: fakeJwt(claims),
          token_type: "Bearer",
          expires_in: 3600,
        },
      });
    }

    rec.other.push(req.url());
    return route.fulfill({ status: 404, headers: cors(origin) });
  });

  await page.route(`${API}/**`, async (route: Route) => {
    const req = route.request();
    const origin = req.headers()["origin"] ?? "*";
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors(origin) });
    rec.api.push(req);
    const status = apiStatus.shift() ?? 200;
    if (status !== 200) return route.fulfill({ status, headers: cors(origin) });
    return route.fulfill({
      status: 200,
      headers: cors(origin),
      json: [{ status: "ok", item: { id: SUB, created_at: CREATED_AT } }],
    });
  });

  return rec;
}

test("token が無いと、認可コードと PKCE（S256）で認可の頁へ送る", async ({ page, baseURL }) => {
  const rec = await stubNetwork(page, { loginReady: true, finishLogin: false });
  await page.goto("/");
  await expect.poll(() => rec.authorize.length).toBe(1);

  const url = rec.authorize[0]!;
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBeTruthy();
  expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
  expect(url.searchParams.get("redirect_uri")).toBe(`${baseURL}/`);
  expect(rec.api).toHaveLength(0);
});

test("login_ready が偽なら、設定の待ちを示してログインへ送らない", async ({ page, baseURL }) => {
  const rec = await stubNetwork(page, { loginReady: false, finishLogin: false });
  await page.goto("/");
  await expect(page.getByText("ログインの設定を待っています")).toBeVisible();
  expect(page.url()).toBe(`${baseURL}/`);
  expect(rec.authorize).toHaveLength(0);
  expect(rec.token).toHaveLength(0);
  expect(rec.api).toHaveLength(0);
});

test("ログインの戻りの後に経路を 1 回だけ呼び、利用者の行を表示する", async ({ page, baseURL }) => {
  const rec = await stubNetwork(page, { loginReady: true, finishLogin: true });
  await page.goto("/");

  await expect(page.getByText(SUB)).toBeVisible();
  await expect(page.locator(`time[datetime="${CREATED_AT}"]`)).toBeVisible();

  // 認可コードの交換は PKCE の検証子つきで 1 回
  expect(rec.token).toHaveLength(1);
  const form = new URLSearchParams(rec.token[0]!.postData() ?? "");
  expect(form.get("grant_type")).toBe("authorization_code");
  expect(form.get("code")).toBe("example-code");
  expect(form.get("code_verifier")).toBeTruthy();

  // 経路は self の 1 要素で 1 回だけ。token を Bearer で渡す
  expect(rec.api).toHaveLength(1);
  const call = rec.api[0]!;
  expect(call.method()).toBe("PUT");
  expect(new URL(call.url()).pathname).toBe("/v1/users");
  expect(call.postData()).toBe('[{"id":"self"}]');
  expect(call.headers()["authorization"]).toMatch(/^Bearer \S+$/);

  // 認可コードを URL に残さない
  expect(page.url()).toBe(`${baseURL}/`);
  expect(rec.other).toHaveLength(0);
});

test("API が 401 なら 1 回だけログインへ送り直し、取り直した token で表示する", async ({ page }) => {
  const rec = await stubNetwork(page, { loginReady: true, finishLogin: true, apiStatus: [401] });
  await page.goto("/");

  await expect(page.getByText(SUB)).toBeVisible();
  expect(rec.authorize).toHaveLength(2);
  expect(rec.api).toHaveLength(2);
});

test("送り直した後にまた 401 ならエラーを出し、送り直しを繰り返さない", async ({ page }) => {
  const rec = await stubNetwork(page, { loginReady: true, finishLogin: true, apiStatus: [401, 401] });
  await page.goto("/");

  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: /もう一度/ })).toBeVisible();
  expect(rec.authorize).toHaveLength(2);
  expect(rec.api).toHaveLength(2);
});

test("画面の設定の値が読めなければエラーと「もう一度」を出し、押すと読み直す", async ({ page }) => {
  const rec = await stubNetwork(page, { loginReady: true, finishLogin: false, configStatus: 404 });
  await page.goto("/");
  const retry = page.getByRole("button", { name: /もう一度/ });
  await expect(page.getByRole("alert")).toBeVisible();

  const reread = page.waitForRequest("**/config.json");
  await retry.click();
  await reread;
  expect(rec.authorize).toHaveLength(0);
});

test("ログインの戻りが失敗するとエラーを出し、「もう一度」でログインへ送り直す", async ({ page }) => {
  const rec = await stubNetwork(page, { loginReady: true, finishLogin: true, tokenStatus: 400 });
  await page.goto("/");

  await expect(page.getByRole("alert")).toBeVisible();
  expect(rec.api).toHaveLength(0);
  expect(new URL(page.url()).search).toBe("");
  await page.getByRole("button", { name: /もう一度/ }).click();
  await expect.poll(() => rec.authorize.length).toBe(2);
});
