import { seal, tagOf, unseal } from "./crypto.ts";
import { type DeviceDb, readOwner } from "./db.ts";

// サインアウトの証と、連携ログインの解除の外しのキャッシュ。呼ぶのは #4 だけで、錠も #4 が持つ

type PendingId = "signout-proof" | "unlink-item";

export type PendingStore = {
  put(id: PendingId, value: unknown, fingerprint: string): Promise<void>;
  // 復号できなくても消さない（#4 が次の候補へ進む）
  read(id: PendingId): Promise<{ value: unknown; fingerprintTag: string } | "unreadable" | null>;
  remove(id: PendingId): Promise<void>;
};

export function createPendingStore({ db }: { db: DeviceDb }): PendingStore {
  return {
    async put(id, value, fingerprint) {
      const keys = await readOwner(db);
      if (keys === null) throw new Error("端末のデータベースに持ち主がいない");
      const fingerprintTag = await tagOf(keys.tagKey, fingerprint);
      await db.put("pending", { id, fingerprintTag, ...(await seal(keys.key, value)) });
    },
    async read(id) {
      const row = await db.get("pending", id);
      if (row === undefined) return null;
      const keys = await readOwner(db);
      if (keys === null) return "unreadable";
      try {
        return { value: await unseal(keys.key, row), fingerprintTag: row.fingerprintTag };
      } catch {
        return "unreadable";
      }
    },
    remove: (id) => db.delete("pending", id),
  };
}
