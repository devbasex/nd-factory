import { defineOperation, okItem } from "@nd-factory/contracts/operation";
import type { AuthDeps } from "@nd-factory/core/auth";
import type { ScopeReader } from "@nd-factory/core/authorize";
import { createClock } from "@nd-factory/core/clock";
import { TABLE_PURPOSES } from "@nd-factory/core/db";
import type { Handler } from "@nd-factory/core/dispatch";
import { createLogger } from "@nd-factory/core/log";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApiHandler, defaultApiDeps, tableNamesOf, type ApiDeps } from "../src/entries/api-fn.ts";
import { FakeStore } from "./fake-store.ts";

// DynamoDB と IdP には触れない。表は偽の文書のクライアントの上の createDb、人は偽の Cognito の照らしと偽の対応の行の読み手で決める

const NOW = Date.parse("2026-11-21T03:04:05.000Z");
const USER = "usr_01890a5d-ac96-774b-bcce-000000000001";
const BOUND_AT = "2026-11-21T03:00:00.000Z";
const HUMAN_TOKEN = "eyJhbGciOiJSUzI1NiJ9.e30.c2ln";

// 経路の表にある読む操作（/v1/teams/get）を、要素と結果の形を持つ作り物の定義で振り分ける
const teamsList = defineOperation({
  name: "teams.get",
  features: ["F2"],
  access: "read",
  delegationKind: "read",
  item: z.strictObject({ label: z.string() }),
  result: okItem(z.strictObject({ label: z.string() })),
  owner: "#2",
});

const echo: Handler = async (item) => ({ result: { ok: true, item: { label: (item as { label: string }).label } }, writes: [] });

const openScope: ScopeReader = {
  seatsOf: async () => [],
  projectsOfTeams: async () => [],
  projectOfTarget: async () => ({ kind: "none" }),
  laneOf: async () => [],
  transferTargetOf: async () => null,
  isHumanOnlyItem: async () => false,
};

function setup(handler: Handler = echo) {
  const store = new FakeStore();
  const lines: string[] = [];
  const clock = createClock(() => NOW);
  const auth: AuthDeps = {
    cognito: async () => ({ ok: true, value: { sub: "acme-sub-1", username: "acme-user", authTime: Date.parse(BOUND_AT) / 1000, originJti: "acme-jti-1" } }),
    signingKey: null,
    webhookSecret: null,
    clock,
    readers: {
      userOfSubject: async () => ({ userId: USER, boundAuthTime: BOUND_AT }),
      sessionRevocation: async () => null,
      cognitoIdentity: async () => null,
      delegation: async () => null,
      touchDelegation: async () => {},
      machine: async () => null,
      lane: async () => null,
      dbPrep: async () => null,
    },
  };
  const deps: ApiDeps = {
    operations: [teamsList],
    handlers: { "teams.get": handler },
    scope: openScope,
    auth,
    db: store.asDb("acme-test-service"),
    clock,
    log: (context) => createLogger(context, (line) => lines.push(line)),
  };
  return { store, lines, handle: createApiHandler(deps) };
}

function event(path: string, body: string | undefined, opts: { base64?: boolean; method?: string; token?: string | null } = {}): APIGatewayProxyEventV2 {
  const token = opts.token === undefined ? HUMAN_TOKEN : opts.token;
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    isBase64Encoded: opts.base64 ?? false,
    body: opts.base64 && body !== undefined ? Buffer.from(body).toString("base64") : body,
    requestContext: { requestId: "req-1", http: { method: opts.method ?? "POST" } },
  } as unknown as APIGatewayProxyEventV2;
}

const context = (remainingMs = 10_000): Context => ({ getRemainingTimeInMillis: () => remainingMs }) as unknown as Context;

const structured = (res: unknown) => res as APIGatewayProxyStructuredResultV2;
const bodyOf = (res: unknown) => JSON.parse(structured(res).body ?? "") as unknown;

