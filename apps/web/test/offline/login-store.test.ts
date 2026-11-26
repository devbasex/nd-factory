// @vitest-environment node
import { createClock } from "@nd-factory/core/clock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { unseal } from "../../src/offline/crypto.ts";
import { readOwner } from "../../src/offline/db.ts";
import { forgetDeviceMemory } from "../../src/offline/erase.ts";
import { createLoginStore, REFRESH_TTL_MS, sessionFingerprint } from "../../src/offline/login-store.ts";
import { createOutbox } from "../../src/offline/outbox.ts";
import { freshIndexedDb, openDb, OTHER_USER, USER } from "./support.ts";

beforeEach(freshIndexedDb);

const KEY = "user:https://issuer.example:client-example";
const AUTH_TIME = 1_700_000_000;

const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

// oidc-client-ts の set が渡す、利用者の値の直列化
const exchange = (session = "jti-1", refresh = "refresh-example") =>
  JSON.stringify({
    id_token: "id-token-example",
    access_token: jwt({ sub: "sub-example", origin_jti: session, auth_time: AUTH_TIME }),
    refresh_token: refresh,
    token_type: "Bearer",
    scope: "openid",
    profile: { sub: "sub-example", email: "ops@example.com" },
    expires_at: AUTH_TIME + 900,
  });

function setup() {
  let flagged = false;
  const log = { info: vi.fn(), warn: vi.fn() };
  const store = createLoginStore({ openDb: () => openDb(), flagged: () => flagged, log });
  return { store, log, setFlagged: (value: boolean) => void (flagged = value) };
}

async function row() {
  const db = await openDb();
  const [keys, login] = [await readOwner(db), await db.get("login", "login")];
  const body = keys === null || login === undefined ? null : await unseal<Record<string, unknown>>(keys.key, login);
  db.close();
  return { keys, login, body };
}

describe("ログインのキャッシュ", () => {
  it("set はメモリに留めるだけで、確定の前の get は値を返さない", async () => {
    const { store } = setup();
    await store.set(KEY, exchange());
    await expect(store.get(KEY)).resolves.toBeNull();
    expect((await row()).login).toBeUndefined();
  });

  it("確定すると決まった項目だけを暗号化して置き、期限はサインインの時刻から 30 日", async () => {
    const { store } = setup();
    await store.set(KEY, exchange());
    await store.confirmSignin(USER);
    const { body, login } = await row();
    expect(body).toEqual({
      refresh_token: "refresh-example",
      userId: USER,
      profile: { sub: "sub-example" },
      scope: "openid",
      token_type: "Bearer",
      storeKey: KEY,
      refreshExpiresAt: AUTH_TIME * 1000 + REFRESH_TTL_MS,
    });
    expect(JSON.stringify(login) + new TextDecoder().decode(login!.data)).not.toMatch(/refresh-example|usr_|jti-1/);
    await expect(store.get(KEY)).resolves.toBe(exchange());
    await expect(store.getAllKeys()).resolves.toEqual([KEY]);
    await expect(store.readSession()).resolves.toEqual({ userId: USER, refreshExpiresAt: AUTH_TIME * 1000 + REFRESH_TTL_MS });
  });

  it("再読み込みの後の get は、access token と ID token の無い値を返す", async () => {
    const { store } = setup();
    await store.set(KEY, exchange());
    await store.confirmSignin(USER);
    forgetDeviceMemory();
    const got = JSON.parse((await store.get(KEY))!) as Record<string, unknown>;
    expect(got).toEqual({ refresh_token: "refresh-example", token_type: "Bearer", scope: "openid", profile: { sub: "sub-example" } });
    await expect(store.get("user:other")).resolves.toBeNull();
  });

  it("留めた結果が無いか捨てた後は、確定できない", async () => {
    const { store } = setup();
    await store.set(KEY, exchange());
    store.discardPendingExchange();
    await expect(store.confirmSignin(USER)).rejects.toThrow();
    expect((await row()).login).toBeUndefined();
  });

  it("取り直しは指紋が合うときだけ書き、期限と利用者を保つ", async () => {
    const { store, setFlagged } = setup();
    await store.set(KEY, exchange());
    await store.confirmSignin(USER);
    const tag = (await store.readFingerprintTag())!;

    await store.set(KEY, exchange("jti-other", "refresh-2"));
    await expect(store.writeRefreshed(tag)).resolves.toBe("discarded");
    setFlagged(true);
    await store.set(KEY, exchange("jti-1", "refresh-2"));
    await expect(store.writeRefreshed(tag)).resolves.toBe("discarded");
    setFlagged(false);
    expect((await row()).body?.refresh_token).toBe("refresh-example");

    await store.set(KEY, exchange("jti-1", "refresh-2"));
    await expect(store.writeRefreshed(tag)).resolves.toBe("written");
    expect((await row()).body).toMatchObject({
      refresh_token: "refresh-2",
      userId: USER,
      refreshExpiresAt: AUTH_TIME * 1000 + REFRESH_TTL_MS,
    });
    await expect(store.writeRefreshed(tag)).resolves.toBe("discarded");
  });

  it("invalid_grant の行はタグが同じときだけ消し、持ち主は残る", async () => {
    const { store } = setup();
    await store.set(KEY, exchange());
    await store.confirmSignin(USER);
    await expect(store.deleteLoginRow("other")).resolves.toBe("kept");
    await expect(store.deleteLoginRow((await store.readFingerprintTag())!)).resolves.toBe("deleted");
    await expect(store.get(KEY)).resolves.toBeNull();
    expect((await row()).keys).not.toBeNull();
  });

  it("期限を過ぎた行だけを起動で消す", async () => {
    const { store } = setup();
    await store.set(KEY, exchange());
    await store.confirmSignin(USER);
    const expires = AUTH_TIME * 1000 + REFRESH_TTL_MS;
    await expect(store.purgeExpiredLogin(expires)).resolves.toBe(false);
    await expect(store.purgeExpiredLogin(expires + 1)).resolves.toBe(true);
    await expect(store.readSession()).resolves.toBeNull();
  });

  it("復号できない行は消して null", async () => {
    const { store, log } = setup();
    await store.set(KEY, exchange());
    await store.confirmSignin(USER);
    const { login } = await row();
    const db = await openDb();
    await db.put("login", { ...login!, data: new ArrayBuffer(32) });
    await expect(store.readSession()).resolves.toBeNull();
    await expect(db.count("login")).resolves.toBe(0);
    expect(log.warn).toHaveBeenCalled();
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/usr_|refresh-example/);
    db.close();
  });

  it("別の利用者の確定は、前の利用者の件を隔離してから作り直し、戻ると件が返る", async () => {
    const { store } = setup();
    await store.set(KEY, exchange());
    await store.confirmSignin(USER);
    const db = await openDb();
    await createOutbox({ db, clock: createClock() }).enqueue(
      { userId: USER, fingerprint: await sessionFingerprint("sub-example", "jti-1"), flagged: () => false },
      { operation: "organizer_messages.create", targetId: "org-example", projectId: null, input: { text: "x" } },
    );
    db.close();

    await store.deleteLoginRow((await store.readFingerprintTag())!);
    await store.set(KEY, exchange("jti-b"));
    await store.confirmSignin(OTHER_USER);
    let next = await openDb();
    await expect(next.count("outbox")).resolves.toBe(0);
    next.close();

    await store.deleteLoginRow((await store.readFingerprintTag())!);
    await store.set(KEY, exchange("jti-2"));
    await store.confirmSignin(USER);
    next = await openDb();
    await expect(next.count("outbox")).resolves.toBe(1);
    next.close();
  });
});
