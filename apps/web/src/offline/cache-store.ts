import type { Logger } from "@nd-factory/core/log";
import { judgeVisibility, withAuthzLock } from "./authz.ts";
import { type Sealed, seal, tagOf, unseal } from "./crypto.ts";
import { type DeviceDb, readOwner } from "./db.ts";
import { commitGuarded, type Guard, type GuardedTx, sameBytes } from "./guarded-commit.ts";
import { kindDefOf, projectIdsOf, type SnapshotKind } from "./snapshot-kinds.ts";

// 端末のキャッシュ（写し）の読み書き。受け取ってから 14 日を過ぎた写しは出さない（IW2）

/** @internal */
export const SNAPSHOT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

type Body =
  | { type: "value"; value: unknown; fetchSeq: number }
  // 消した対象を、遅れて届いた古い成功で作り直さないための印
  | { type: "gone"; fetchSeq: number }
  // 一覧の読み出しの記録。写しの無い対象の古い詳細も採らない
  | { type: "list"; ids: string[]; fetchSeq: number };

type ListScope = { kind: SnapshotKind; projectId: string };

type Write = (tx: GuardedTx) => Promise<boolean>;

export type CacheStore = {
  read(kind: SnapshotKind, targetId: string): Promise<{ value: unknown; receivedAt: number; fetchSeq: number } | null>;
  // 写しを読み、読んだときから行が変わっていないことを書き込みの中で確かめる関数も返す。写しが無い・14 日を過ぎた・
  // 削除の印なら found は null。復号できなければ unreadable を真にし、行も写しも消さない。呼び出し元は dropAll で
  // 写しをすべて消し（セッションを照合する）、読み直しへ回す
  readGuarded(
    guard: Guard,
    kind: SnapshotKind,
    targetId: string,
  ): Promise<{ found: { value: unknown; fetchSeq: number } | null; unreadable: boolean; unchanged: Write }>;
  // 復号できない写しが見つかったときに、セッションを照合したうえで写しをすべて消す
  dropAll(guard: Guard): Promise<"committed" | "stale">;
  prepareReplace(guard: Guard, kind: SnapshotKind, targetId: string, value: unknown, fetchSeq: number): Promise<Write | null>;
  applyOptimistic(guard: Guard, kind: SnapshotKind, targetId: string, change: (value: unknown) => unknown): Promise<void>;
  markGone(guard: Guard, kind: SnapshotKind, targetId: string, goneSeq: number): Promise<void>;
  // 削除の印を、ほかの書き込みと同じトランザクションで書くとき
  prepareGone(guard: Guard, kind: SnapshotKind, targetId: string, goneSeq: number): Promise<Write | null>;
  recordList(guard: Guard, scope: ListScope, ids: string[], fetchSeq: number): Promise<void>;
  dropProjects(tx: GuardedTx, projectTags: string[]): Promise<void>;
  purgeExpired(): Promise<number>;
  lastReceivedAt(): Promise<number | null>;
};

export type CacheDeps = {
  db: DeviceDb;
  wallNow: () => number;
  log: Pick<Logger, "warn">;
  // ほかのタブへの知らせ。中身は載せない
  notify: (message: { type: "gone" }) => void;
};

// 件数の上限を超える項目は後ろ（古い方）から落とす
function limited(kind: SnapshotKind, value: unknown): unknown {
  const limit = kindDefOf(kind)?.limit;
  const items = (value as { items?: unknown } | null)?.items;
  if (limit === undefined || !Array.isArray(items) || items.length <= limit) return value;
  return { ...(value as object), items: items.slice(0, limit) };
}

