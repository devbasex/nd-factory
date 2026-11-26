import type { IDBPTransaction } from "idb";
import type { AuthzRecord } from "./authz.ts";
import { tagOf, unseal } from "./crypto.ts";
import type { DeviceDb, DeviceSchema, KeyRow } from "./db.ts";

// 「利用者の境界」の照合と書き込み。復号と HMAC はトランザクションの外で済ませ、書くトランザクションでは
// 読んだときから持ち主・ログインの行・記録が変わっていないことを比べるだけにする

export type Owner = {
  userId: string;
  // このセッションの指紋
  fingerprint: string;
  // サインアウトか連携ログインの解除の途中のフラグがあるか（フラグは #4 が持つ）
  flagged: () => boolean;
};

const SCOPE = ["keys", "login", "snapshots", "outbox", "held", "authz"] as const;
export type GuardedTx = IDBPTransaction<DeviceSchema, (typeof SCOPE)[number][], "readwrite">;

export type Guard = {
  db: DeviceDb;
  owner: Owner;
  keys: KeyRow;
  loginIv: Uint8Array;
  authzIv: Uint8Array | null;
  authz: AuthzRecord | null;
};

export function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

export async function prepareGuard(db: DeviceDb, owner: Owner): Promise<Guard | null> {
  if (owner.flagged()) return null;
  const tx = db.transaction(["keys", "login", "authz"], "readonly");
  const [keys, login, authz] = await Promise.all([
    tx.objectStore("keys").get("main"),
    tx.objectStore("login").get("login"),
    tx.objectStore("authz").get("authz"),
  ]);
  await tx.done;
  if (keys === undefined || login === undefined) return null;
  const [userTag, fingerprintTag] = await Promise.all([
    tagOf(keys.tagKey, owner.userId),
    tagOf(keys.tagKey, owner.fingerprint),
  ]);
  if (userTag !== keys.ownerTag || userTag !== login.userTag || fingerprintTag !== login.fingerprintTag) return null;
  return {
    db,
    owner,
    keys,
    loginIv: login.iv,
    authzIv: authz?.iv ?? null,
    authz: authz === undefined ? null : await unseal<AuthzRecord>(keys.key, authz),
  };
}

// write は IndexedDB の要求だけを待ってよい。false を返すと全部を取り消す
export async function commitGuarded(
  guard: Guard,
  write: (tx: GuardedTx) => void | Promise<boolean | void>,
): Promise<"committed" | "stale"> {
  const tx = guard.db.transaction([...SCOPE], "readwrite");
  const abort = async () => {
    tx.abort();
    await tx.done.catch(() => {});
    return "stale" as const;
  };
  const [keys, login, authz] = await Promise.all([
    tx.objectStore("keys").get("main"),
    tx.objectStore("login").get("login"),
    tx.objectStore("authz").get("authz"),
  ]);
  const unchanged =
    keys !== undefined &&
    keys.ownerTag === guard.keys.ownerTag &&
    keys.switching !== true &&
    login !== undefined &&
    login.userTag === guard.keys.ownerTag &&
    sameBytes(login.iv, guard.loginIv) &&
    sameBytes(authz?.iv ?? null, guard.authzIv) &&
    !guard.owner.flagged();
  if (!unchanged) return abort();
  if ((await write(tx)) === false) return abort();
  await tx.done;
  return "committed";
}
