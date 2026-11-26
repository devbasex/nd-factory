import type { Logger } from "@nd-factory/core/log";
import type { StateStore } from "oidc-client-ts";
import { seal, tagOf, unseal } from "./crypto.ts";
import { createOwner, type DeviceDb, deleteDeviceDb, type KeyRow, readOwner } from "./db.ts";
import { onForgetDeviceMemory } from "./erase.ts";
import { sameBytes } from "./guarded-commit.ts";
import { quarantinePending, restoreQuarantined } from "./quarantine.ts";

// oidc-client-ts の userStore と、#4 が呼ぶ書き込み。set はメモリに留めるだけで、IndexedDB へは
// confirmSignin と writeRefreshed だけが書く。access token と ID token は置かない（#12 の決定 4）

/** refresh token の期限は、サインインした時刻から 30 日 @internal */
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type LoginBody = {
  refresh_token: string;
  userId: string;
  profile: { sub: string };
  scope: string;
  token_type: string;
  storeKey: string;
  refreshExpiresAt: number;
};

type Stored = { key: string; value: string };

type Exchange = {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  profile: { sub: string };
};

export type LoginStore = StateStore & {
  confirmSignin(userId: string): Promise<void>;
  discardPendingExchange(): void;
  readFingerprintTag(): Promise<string | null>;
  writeRefreshed(fingerprintTag: string): Promise<"written" | "discarded">;
  deleteLoginRow(fingerprintTag: string): Promise<"deleted" | "kept">;
  purgeExpiredLogin(nowMs: number): Promise<boolean>;
  readSession(): Promise<{ userId: string; refreshExpiresAt: number } | null>;
  forget(): void;
};

export type LoginDeps = {
  openDb: () => Promise<DeviceDb>;
  // サインアウトか連携ログインの解除の途中のフラグがあるか
  flagged: () => boolean;
  log: Pick<Logger, "info" | "warn">;
};

