// @vitest-environment node
import { createClock } from "@nd-factory/core/clock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCacheStore } from "../../src/offline/cache-store.ts";
import { DB_NAME } from "../../src/offline/db.ts";
import {
  deleteDeviceData,
  forgetDeviceMemory,
  onForgetDeviceMemory,
  recordDiscardConfirmation,
  settleForSignout,
} from "../../src/offline/erase.ts";
import { commitGuarded, prepareGuard } from "../../src/offline/guarded-commit.ts";
import { createOutbox, type Draft } from "../../src/offline/outbox.ts";
import { restoreQuarantined } from "../../src/offline/quarantine.ts";
import { freshIndexedDb, openDb, signedIn, USER } from "./support.ts";

beforeEach(freshIndexedDb);

const message = (text: string): Draft => ({
  operation: "organizer_messages.create",
  targetId: "org-example",
  projectId: "p-example",
  input: { text },
});

async function seeded() {
  const db = await openDb();
  const signed = await signedIn(db);
  const outbox = createOutbox({ db, clock: createClock() });
  const confirmed = await outbox.enqueue(signed.owner, message("confirmed"));
  const kept = await outbox.enqueue(signed.owner, message("kept"));
  const cache = createCacheStore({ db, wallNow: () => 1, log: { warn: vi.fn() }, notify: () => {} });
  const guard = (await prepareGuard(db, signed.owner))!;
  await commitGuarded(guard, (await cache.prepareReplace(guard, "self", "me", {}, 1))!);
  return { db, ...signed, outbox, confirmed, kept };
}

// 同じ利用者が次にサインインしたときに戻る件の数
async function restoredAfterSignin() {
  const db = await openDb();
  await signedIn(db);
  await restoreQuarantined(db, USER);
  const tags = await db.count("outbox");
  db.close();
  return tags;
}

const databases = async () => (await indexedDB.databases()).map((d) => d.name);
const noBlock = { onBlocked: () => {} };

describe("サインアウトで消す", () => {
  it("API のキャッシュとログインのキャッシュが消え、確認した件は捨て、ほかは次のサインインで戻る", async () => {
    const { db, confirmed } = await seeded();
    await recordDiscardConfirmation(db, "signout-1", [confirmed.answerTag]);
    await settleForSignout(db, "signout-1");
    await expect(deleteDeviceData(db, "signout-1", noBlock)).resolves.toBe("deleted");
    await expect(databases()).resolves.not.toContain(DB_NAME);
    await expect(restoredAfterSignin()).resolves.toBe(1);
  });

  it("確認の記録の ID が合わなければ、すべて隔離する", async () => {
    const { db, confirmed } = await seeded();
    await recordDiscardConfirmation(db, "signout-old", [confirmed.answerTag]);
    await settleForSignout(db, "signout-2");
    await expect(deleteDeviceData(db, "signout-2", noBlock)).resolves.toBe("deleted");
    await expect(restoredAfterSignin()).resolves.toBe(2);
  });

  it("隔離し残しがあればデータベースを消さず、2. からやり直すと消せる", async () => {
    const { db, owner, outbox, confirmed, kept } = await seeded();
    await recordDiscardConfirmation(db, "s", [confirmed.answerTag, kept.answerTag]);
    await settleForSignout(db, "s");
    // 隔離の後に足した件を作る
    const keys = (await db.get("keys", "main"))!;
    await db.put("keys", { ...keys, switching: false });
    await outbox.enqueue(owner, message("late"));
    await expect(deleteDeviceData(db, "s", noBlock)).resolves.toBe("failed");
    await expect(databases()).resolves.toContain(DB_NAME);
    await settleForSignout(db, "s");
    await expect(deleteDeviceData(db, "s", noBlock)).resolves.toBe("deleted");
    await expect(restoredAfterSignin()).resolves.toBe(1);
  });

  it("メモリの破棄は、登録した持ち手を何度でも呼ぶ", () => {
    const forget = vi.fn();
    const remove = onForgetDeviceMemory(forget);
    forgetDeviceMemory();
    forgetDeviceMemory();
    remove();
    forgetDeviceMemory();
    expect(forget).toHaveBeenCalledTimes(2);
  });
});
