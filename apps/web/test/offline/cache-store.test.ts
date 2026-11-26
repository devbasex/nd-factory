// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seal, tagOf } from "../../src/offline/crypto.ts";
import { createCacheStore, SNAPSHOT_TTL_MS } from "../../src/offline/cache-store.ts";
import { commitGuarded, type Guard, prepareGuard } from "../../src/offline/guarded-commit.ts";
import { projectIdsOf, type SnapshotKind, snapshotKindOf } from "../../src/offline/snapshot-kinds.ts";
import { freshIndexedDb, openDb, signedIn } from "./support.ts";

beforeEach(freshIndexedDb);

async function setup() {
  const db = await openDb();
  const { keys, owner } = await signedIn(db);
  let now = 1_000_000;
  const log = { warn: vi.fn() };
  const notify = vi.fn();
  const store = createCacheStore({ db, wallNow: () => now, log, notify });
  const guard = async () => (await prepareGuard(db, owner))!;
  const replace = async (kind: SnapshotKind, id: string, value: unknown, fetchSeq: number) => {
    const g: Guard = await guard();
    const write = await store.prepareReplace(g, kind, id, value, fetchSeq);
    return write === null ? null : commitGuarded(g, write);
  };
  return { db, keys, store, guard, replace, log, notify, advance: (ms: number) => void (now += ms) };
}

const sprint = (title: string) => ({ project_id: "p-example", title });

describe("写しにする種類の表", () => {
  it("表の操作は種類を返し、表に無い操作は null", () => {
    expect(snapshotKindOf("sprints.list")).toBe("sprint-list");
    expect(snapshotKindOf("approvals.get")).toBe("approval");
    expect(snapshotKindOf("audit_records.list")).toBeNull();
    expect(snapshotKindOf("usage.get")).toBeNull();
  });

  it("中身が含むプロジェクトの ID を重ねずに集める", () => {
    const rows = { items: [{ project_id: "p-1" }, { project_id: "p-2" }, { project_id: "p-1" }] };
    expect(projectIdsOf("approvals-list", rows).sort()).toEqual(["p-1", "p-2"]);
    expect(projectIdsOf("approvals-list", { items: [] })).toEqual([]);
  });
});

