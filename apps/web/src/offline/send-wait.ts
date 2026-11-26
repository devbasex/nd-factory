import { type Sealed, seal, unseal } from "./crypto.ts";
import { type DeviceDb, readOwner } from "./db.ts";
import { sameBytes } from "./guarded-commit.ts";

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
  writeApiTime(ms: number): Promise<void>;
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

  return {
    read: async () => (await load<RetryWait>("retry"))?.value ?? null,
    write: (wait) => writeLater("retry", wait, (w) => w.retryUntil),
    clear: () => db.delete("wait", "retry"),
    readApiTime: async () => (await load<number>("api-time"))?.value ?? null,
    writeApiTime: (ms) => writeLater("api-time", ms, (v) => v),
  };
}
