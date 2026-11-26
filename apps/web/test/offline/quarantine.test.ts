// @vitest-environment node
import { createClock } from "@nd-factory/core/clock";
import { beforeEach, describe, expect, it } from "vitest";
import { seal, tagOf, unseal } from "../../src/offline/crypto.ts";
import { createOwner, type DeviceDb, deleteDeviceDb } from "../../src/offline/db.ts";
import { createOutbox, type Draft, type OutboxBody } from "../../src/offline/outbox.ts";
import {
  quarantinePending,
  restoreQuarantined,
  rollbackQuarantine,
  unreadableQuarantine,
} from "../../src/offline/quarantine.ts";
import { freshIndexedDb, openDb, OTHER_USER, signedIn, USER } from "./support.ts";

beforeEach(freshIndexedDb);

const confirm = (targetId: string): Draft => ({
  operation: "approvals.answer",
  targetId,
  projectId: "p-example",
  input: { reason: targetId },
  check: { version: 1 },
});
const queued = (text: string): Draft => ({
  operation: "organizer_messages.create",
  targetId: "org-example",
  projectId: "p-example",
  input: { text },
});

// 未送信の確定待ち・送り始めた確定待ち・キャッシュして送る・保留の件を 1 件ずつ持つ
async function seeded() {
  const db = await openDb();
  const signed = await signedIn(db);
  const outbox = createOutbox({ db, clock: createClock() });
  const unsent = await outbox.enqueue(signed.owner, confirm("unsent"));
  const sent = (await outbox.markSendStarted(await outbox.enqueue(signed.owner, confirm("sent")), 1))!;
  const message = await outbox.enqueue(signed.owner, queued("message"));
  const held = await outbox.enqueue(signed.owner, queued("held"));
  await outbox.moveToHeld([held.answerTag], "revoked");
  return { db, ...signed, outbox, items: { unsent, sent, message, held } };
}

// 持ち主の交代の後の、空の新しいデータベース
async function recreate(db: DeviceDb, userId = USER) {
  db.close();
  await deleteDeviceDb({ onBlocked: () => {} });
  const next = await openDb();
  const keys = await createOwner(next, userId);
  return { db: next, keys };
}

async function quarantinedCount(): Promise<number> {
  const q = await new Promise<IDBDatabase>((resolve) => {
    const request = indexedDB.open("nd-quarantine");
    request.onsuccess = () => resolve(request.result);
  });
  if (!q.objectStoreNames.contains("items")) return (q.close(), 0);
  const count = await new Promise<number>((resolve) => {
    const request = q.transaction("items").objectStore("items").count();
    request.onsuccess = () => resolve(request.result);
  });
  q.close();
  return count;
}

const bodies = async (db: DeviceDb, key: CryptoKey, store: "outbox" | "held") =>
  Promise.all(
    (await db.getAll(store)).map(async (row) => ({
      target: (await unseal<OutboxBody>(key, row)).targetId,
      text: JSON.stringify((await unseal<OutboxBody>(key, row)).input),
      reason: "holdReason" in row ? row.holdReason : undefined,
    })),
  );

