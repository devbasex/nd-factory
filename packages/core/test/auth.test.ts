import { FetchError } from "aws-jwt-verify/error";
import type { Fetcher } from "aws-jwt-verify/https";
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authenticate,
  createCognitoCheck,
  DELEGATION_TOUCH_MS,
  idempotencyPrincipalKey,
  LOGIN_BIND_FRESH_MS,
  verifyLoginToLink,
  type AuthDeps,
  type AuthReaders,
  type CognitoBinding,
  type DbPrepRecord,
  type DelegationRecord,
  type InboundRequest,
  type LaneRecord,
  type MachineRecord,
} from "../src/auth/authenticate.ts";
import { createClock } from "../src/clock.ts";
import { createLogger } from "../src/log.ts";

// IdP と表には触れない。Cognito の公開鍵は差し替えた取り手が返し、鍵と token はテストの中で作った作り物にする。
// 時刻は注入した時計の NOW を使う。実時刻も NOW に止め、注入した時計と実時刻が違うときの照らしは個別に実時刻をずらして確かめる

const NOW = Date.parse("2026-11-21T03:04:05.000Z");
const clock = createClock(() => NOW);
const NOW_SEC = NOW / 1000;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

const id = <K extends string>(kind: K, n: number) => `${kind}_01890a5d-ac96-774b-bcce-${n.toString(16).padStart(12, "0")}` as `${K}_${string}`;

const USER = id("usr", 1);
const DELEGATION = id("dlg", 2);
const TEAM = id("team", 3);
const MACHINE = id("mch", 4);
const LANE = id("lane", 5);
const PROJECT = id("prj", 6);
const PREP = "prep-acme-1";

const UNAUTHORIZED = { ok: false, reason: "unauthorized" } as const;
const UNAVAILABLE = { ok: false, reason: "unavailable" } as const;
const LINK_INVALID = { ok: false, reason: "link_invalid" } as const;

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const newSecret = (): string => randomBytes(32).toString("base64url");
const iso = (ms: number): string => new Date(ms).toISOString();

// Cognito の作り物

const POOL = "us-west-2_EXAMPLE";
const CLIENT = "acmeclient";
const ISSUER = `https://cognito-idp.us-west-2.amazonaws.com/${POOL}`;
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherRsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWKS = { keys: [{ ...rsa.publicKey.export({ format: "jwk" }), kid: "kid-1", alg: "RS256", use: "sig" }] };

function cognitoToken(over: Record<string, unknown> = {}, opts: { key?: KeyObject; kid?: string } = {}): string {
  const sub = typeof over["sub"] === "string" ? over["sub"] : "cognito-sub-1";
  const payload: Record<string, unknown> = { sub, username: `google_${sub}`, iss: ISSUER, client_id: CLIENT, token_use: "access", auth_time: NOW_SEC - 60, origin_jti: `session-${sub}`, iat: NOW_SEC, exp: NOW_SEC + 600, ...over };
  for (const [k, v] of Object.entries(payload)) if (v === undefined) delete payload[k];
  const input = `${b64({ alg: "RS256", kid: opts.kid ?? "kid-1", typ: "JWT" })}.${b64(payload)}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), opts.key ?? rsa.privateKey).toString("base64url")}`;
}

function fakeFetcher(mode: "ok" | "fail" = "ok"): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async fetch(uri) {
      calls.push(uri);
      if (mode === "fail") throw new FetchError(uri, "Response time-out (after 3000 ms.)");
      return new TextEncoder().encode(JSON.stringify(JWKS)).buffer as ArrayBuffer;
    },
  };
}

// Ed25519 の作り物（nd-factory 自身の署名の鍵）

const ed = generateKeyPairSync("ed25519");
const otherEd = generateKeyPairSync("ed25519");

function signedToken(payload: Record<string, unknown>, key: KeyObject = ed.privateKey, alg = "EdDSA"): string {
  const input = `${b64({ alg, typ: "JWT" })}.${b64(payload)}`;
  return `${input}.${sign(null, Buffer.from(input), key).toString("base64url")}`;
}

const laneClaims = (over: Record<string, unknown> = {}) => ({ aud: "lane", token_use: "lane", sub: LANE, project_id: PROJECT, generation: 2, exp: NOW_SEC + 3600, ...over });
const prepClaims = (over: Record<string, unknown> = {}) => ({ aud: "db_prep", token_use: "exchange", sub: PREP, project_id: PROJECT, exp: NOW_SEC + 600, ...over });

// 読み手の作り物

type World = {
  delegation?: DelegationRecord | null;
  machine?: MachineRecord | null;
  lane?: LaneRecord | null;
  prep?: DbPrepRecord | null;
  fail?: Error;
  touchFail?: Error;
  // 結んだ主体（cognito-sub-1）の対応の行の bound_auth_time
  boundAuthTime?: string;
  // cognito-sub-1 以外の主体の対応の行（外した主体など）。無ければ一度も結んでいない
  bindings?: Readonly<Record<string, CognitoBinding>>;
};

