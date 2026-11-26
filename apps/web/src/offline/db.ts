import { type DBSchema, deleteDB, type IDBPDatabase, openDB } from "idb";
import { createKeySet, type Sealed, tagOf } from "./crypto.ts";

// 端末のデータベースの形と、開く・持ち主を作る・番号を取る・消す。列の意味は #12 の設計書の「端末のデータベースの保存先と列」

/** @internal */
export const DB_NAME = "nd-device";
const DB_VERSION = 1;

/** @internal */
export const STORE_NAMES = ["keys", "snapshots", "outbox", "held", "login", "pending", "wait", "authz", "seq"] as const;
export type StoreName = (typeof STORE_NAMES)[number];

/** 保留にした理由（#12 の設計書の「保留の件と隔離」の表） */
export type HoldReason =
  | "unmigrated"
  | "unreadable"
  | "revoked"
  | "transfer-unavailable"
  | "expired"
  | "restored"
  | "unknown-result"
  | "rejected";

export type KeyRow = {
  id: "main";
  key: CryptoKey;
  tagKey: CryptoKey;
  ownerTag: string;
  // 保存先ごとの、移し終えた版
  migrated: Record<StoreName, number>;
  switching?: boolean;
  discardConfirmed?: { signoutTag: string; answerTags: string[] };
};

type SnapshotRow = Sealed & { id: string; kind: string; receivedAt: number; projectTags: string[] };
export type OutboxRow = Sealed & { answerTag: string; targetTag: string; kind: "queued" | "confirm"; projectTag?: string };
type HeldRow = OutboxRow & { holdReason: HoldReason };
type LoginRow = Sealed & { id: "login"; userTag: string; fingerprintTag: string };
type PendingRow = Sealed & { id: "signout-proof" | "unlink-item"; fingerprintTag: string };
type WaitRow = Sealed & { id: "retry" | "api-time" };
type AuthzRow = Sealed & { id: "authz" };

export interface DeviceSchema extends DBSchema {
  keys: { key: string; value: KeyRow };
  snapshots: { key: string; value: SnapshotRow; indexes: { kind: string; receivedAt: number; projectTags: string } };
  outbox: { key: string; value: OutboxRow; indexes: { targetTag: string; projectTag: string } };
  held: { key: string; value: HeldRow; indexes: { projectTag: string } };
  login: { key: string; value: LoginRow };
  pending: { key: string; value: PendingRow };
  wait: { key: string; value: WaitRow };
  authz: { key: string; value: AuthzRow };
  seq: { key: number; value: Record<string, never> };
}

export type DeviceDb = IDBPDatabase<DeviceSchema>;

export async function openDeviceDb(o: { onClosed: () => void }): Promise<DeviceDb> {
  const db = await openDB<DeviceSchema>(DB_NAME, DB_VERSION, {
    // upgrade は保存先と索引の追加だけを行う。中身の移行は暗号化を待つため、開いた後の runMigrations が行う
    upgrade(target) {
      target.createObjectStore("keys", { keyPath: "id" });
      const snapshots = target.createObjectStore("snapshots", { keyPath: "id" });
      snapshots.createIndex("kind", "kind");
      snapshots.createIndex("receivedAt", "receivedAt");
      snapshots.createIndex("projectTags", "projectTags", { multiEntry: true });
      const outbox = target.createObjectStore("outbox", { keyPath: "answerTag" });
      outbox.createIndex("targetTag", "targetTag");
      outbox.createIndex("projectTag", "projectTag");
      target.createObjectStore("held", { keyPath: "answerTag" }).createIndex("projectTag", "projectTag");
      target.createObjectStore("login", { keyPath: "id" });
      target.createObjectStore("pending", { keyPath: "id" });
      target.createObjectStore("wait", { keyPath: "id" });
      target.createObjectStore("authz", { keyPath: "id" });
      target.createObjectStore("seq", { autoIncrement: true });
    },
  });
  // ほかのタブがデータベースを消すか版を上げるときは、閉じて知らせる
  db.addEventListener("versionchange", () => {
    db.close();
    o.onClosed();
  });
  return db;
}

export async function readOwner(db: DeviceDb): Promise<KeyRow | null> {
  return (await db.get("keys", "main")) ?? null;
}

export async function createOwner(db: DeviceDb, userId: string): Promise<KeyRow> {
  const keys = await createKeySet();
  const row: KeyRow = {
    id: "main",
    ...keys,
    ownerTag: await tagOf(keys.tagKey, userId),
    migrated: Object.fromEntries(STORE_NAMES.map((name) => [name, DB_VERSION])) as Record<StoreName, number>,
  };
  // add は行があると失敗する。持ち主を上書きしない
  await db.add("keys", row);
  return row;
}

// 番号の生成器はタブをまたいで重ならず、行を消しても値を戻さない
export async function nextSeq(db: DeviceDb): Promise<number> {
  const tx = db.transaction("seq", "readwrite");
  const number = await tx.store.add({});
  await tx.store.delete(number);
  await tx.done;
  return number;
}

export async function deleteDeviceDb(o: { onBlocked: () => void }): Promise<"deleted" | "failed"> {
  try {
    await deleteDB(DB_NAME, { blocked: () => o.onBlocked() });
    return "deleted";
  } catch {
    return "failed";
  }
}
