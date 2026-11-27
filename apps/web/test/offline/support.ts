import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { seal, tagOf } from "../../src/offline/crypto.ts";
import { createOwner, type DeviceDb, openDeviceDb } from "../../src/offline/db.ts";

// 端末のデータの単体テストの準備。テストごとに空の IndexedDB へ替える

/** 作り物の利用者の ID */
export const USER = "usr_example-a";
export const OTHER_USER = "usr_example-b";

export function freshIndexedDb(): void {
  globalThis.indexedDB = new IDBFactory();
}

export function openDb(onClosed: () => void = () => {}): Promise<DeviceDb> {
  return openDeviceDb({ onClosed });
}

const FINGERPRINT = "fp-example";

/** 持ち主とログインのキャッシュの行を持つデータベース */
export async function signedIn(db: DeviceDb) {
  const keys = await createOwner(db, USER);
  const row = {
    id: "login" as const,
    userTag: keys.ownerTag,
    fingerprintTag: await tagOf(keys.tagKey, FINGERPRINT),
    ...(await seal(keys.key, {})),
  };
  await db.put("login", row);
  return { keys, owner: { userId: USER, fingerprint: FINGERPRINT, flagged: () => false } };
}
