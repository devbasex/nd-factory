// @vitest-environment node
import { createClock } from "@nd-factory/core/clock";
import { beforeEach, describe, expect, it } from "vitest";
import { unseal } from "../../src/offline/crypto.ts";
import { MissingCheckError } from "../../src/offline/operation-classes.ts";
import { createOutbox, type Draft, type OutboxItem } from "../../src/offline/outbox.ts";
import { freshIndexedDb, openDb, OTHER_USER, signedIn } from "./support.ts";

beforeEach(freshIndexedDb);

async function setup() {
  const db = await openDb();
  const { keys, owner } = await signedIn(db);
  let now = 5_000;
  const outbox = createOutbox({ db, clock: { ...createClock(), epochMs: () => now } });
  return { db, keys, owner, outbox, setNow: (ms: number) => void (now = ms) };
}

const answer = (targetId: string, reason = "example-reason"): Draft => ({
  operation: "approvals.answer",
  targetId,
  projectId: "p-example",
  input: { answer: "approve", reason },
  check: { version: 3, material_digest: "sha256:example" },
});
const message = (text: string): Draft => ({
  operation: "organizer_messages.create",
  targetId: "org-example",
  projectId: "p-example",
  input: { text },
});

const texts = (items: OutboxItem[]) => items.map((i) => (i.input as { text?: string; reason?: string }).text ?? (i.input as { reason: string }).reason);