describe("隔離", () => {
  it("確認した件のほかを暗号文のまま移し、元は消さない", async () => {
    const { db, items } = await seeded();
    await quarantinePending(db, { drop: new Set([items.message.answerTag]) });
    await expect(quarantinedCount()).resolves.toBe(3);
    await expect(db.count("outbox")).resolves.toBe(3);
    expect((await db.get("keys", "main"))?.switching).toBe(true);
    db.close();
  });

  it("件が無ければ何も残さない", async () => {
    const db = await openDb();
    await signedIn(db);
    await quarantinePending(db, { drop: new Set() });
    await expect(quarantinedCount()).resolves.toBe(0);
    db.close();
  });

  it("同じ利用者に戻すと、確定待ちは保留へ、キャッシュして送るは送る列へ戻り、2 回打っても増えない", async () => {
    const first = await seeded();
    await quarantinePending(first.db, { drop: new Set() });
    const { db, keys } = await recreate(first.db);

    await restoreQuarantined(db, USER);
    await restoreQuarantined(db, USER);

    await expect(bodies(db, keys.key, "outbox")).resolves.toEqual([expect.objectContaining({ target: "org-example" })]);
    const held = await bodies(db, keys.key, "held");
    expect(held.map((h) => h.reason).sort()).toEqual(["restored", "revoked", "unknown-result"]);
    const [row] = await db.getAll("outbox");
    expect(row!.projectTag).toBe(await tagOf(keys.tagKey, "p-example"));
    expect(row!.answerTag).toBe(await tagOf(keys.tagKey, first.items.message.idempotencyKey));
    await expect(quarantinedCount()).resolves.toBe(0);
    db.close();
  });

  it("別の利用者には戻さない", async () => {
    const first = await seeded();
    await quarantinePending(first.db, { drop: new Set() });
    const { db } = await recreate(first.db, OTHER_USER);
    await restoreQuarantined(db, OTHER_USER);
    await expect(db.count("outbox")).resolves.toBe(0);
    await expect(db.count("held")).resolves.toBe(0);
    await expect(quarantinedCount()).resolves.toBe(4);
    db.close();
  });

  it("中断した隔離は、元にある件の複製だけを消して switching を外す", async () => {
    const { db, items } = await seeded();
    await quarantinePending(db, { drop: new Set() });
    await db.delete("outbox", items.message.answerTag);
    await rollbackQuarantine(db);
    await expect(quarantinedCount()).resolves.toBe(1);
    expect((await db.get("keys", "main"))?.switching).toBeUndefined();
    await rollbackQuarantine(db);
    db.close();
  });
});

// 1 件を壊してから隔離し、同じ利用者で作り直す
async function unreadableSetup() {
  const first = await seeded();
  const row = (await first.db.get("outbox", first.items.message.answerTag))!;
  await first.db.put("outbox", { ...row, data: new ArrayBuffer(32) });
  await quarantinePending(first.db, { drop: new Set() });
  const { db, keys } = await recreate(first.db);
  await restoreQuarantined(db, USER);
  let fingerprint: string | null = "fp-example";
  const login = {
    id: "login" as const,
    userTag: keys.ownerTag,
    fingerprintTag: await tagOf(keys.tagKey, "fp-example"),
    ...(await seal(keys.key, {})),
  };
  await db.put("login", login);
  return {
    db,
    answerTag: first.items.message.answerTag,
    read: () => fingerprint,
    setFingerprint: (value: string | null) => void (fingerprint = value),
  };
}

describe("読めない隔離の件", () => {
  const open = async (db: DeviceDb, read: () => string | null, userId = USER, flagged = () => false) =>
    unreadableQuarantine(db, userId, read, flagged);

  it("戻せない件は隔離に残り、持ち主にだけ出て、指定した 1 件を破棄できる", async () => {
    const { db, answerTag, read } = await unreadableSetup();
    const found = await open(db, read);
    if (typeof found === "string") throw new Error(found);
    expect(found.items).toEqual([{ answerTag, kind: "queued" }]);
    const other = await open(db, read, OTHER_USER);
    expect(other).toBe("stale");
    await expect(found.discard("none")).resolves.toBe("kept");
    await expect(found.discard(answerTag)).resolves.toBe("deleted");
    await expect(quarantinedCount()).resolves.toBe(0);
    db.close();
  });

  it("指紋が無ければ no-token、違えば stale で件を読まない", async () => {
    const { db, read, setFingerprint } = await unreadableSetup();
    setFingerprint(null);
    await expect(open(db, read)).resolves.toBe("no-token");
    setFingerprint("fp-other");
    await expect(open(db, read)).resolves.toBe("stale");
    db.close();
  });

  it("一覧の後にセッションが替わるか、途中のフラグがあると消えない", async () => {
    const { db, answerTag, read, setFingerprint } = await unreadableSetup();
    let flagged = false;
    const found = await open(db, read, USER, () => flagged);
    if (typeof found === "string") throw new Error(found);
    flagged = true;
    await expect(found.discard(answerTag)).resolves.toBe("stale");
    flagged = false;
    setFingerprint("fp-other");
    await expect(found.discard(answerTag)).resolves.toBe("stale");
    await expect(quarantinedCount()).resolves.toBe(1);
    db.close();
  });
});
