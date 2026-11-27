import type { Page, Request, Route } from "@playwright/test";

// 利用者プールの認可と token、API、画面の設定の値をブラウザーのネットワークの手前で差し替える。
// 製品のコードは本物の URL を /config.json から読むだけで、試験のための分岐を持たない

const AUTH = "https://acme-test.auth.example.com";
const API = "https://api.example.com";
export const CLIENT_ID = "example-app-client";
export const SUB = "example-user-sub";
export const CREATED_AT = "2026-01-02T03:04:05.000Z";

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

export async function stubNetwork(page: Page, opts: StubOptions): Promise<Recorder> {
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
