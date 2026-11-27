// @vitest-environment node
import { createClock } from "@nd-factory/core/clock";
import { beforeEach, describe, expect, it } from "vitest";
import { seal, tagOf, unseal } from "../../src/offline/crypto.ts";
import { createOwner, type DeviceDb, deleteDeviceDb, type OutboxRow } from "../../src/offline/db.ts";
import { createOutbox, type Draft, type OutboxBody } from "../../src/offline/outbox.ts";
import { quarantinePending, restoreQuarantined } from "../../src/offline/quarantine.ts";
import { freshIndexedDb, openDb, signedIn, USER } from "./support.ts";

// 送る列の行（主キー・対象・種類・プロジェクトのタグと暗号文）の作り方を、足すときと隔離から戻すときの両方で固定する

beforeEach(freshIndexedDb);

const confirm = (targetId: string, projectId: string | null = "p-example"): Draft => ({
  operation: "approvals.answer",
  targetId,
  projectId,
  input: { reason: targetId },
  check: { version: 1, material_digest: "sha256:example" },
});
const queued = (text: string, projectId: string | null = "p-example"): Draft => ({
  operation: "organizer_messages.create",
  targetId: "org-example",
  projectId,
  input: { text },
});

type Keys = { key: CryptoKey; tagKey: CryptoKey };

// 行が本文から作った列だけを持ち、その値が本文から作ったタグであること
async function expectRowOf(row: OutboxRow, keys: Keys, body: OutboxBody, kind: OutboxRow["kind"]) {
  const { holdReason: _reason, ...columns } = row as OutboxRow & { holdReason?: unknown };
  const expected = ["answerTag", "data", "iv", "kind", "targetTag", ...(body.projectId === null ? [] : ["projectTag"])];
  expect(Object.keys(columns).sort()).toEqual(expected.sort());
  expect(row.answerTag).toBe(await tagOf(keys.tagKey, body.idempotencyKey));
  expect(row.targetTag).toBe(await tagOf(keys.tagKey, body.operation, body.targetId));
  expect(row.kind).toBe(kind);
  if (body.projectId === null) expect("projectTag" in row).toBe(false);
  else expect(row.projectTag).toBe(await tagOf(keys.tagKey, body.projectId));
  expect(row.iv).toBeInstanceOf(Uint8Array);
  expect(row.iv.byteLength).toBe(12);
  await expect(unseal<OutboxBody>(keys.key, row)).resolves.toEqual(body);
}

async function setup() {
  const db = await openDb();
  const signed = await signedIn(db);
  let now = 7_000;
  const outbox = createOutbox({ db, clock: { ...createClock(), epochMs: () => now } });
  return { db, ...signed, outbox, setNow: (ms: number) => void (now = ms) };
}

async function recreate(db: DeviceDb) {
  db.close();
  await deleteDeviceDb({ onBlocked: () => {} });
  const next = await openDb();
  return { db: next, keys: await createOwner(next, USER) };
}

describe("足すときの送る列の行", () => {
  it("確定待ちは、冪等キー・操作と対象・プロジェクトのタグと、押した時点の本文の暗号文を持つ", async () => {
    const { db, keys, owner, outbox } = await setup();
    const item = await outbox.enqueue(owner, { ...confirm("a"), pressedFloor: 42 });
    const row = (await db.get("outbox", item.answerTag))!;
    const body: OutboxBody = {
      ...confirm("a"),
      idempotencyKey: item.idempotencyKey,
      pressedAt: 7_000,
      pressedFloor: 42,
      seq: item.seq,
      sendStarted: false,
      sentAt: null,
    };
    await expectRowOf(row, keys, body, "confirm");
    // 返す件は行の列と本文を合わせたもの
    expect(item).toEqual({ ...body, answerTag: row.answerTag, targetTag: row.targetTag, kind: "confirm", projectTag: row.projectTag, iv: row.iv });
    db.close();
  });

  it("キャッシュして送る件は kind が queued で、押した下限が無ければ null を入れる", async () => {
    const { db, keys, owner, outbox } = await setup();
    const item = await outbox.enqueue(owner, queued("hello"));
    const row = (await db.get("outbox", item.answerTag))!;
    await expectRowOf(row, keys, { ...queued("hello"), idempotencyKey: item.idempotencyKey, pressedAt: 7_000, pressedFloor: null, seq: item.seq, sendStarted: false, sentAt: null }, "queued");
    db.close();
  });

  it("プロジェクトの無い件は projectTag の列を持たない", async () => {
    const { db, keys, owner, outbox } = await setup();
    const item = await outbox.enqueue(owner, queued("no-project", null));
    const row = (await db.get("outbox", item.answerTag))!;
    expect("projectTag" in item).toBe(false);
    await expectRowOf(row, keys, { ...queued("no-project", null), idempotencyKey: item.idempotencyKey, pressedAt: 7_000, pressedFloor: null, seq: item.seq, sendStarted: false, sentAt: null }, "queued");
    db.close();
  });

  it("同じ対象の確定待ちは同じ targetTag を持ち、対象が違えば別の targetTag を持つ", async () => {
    const { db, owner, outbox } = await setup();
    const a = await outbox.enqueue(owner, confirm("a"));
    const sent = (await outbox.markSendStarted(a, 1))!;
    const again = await outbox.enqueue(owner, confirm("a"));
    const other = await outbox.enqueue(owner, confirm("b"));
    expect(again.targetTag).toBe(sent.targetTag);
    expect(other.targetTag).not.toBe(sent.targetTag);
    expect(new Set([sent.answerTag, again.answerTag, other.answerTag]).size).toBe(3);
    db.close();
  });
});