function readers(world: World): AuthReaders & { touches: string[][] } {
  const touches: string[][] = [];
  const guard = () => {
    if (world.fail !== undefined) throw world.fail;
  };
  return {
    touches,
    async userOfSubject(sub) {
      guard();
      if (sub === "cognito-sub-1") return { state: "bound", userId: USER, boundAuthTime: world.boundAuthTime ?? iso(NOW - 86_400_000), epoch: 0, version: 1 };
      return world.bindings?.[sub] ?? null;
    },
    // 利用者プールの作り物: username は google_<sub>。identities の無い利用者（unlinked）は null
    async cognitoIdentity(username) {
      guard();
      const sub = username.replace(/^google_/, "");
      return sub === "cognito-sub-unlinked" ? null : { cognitoSub: sub, idp: "google", subject: `g-${sub}` };
    },
    async delegation() {
      guard();
      return world.delegation ?? null;
    },
    async touchDelegation(userId, delegationId, at, ifBefore) {
      touches.push([userId, delegationId, at, ifBefore]);
      if (world.touchFail !== undefined) throw world.touchFail;
    },
    async machine() {
      guard();
      return world.machine ?? null;
    },
    async lane() {
      guard();
      return world.lane ?? null;
    },
    async dbPrep() {
      guard();
      return world.prep ?? null;
    },
  };
}

function setup(world: World = {}, opts: { fetcher?: Fetcher; webhookSecret?: string | null } = {}) {
  const lines: string[] = [];
  const r = readers(world);
  const deps: AuthDeps = {
    cognito: createCognitoCheck({ userPoolId: POOL, clientId: CLIENT }, { fetcher: opts.fetcher ?? fakeFetcher() }),
    signingKey: ed.publicKey,
    webhookSecret: opts.webhookSecret === undefined ? "acme-webhook-secret" : opts.webhookSecret,
    readers: r,
    clock,
    log: createLogger({ request_id: "req-1", fn: "test", endpoint: "user" }, (line) => lines.push(line)),
  };
  return { deps, lines, readers: r };
}

const req = (endpoint: InboundRequest["endpoint"], token: string | null, operation = "projects.get"): InboundRequest => ({ endpoint, operation, token });

// 委任の token と行
function delegationFixture(over: Partial<DelegationRecord> = {}) {
  const secret = newSecret();
  const token = `ndfd_${USER}.${DELEGATION}.${secret}`;
  const record: DelegationRecord = {
    secretSha256: sha256(secret),
    expiresAt: iso(NOW + 7 * 86_400_000),
    revokedAt: null,
    lastUsedAt: iso(NOW - 60_000),
    scope: { projectIds: [PROJECT], operations: "read" },
    clientName: "acme-agent",
    ...over,
  };
  return { token, secret, record };
}

function machineFixture(over: Partial<MachineRecord> = {}) {
  const secret = newSecret();
  return { token: `ndfm_${TEAM}.${MACHINE}.${secret}`, secret, record: { secretSha256: sha256(secret), expiresAt: iso(NOW + 86_400_000), revokedAt: null, ...over } };
}

