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

const SCOPE = ["keys", "login", "snapshots", "outbox", "held", "authz", "wait"] as const;
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

// このタブの利用者とセッションが、端末の持ち主とログインの行に合うときだけ、読んだ行を返す
async function readSessionRows(db: DeviceDb, owner: Owner) {
  if (owner.flagged()) return null;
  const tx = db.transaction(["keys", "login", "authz"], "readonly");
  const [keys, login, authz] = await Promise.all([
    tx.objectStore("keys").get("main"),
    tx.objectStore("login").get("login"),
    tx.objectStore("authz").get("authz"),
  ]);
  await tx.done;
  // 利用者の切り替えに伴う隔離が始まっていれば、旧ログインの行が残っていても合わないとする
  if (keys === undefined || keys.switching === true || login === undefined) return null;
  const [userTag, fingerprintTag] = await Promise.all([
    tagOf(keys.tagKey, owner.userId),
    tagOf(keys.tagKey, owner.fingerprint),
  ]);
  if (userTag !== keys.ownerTag || userTag !== login.userTag || fingerprintTag !== login.fingerprintTag) return null;
  return { keys, login, authz };
}

// 読み出しや表示の前後に、別のタブで利用者かセッションが替わっていないかを確かめる
export async function sessionMatches(db: DeviceDb, owner: Owner): Promise<boolean> {
  return (await readSessionRows(db, owner)) !== null;
}

// readAuthz が偽なら、見られる対象の記録を復号しない（authz は null）。記録を使わない書き込み
// （保留の件の破棄）が、記録の破損で止まらないようにするため。記録の行の iv の照合は同じく行う
export async function prepareGuard(
  db: DeviceDb,
  owner: Owner,
  { readAuthz = true }: { readAuthz?: boolean } = {},
): Promise<Guard | null> {
  const rows = await readSessionRows(db, owner);
  if (rows === null) return null;
  const { keys, login, authz } = rows;
  return {
    db,
    owner,
    keys,
    loginIv: login.iv,
    authzIv: authz?.iv ?? null,
    authz: authz === undefined || !readAuthz ? null : await unseal<AuthzRecord>(keys.key, authz),
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
  try {
    if ((await write(tx)) === false) return abort();
  } catch (error) {
    // 要求の失敗で終わったトランザクションは、もう取り消せない
    await abort().catch(() => {});
    throw error;
  }
  await tx.done;
  return "committed";
}
