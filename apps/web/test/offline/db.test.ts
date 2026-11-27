// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { tagOf } from "../../src/offline/crypto.ts";
import { createOwner, DB_NAME, deleteDeviceDb, nextSeq, readOwner, STORE_NAMES } from "../../src/offline/db.ts";
import { freshIndexedDb, openDb, USER } from "./support.ts";

beforeEach(freshIndexedDb);

describe("端末のデータベース", () => {
  it("版 1 は 9 つの保存先を持ち、キーの行が無ければ null", async () => {
    const db = await openDb();
    expect([...db.objectStoreNames].sort()).toEqual([...STORE_NAMES].sort());
    expect(STORE_NAMES).toHaveLength(9);
    await expect(readOwner(db)).resolves.toBeNull();
    db.close();
  });

  it("持ち主を作ると利用者の ID は HMAC の値だけで残り、全保存先が移行済みになる", async () => {
    const db = await openDb();
    const row = await createOwner(db, USER);
    expect(row.ownerTag).toBe(await tagOf(row.tagKey, USER));
    expect(JSON.stringify(await db.get("keys", "main"))).not.toContain(USER);
    expect(Object.keys(row.migrated).sort()).toEqual([...STORE_NAMES].sort());
    await expect(readOwner(db)).resolves.toMatchObject({ ownerTag: row.ownerTag });
    db.close();
  });

  it("持ち主がいる間はもう 1 度作れず、前の持ち主が残る", async () => {
    const db = await openDb();
    const first = await createOwner(db, USER);
    await expect(createOwner(db, "usr_example-b")).rejects.toThrow();
    expect((await readOwner(db))?.ownerTag).toBe(first.ownerTag);
    db.close();
  });

  it("通し番号は 2 つの接続でも重ならずに増え、行を残さない", async () => {
    const [a, b] = [await openDb(), await openDb()];
    const numbers = [await nextSeq(a), await nextSeq(b), await nextSeq(a)];
    expect(numbers).toEqual([...numbers].sort((x, y) => x - y));
    expect(new Set(numbers).size).toBe(3);
    await expect(a.count("seq")).resolves.toBe(0);
    a.close();
    b.close();
  });

  it("消すときはほかの接続が versionchange で閉じて知らせる", async () => {
    let closed = 0;
    const db = await openDb(() => closed++);
    await createOwner(db, USER);
    await expect(deleteDeviceDb({ onBlocked: () => {} })).resolves.toBe("deleted");
    expect(closed).toBe(1);
    await expect(indexedDB.databases()).resolves.not.toContainEqual(expect.objectContaining({ name: DB_NAME }));
  });

  it("消せなければ failed", async () => {
    indexedDB.deleteDatabase = () => {
      throw new DOMException("example", "UnknownError");
    };
    await expect(deleteDeviceDb({ onBlocked: () => {} })).resolves.toBe("failed");
  });
});