describe("authenticate: 人（Cognito の access token）", () => {
  it("署名・発行元・client_id・token_use・期限が合えば人に決まる", async () => {
    const fetcher = fakeFetcher();
    const { deps } = setup({}, { fetcher });
    await expect(authenticate(req("user", cognitoToken()), deps)).resolves.toEqual({ ok: true, principal: { kind: "human", userId: USER, cognitoSub: "cognito-sub-1", sessionId: "session-cognito-sub-1", bindingEpoch: 0 } });
    expect(fetcher.calls).toEqual([`${ISSUER}/.well-known/jwks.json`]);
  });

  it("公開鍵は控えから使い、2 回目の要求で取り直さない", async () => {
    const fetcher = fakeFetcher();
    const { deps } = setup({}, { fetcher });
    await authenticate(req("user", cognitoToken()), deps);
    await authenticate(req("user", cognitoToken()), deps);
    expect(fetcher.calls).toHaveLength(1);
  });

  it.each([
    ["期限切れ", cognitoToken({ exp: NOW_SEC - 1 })],
    ["期限の時刻ちょうど", cognitoToken({ exp: NOW_SEC })],
    ["exp が無い", cognitoToken({ exp: undefined })],
    ["exp が文字列", cognitoToken({ exp: String(NOW_SEC + 600) })],
    ["nbf が先", cognitoToken({ nbf: NOW_SEC + 60 })],
    ["別のクライアント", cognitoToken({ client_id: "other-client" })],
    ["id token", cognitoToken({ token_use: "id" })],
    ["別の発行元", cognitoToken({ iss: "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_OTHER" })],
    ["署名の違い", cognitoToken({}, { key: otherRsa.privateKey })],
    ["知らない kid", cognitoToken({}, { kid: "kid-unknown" })],
    ["形の違い", "a.b.c"],
    ["結んでいない主体", cognitoToken({ sub: "cognito-sub-unknown" })],
  ])("%s は理由によらず同じ unauthorized", async (_label, token) => {
    const { deps } = setup();
    await expect(authenticate(req("user", token), deps)).resolves.toEqual(UNAUTHORIZED);
  });

  it("結んでいない主体は sessions.create にだけ、まだ結んでいない人として渡る", async () => {
    const { deps } = setup();
    const token = cognitoToken({ sub: "cognito-sub-new" });
    // IdP の主体は本文から採らず、検証した username で利用者プールを引いて得る
    await expect(authenticate(req("user", token, "sessions.create"), deps)).resolves.toEqual({
      ok: true,
      principal: { kind: "newcomer", login: { cognitoSub: "cognito-sub-new", username: "google_cognito-sub-new", idp: "google", subject: "g-cognito-sub-new", authTime: NOW_SEC - 60, bindingEpoch: 0, rowVersion: null } },
    });
    await expect(authenticate(req("user", token, "users.get"), deps)).resolves.toEqual(UNAUTHORIZED);
    // 結んだ主体は sessions.create でも人
    await expect(authenticate(req("user", cognitoToken(), "sessions.create"), deps)).resolves.toEqual({ ok: true, principal: { kind: "human", userId: USER, cognitoSub: "cognito-sub-1", sessionId: "session-cognito-sub-1", bindingEpoch: 0 } });
    // 検証に外れた token は sessions.create でも断る
    await expect(authenticate(req("user", cognitoToken({ sub: "cognito-sub-new", exp: NOW_SEC - 1 }), "sessions.create"), deps)).resolves.toEqual(UNAUTHORIZED);
  });

  it("結ぶ token は新しいサインインに限り、利用者プールで IdP の主体を引けなければ断る", async () => {
    const { deps } = setup();
    const stale = cognitoToken({ sub: "cognito-sub-new", auth_time: (NOW - LOGIN_BIND_FRESH_MS - 1000) / 1000 });
    await expect(authenticate(req("user", stale, "sessions.create"), deps)).resolves.toEqual(UNAUTHORIZED);
    await expect(authenticate(req("user", cognitoToken({ sub: "cognito-sub-unlinked" }), "sessions.create"), deps)).resolves.toEqual(UNAUTHORIZED);
    // username・auth_time・origin_jti の無い token は形の違い
    await expect(authenticate(req("user", cognitoToken({ username: undefined })), deps)).resolves.toEqual(UNAUTHORIZED);
    await expect(authenticate(req("user", cognitoToken({ origin_jti: undefined })), deps)).resolves.toEqual(UNAUTHORIZED);
    await expect(authenticate(req("user", cognitoToken({ auth_time: undefined })), deps)).resolves.toEqual(UNAUTHORIZED);
  });

  it("対応の行を結んだときより前にサインインした token は断る（外して結び直す前のセッション）", async () => {
    const { deps } = setup({ boundAuthTime: iso(NOW - 30_000) });
    await expect(authenticate(req("user", cognitoToken({ auth_time: NOW_SEC - 60 })), deps)).resolves.toEqual(UNAUTHORIZED);
    await expect(authenticate(req("user", cognitoToken({ auth_time: NOW_SEC - 30 })), deps)).resolves.toMatchObject({ ok: true });
  });

  it("外した主体は、失効を済ませた後の新しいサインインでだけ sessions.create へ渡り、外す前と失効の待ちのサインインでは結び直せない", async () => {
    const bindings: Record<string, CognitoBinding> = {
      "cognito-sub-out": { state: "unlinked", revokedBefore: iso(NOW - 30_000), epoch: 1, version: 3 },
      "cognito-sub-pending": { state: "signing_out", epoch: 1, version: 2 },
    };
    const { deps } = setup({ bindings });
    // 外す前（失効の境の前）にサインインした token は、まだ 5 分の内でも結び直せない
    await expect(authenticate(req("user", cognitoToken({ sub: "cognito-sub-out", auth_time: NOW_SEC - 60 }), "sessions.create"), deps)).resolves.toEqual(UNAUTHORIZED);
    await expect(authenticate(req("user", cognitoToken({ sub: "cognito-sub-out", auth_time: NOW_SEC - 30 }), "sessions.create"), deps)).resolves.toEqual(UNAUTHORIZED);
    await expect(authenticate(req("user", cognitoToken({ sub: "cognito-sub-out", auth_time: NOW_SEC - 29 }), "sessions.create"), deps)).resolves.toEqual({
      ok: true,
      principal: { kind: "newcomer", login: { cognitoSub: "cognito-sub-out", username: "google_cognito-sub-out", idp: "google", subject: "g-cognito-sub-out", authTime: NOW_SEC - 29, bindingEpoch: 1, rowVersion: 3 } },
    });
    // 外した主体はほかの操作を通らない
    await expect(authenticate(req("user", cognitoToken({ sub: "cognito-sub-out", auth_time: NOW_SEC - 29 })), deps)).resolves.toEqual(UNAUTHORIZED);
    // 失効の済むのを待つ間は、新しいサインインでも結び直せない
    await expect(authenticate(req("user", cognitoToken({ sub: "cognito-sub-pending", auth_time: NOW_SEC - 1 }), "sessions.create"), deps)).resolves.toEqual(UNAUTHORIZED);
  });

  it("sessions.create の冪等の鍵は、対応の行を作る前と後で同じで、外すと変わる", () => {
    const login = { cognitoSub: "cognito-sub-new", username: "google_cognito-sub-new", idp: "google", subject: "g-1", authTime: NOW_SEC, bindingEpoch: 0, rowVersion: null } as const;
    const before = idempotencyPrincipalKey({ kind: "newcomer", login }, "sessions.create");
    const after = idempotencyPrincipalKey({ kind: "human", userId: USER, cognitoSub: "cognito-sub-new", sessionId: "s-1", bindingEpoch: 0 }, "sessions.create");
    expect(after).toBe(before);
    // 外した後に結び直した要求は、外す前の結果を引かない
    const relinked = idempotencyPrincipalKey({ kind: "newcomer", login: { ...login, bindingEpoch: 1, rowVersion: 3 } }, "sessions.create");
    expect(relinked).not.toBe(before);
    expect(idempotencyPrincipalKey({ kind: "human", userId: id("usr", 9), cognitoSub: "cognito-sub-new", sessionId: "s-2", bindingEpoch: 1 }, "sessions.create")).toBe(relinked);
    expect(idempotencyPrincipalKey({ kind: "human", userId: USER, cognitoSub: "cognito-sub-new", sessionId: "s-1", bindingEpoch: 0 }, "users.get")).toBe(USER);
  });
});