describe("端末のキャッシュ", () => {
  it("置いた写しを読め、IndexedDB の中身に平文の ID と中身が無い", async () => {
    const { db, store, replace } = await setup();
    await expect(replace("sprint", "spr-example", sprint("example-title"), 5)).resolves.toBe("committed");
    await expect(store.read("sprint", "spr-example")).resolves.toEqual({
      value: sprint("example-title"),
      receivedAt: 1_000_000,
      fetchSeq: 5,
    });
    const [raw] = await db.getAll("snapshots");
    const plain = JSON.stringify(raw) + new TextDecoder().decode(raw!.data);
    for (const secret of ["spr-example", "p-example", "example-title"]) expect(plain).not.toContain(secret);
    db.close();
  });

  it("ちょうど 14 日までは出し、過ぎたら出さずに消す", async () => {
    const { db, store, replace, advance } = await setup();
    await replace("self", "me", { name: "example" }, 1);
    advance(SNAPSHOT_TTL_MS);
    await expect(store.read("self", "me")).resolves.not.toBeNull();
    await expect(store.purgeExpired()).resolves.toBe(0);
    advance(1);
    await expect(store.read("self", "me")).resolves.toBeNull();
    await expect(store.lastReceivedAt()).resolves.toBe(1_000_000);
    await expect(store.purgeExpired()).resolves.toBe(1);
    await expect(db.count("snapshots")).resolves.toBe(0);
    db.close();
  });

  it("表に無い種類と、古い番号のレスポンスは書かない", async () => {
    const { db, store, replace } = await setup();
    await expect(replace("audit" as SnapshotKind, "a", {}, 1)).resolves.toBeNull();
    await replace("sprint", "s", sprint("new"), 8);
    await expect(replace("sprint", "s", sprint("old"), 7)).resolves.toBeNull();
    expect((await store.read("sprint", "s"))?.value).toEqual(sprint("new"));
    db.close();
  });

  it("手順の間に行が書き換わると stale", async () => {
    const { db, store, guard, replace } = await setup();
    const g = await guard();
    const write = (await store.prepareReplace(g, "sprint", "s", sprint("slow"), 2))!;
    await replace("sprint", "s", sprint("fast"), 3);
    await expect(commitGuarded(g, write)).resolves.toBe("stale");
    expect((await store.read("sprint", "s"))?.value).toEqual(sprint("fast"));
    db.close();
  });

  it("見られるプロジェクトの記録に合わないレスポンスは書かない", async () => {
    const { db, keys, replace } = await setup();
    const record = { generation: 1, allowedProjectIds: [], listedSeq: 10, mismatchProjectIds: [], mismatchSeq: null, denied: [] };
    await db.put("authz", { id: "authz", ...(await seal(keys.key, record)) });
    await expect(replace("sprint", "s", sprint("x"), 9)).resolves.toBeNull();
    await expect(replace("sprint", "s", sprint("x"), 11)).resolves.toBe("committed");
    db.close();
  });

  it("削除の印は写しが無いものとして扱い、古い成功で作り直さない", async () => {
    const { db, store, guard, replace, notify } = await setup();
    await replace("sprint", "s", sprint("x"), 2);
    await store.markGone(await guard(), "sprint", "s", 5);
    await expect(store.read("sprint", "s")).resolves.toBeNull();
    await expect(store.lastReceivedAt()).resolves.toBeNull();
    expect(notify).toHaveBeenCalledWith({ type: "gone" });
    await expect(replace("sprint", "s", sprint("old"), 4)).resolves.toBeNull();
    await expect(replace("sprint", "s", sprint("new"), 6)).resolves.toBe("committed");
    // 後の番号の写しには、前の 404 を当てない
    await store.markGone(await guard(), "sprint", "s", 5);
    await expect(store.read("sprint", "s")).resolves.not.toBeNull();
    db.close();
  });

  it("一覧に返らなかった行へ印を置き、写しの無い対象の古い詳細も採らない", async () => {
    const { db, store, guard, replace } = await setup();
    await replace("sprint", "kept", sprint("kept"), 1);
    await replace("sprint", "lost", sprint("lost"), 1);
    await replace("sprint", "elsewhere", { project_id: "p-other" }, 1);
    await store.recordList(await guard(), { kind: "sprint-list", projectId: "p-example" }, ["kept"], 5);
    await expect(store.read("sprint", "kept")).resolves.not.toBeNull();
    await expect(store.read("sprint", "lost")).resolves.toBeNull();
    await expect(store.read("sprint", "elsewhere")).resolves.not.toBeNull();
    await expect(replace("sprint", "unseen", sprint("old"), 4)).resolves.toBeNull();
    await expect(replace("sprint", "unseen", sprint("new"), 6)).resolves.toBe("committed");
    db.close();
  });

  it("先映しは番号を変えず、写しが無ければ何もしない", async () => {
    const { db, store, guard, replace } = await setup();
    await replace("self", "me", { name: "a" }, 3);
    await store.applyOptimistic(await guard(), "self", "me", () => ({ name: "b" }));
    await store.applyOptimistic(await guard(), "self", "none", () => ({ name: "c" }));
    await expect(store.read("self", "me")).resolves.toMatchObject({ value: { name: "b" }, fetchSeq: 3 });
    await expect(db.count("snapshots")).resolves.toBe(1);
    db.close();
  });

  it("件数の上限を超える項目は古い方から落とす", async () => {
    const { db, store, replace } = await setup();
    const items = Array.from({ length: 51 }, (_, i) => ({ project_id: "p-example", n: i }));
    await replace("sprint-list", "p-example", { items }, 1);
    const saved = (await store.read("sprint-list", "p-example"))!.value as { items: { n: number }[] };
    // 一覧は新しい順に返る
    expect(saved.items).toHaveLength(50);
    expect(saved.items.at(-1)?.n).toBe(49);
    db.close();
  });

  it("プロジェクト単位で消し、またぐ写しも消す", async () => {
    const { db, keys, store, guard, replace } = await setup();
    await replace("sprint", "a", sprint("a"), 1);
    await replace("approvals-list", "all", { items: [{ project_id: "p-example" }, { project_id: "p-other" }] }, 1);
    await replace("sprint", "b", { project_id: "p-other" }, 1);
    const tag = await tagOf(keys.tagKey, "p-example");
    await commitGuarded(await guard(), (tx) => store.dropProjects(tx, [tag]));
    await expect(db.count("snapshots")).resolves.toBe(1);
    db.close();
  });

  it("復号できない写しがあれば、全写しを消して null", async () => {
    const { db, store, replace, log } = await setup();
    await replace("self", "me", {}, 1);
    await replace("sprint", "s", sprint("x"), 1);
    const rows = await db.getAll("snapshots");
    const self = rows.find((r) => r.kind === "self")!;
    await db.put("snapshots", { ...self, data: new ArrayBuffer(32) });
    await expect(store.read("self", "me")).resolves.toBeNull();
    await expect(db.count("snapshots")).resolves.toBe(0);
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), { kind: "self" });
    db.close();
  });
});
