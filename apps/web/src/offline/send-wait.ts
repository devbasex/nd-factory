import { type Sealed, seal, unseal } from "./crypto.ts";
import { type DeviceDb, readOwner } from "./db.ts";
import { commitGuarded, type Owner, prepareGuard, sameBytes } from "./guarded-commit.ts";

// 429 の待機の期限と、最後に受けた API の時刻。タブをまたいで共有するので端末のデータベースに暗号化して置く

const BACKOFF_FIRST_MS = 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;

export type RetryWait = { retryUntil: number; backoffMs: number };

// backoffMs は今の既定の待ちの長さ（まだ無ければ 0）
export function retryUntilFrom(retryAfter: string | null, date: string | null, nowMs: number, backoffMs: number): RetryWait {
  const value = retryAfter?.trim() ?? "";
  if (/^\d+$/.test(value)) return { retryUntil: nowMs + Number(value) * 1000, backoffMs };
  const until = Date.parse(value);
  if (!Number.isNaN(until)) {
    // 端末と API の時計がずれていても、待つ長さを変えない
    const from = date === null ? Number.NaN : Date.parse(date);
    return { retryUntil: Number.isNaN(from) ? until : nowMs + Math.max(0, until - from), backoffMs };
  }
  const next = backoffMs === 0 ? BACKOFF_FIRST_MS : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  return { retryUntil: nowMs + next, backoffMs: next };
}

export type SendWait = {
  read(): Promise<RetryWait | null>;
  write(wait: RetryWait): Promise<void>;
  clear(): Promise<void>;
  readApiTime(): Promise<number | null>;
  // owner はその Date を受けたリクエストのセッション。端末の持ち主とログインの行に合うときだけ、
  // 照合と同じトランザクションで書く（別のタブで替わった後の新しいセッションへ、旧い応答の時刻を書かない）
  writeApiTime(owner: Owner, ms: number): Promise<void>;
};

export function createSendWait({ db }: { db: DeviceDb }): SendWait {
  async function load<T>(id: "retry" | "api-time"): Promise<{ value: T; iv: Uint8Array } | null> {
    const row = await db.get("wait", id);
    const owner = await readOwner(db);
    if (row === undefined || owner === null) return null;
    try {
      return { value: await unseal<T>(owner.key, row), iv: row.iv };
    } catch {
      await db.delete("wait", id);
      return null;
    }
  }

  // 保存済みの値より後のときだけ書く。比べた後に行が変わっていれば比べ直す
  async function writeLater<T>(id: "retry" | "api-time", value: T, at: (v: T) => number): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const owner = await readOwner(db);
      if (owner === null) return;
      const current = await load<T>(id);
      if (current !== null && at(current.value) >= at(value)) return;
      const sealed: Sealed = await seal(owner.key, value);
      const tx = db.transaction("wait", "readwrite");
      const now = await tx.store.get(id);
      const unchanged = sameBytes(now?.iv ?? null, current?.iv ?? null);
      if (unchanged) await tx.store.put({ id, ...sealed });
      await tx.done;
      if (unchanged) return;
    }
  }

  async function writeApiTime(owner: Owner, ms: number): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const guard = await prepareGuard(db, owner, { readAuthz: false });
      if (guard === null) return;
      const current = await load<number>("api-time");
      if (current !== null && current.value >= ms) return;
      const sealed: Sealed = await seal(guard.keys.key, ms);
      const result = await commitGuarded(guard, async (tx) => {
        const now = await tx.objectStore("wait").get("api-time");
        if (!sameBytes(now?.iv ?? null, current?.iv ?? null)) return false;
        await tx.objectStore("wait").put({ id: "api-time", ...sealed });
        return true;
      });
      if (result === "committed") return;
    }
  }

  return {
    read: async () => (await load<RetryWait>("retry"))?.value ?? null,
    write: (wait) => writeLater("retry", wait, (w) => w.retryUntil),
    clear: () => db.delete("wait", "retry"),
    readApiTime: async () => (await load<number>("api-time"))?.value ?? null,
    writeApiTime,
  };
}
