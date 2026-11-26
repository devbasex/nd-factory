import { type Sealed, seal, unseal } from "./crypto.ts";
import { type DeviceDb, readOwner } from "./db.ts";
import { commitGuarded, type GuardedTx, type Owner, prepareGuard, sameBytes } from "./guarded-commit.ts";

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
  // 読めない行は無いものとして返す（read は待機の期限とバックオフが未設定、readApiTime は保存した時刻が取れない）。
  // 読めない行を置き換えるのは、照合して書くトランザクションの中だけ
  read(): Promise<RetryWait | null>;
  readApiTime(): Promise<number | null>;
  // 送る前に、待機の期限の行の IV を控える（行が無ければ null）。解除はこの IV の行だけを消す
  seen(): Promise<Uint8Array | null>;
  // 書き込みと解除は、owner（その応答を受けたリクエストのセッション）が端末の持ち主とログインの行に合うときだけ、
  // 照合と同じトランザクションで行う。別のタブで替わった後の新しいセッションの行を、旧い応答で書き換えない。
  // 戻り値が偽なら、セッションが合わなかったので書いていない
  write(owner: Owner, wait: RetryWait): Promise<boolean>;
  writeApiTime(owner: Owner, ms: number): Promise<boolean>;
  // 解除は読み直さない。行が seen の IV のままのときだけ消し、変わっていれば（別のタブが後から書いた期限）残す
  clear(owner: Owner, seen: Uint8Array | null): Promise<boolean>;
  // 呼び出し元の照合したトランザクションの中で、clear と同じ解除を行う。成功した件の反映と同じトランザクションで解く
  clearIn(tx: GuardedTx, seen: Uint8Array | null): Promise<void>;
};

type WaitId = "retry" | "api-time";
// value が null なら、行はあるが復号できない
type Loaded<T> = { value: T | null; iv: Uint8Array } | null;

export function createSendWait({ db }: { db: DeviceDb }): SendWait {
  // key を渡さなければ、端末の持ち主の鍵で読む
  async function load<T>(id: WaitId, key?: CryptoKey): Promise<Loaded<T>> {
    const row = await db.get("wait", id);
    const readKey = key ?? (await readOwner(db))?.key;
    if (row === undefined || readKey === undefined) return null;
    try {
      return { value: await unseal<T>(readKey, row), iv: row.iv };
    } catch {
      return { value: null, iv: row.iv };
    }
  }

  // 照合と同じトランザクションで、読んだときから行の IV が変わっていなければ change の値を書く。
  // change が undefined を返せば書かずに終える。IV が変わっていれば読み直して値を比べ直す（3 回まで）。
  // 書き込みは期限・時刻の後のものだけを残すので、読み直した行と比べてよい。解除はここを通さない
  async function guardedUpdate<T>(owner: Owner, id: WaitId, change: (current: Loaded<T>) => T | undefined): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const guard = await prepareGuard(db, owner, { readAuthz: false });
      if (guard === null) return false;
      const current = await load<T>(id, guard.keys.key);
      const next = change(current);
      if (next === undefined) return true;
      const sealed: Sealed = await seal(guard.keys.key, next);
      let moved = false;
      const result = await commitGuarded(guard, async (tx) => {
        const now = await tx.objectStore("wait").get(id);
        moved = !sameBytes(now?.iv ?? null, current?.iv ?? null);
        if (moved) return false;
        await tx.objectStore("wait").put({ id, ...sealed });
        return true;
      });
      if (result === "committed") return true;
      if (!moved) return false;
    }
    return true;
  }

  // 保存済みの値より後のときだけ書く。読めない行は置き換える
  const writeLater =
    <T>(value: T, at: (v: T) => number) =>
    (current: Loaded<T>): T | undefined =>
      current !== null && current.value !== null && at(current.value) >= at(value) ? undefined : value;

  async function clearIn(tx: GuardedTx, seen: Uint8Array | null): Promise<void> {
    if (seen === null) return;
    const now = await tx.objectStore("wait").get("retry");
    if (now !== undefined && sameBytes(now.iv, seen)) await tx.objectStore("wait").delete("retry");
  }

  return {
    seen: async () => (await db.get("wait", "retry"))?.iv ?? null,
    clearIn,
    async clear(owner, seen) {
      const guard = await prepareGuard(db, owner, { readAuthz: false });
      if (guard === null) return false;
      return (await commitGuarded(guard, (tx) => clearIn(tx, seen))) === "committed";
    },
    read: async () => (await load<RetryWait>("retry"))?.value ?? null,
    readApiTime: async () => (await load<number>("api-time"))?.value ?? null,
    write: (owner, wait) => guardedUpdate(owner, "retry", writeLater(wait, (w) => w.retryUntil)),
    writeApiTime: (owner, ms) => guardedUpdate(owner, "api-time", writeLater(ms, (v) => v)),
  };
}