// セッションの指紋は、sub と origin_jti をつないだ SHA-256（画面の文書の「サインアウトの途中のフラグ」）
export async function sessionFingerprint(sub: string, originJti: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${sub}${originJti}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// 署名は API が検証する。ここでは指紋と期限の元の項目を読むだけ
function claimsOf(token: string): { sub: string; origin_jti: string; auth_time: number } {
  const base64 = (token.split(".")[1] ?? "").replaceAll("-", "+").replaceAll("_", "/");
  const claims = JSON.parse(atob(base64)) as Record<string, unknown>;
  const { sub, origin_jti, auth_time } = claims;
  if (typeof sub !== "string" || typeof origin_jti !== "string" || typeof auth_time !== "number") {
    throw new Error("access token にセッションの項目が無い");
  }
  return { sub, origin_jti, auth_time };
}

export function createLoginStore({ openDb, flagged, log }: LoginDeps): LoginStore {
  // 確定の前の交換の結果と、確定した値は別に持つ。前者は通常の読み出しに出さない
  let pending: Stored | null = null;
  let confirmed: Stored | null = null;

  const forget = () => {
    pending = null;
    confirmed = null;
  };
  onForgetDeviceMemory(forget);

  async function withDb<T>(fn: (db: DeviceDb) => Promise<T>): Promise<T> {
    const db = await openDb();
    try {
      return await fn(db);
    } finally {
      db.close();
    }
  }

  // 行を復号する。読めないか持ち主の ID と合わなければ行を消す
  async function readRow(db: DeviceDb) {
    const row = await db.get("login", "login");
    const keys = await readOwner(db);
    if (row === undefined || keys === null) return null;
    const body = await unseal<LoginBody>(keys.key, row).catch(() => null);
    if (body === null || (await tagOf(keys.tagKey, body.userId)) !== row.userTag) {
      log.warn("ログインのキャッシュを読めないため消した");
      await db.delete("login", "login");
      return null;
    }
    return { row, keys, body };
  }

  async function loginRow(keys: KeyRow, userTag: string, fingerprintTag: string, body: LoginBody) {
    return { id: "login" as const, userTag, fingerprintTag, ...(await seal(keys.key, body)) };
  }

  // 前の持ち主の件を隔離してから、データベースを作り直す
  async function openFor(userId: string): Promise<{ db: DeviceDb; keys: KeyRow }> {
    let db = await openDb();
    try {
      let keys = await readOwner(db);
      if (keys !== null && (await tagOf(keys.tagKey, userId)) !== keys.ownerTag) {
        await quarantinePending(db, { drop: new Set() });
        db.close();
        if ((await deleteDeviceDb({ onBlocked: () => {} })) === "failed") throw new Error("端末のデータベースを消せない");
        db = await openDb();
        keys = null;
      }
      return { db, keys: keys ?? (await createOwner(db, userId)) };
    } catch (error) {
      db.close();
      throw error;
    }
  }

  return {
    async set(key, value) {
      pending = { key, value };
    },

    async get(key) {
      if (confirmed !== null) return confirmed.key === key ? confirmed.value : null;
      return withDb(async (db) => {
        const found = await readRow(db);
        if (found === null || found.body.storeKey !== key) return null;
        const { refresh_token, token_type, scope, profile } = found.body;
        return JSON.stringify({ refresh_token, token_type, scope, profile });
      });
    },

    // 行を消すのは deleteLoginRow とサインアウトで、ここはメモリだけを捨てる
    async remove(key) {
      const previous = confirmed?.key === key ? confirmed.value : null;
      forget();
      return previous;
    },

    async getAllKeys() {
      if (confirmed !== null) return [confirmed.key];
      return withDb(async (db) => {
        const found = await readRow(db);
        return found === null ? [] : [found.body.storeKey];
      });
    },

    async confirmSignin(userId) {
      const exchange = pending;
      if (exchange === null) throw new Error("確定する交換の結果が無い");
      const user = JSON.parse(exchange.value) as Exchange;
      const claims = claimsOf(user.access_token);
      const fingerprint = await sessionFingerprint(claims.sub, claims.origin_jti);
      const { db, keys } = await openFor(userId);
      try {
        await restoreQuarantined(db, userId);
        const body: LoginBody = {
          refresh_token: user.refresh_token,
          userId,
          profile: { sub: user.profile.sub },
          scope: user.scope,
          token_type: user.token_type,
          storeKey: exchange.key,
          // 確定が遅れても、Cognito の側の期限より後ろへ延びないようにする
          refreshExpiresAt: claims.auth_time * 1000 + REFRESH_TTL_MS,
        };
        await db.put("login", await loginRow(keys, keys.ownerTag, await tagOf(keys.tagKey, fingerprint), body));
      } finally {
        db.close();
      }
      confirmed = exchange;
      pending = null;
      log.info("サインインを確定した");
    },

    discardPendingExchange() {
      pending = null;
    },

    readFingerprintTag: () => withDb(async (db) => (await db.get("login", "login"))?.fingerprintTag ?? null),

    async writeRefreshed(fingerprintTag) {
      const exchange = pending;
      pending = null;
      if (exchange === null) return "discarded";
      const user = JSON.parse(exchange.value) as Exchange;
      const claims = claimsOf(user.access_token);
      const fingerprint = await sessionFingerprint(claims.sub, claims.origin_jti);
      const written = await withDb(async (db) => {
        const found = await readRow(db);
        if (found === null) return false;
        const { row, keys, body } = found;
        const tag = await tagOf(keys.tagKey, fingerprint);
        if (tag !== fingerprintTag || row.fingerprintTag !== fingerprintTag || row.userTag !== keys.ownerTag) return false;
        // 利用者と期限は確定のときの値を保つ
        const next = await loginRow(keys, row.userTag, row.fingerprintTag, {
          ...body,
          refresh_token: user.refresh_token,
          scope: user.scope,
          token_type: user.token_type,
        });
        const tx = db.transaction("login", "readwrite");
        const current = await tx.store.get("login");
        const unchanged = current !== undefined && sameBytes(current.iv, row.iv) && !flagged();
        if (unchanged) await tx.store.put(next);
        await tx.done;
        return unchanged;
      });
      if (!written) {
        log.warn("取り直しの結果を捨てた");
        return "discarded";
      }
      confirmed = exchange;
      return "written";
    },

    async deleteLoginRow(fingerprintTag) {
      const deleted = await withDb(async (db) => {
        const tx = db.transaction("login", "readwrite");
        const same = (await tx.store.get("login"))?.fingerprintTag === fingerprintTag;
        if (same) await tx.store.delete("login");
        await tx.done;
        return same;
      });
      if (!deleted) return "kept";
      forget();
      log.info("ログインのキャッシュを消した");
      return "deleted";
    },

    purgeExpiredLogin: (nowMs) =>
      withDb(async (db) => {
        const found = await readRow(db);
        if (found === null || nowMs <= found.body.refreshExpiresAt) return false;
        const tx = db.transaction("login", "readwrite");
        const current = await tx.store.get("login");
        const same = current !== undefined && sameBytes(current.iv, found.row.iv);
        if (same) await tx.store.delete("login");
        await tx.done;
        return same;
      }),

    readSession: () =>
      withDb(async (db) => {
        const found = await readRow(db);
        if (found === null || found.row.userTag !== found.keys.ownerTag) return null;
        return { userId: found.body.userId, refreshExpiresAt: found.body.refreshExpiresAt };
      }),

    forget,
  };
}
