// @vitest-environment node
import { createClock } from "@nd-factory/core/clock";
import { beforeEach, describe, expect, it } from "vitest";
import { type AuthzRecord, type ListsRead } from "../../src/offline/authz.ts";
import { createCacheStore } from "../../src/offline/cache-store.ts";
import { tagOf, unseal } from "../../src/offline/crypto.ts";
import { nextSeq } from "../../src/offline/db.ts";
import { prepareGuard } from "../../src/offline/guarded-commit.ts";
import { createOutbox } from "../../src/offline/outbox.ts";
import { applyRevocation, holdDenied, planRevocation, readLocalIndex } from "../../src/offline/revocation.ts";
import { freshIndexedDb, openDb, signedIn } from "./support.ts";

beforeEach(freshIndexedDb);

const read = (projects: { id: string; teamId: string }[], teams: string[] | null = ["t-a"]): ListsRead => ({
  projects,
  projectsStartSeq: 100,
  listedSeq: 101,
  teams: teams === null ? null : { ids: teams, startSeq: 102, endSeq: 103 },
  mismatchSeq: 104,
});

async function setup() {
  const db = await openDb();
  const { keys, owner } = await signedIn(db);
  const outbox = createOutbox({ db, clock: createClock() });
  const notified: string[] = [];
  const cache = createCacheStore({ db, wallNow: () => 1_000, log: { warn: () => {} }, notify: () => {} });
  const put = async (kind: "sprint" | "notices", id: string, value: unknown) => {
    const guard = (await prepareGuard(db, owner))!;
    const write = (await cache.prepareReplace(guard, kind, id, value, await nextSeq(db)))!;
    const tx = db.transaction(["keys", "login", "snapshots", "outbox", "held", "authz"], "readwrite");
    await write(tx);
    await tx.done;
  };
  const enqueue = (projectId: string, targetId: string) =>
    outbox.enqueue(owner, { operation: "questions.answer", targetId, projectId, input: { text: "example" }, check: { version: 1 } });
  const record = async () => unseal<AuthzRecord>(keys.key, (await db.get("authz", "authz"))!);
  const apply = async (lists: ListsRead) => {
    const guard = (await prepareGuard(db, owner))!;
    const plan = planRevocation(lists, await readLocalIndex(guard, lists));
    return applyRevocation(guard, plan, { notify: () => void notified.push("authz") });
  };
  return { db, keys, owner, outbox, cache, put, enqueue, record, apply, notified };
}

describe("失効の反映", () => {
  it("見られないプロジェクトの写しと、プロジェクトをまたぐ写しを消し、送る列の件を保留に移して記録を書く", async () => {
    const { db, put, enqueue, apply, record, notified, cache } = await setup();
    await put("sprint", "s-lost", { project_id: "p-lost" });
    await put("sprint", "s-kept", { project_id: "p-kept" });
    await put("notices", "n", { items: [] });
    await enqueue("p-lost", "q1");
    await enqueue("p-kept", "q2");

    expect(await apply(read([{ id: "p-kept", teamId: "t-a" }]))).toBe("committed");

    expect(await cache.read("sprint", "s-lost")).toBeNull();
    expect(await cache.read("sprint", "s-kept")).not.toBeNull();
    expect(await cache.read("notices", "n")).toBeNull();
    expect(await db.count("outbox")).toBe(1);
    expect((await db.getAll("held")).map((r) => r.holdReason)).toEqual(["revoked"]);
    expect(await record()).toMatchObject({ allowedProjectIds: ["p-kept"], listedSeq: 101 });
    expect(notified).toEqual(["authz"]);
    db.close();
  });

  it("食い違いのプロジェクトは写しを消すが、送る列の件は残す", async () => {
    const { db, put, enqueue, apply, record, cache } = await setup();
    await put("sprint", "s", { project_id: "p-mix" });
    await enqueue("p-mix", "q");
    await apply(read([{ id: "p-mix", teamId: "t-gone" }]));
    expect(await cache.read("sprint", "s")).toBeNull();
    expect(await db.count("outbox")).toBe(1);
    expect(await db.count("held")).toBe(0);
    expect(await record()).toMatchObject({ allowedProjectIds: [], mismatchProjectIds: ["p-mix"] });
    db.close();
  });

  it("読んだ後に記録が書き換わっていれば stale で何も書かない", async () => {
    const { db, owner, enqueue, apply } = await setup();
    await enqueue("p-lost", "q");
    const guard = (await prepareGuard(db, owner))!;
    const lists = read([]);
    const plan = planRevocation(lists, await readLocalIndex(guard, lists));
    await apply(read([{ id: "p-lost", teamId: "t-a" }]));
    expect(await applyRevocation(guard, plan, { notify: () => {} })).toBe("stale");
    expect(await db.count("outbox")).toBe(1);
    db.close();
  });

  it("送るのを一度も始めていない受け入れの確定待ちは残す", async () => {
    const { db, owner, outbox, apply } = await setup();
    await outbox.enqueue(owner, {
      operation: "project_transfers.accept",
      targetId: "tr",
      projectId: "p-new",
      input: {},
      check: { version: 1 },
      transfer: { teamId: "t-a", transferId: "tr" },
    });
    await apply(read([]));
    expect(await db.count("outbox")).toBe(1);
    db.close();
  });
});

describe("403・404 の対象の保留", () => {
  it("件を保留の件に移すのと denied の記録を 1 度に書き、写しは消さない", async () => {
    const { db, keys, owner, put, enqueue, record, cache } = await setup();
    await put("sprint", "s", { project_id: "p-a" });
    const item = await enqueue("p-a", "q");
    const guard = (await prepareGuard(db, owner))!;
    await holdDenied(guard, {
      id: "p-a",
      item: { answerTag: item.answerTag, outcome: { kind: "hold", reason: "rejected", result: { status: 403, reason: "forbidden" } } },
      notify: () => {},
    });
    expect(await db.count("outbox")).toBe(0);
    const [held] = await db.getAll("held");
    expect(held?.holdReason).toBe("rejected");
    expect(await unseal(keys.key, held!)).toMatchObject({ result: { status: 403, reason: "forbidden" } });
    expect((await record()).denied.map((d) => d.id)).toEqual(["p-a"]);
    expect(await cache.read("sprint", "s")).not.toBeNull();
    expect(await db.get("snapshots", await tagOf(keys.tagKey, "sprint", "s"))).toBeDefined();
    db.close();
  });
});