describe("createApiHandler", () => {
  it("偽の操作とハンドラーで 200 と要素の結果の配列を返し、no-store を付ける", async () => {
    const { handle } = setup();
    const res = structured(await handle(event("/v1/teams/get", '[{"label":"one"},{"label":"two"}]'), context()));
    expect(res.statusCode).toBe(200);
    expect(res.headers?.["cache-control"]).toBe("no-store");
    expect(res.headers?.["content-type"]).toBe("application/json");
    expect(bodyOf(res)).toEqual([
      { ok: true, item: { label: "one" } },
      { ok: true, item: { label: "two" } },
    ]);
  });

  it("base64 の本文を解いて読む", async () => {
    const { handle } = setup();
    const res = structured(await handle(event("/v1/teams/get", '[{"label":"one"}]', { base64: true }), context()));
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual([{ ok: true, item: { label: "one" } }]);
  });

  it("I12: 配列でない本文は 400 body_not_array で、no-store を付ける（受け入れ条件 5）", async () => {
    const { handle } = setup();
    const res = structured(await handle(event("/v1/teams/get", '{"a": 1}'), context()));
    expect(res.statusCode).toBe(400);
    expect(res.headers?.["cache-control"]).toBe("no-store");
    expect(res.headers?.["content-type"]).toBe("application/problem+json");
    expect(bodyOf(res)).toEqual({ type: "about:blank", status: 400, reason: "body_not_array" });
  });

  it("ハンドラーの例外は 503 で、500 を返さない", async () => {
    const { handle } = setup(async () => {
      throw new Error("boom");
    });
    const res = structured(await handle(event("/v1/teams/get", '[{"label":"one"}]'), context()));
    expect(res.statusCode).toBe(503);
    expect(res.headers?.["cache-control"]).toBe("no-store");
  });

  it("関数の残り時間を振り分けへ渡す（予備の時間を下回れば要素を処理せずに 503）", async () => {
    let called = 0;
    const { handle } = setup(async (item, ctx) => {
      called += 1;
      return echo(item, ctx);
    });
    const res = structured(await handle(event("/v1/teams/get", '[{"label":"one"}]'), context(100)));
    expect(res.statusCode).toBe(503);
    expect(called).toBe(0);
  });

  it("表に無い経路は 404 で、要約の記録の行を書く", async () => {
    const { handle, store } = setup();
    const res = structured(await handle(event("/v1/nothing/here", "[]"), context()));
    expect(res.statusCode).toBe(404);
    expect(res.headers?.["cache-control"]).toBe("no-store");
    expect(store.calls).toHaveLength(1);
  });

  it("読めない形の要求でも 500 を返さず 503 にする", async () => {
    const { handle } = setup();
    const broken = { rawPath: "/v1/teams/get", isBase64Encoded: false } as unknown as APIGatewayProxyEventV2;
    const res = structured(await handle(broken, context()));
    expect(res.statusCode).toBe(503);
    expect(res.headers?.["cache-control"]).toBe("no-store");
  });

  it("ログは要求の ID と関数と受け口を文脈に持ち、token と本文の値を出さない", async () => {
    const { handle, lines } = setup();
    await handle(event("/v1/teams/get", '[{"label":"secret-label"}]'), context());
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ request_id: "req-1", fn: "api-fn", endpoint: "user" });
      expect(line).not.toContain(HUMAN_TOKEN);
      expect(line).not.toContain("secret-label");
    }
  });
});

describe("tableNamesOf", () => {
  const env = Object.fromEntries(TABLE_PURPOSES.map((purpose) => [`${purpose.toUpperCase()}_TABLE`, `acme-test-${purpose}`]));

  it("用途ごとの環境変数から表の名前を組む", () => {
    expect(tableNamesOf(env)).toEqual(Object.fromEntries(TABLE_PURPOSES.map((purpose) => [purpose, `acme-test-${purpose}`])));
  });

  it.each([["AUDIT_TABLE"], ["IDEMPOTENCY_TABLE"]])("%s が無いか空なら null", (name) => {
    expect(tableNamesOf({ ...env, [name]: undefined })).toBeNull();
    expect(tableNamesOf({ ...env, [name]: "" })).toBeNull();
  });
});

describe("defaultApiDeps", () => {
  const env = Object.fromEntries(TABLE_PURPOSES.map((purpose) => [`${purpose.toUpperCase()}_TABLE`, `acme-test-${purpose}`]));

  it("ハンドラーの表は空", () => {
    const deps = defaultApiDeps(env, new FakeStore().asClient());
    expect(deps.handlers).toEqual({});
  });

  it.each([
    ["人の token", HUMAN_TOKEN],
    ["委任の token", `ndfd_${USER}.dlg_01890a5d-ac96-774b-bcce-000000000030.c2VjcmV0`],
    ["token 無し", null],
  ])("認証の依存は閉じていて、%s を 401 で断つ", async (_label, token) => {
    const store = new FakeStore();
    const handle = createApiHandler(defaultApiDeps(env, store.asClient()));
    const res = structured(await handle(event("/v1/teams/get", '[{"label":"one"}]', { token }), context()));
    expect(res.statusCode).toBe(401);
    expect(res.headers?.["cache-control"]).toBe("no-store");
  });

  it("表の名前が足りないと、表へ送らずに 503 にする", async () => {
    const store = new FakeStore();
    const handle = createApiHandler(defaultApiDeps({ ...env, AUDIT_TABLE: undefined }, store.asClient()));
    const res = structured(await handle(event("/v1/teams/get", '[{"label":"one"}]'), context()));
    expect(res.statusCode).toBe(503);
    expect(store.calls).toHaveLength(0);
  });
});