describe("verifyLoginToLink: logins.create が認可コードの交換で得た、つなぐログインの token", () => {
  it("まだ結んでいない主体の新しいサインインだけを、サーバーの側で引いた IdP の主体とともに返す", async () => {
    const { deps } = setup();
    await expect(verifyLoginToLink(cognitoToken({ sub: "cognito-sub-new" }), "google", deps)).resolves.toEqual({
      ok: true,
      login: { cognitoSub: "cognito-sub-new", username: "google_cognito-sub-new", idp: "google", subject: "g-cognito-sub-new", authTime: NOW_SEC - 60, bindingEpoch: 0, rowVersion: null },
    });
  });

  it("既に結んだ主体は already_linked（IdP で別のアカウントを選び直す）", async () => {
    const { deps } = setup();
    await expect(verifyLoginToLink(cognitoToken(), "google", deps)).resolves.toEqual({ ok: false, reason: "already_linked" });
  });

  it("外した主体は、失効を済ませた後のサインインだけを返す", async () => {
    const { deps } = setup({ bindings: { "cognito-sub-out": { state: "unlinked", revokedBefore: iso(NOW - 30_000), epoch: 2, version: 5 } } });
    await expect(verifyLoginToLink(cognitoToken({ sub: "cognito-sub-out", auth_time: NOW_SEC - 60 }), "google", deps)).resolves.toEqual(LINK_INVALID);
    await expect(verifyLoginToLink(cognitoToken({ sub: "cognito-sub-out", auth_time: NOW_SEC - 10 }), "google", deps)).resolves.toMatchObject({ ok: true, login: { bindingEpoch: 2, rowVersion: 5 } });
  });

  it.each([
    ["古いサインイン", cognitoToken({ sub: "cognito-sub-new", auth_time: (NOW - LOGIN_BIND_FRESH_MS - 1000) / 1000 })],
    ["期限切れ", cognitoToken({ sub: "cognito-sub-new", exp: NOW_SEC - 1 })],
    ["IdP の主体を引けない", cognitoToken({ sub: "cognito-sub-unlinked" })],
    ["JWT でない", "ndfd_x.y.z"],
  ])("%s は link_invalid（流れを始め直す）", async (_label, token) => {
    const { deps } = setup();
    await expect(verifyLoginToLink(token, "google", deps)).resolves.toEqual(LINK_INVALID);
  });

  it("サーバーの側で得た IdP が流れを始めたときに選んだ IdP と違えば link_invalid", async () => {
    const { deps } = setup();
    await expect(verifyLoginToLink(cognitoToken({ sub: "cognito-sub-new" }), "github", deps)).resolves.toEqual(LINK_INVALID);
  });

  it("利用者プールか表に届かなければ unavailable", async () => {
    const { deps } = setup({ fail: new Error("down") });
    await expect(verifyLoginToLink(cognitoToken({ sub: "cognito-sub-new" }), "google", deps)).resolves.toEqual(UNAVAILABLE);
  });

  it("期限と nbf は実時刻でなく注入した時計だけで照らす", async () => {
    const { deps } = setup();
    try {
      // 実時刻が期限より後でも、注入した時計で期限の前なら通る
      vi.setSystemTime(NOW + 86_400_000);
      await expect(authenticate(req("user", cognitoToken({ exp: NOW_SEC + 600, nbf: NOW_SEC - 60 })), deps)).resolves.toMatchObject({ ok: true });
      // 実時刻が nbf より前でも、注入した時計で nbf を過ぎていれば通る
      vi.setSystemTime(NOW - 86_400_000);
      await expect(authenticate(req("user", cognitoToken({ exp: NOW_SEC + 600, nbf: NOW_SEC - 60 })), deps)).resolves.toMatchObject({ ok: true });
      // 実時刻では有効でも、注入した時計で期限切れか nbf の前なら断る
      vi.setSystemTime(NOW + 86_400_000);
      await expect(authenticate(req("user", cognitoToken({ exp: NOW_SEC - 1 })), deps)).resolves.toEqual(UNAUTHORIZED);
      vi.setSystemTime(NOW - 86_400_000);
      await expect(authenticate(req("user", cognitoToken({ nbf: NOW_SEC + 60 })), deps)).resolves.toEqual(UNAUTHORIZED);
    } finally {
      vi.setSystemTime(NOW);
    }
  });

  it("期限の 1 秒前は通り、期限は注入した時計で照らす", async () => {
    const { deps } = setup();
    await expect(authenticate(req("user", cognitoToken({ exp: NOW_SEC + 1 })), deps)).resolves.toMatchObject({ ok: true });
    // 実時刻では期限の前でも、注入した時計で期限を過ぎていれば断る
    const later = { ...deps, clock: createClock(() => NOW + 2000) };
    await expect(authenticate(req("user", cognitoToken({ exp: NOW_SEC + 1 })), later)).resolves.toEqual(UNAUTHORIZED);
  });

  it("全体の形の発行元も通り、設定に無い発行元は鍵を取らずに unauthorized", async () => {
    const fetcher = fakeFetcher();
    const { deps } = setup({}, { fetcher });
    await expect(authenticate(req("user", cognitoToken({ iss: "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_OTHER" })), deps)).resolves.toEqual(UNAUTHORIZED);
    expect(fetcher.calls).toHaveLength(0);
    await expect(authenticate(req("user", cognitoToken({ iss: `https://issuer-cognito-idp.us-west-2.amazonaws.com/${POOL}` })), deps)).resolves.toMatchObject({ ok: true });
  });

  it("公開鍵を取れないときは unavailable で、unauthorized にしない", async () => {
    const { deps, lines } = setup({}, { fetcher: fakeFetcher("fail") });
    await expect(authenticate(req("user", cognitoToken()), deps)).resolves.toEqual(UNAVAILABLE);
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({ level: "warn", result: "unavailable" });
  });

  it("受け口 mcp の JWT は鍵を取らずに unauthorized", async () => {
    const fetcher = fakeFetcher();
    const { deps } = setup({}, { fetcher });
    await expect(authenticate(req("mcp", cognitoToken()), deps)).resolves.toEqual(UNAUTHORIZED);
    expect(fetcher.calls).toHaveLength(0);
  });

  it("受け口 mcp の登録の token は行を読まずに unauthorized", async () => {
    const f = machineFixture();
    const { deps } = setup({ machine: f.record });
    const spy = vi.spyOn(deps.readers, "machine");
    await expect(authenticate(req("mcp", f.token), deps)).resolves.toEqual(UNAUTHORIZED);
    expect(spy).not.toHaveBeenCalled();
  });

  it("Cognito の設定の無い環境は人の token を断つ", async () => {
    const { deps } = setup();
    await expect(authenticate(req("user", cognitoToken()), { ...deps, cognito: null })).resolves.toEqual(UNAUTHORIZED);
  });
});

