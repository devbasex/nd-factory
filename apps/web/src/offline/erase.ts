import { tagOf } from "./crypto.ts";
import { type DeviceDb, deleteDeviceDb, readOwner } from "./db.ts";
import { quarantinedTags, quarantinePending } from "./quarantine.ts";

// サインアウトの 2.（送る列と保留の件を片付ける）と 5.（データベースを消す）。#4 がサインインの錠を持って呼ぶ

export async function recordDiscardConfirmation(db: DeviceDb, signoutId: string, answerTags: string[]): Promise<void> {
  const keys = await readOwner(db);
  if (keys === null) return;
  const signoutTag = await tagOf(keys.tagKey, signoutId);
  await db.put("keys", { ...keys, discardConfirmed: { signoutTag, answerTags } });
}

// このサインアウトで本人が破棄を確認した件。ID の合わない記録は使わない
async function confirmedTags(db: DeviceDb, signoutId: string): Promise<Set<string>> {
  const keys = await readOwner(db);
  const record = keys?.discardConfirmed;
  if (keys === null || record === undefined || record.signoutTag !== (await tagOf(keys.tagKey, signoutId))) return new Set();
  return new Set(record.answerTags);
}

export async function settleForSignout(db: DeviceDb, signoutId: string): Promise<void> {
  const drop = await confirmedTags(db, signoutId);
  await quarantinePending(db, { drop });
  const tx = db.transaction(["outbox", "held"], "readwrite");
  for (const answerTag of drop) {
    await tx.objectStore("outbox").delete(answerTag);
    await tx.objectStore("held").delete(answerTag);
  }
  await tx.done;
}

export async function deleteDeviceData(
  db: DeviceDb,
  signoutId: string,
  o: { onBlocked: () => void },
): Promise<"deleted" | "failed"> {
  const confirmed = await confirmedTags(db, signoutId);
  const quarantined = await quarantinedTags();
  const pending = [...(await db.getAllKeys("outbox")), ...(await db.getAllKeys("held"))];
  // 隔離し残した件があれば消さない
  if (pending.some((tag) => !confirmed.has(tag) && !quarantined.has(tag))) return "failed";
  db.close();
  return deleteDeviceDb(o);
}

const forgetters = new Set<() => void>();

/** 復号した値やキーをメモリに持つ部品が、捨てる関数を登録する */
export function onForgetDeviceMemory(forget: () => void): () => void {
  forgetters.add(forget);
  return () => void forgetters.delete(forget);
}

// versionchange と、#4 のほかのタブからの通知で呼ぶ
export function forgetDeviceMemory(): void {
  for (const forget of forgetters) forget();
}