describe("隔離から戻すときの送る列の行", () => {
  it("新しい持ち主のキーで、同じ列を作り直し、本文は seq だけを付け直す", async () => {
    const first = await setup();
    const unsent = await first.outbox.enqueue(first.owner, { ...confirm("unsent"), pressedFloor: 9 });
    const sent = (await first.outbox.markSendStarted(await first.outbox.enqueue(first.owner, confirm("sent")), 123))!;
    const message = await first.outbox.enqueue(first.owner, queued("message", null));
    const held = await first.outbox.enqueue(first.owner, queued("held"));
    await first.outbox.moveToHeld([held.answerTag], "revoked");
    await quarantinePending(first.db, { drop: new Set() });
    const { db, keys } = await recreate(first.db);

    await restoreQuarantined(db, USER);

    const bodyOf = (item: typeof unsent): OutboxBody => {
      const { answerTag: _a, targetTag: _t, kind: _k, projectTag: _p, iv: _iv, ...body } = item;
      return body;
    };
    const restored = new Map<string, { row: OutboxRow; store: string; reason?: string }>();
    for (const row of await db.getAll("outbox")) restored.set(row.answerTag, { row, store: "outbox" });
    for (const row of await db.getAll("held")) restored.set(row.answerTag, { row, store: "held", reason: row.holdReason });
    expect(restored.size).toBe(4);

    const cases = [
      { item: unsent, kind: "confirm", store: "held", reason: "restored" },
      { item: sent, kind: "confirm", store: "held", reason: "unknown-result" },
      { item: message, kind: "queued", store: "outbox", reason: undefined },
      { item: held, kind: "queued", store: "held", reason: "revoked" },
    ] as const;
    const seqs: number[] = [];
    for (const c of cases) {
      const found = restored.get(await tagOf(keys.tagKey, c.item.idempotencyKey))!;
      expect(found).toBeDefined();
      expect(found.store).toBe(c.store);
      expect(found.reason).toBe(c.reason);
      const body = await unseal<OutboxBody>(keys.key, found.row);
      seqs.push(body.seq);
      await expectRowOf(found.row, keys, { ...bodyOf(c.item), seq: body.seq }, c.kind);
    }
    // 元の押した順のまま、新しいデータベースで番号を取り直す
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(4);
    db.close();
  });

  it("戻した件は新しい送る列で読め、後から押した同じ対象の件と targetTag を共有する", async () => {
    const first = await setup();
    const message = await first.outbox.enqueue(first.owner, queued("before"));
    await quarantinePending(first.db, { drop: new Set() });
    const { db, keys } = await recreate(first.db);
    await restoreQuarantined(db, USER);
    await db.put("login", {
      id: "login",
      userTag: keys.ownerTag,
      fingerprintTag: await tagOf(keys.tagKey, first.owner.fingerprint),
      ...(await seal(keys.key, {})),
    });
    const outbox = createOutbox({ db, clock: createClock() });
    const later = await outbox.enqueue(first.owner, queued("after"));
    const { items } = await outbox.readBatch();
    expect(items.map((i) => i.idempotencyKey)).toEqual([message.idempotencyKey, later.idempotencyKey]);
    expect(items[0]).toMatchObject({ input: { text: "before" }, kind: "queued", sendStarted: false, sentAt: null, pressedAt: 7_000 });
    expect(items[0]!.targetTag).toBe(later.targetTag);
    expect(items[0]!.projectTag).toBe(later.projectTag);
    db.close();
  });
});