describe("authenticate: 委任", () => {
  it("受け口 user と mcp で、行の範囲とクライアントの名前を持つ委任に決まる", async () => {
    const { token, record } = delegationFixture();
    const { deps } = setup({ delegation: record });
    const principal = { kind: "delegation", userId: USER, delegationId: DELEGATION, scope: record.scope, clientName: "acme-agent" };
    await expect(authenticate(req("user", token), deps)).resolves.toEqual({ ok: true, principal });
    await expect(authenticate(req("mcp", token), deps)).resolves.toEqual({ ok: true, principal });
  });

  it("期限の 1 秒前は通り、1 秒後は unauthorized", async () => {
    const before = delegationFixture({ expiresAt: iso(NOW + 1000) });
    const after = delegationFixture({ expiresAt: iso(NOW - 1000) });
    await expect(authenticate(req("user", before.token), setup({ delegation: before.record }).deps)).resolves.toMatchObject({ ok: true });
    await expect(authenticate(req("user", after.token), setup({ delegation: after.record }).deps)).resolves.toEqual(UNAUTHORIZED);
  });

  it("秘密の違い・取り消し・無い行・形の違い・受け口の違いはどれも同じ unauthorized", async () => {
    const good = delegationFixture();
    const cases: [InboundRequest, World][] = [
      [req("user", `ndfd_${USER}.${DELEGATION}.${newSecret()}`), { delegation: good.record }],
      [req("user", good.token), { delegation: { ...good.record, revokedAt: iso(NOW - 1) } }],
      [req("user", good.token), { delegation: null }],
      [req("user", `ndfd_${USER}.${DELEGATION}.short`), { delegation: good.record }],
      [req("user", null), { delegation: good.record }],
      [req("runner", good.token), { delegation: good.record }],
      [req("machine", good.token), { delegation: good.record }],
    ];
    for (const [request, world] of cases) {
      await expect(authenticate(request, setup(world).deps)).resolves.toEqual(UNAUTHORIZED);
    }
  });

  it("最後に使った時刻は前の値から 1 時間以上たったときだけ書く", async () => {
    const recent = delegationFixture({ lastUsedAt: iso(NOW - DELEGATION_TOUCH_MS + 1) });
    const old = delegationFixture({ lastUsedAt: iso(NOW - DELEGATION_TOUCH_MS) });
    const never = delegationFixture({ lastUsedAt: null });
    const a = setup({ delegation: recent.record });
    await authenticate(req("user", recent.token), a.deps);
    expect(a.readers.touches).toHaveLength(0);
    const b = setup({ delegation: old.record });
    await authenticate(req("user", old.token), b.deps);
    expect(b.readers.touches).toEqual([[USER, DELEGATION, iso(NOW), iso(NOW - DELEGATION_TOUCH_MS)]]);
    const c = setup({ delegation: never.record });
    await authenticate(req("user", never.token), c.deps);
    expect(c.readers.touches).toHaveLength(1);
  });

  it("最後に使った時刻を書けなくても主体は決まり、warn を残す", async () => {
    const f = delegationFixture({ lastUsedAt: null });
    const failure = Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" });
    const { deps, lines } = setup({ delegation: f.record, touchFail: failure });
    await expect(authenticate(req("user", f.token), deps)).resolves.toMatchObject({ ok: true, principal: { kind: "delegation" } });
    expect(lines.map((l) => JSON.parse(l))).toContainEqual(expect.objectContaining({ level: "warn", error: "ProvisionedThroughputExceededException" }));
  });

  it("表に届かないときは unavailable", async () => {
    const f = delegationFixture();
    const failure = Object.assign(new Error("down"), { name: "InternalServerError" });
    await expect(authenticate(req("user", f.token), setup({ delegation: f.record, fail: failure }).deps)).resolves.toEqual(UNAVAILABLE);
  });

  it("ログに token・秘密の部分・要約値を出さず、unauthorized の内訳はログにだけ出す", async () => {
    const f = delegationFixture();
    const { deps, lines } = setup({ delegation: { ...f.record, revokedAt: iso(NOW - 1) } });
    const result = await authenticate(req("user", f.token), deps);
    expect(result).toEqual(UNAUTHORIZED);
    const text = lines.join("\n");
    expect(text).not.toContain(f.secret);
    expect(text).not.toContain(f.record.secretSha256);
    expect(text).not.toContain(DELEGATION);
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({ level: "info", result: "unauthorized", fault: "revoked" });
  });
});

