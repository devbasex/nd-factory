// @vitest-environment node
import { createClock } from "@nd-factory/core/clock";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthzRecord } from "../../src/offline/authz.ts";
import { createHeldStore, type HeldItem, visibleFieldsOf } from "../../src/offline/held-store.ts";
import { createOutbox, type Draft } from "../../src/offline/outbox.ts";
import { freshIndexedDb, openDb, signedIn } from "./support.ts";

beforeEach(freshIndexedDb);

const draft: Draft = {
  operation: "approvals.answer",
  targetId: "apr-example",
  projectId: "p-example",
  input: { reason: "example-reason" },
  check: { version: 1 },
};

async function heldOne(over: Partial<Draft> = {}) {
  const db = await openDb();
  const { owner } = await signedIn(db);
  const outbox = createOutbox({ db, clock: createClock() });
  await outbox.enqueue(owner, { ...draft, ...over });
  const [item] = (await outbox.readBatch()).items;
  await outbox.moveToHeld([item!.answerTag], "revoked");
  return { db, store: createHeldStore({ db }), answerTag: item!.answerTag };
}

describe("保留の件", () => {
  it("件数と中身を読み、破棄した件だけが消える", async () => {
    const { db, store, answerTag } = await heldOne();
    await expect(store.count()).resolves.toBe(1);
    await expect(store.list()).resolves.toMatchObject([
      { answerTag, holdReason: "revoked", kind: "confirm", body: { operation: "approvals.answer" } },
    ]);
    await store.discard("none");
    await expect(store.count()).resolves.toBe(1);
    await store.discard(answerTag);
    await expect(store.count()).resolves.toBe(0);
    db.close();
  });

  it("復号できない件は中身を null にして残す", async () => {
    const { db, store, answerTag } = await heldOne();
    const row = (await db.get("held", answerTag))!;
    await db.put("held", { ...row, data: new ArrayBuffer(32) });
    await expect(store.list()).resolves.toEqual([{ answerTag, holdReason: "revoked", kind: "confirm", body: null }]);
    db.close();
  });
});

const record: AuthzRecord = {
  generation: 1,
  allowedProjectIds: ["p-example"],
  listedSeq: 1,
  mismatchProjectIds: [],
  mismatchSeq: null,
  allowedTeamIds: ["t-example"],
  teamsSeq: 1,
  denied: [],
};

const item = (over: Partial<Draft> = {}): HeldItem => ({
  answerTag: "tag",
  holdReason: "revoked",
  kind: "confirm",
  body: { ...draft, ...over, idempotencyKey: "k", pressedAt: 7, pressedFloor: null, seq: 1, sendStarted: false, sentAt: null },
});

const base = { answerTag: "tag", holdReason: "revoked", operation: "approvals.answer", pressedAt: 7 };

describe("件の表示で出すもの", () => {
  it("今の権限で見られる対象は、入力と対象を出す", () => {
    expect(visibleFieldsOf(item(), record)).toMatchObject({
      ...base,
      content: { input: { reason: "example-reason" }, targetId: "apr-example", projectId: "p-example" },
    });
  });

  it.each([
    ["記録が無い", null],
    ["許す並びに無い", { ...record, allowedProjectIds: [] }],
    ["denied にある", { ...record, denied: [{ id: "p-example", deniedSeq: 1 }] }],
  ])("%sときは、理由と操作の種類と時刻だけ", (_, rec) => {
    expect(visibleFieldsOf(item(), rec)).toEqual({ ...base, content: null });
  });

  it("受け入れは受け入れ先のチームで確かめる", () => {
    const accept = { operation: "project_transfers.accept", projectId: "p-new", transfer: { teamId: "t-example", transferId: "x" } };
    expect(visibleFieldsOf(item(accept), record).content).not.toBeNull();
    expect(visibleFieldsOf(item(accept), { ...record, allowedTeamIds: [] }).content).toBeNull();
  });

  it("自分の設定は常に出し、ほかのプロジェクトの無い件は出さない", () => {
    expect(visibleFieldsOf(item({ operation: "users.update", projectId: null }), null).content).not.toBeNull();
    expect(visibleFieldsOf(item({ operation: "sprints.cancel", projectId: null }), record).content).toBeNull();
  });

  it("復号できない件は区分だけ", () => {
    expect(visibleFieldsOf({ ...item(), body: null }, record)).toEqual({
      answerTag: "tag",
      holdReason: "revoked",
      unreadableKind: "confirm",
      content: null,
    });
  });
});
