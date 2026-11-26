// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { tagOf } from "../../src/offline/crypto.ts";
import { createPendingStore } from "../../src/offline/pending-store.ts";
import { freshIndexedDb, openDb, signedIn } from "./support.ts";

beforeEach(freshIndexedDb);

describe("途中の記録", () => {
  it("置いて読み、平文に token が無く、同じ種類は 1 件", async () => {
    const db = await openDb();
    const { keys } = await signedIn(db);
    const store = createPendingStore({ db });
    await store.put("signout-proof", "access-example", "fp-example");
    await store.put("signout-proof", "access-example-2", "fp-example");
    await expect(store.read("signout-proof")).resolves.toEqual({
      value: "access-example-2",
      fingerprintTag: await tagOf(keys.tagKey, "fp-example"),
    });
    await expect(db.count("pending")).resolves.toBe(1);
    const [row] = await db.getAll("pending");
    expect(JSON.stringify(row) + new TextDecoder().decode(row!.data)).not.toMatch(/access-example|fp-example/);
    await expect(store.read("unlink-item")).resolves.toBeNull();
    await store.remove("signout-proof");
    await expect(store.read("signout-proof")).resolves.toBeNull();
    db.close();
  });

  it("復号できない記録は unreadable を返して残す", async () => {
    const db = await openDb();
    await signedIn(db);
    const store = createPendingStore({ db });
    await store.put("unlink-item", { idp: "example" }, "fp-example");
    await db.put("pending", { ...(await db.get("pending", "unlink-item"))!, data: new ArrayBuffer(32) });
    await expect(store.read("unlink-item")).resolves.toBe("unreadable");
    await expect(db.count("pending")).resolves.toBe(1);
    db.close();
  });
});