describe("authenticate: 手元のマシン", () => {
  it("登録の token で手元のマシンに決まる", async () => {
    const f = machineFixture();
    await expect(authenticate(req("machine", f.token, "machine.lanes.pull"), setup({ machine: f.record }).deps)).resolves.toEqual({
      ok: true,
      principal: { kind: "machine", teamId: TEAM, machineId: MACHINE },
    });
  });

  it("取り消し・期限切れ・秘密の違い・受け口の違いは unauthorized", async () => {
    const f = machineFixture();
    const cases: [InboundRequest, MachineRecord][] = [
      [req("machine", f.token), { ...f.record, revokedAt: iso(NOW - 1) }],
      [req("machine", f.token), { ...f.record, expiresAt: iso(NOW) }],
      [req("machine", `ndfm_${TEAM}.${MACHINE}.${newSecret()}`), f.record],
      [req("user", f.token), f.record],
      [req("mcp", f.token), f.record],
      [req("machine", signedToken(laneClaims())), f.record],
      [req("machine", cognitoToken()), f.record],
    ];
    for (const [request, record] of cases) {
      await expect(authenticate(request, setup({ machine: record }).deps)).resolves.toEqual(UNAUTHORIZED);
    }
  });
});

describe("authenticate: ランナー", () => {
  const lane: LaneRecord = { projectId: PROJECT, generation: 2, ended: false, exchangedGeneration: 1 };

  it("レーンの token で、終わっていない同じ世代のレーンのランナーに決まる", async () => {
    await expect(authenticate(req("runner", signedToken(laneClaims()), "runner.events.create"), setup({ lane }).deps)).resolves.toEqual({
      ok: true,
      principal: { kind: "runner", laneId: LANE, projectId: PROJECT, generation: 2 },
    });
  });

  it("引き換えの経路だけ引き換えの token を受ける", async () => {
    const exchange = signedToken(laneClaims({ token_use: "exchange" }));
    await expect(authenticate(req("runner", exchange, "runner.exchanges.create"), setup({ lane }).deps)).resolves.toMatchObject({ ok: true });
    await expect(authenticate(req("runner", exchange, "runner.events.create"), setup({ lane }).deps)).resolves.toEqual(UNAUTHORIZED);
    await expect(authenticate(req("runner", signedToken(laneClaims()), "runner.exchanges.create"), setup({ lane }).deps)).resolves.toEqual(UNAUTHORIZED);
  });

  it("引き換えの token はその世代で引き換えた後は unauthorized で、レーンの token は通る", async () => {
    const exchanged = { ...lane, exchangedGeneration: 2 };
    await expect(authenticate(req("runner", signedToken(laneClaims({ token_use: "exchange" })), "runner.exchanges.create"), setup({ lane: exchanged }).deps)).resolves.toEqual(UNAUTHORIZED);
    await expect(authenticate(req("runner", signedToken(laneClaims()), "runner.events.create"), setup({ lane: exchanged }).deps)).resolves.toMatchObject({ ok: true });
  });

  it("検証の鍵が Ed25519 の公開鍵でなければ、ヘッダーが EdDSA で署名が鍵に合っても照らさず unavailable", async () => {
    const rsaSigned = signedToken(laneClaims(), rsa.privateKey);
    const { deps, lines } = setup({ lane });
    await expect(authenticate(req("runner", rsaSigned, "runner.events.create"), { ...deps, signingKey: rsa.publicKey })).resolves.toEqual(UNAVAILABLE);
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({ level: "warn", result: "unavailable", error: "signing_key_not_ed25519" });
    // 私有鍵を検証の鍵に渡しても照らさない
    await expect(authenticate(req("runner", signedToken(laneClaims()), "runner.events.create"), { ...deps, signingKey: ed.privateKey })).resolves.toEqual(UNAVAILABLE);
  });

  it("検証の鍵の無い環境は unauthorized", async () => {
    const { deps } = setup({ lane });
    await expect(authenticate(req("runner", signedToken(laneClaims()), "runner.events.create"), { ...deps, signingKey: null })).resolves.toEqual(UNAUTHORIZED);
  });

  it("期限の 1 秒前は通り、1 秒後は unauthorized", async () => {
    await expect(authenticate(req("runner", signedToken(laneClaims({ exp: NOW / 1000 + 1 }))), setup({ lane }).deps)).resolves.toMatchObject({ ok: true });
    await expect(authenticate(req("runner", signedToken(laneClaims({ exp: NOW / 1000 - 1 }))), setup({ lane }).deps)).resolves.toEqual(UNAUTHORIZED);
  });

  it.each([
    ["終わったレーン", signedToken(laneClaims()), { ...lane, ended: true }],
    ["前の世代", signedToken(laneClaims({ generation: 1 })), lane],
    ["別の鍵の署名", signedToken(laneClaims(), otherEd.privateKey), lane],
    ["宛先の違い", signedToken(laneClaims({ aud: "db_prep" })), lane],
    ["EdDSA でない", signedToken(laneClaims(), ed.privateKey, "none"), lane],
    ["無いレーン", signedToken(laneClaims()), null],
    ["別のプロジェクトのレーン", signedToken(laneClaims()), { ...lane, projectId: id("prj", 7) }],
  ])("%s は unauthorized", async (_label, token, record) => {
    await expect(authenticate(req("runner", token, "runner.events.create"), setup({ lane: record }).deps)).resolves.toEqual(UNAUTHORIZED);
  });
});