export function createCacheStore({ db, wallNow, log, notify }: CacheDeps): CacheStore {
  const listId = (tagKey: CryptoKey, scope: ListScope) => tagOf(tagKey, scope.kind, "list", scope.projectId);

  // 行を読んで復号する。書くときに iv を比べるため、行の iv も返す
  async function load(key: CryptoKey, id: string) {
    const row = await db.get("snapshots", id);
    return row === undefined ? null : { row, body: await unseal<Body>(key, row) };
  }

  const unchanged = async (tx: GuardedTx, id: string, iv: Uint8Array | null) =>
    sameBytes((await tx.objectStore("snapshots").get(id))?.iv ?? null, iv);

  const row = (id: string, kind: string, projectTags: string[], sealed: Sealed, receivedAt = wallNow()) => ({
    id,
    kind,
    receivedAt,
    projectTags,
    ...sealed,
  });

  async function commitAndNotify(guard: Guard, writes: Write[]): Promise<void> {
    const result = await withAuthzLock("exclusive", () =>
      commitGuarded(guard, async (tx) => {
        for (const write of writes) if (!(await write(tx))) return false;
        return true;
      }),
    );
    if (result === "committed") notify({ type: "gone" });
  }

  async function goneWrite(guard: Guard, kind: string, id: string, goneSeq: number): Promise<Write | null> {
    const { key } = guard.keys;
    const current = await load(key, id);
    if (current !== null && current.body.fetchSeq >= goneSeq) return null;
    const next = row(id, kind, current?.row.projectTags ?? [], await seal(key, { type: "gone", fetchSeq: goneSeq }));
    return async (tx) => {
      if (!(await unchanged(tx, id, current?.row.iv ?? null))) return false;
      await tx.objectStore("snapshots").put(next);
      return true;
    };
  }

  return {
    async read(kind, targetId) {
      const owner = await readOwner(db);
      if (owner === null) return null;
      const id = await tagOf(owner.tagKey, kind, targetId);
      let found: Awaited<ReturnType<typeof load>>;
      try {
        found = await load(owner.key, id);
      } catch {
        log.warn("写しを復号できないため、写しをすべて消した", { kind });
        await db.clear("snapshots");
        return null;
      }
      if (found === null || found.body.type !== "value" || wallNow() - found.row.receivedAt > SNAPSHOT_TTL_MS) return null;
      return { value: found.body.value, receivedAt: found.row.receivedAt, fetchSeq: found.body.fetchSeq };
    },

    async readGuarded(guard, kind, targetId) {
      const id = await tagOf(guard.keys.tagKey, kind, targetId);
      const current = await db.get("snapshots", id);
      const iv = current?.iv ?? null;
      const same: Write = (tx) => unchanged(tx, id, iv);
      let unreadable = false;
      const body =
        current === undefined
          ? null
          : await unseal<Body>(guard.keys.key, current).catch(() => {
              unreadable = true;
              return null;
            });
      const fresh = body?.type === "value" && current !== undefined && wallNow() - current.receivedAt <= SNAPSHOT_TTL_MS;
      return { found: fresh ? { value: body.value, fetchSeq: body.fetchSeq } : null, unreadable, unchanged: same };
    },

    async dropAll(guard) {
      const result = await commitGuarded(guard, async (tx) => {
        await tx.objectStore("snapshots").clear();
        return true;
      });
      if (result === "committed") log.warn("写しを復号できないため、写しをすべて消した", {});
      return result;
    },

    async prepareReplace(guard, kind, targetId, value, fetchSeq) {
      const def = kindDefOf(kind);
      if (def === null) return null;
      const { key, tagKey } = guard.keys;
      const projects = projectIdsOf(kind, value);
      if (projects.some((project) => judgeVisibility(guard.authz, { project }, fetchSeq) !== "show")) return null;
      const id = await tagOf(tagKey, kind, targetId);
      const current = await load(key, id);
      if (current !== null && current.body.fetchSeq > fetchSeq) return null;

      // 対象が入る一覧の記録が後の番号で、対象を返していなければ採らない
      let list: { id: string; iv: Uint8Array | null } | null = null;
      const [project] = projects;
      if (def.list !== undefined && project !== undefined) {
        const lid = await listId(tagKey, { kind: def.list as SnapshotKind, projectId: project });
        const record = await load(key, lid);
        list = { id: lid, iv: record?.row.iv ?? null };
        if (record?.body.type === "list" && record.body.fetchSeq > fetchSeq && !record.body.ids.includes(targetId)) return null;
      }

      const projectTags = await Promise.all(projects.map((p) => tagOf(tagKey, p)));
      const next = row(id, kind, projectTags, await seal(key, { type: "value", value: limited(kind, value), fetchSeq }));
      return async (tx) => {
        if (!(await unchanged(tx, id, current?.row.iv ?? null))) return false;
        if (list !== null && !(await unchanged(tx, list.id, list.iv))) return false;
        await tx.objectStore("snapshots").put(next);
        return true;
      };
    },

    async applyOptimistic(guard, kind, targetId, change) {
      const { key, tagKey } = guard.keys;
      const id = await tagOf(tagKey, kind, targetId);
      const current = await load(key, id);
      if (current === null || current.body.type !== "value") return;
      const body: Body = { ...current.body, value: change(current.body.value) };
      // 受け取った時刻と番号は変えない
      const next = row(id, kind, current.row.projectTags, await seal(key, body), current.row.receivedAt);
      await commitGuarded(guard, async (tx) => {
        if (!(await unchanged(tx, id, current.row.iv))) return false;
        await tx.objectStore("snapshots").put(next);
        return true;
      });
    },

    async markGone(guard, kind, targetId, goneSeq) {
      if (kindDefOf(kind) === null) return;
      const write = await goneWrite(guard, kind, await tagOf(guard.keys.tagKey, kind, targetId), goneSeq);
      if (write !== null) await commitAndNotify(guard, [write]);
    },

    async prepareGone(guard, kind, targetId, goneSeq) {
      if (kindDefOf(kind) === null) return null;
      return goneWrite(guard, kind, await tagOf(guard.keys.tagKey, kind, targetId), goneSeq);
    },

    async recordList(guard, scope, ids, fetchSeq) {
      const { key, tagKey } = guard.keys;
      const lid = await listId(tagKey, scope);
      const current = await load(key, lid);
      if (current !== null && current.body.fetchSeq > fetchSeq) return;
      const projectTag = await tagOf(tagKey, scope.projectId);
      const record = row(lid, scope.kind, [projectTag], await seal(key, { type: "list", ids, fetchSeq }));
      const writes: Write[] = [
        async (tx) => {
          if (!(await unchanged(tx, lid, current?.row.iv ?? null))) return false;
          await tx.objectStore("snapshots").put(record);
          return true;
        },
      ];
      // 一覧が返さなかった対象の写しは印に置き換える
      const rows = await db.getAllFromIndex("snapshots", "projectTags", projectTag);
      for (const found of rows) {
        if (kindDefOf(found.kind)?.list !== scope.kind) continue;
        const returned = await Promise.all(ids.map((targetId) => tagOf(tagKey, found.kind, targetId)));
        if (returned.includes(found.id)) continue;
        const write = await goneWrite(guard, found.kind, found.id, fetchSeq);
        if (write !== null) writes.push(write);
      }
      await commitAndNotify(guard, writes);
    },

    async dropProjects(tx, projectTags) {
      const store = tx.objectStore("snapshots");
      for (const tag of projectTags) {
        for (const id of await store.index("projectTags").getAllKeys(tag)) await store.delete(id);
      }
    },

    async purgeExpired() {
      const tx = db.transaction("snapshots", "readwrite");
      const expired = await tx.store.index("receivedAt").getAllKeys(IDBKeyRange.upperBound(wallNow() - SNAPSHOT_TTL_MS, true));
      await Promise.all(expired.map((id) => tx.store.delete(id)));
      await tx.done;
      return expired.length;
    },

    // 印と一覧の記録は写しが無いものとして数えない
    async lastReceivedAt() {
      const owner = await readOwner(db);
      if (owner === null) return null;
      const rows = await db.getAllFromIndex("snapshots", "receivedAt");
      for (const found of rows.reverse()) {
        const body = await unseal<Body>(owner.key, found).catch(() => null);
        if (body?.type === "value") return found.receivedAt;
      }
      return null;
    },
  };
}