describe("送る列", () => {
  it("時計が戻っても押した順に読め、IndexedDB に平文の ID と入力が無い", async () => {
    const { db, owner, outbox, setNow } = await setup();
    await outbox.enqueue(owner, message("one"));
    setNow(1_000);
    await outbox.enqueue(owner, message("two"));
    expect(texts((await outbox.readBatch()).items)).toEqual(["one", "two"]);
    for (const row of await db.getAll("outbox")) {
      const plain = JSON.stringify(row) + new TextDecoder().decode(row.data);
      for (const secret of ["org-example", "p-example", "organizer_messages", "one", "two"]) {
        expect(plain).not.toContain(secret);
      }
    }
    db.close();
  });

  it("同じ対象の未送信の確定待ちは置き換え、送り始めた件は残して後ろに足す", async () => {
    const { db, owner, outbox } = await setup();
    await outbox.enqueue(owner, answer("a", "first"));
    await outbox.enqueue(owner, answer("a", "second"));
    let { items } = await outbox.readBatch();
    expect(texts(items)).toEqual(["second"]);
    expect(await outbox.markSendStarted(items[0]!, 111)).toMatchObject({ sendStarted: true, sentAt: 111 });
    await outbox.enqueue(owner, answer("a", "third"));
    ({ items } = await outbox.readBatch());
    expect(texts(items)).toEqual(["second", "third"]);
    db.close();
  });

  it("つながってから押す操作と、別の持ち主の操作は受けない", async () => {
    const { db, owner, outbox } = await setup();
    await expect(outbox.enqueue(owner, { ...message("x"), operation: "sprints.create" })).rejects.toThrow();
    await expect(outbox.enqueue({ ...owner, userId: OTHER_USER }, message("x"))).rejects.toThrow();
    await expect(db.count("outbox")).resolves.toBe(0);
    db.close();
  });

  it("照合の値がそろわない確定待ちは、保存せずに照合の値が無いことを知らせる", async () => {
    const { db, owner, outbox } = await setup();
    const { check: _check, ...bare } = answer("a");
    await expect(outbox.enqueue(owner, bare)).rejects.toBeInstanceOf(MissingCheckError);
    await expect(outbox.enqueue(owner, { ...bare, check: { version: 3 } })).rejects.toMatchObject({ missing: ["material_digest"] });
    await expect(outbox.enqueue(owner, { ...bare, check: { version: "3", material_digest: "sha256:example" } })).rejects.toMatchObject({
      missing: ["version"],
    });
    await expect(db.count("outbox")).resolves.toBe(0);
    db.close();
  });

  it("隔離している間は受けない", async () => {
    const { db, keys, owner, outbox } = await setup();
    await db.put("keys", { ...keys, switching: true });
    await expect(outbox.enqueue(owner, message("x"))).rejects.toThrow();
    await expect(db.count("outbox")).resolves.toBe(0);
    db.close();
  });

  it("送り始めた時刻は 1 回目だけ書き、古い控えでは書かない", async () => {
    const { db, owner, outbox } = await setup();
    await outbox.enqueue(owner, message("x"));
    const [item] = (await outbox.readBatch()).items;
    const started = (await outbox.markSendStarted(item!, null))!;
    await expect(outbox.markSendStarted(item!, 2)).resolves.toBeNull();
    await expect(outbox.markSendStarted(started, 3)).resolves.toMatchObject({ sentAt: null });
    db.close();
  });

  it("印を戻す。同じ対象の確定待ちが後ろにあれば、元の件を消す", async () => {
    const { db, owner, outbox } = await setup();
    await outbox.enqueue(owner, answer("a", "first"));
    const [first] = (await outbox.readBatch()).items;
    await outbox.unmarkSendStarted((await outbox.markSendStarted(first!, 1))!);
    const [reset] = (await outbox.readBatch()).items;
    expect(reset).toMatchObject({ sendStarted: false, sentAt: null });
    const started = (await outbox.markSendStarted(reset!, 1))!;
    await outbox.enqueue(owner, answer("a", "second"));
    await outbox.unmarkSendStarted(started);
    expect(texts((await outbox.readBatch()).items)).toEqual(["second"]);
    db.close();
  });

  it("結果で、同じ答えの 1 件だけを消すか保留へ移す", async () => {
    const { db, keys, owner, outbox } = await setup();
    for (const target of ["a", "b", "c"]) await outbox.enqueue(owner, answer(target, target));
    const [a, b, c] = (await outbox.readBatch()).items;
    await expect(outbox.settle(a!, { kind: "remove" })).resolves.toBe("removed");
    await expect(outbox.settle(a!, { kind: "remove" })).resolves.toBe("missing");
    await expect(outbox.settle(b!, { kind: "keep" })).resolves.toBe("kept");
    const result = { status: 409, reason: "version_mismatch" };
    await expect(outbox.settle(c!, { kind: "hold", reason: "rejected", result })).resolves.toBe("held");
    await expect(db.getAllKeys("outbox")).resolves.toEqual([b!.answerTag]);
    const held = (await db.get("held", c!.answerTag))!;
    expect(held.holdReason).toBe("rejected");
    await expect(unseal(keys.key, held)).resolves.toMatchObject({ result, input: { reason: "c" } });
    // 取り下げで保留にある件は、後の成功で消す
    await expect(outbox.settle(c!, { kind: "remove" })).resolves.toBe("removed");
    await expect(db.count("held")).resolves.toBe(0);
    db.close();
  });

  it("保留へ暗号文のまま移し、復号できない件も失わない", async () => {
    const { db, owner, outbox } = await setup();
    await outbox.enqueue(owner, message("x"));
    await outbox.enqueue(owner, message("y"));
    const [x, y] = (await outbox.readBatch()).items;
    const original = (await db.get("outbox", x!.answerTag))!;
    await expect(outbox.moveToHeld([x!.answerTag, "none"], "revoked")).resolves.toBe(1);
    await expect(db.get("held", x!.answerTag)).resolves.toEqual({ ...original, holdReason: "revoked" });
    const broken = (await db.get("outbox", y!.answerTag))!;
    await db.put("outbox", { ...broken, data: new ArrayBuffer(32) });
    await expect(outbox.readBatch()).resolves.toEqual({ items: [], unreadable: [y!.answerTag] });
    await expect(db.get("held", y!.answerTag)).resolves.toMatchObject({ holdReason: "unreadable" });
    await expect(outbox.countPending(owner)).resolves.toEqual({ confirm: 0, queued: 0, held: 2 });
    db.close();
  });

  it("数は持ち主にだけ返す", async () => {
    const { db, owner, outbox } = await setup();
    await outbox.enqueue(owner, answer("a"));
    await outbox.enqueue(owner, message("x"));
    await expect(outbox.countPending(owner)).resolves.toEqual({ confirm: 1, queued: 1, held: 0 });
    await expect(outbox.countPending({ ...owner, userId: OTHER_USER })).resolves.toEqual({ confirm: 0, queued: 0, held: 0 });
    db.close();
  });
});