describe("authenticate: DB の用意のタスク", () => {
  const prep: DbPrepRecord = { prepId: PREP, inProgress: true, consumed: [] };

  it("引き換えの token は引き換えの経路で 1 回だけ通る", async () => {
    const token = signedToken(prepClaims());
    await expect(authenticate(req("db_prep", token, "db_prep.exchanges.create"), setup({ prep }).deps)).resolves.toEqual({
      ok: true,
      principal: { kind: "db_prep", projectId: PROJECT, prepId: PREP },
    });
    await expect(authenticate(req("db_prep", token, "db_prep.exchanges.create"), setup({ prep: { ...prep, consumed: ["exchange"] } }).deps)).resolves.toEqual(UNAUTHORIZED);
  });

  it("終わりの報告の経路だけ終わりの報告の token を受ける", async () => {
    const completion = signedToken(prepClaims({ token_use: "completion" }));
    await expect(authenticate(req("db_prep", completion, "db_prep.completions.create"), setup({ prep }).deps)).resolves.toMatchObject({ ok: true });
    await expect(authenticate(req("db_prep", completion, "db_prep.exchanges.create"), setup({ prep }).deps)).resolves.toEqual(UNAUTHORIZED);
  });

  it("用意の途中でない・別の用意の token は unauthorized", async () => {
    const token = signedToken(prepClaims());
    await expect(authenticate(req("db_prep", token, "db_prep.exchanges.create"), setup({ prep: { ...prep, inProgress: false } }).deps)).resolves.toEqual(UNAUTHORIZED);
    await expect(authenticate(req("db_prep", token, "db_prep.exchanges.create"), setup({ prep: { ...prep, prepId: "prep-acme-2" } }).deps)).resolves.toEqual(UNAUTHORIZED);
  });

  it("終わりの報告の token は使い終えた後は unauthorized で、引き換えの使い終えには引きずられない", async () => {
    const completion = signedToken(prepClaims({ token_use: "completion" }));
    await expect(authenticate(req("db_prep", completion, "db_prep.completions.create"), setup({ prep: { ...prep, consumed: ["exchange"] } }).deps)).resolves.toMatchObject({ ok: true });
    await expect(authenticate(req("db_prep", completion, "db_prep.completions.create"), setup({ prep: { ...prep, consumed: ["exchange", "completion"] } }).deps)).resolves.toEqual(UNAUTHORIZED);
  });

  it("token のプロジェクトと読んだ行が食い違えば unauthorized", async () => {
    const token = signedToken(prepClaims());
    const { deps } = setup({ prep });
    const spy = vi.spyOn(deps.readers, "dbPrep").mockImplementation(async (projectId) => (projectId === PROJECT ? prep : null));
    await expect(authenticate(req("db_prep", signedToken(prepClaims({ project_id: id("prj", 7) })), "db_prep.exchanges.create"), deps)).resolves.toEqual(UNAUTHORIZED);
    await expect(authenticate(req("db_prep", token, "db_prep.exchanges.create"), deps)).resolves.toMatchObject({ ok: true });
    expect(spy.mock.calls).toEqual([[id("prj", 7)], [PROJECT]]);
  });

  it("検証の鍵の無い環境は unauthorized", async () => {
    const { deps } = setup({ prep });
    await expect(authenticate(req("db_prep", signedToken(prepClaims()), "db_prep.exchanges.create"), { ...deps, signingKey: null })).resolves.toEqual(UNAUTHORIZED);
  });
});

