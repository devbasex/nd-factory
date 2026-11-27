// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tagOf } from "../../src/offline/crypto.ts";
import { createCacheStore } from "../../src/offline/cache-store.ts";
import type { DeviceDb } from "../../src/offline/db.ts";
import { commitGuarded, prepareGuard } from "../../src/offline/guarded-commit.ts";
import type { SnapshotKind } from "../../src/offline/snapshot-kinds.ts";
import { freshIndexedDb, openDb, signedIn } from "./support.ts";

// 「行の iv が読んだときのままなら snapshots へ書いて真を返す」書き込みの振る舞いを固定する。
// 読んでから書くまでの間に別のタブが行を書き換える・作る・消すと、書き込みは偽になり、トランザクションごと取り消される

beforeEach(freshIndexedDb);

type AfterGet = ((id: string) => Promise<void>) | null;

async function setup() {
  const db = await openDb();
  const { keys, owner } = await signedIn(db);
  const log = { warn: vi.fn() };
  const notify = vi.fn();
  const hook: { afterGet: AfterGet } = { afterGet: null };
  // 写しの行を読んだ直後に割り込む。読んでから書くまでの間の別のタブの書き込みに見立てる
  const interleaved = new Proxy(db, {
    get(target, prop) {
      if (prop === "get") {
        return async (store: "snapshots", key: string) => {
          const found = await target.get(store, key);
          if (store === "snapshots" && hook.afterGet !== null) await hook.afterGet(key);
          return found;
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as DeviceDb;
  const store = createCacheStore({ db: interleaved, wallNow: () => 1_000_000, log, notify });
  // 割り込みの書き込みに使う、別のタブに見立てた写しの読み書き
  const other = createCacheStore({ db, wallNow: () => 1_000_000, log, notify: () => {} });
  const guard = async () => (await prepareGuard(db, owner))!;
  const replaceBy = async (target: typeof store, kind: SnapshotKind, id: string, value: unknown, fetchSeq: number) => {
    const g = await guard();
    const write = await target.prepareReplace(g, kind, id, value, fetchSeq);
    return write === null ? null : commitGuarded(g, write);
  };
  const replace = (kind: SnapshotKind, id: string, value: unknown, fetchSeq: number) =>
    replaceBy(other, kind, id, value, fetchSeq);
  const rowId = (kind: string, targetId: string) => tagOf(keys.tagKey, kind, targetId);
  // 一度だけ割り込む
  const interleaveOnce = (match: (id: string) => boolean, action: () => Promise<unknown>) => {
    hook.afterGet = async (id) => {
      if (!match(id)) return;
      hook.afterGet = null;
      await action();
    };
  };
  return { db, store, other, guard, replace, rowId, interleaveOnce, notify };
}

const sprint = (title: string) => ({ project_id: "p-example", title });

describe("写しの置き換え（prepareReplace）の書き込み", () => {
  it("行が読んだときのままなら書き、committed", async () => {
    const { db, store, guard, replace } = await setup();
    await replace("sprint", "s", sprint("old"), 1);
    const g = await guard();
    const write = (await store.prepareReplace(g, "sprint", "s", sprint("new"), 2))!;
    await expect(commitGuarded(g, write)).resolves.toBe("committed");
    await expect(store.read("sprint", "s")).resolves.toMatchObject({ value: sprint("new"), fetchSeq: 2 });
    db.close();
  });

  it("読んだときに無かった行が書くまでに作られていれば stale で、作られた行を残す", async () => {
    const { db, store, guard, replace } = await setup();
    const g = await guard();
    const write = (await store.prepareReplace(g, "sprint", "s", sprint("slow"), 2))!;
    await replace("sprint", "s", sprint("fast"), 1);
    await expect(commitGuarded(g, write)).resolves.toBe("stale");
    await expect(store.read("sprint", "s")).resolves.toMatchObject({ value: sprint("fast"), fetchSeq: 1 });
    db.close();
  });

  it("読んだときにあった行が書くまでに消えていれば stale で、作り直さない", async () => {
    const { db, store, guard, replace, rowId } = await setup();
    await replace("sprint", "s", sprint("old"), 1);
    const g = await guard();
    const write = (await store.prepareReplace(g, "sprint", "s", sprint("new"), 2))!;
    await db.delete("snapshots", await rowId("sprint", "s"));
    await expect(commitGuarded(g, write)).resolves.toBe("stale");
    await expect(db.count("snapshots")).resolves.toBe(0);
    db.close();
  });

  it("対象が入る一覧の記録が書くまでに書き換わっていれば stale", async () => {
    const { db, store, other, guard } = await setup();
    const scope = { kind: "sprint-list" as const, projectId: "p-example" };
    await other.recordList(await guard(), scope, ["s"], 1);
    const g = await guard();
    const write = (await store.prepareReplace(g, "sprint", "s", sprint("x"), 2))!;
    await other.recordList(await guard(), scope, ["s"], 3);
    await expect(commitGuarded(g, write)).resolves.toBe("stale");
    await expect(store.read("sprint", "s")).resolves.toBeNull();
    db.close();
  });

  it("一覧の記録が無いまま書くまでに作られても stale", async () => {
    const { db, store, other, guard } = await setup();
    const g = await guard();
    const write = (await store.prepareReplace(g, "sprint", "s", sprint("x"), 2))!;
    await other.recordList(await guard(), { kind: "sprint-list", projectId: "p-example" }, ["s"], 1);
    await expect(commitGuarded(g, write)).resolves.toBe("stale");
    await expect(store.read("sprint", "s")).resolves.toBeNull();
    db.close();
  });
});

describe("削除の印（prepareGone）の書き込み", () => {
  it("行が読んだときのままなら印を書き、committed", async () => {
    const { db, store, guard, replace } = await setup();
    await replace("sprint", "s", sprint("x"), 1);
    const g = await guard();
    const write = (await store.prepareGone(g, "sprint", "s", 2))!;
    await expect(commitGuarded(g, write)).resolves.toBe("committed");
    await expect(store.read("sprint", "s")).resolves.toBeNull();
    await expect(db.count("snapshots")).resolves.toBe(1);
    db.close();
  });

  it("行が書くまでに書き換わっていれば stale で、書き換わった写しを残す", async () => {
    const { db, store, guard, replace } = await setup();
    await replace("sprint", "s", sprint("old"), 1);
    const g = await guard();
    const write = (await store.prepareGone(g, "sprint", "s", 5))!;
    await replace("sprint", "s", sprint("fresh"), 3);
    await expect(commitGuarded(g, write)).resolves.toBe("stale");
    await expect(store.read("sprint", "s")).resolves.toMatchObject({ value: sprint("fresh"), fetchSeq: 3 });
    db.close();
  });

  it("読んだときに無かった行が書くまでに作られていれば stale", async () => {
    const { db, store, guard, replace } = await setup();
    const g = await guard();
    const write = (await store.prepareGone(g, "sprint", "s", 5))!;
    await replace("sprint", "s", sprint("fresh"), 3);
    await expect(commitGuarded(g, write)).resolves.toBe("stale");
    await expect(store.read("sprint", "s")).resolves.toMatchObject({ value: sprint("fresh") });
    db.close();
  });

  it("書き込みが偽を返せば、同じトランザクションのほかの書き込みも取り消す", async () => {
    const { db, store, guard, replace } = await setup();
    await replace("sprint", "a", sprint("a"), 1);
    await replace("sprint", "b", sprint("b"), 1);
    const g = await guard();
    const goneA = (await store.prepareGone(g, "sprint", "a", 5))!;
    const goneB = (await store.prepareGone(g, "sprint", "b", 5))!;
    await replace("sprint", "b", sprint("b2"), 2);
    const result = await commitGuarded(g, async (tx) => (await goneA(tx)) && (await goneB(tx)));
    expect(result).toBe("stale");
    await expect(store.read("sprint", "a")).resolves.toMatchObject({ value: sprint("a") });
    await expect(store.read("sprint", "b")).resolves.toMatchObject({ value: sprint("b2") });
    db.close();
  });
});

describe("読んでから書くまでに行が変わる、内側で書く操作", () => {
  it("先映しは、読んだ後に行が書き換わっていれば書かない", async () => {
    const { db, store, replace, rowId, interleaveOnce, guard } = await setup();
    await replace("self", "me", { name: "a" }, 1);
    const id = await rowId("self", "me");
    interleaveOnce((got) => got === id, () => replace("self", "me", { name: "other-tab" }, 2));
    await store.applyOptimistic(await guard(), "self", "me", () => ({ name: "optimistic" }));
    await expect(store.read("self", "me")).resolves.toMatchObject({ value: { name: "other-tab" }, fetchSeq: 2 });
    db.close();
  });

  it("先映しは、読んだ後に行が消えていれば作り直さない", async () => {
    const { db, store, replace, rowId, interleaveOnce, guard } = await setup();
    await replace("self", "me", { name: "a" }, 1);
    const id = await rowId("self", "me");
    interleaveOnce((got) => got === id, () => db.delete("snapshots", id));
    await store.applyOptimistic(await guard(), "self", "me", () => ({ name: "optimistic" }));
    await expect(db.count("snapshots")).resolves.toBe(0);
    db.close();
  });

  it("削除の印は、読んだ後に行が書き換わっていれば置かず、ほかのタブへ知らせない", async () => {
    const { db, store, replace, rowId, interleaveOnce, guard, notify } = await setup();
    await replace("sprint", "s", sprint("old"), 1);
    const id = await rowId("sprint", "s");
    interleaveOnce((got) => got === id, () => replace("sprint", "s", sprint("fresh"), 2));
    await store.markGone(await guard(), "sprint", "s", 5);
    await expect(store.read("sprint", "s")).resolves.toMatchObject({ value: sprint("fresh"), fetchSeq: 2 });
    expect(notify).not.toHaveBeenCalled();
    db.close();
  });

  it("削除の印は、行が読んだときのままなら置いて知らせる", async () => {
    const { db, store, replace, guard, notify } = await setup();
    await replace("sprint", "s", sprint("old"), 1);
    await store.markGone(await guard(), "sprint", "s", 5);
    await expect(store.read("sprint", "s")).resolves.toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("一覧の記録は、読んだ後に記録が書き換わっていれば書かず、印も置かない", async () => {
    const { db, store, other, replace, interleaveOnce, guard, notify } = await setup();
    const scope = { kind: "sprint-list" as const, projectId: "p-example" };
    await replace("sprint", "kept", sprint("kept"), 1);
    await replace("sprint", "lost", sprint("lost"), 1);
    const listTag = await tagOf((await guard()).keys.tagKey, "sprint-list", "list", "p-example");
    interleaveOnce(
      (got) => got === listTag,
      async () => other.recordList(await guard(), scope, ["kept", "lost"], 3),
    );
    await store.recordList(await guard(), scope, ["kept"], 5);
    await expect(store.read("sprint", "lost")).resolves.not.toBeNull();
    expect(notify).not.toHaveBeenCalled();
    // 記録は割り込んだ番号 3 のまま。番号 4 の写しの無い対象の詳細は採る
    await expect(replace("sprint", "unseen", sprint("x"), 4)).resolves.toBe("committed");
    db.close();
  });

  it("一覧の記録は、印を置く行が読んだ後に書き換わっていれば、記録も印もまとめて書かない", async () => {
    const { db, store, replace, interleaveOnce, guard, notify, rowId } = await setup();
    const scope = { kind: "sprint-list" as const, projectId: "p-example" };
    await replace("sprint", "kept", sprint("kept"), 1);
    await replace("sprint", "lost", sprint("lost"), 1);
    await replace("sprint", "lost2", sprint("lost2"), 1);
    const lost = await rowId("sprint", "lost");
    interleaveOnce((got) => got === lost, () => replace("sprint", "lost", sprint("lost-fresh"), 2));
    await store.recordList(await guard(), scope, ["kept"], 5);
    await expect(store.read("sprint", "lost")).resolves.toMatchObject({ value: sprint("lost-fresh") });
    await expect(store.read("sprint", "lost2")).resolves.toMatchObject({ value: sprint("lost2") });
    expect(notify).not.toHaveBeenCalled();
    // 一覧の記録も書かれていない
    await expect(replace("sprint", "unseen", sprint("x"), 4)).resolves.toBe("committed");
    db.close();
  });
});