describe("authenticate: GitHub", () => {
  const body = Buffer.from('{"action":"opened"}');
  const signature = `sha256=${createHmac("sha256", "acme-webhook-secret").update(body).digest("hex")}`;

  it("本文の HMAC-SHA256 が合えば GitHub に決まり、Authorization を読まない", async () => {
    const request: InboundRequest = { endpoint: "github", operation: "", token: null, rawBody: body, signature };
    await expect(authenticate(request, setup().deps)).resolves.toEqual({ ok: true, principal: { kind: "github" } });
  });

  it("UTF-8 として正しくない本文もバイト列のまま照らす", async () => {
    const raw = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);
    const sig = `sha256=${createHmac("sha256", "acme-webhook-secret").update(raw).digest("hex")}`;
    await expect(authenticate({ endpoint: "github", operation: "", token: null, rawBody: raw, signature: sig }, setup().deps)).resolves.toEqual({ ok: true, principal: { kind: "github" } });
  });

  it("署名が違う・無い・秘密が無いと unauthorized", async () => {
    const base: InboundRequest = { endpoint: "github", operation: "", token: null, rawBody: body, signature };
    await expect(authenticate({ ...base, rawBody: Buffer.concat([body, Buffer.from(" ")]) }, setup().deps)).resolves.toEqual(UNAUTHORIZED);
    await expect(authenticate({ ...base, signature: null }, setup().deps)).resolves.toEqual(UNAUTHORIZED);
    await expect(authenticate(base, setup({}, { webhookSecret: null }).deps)).resolves.toEqual(UNAUTHORIZED);
  });
});

describe("authenticate: 読み手の失敗", () => {
  it("どの主体でも読み手が投げれば unavailable で、ログは warn", async () => {
    const failure = Object.assign(new Error("down"), { name: "InternalServerError" });
    const f = machineFixture();
    const { deps, lines } = setup({ fail: failure });
    const spy = vi.spyOn(deps.readers, "machine");
    await expect(authenticate(req("machine", f.token), deps)).resolves.toEqual(UNAVAILABLE);
    expect(spy).toHaveBeenCalledOnce();
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({ level: "warn", error: "InternalServerError" });
  });
});
