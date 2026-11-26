// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { seal } from "../../src/offline/crypto.ts";
import { commitGuarded, prepareGuard } from "../../src/offline/guarded-commit.ts";
import { freshIndexedDb, openDb, OTHER_USER, signedIn } from "./support.ts";

beforeEach(freshIndexedDb);

async function setup() {
  const db = await openDb();
  return { db, ...(await signedIn(db)) };
}

const row = { id: "s", kind: "self", receivedAt: 1, projectTags: [], iv: new Uint8Array(12), data: new ArrayBuffer(1) };

describe("利用者の境界の照合と書き込み", () => {
  it("合えば書く", async () => {
    const { db, owner } = await setup();
    const guard = (await prepareGuard(db, owner))!;
    await expect(commitGuarded(guard, (tx) => void tx.objectStore("snapshots").put(row))).resolves.toBe("committed");
    await expect(db.count("snapshots")).resolves.toBe(1);
    db.close();
  });

  it.each([
    ["別の利用者", { userId: OTHER_USER }],
    ["別のセッション", { fingerprint: "fp-other" }],
    ["途中のフラグ", { flagged: () => true }],
  ])("%s には照合の控えを返さない", async (_, over) => {
    const { db, owner } = await setup();
    await expect(prepareGuard(db, { ...owner, ...over })).resolves.toBeNull();
    db.close();
  });

  it.each([
    ["ログインの行が書き換わる", async (s: Awaited<ReturnType<typeof setup>>) => {
      const login = (await s.db.get("login", "login"))!;
      await s.db.put("login", { ...login, ...(await seal(s.keys.key, {})) });
    }],
    ["記録が足される", async (s: Awaited<ReturnType<typeof setup>>) => {
      await s.db.put("authz", { id: "authz", ...(await seal(s.keys.key, {})) });
    }],
    ["隔離が始まる", async (s: Awaited<ReturnType<typeof setup>>) => {
      await s.db.put("keys", { ...s.keys, switching: true });
    }],
  ])("控えの後に%sと、何も書かず stale", async (_, change) => {
    const state = await setup();
    const guard = (await prepareGuard(state.db, state.owner))!;
    await change(state);
    await expect(commitGuarded(guard, (tx) => void tx.objectStore("snapshots").put(row))).resolves.toBe("stale");
    await expect(state.db.count("snapshots")).resolves.toBe(0);
    state.db.close();
  });

  it("控えの後に途中のフラグが立つか、書く側が false を返すと何も書かない", async () => {
    const { db, owner } = await setup();
    let flagged = false;
    const guard = (await prepareGuard(db, { ...owner, flagged: () => flagged }))!;
    const rejected = commitGuarded(guard, async (tx) => {
      await tx.objectStore("snapshots").put(row);
      return false;
    });
    await expect(rejected).resolves.toBe("stale");
    flagged = true;
    await expect(commitGuarded(guard, (tx) => void tx.objectStore("snapshots").put(row))).resolves.toBe("stale");
    await expect(db.count("snapshots")).resolves.toBe(0);
    db.close();
  });
});

describe("書き込みの失敗", () => {
  it("書く側が例外を投げると、何も残さず呼び出し元へ返す", async () => {
    const { db, owner } = await setup();
    const guard = (await prepareGuard(db, owner))!;
    const failed = commitGuarded(guard, async (tx) => {
      await tx.objectStore("snapshots").put(row);
      throw new DOMException("example", "QuotaExceededError");
    });
    await expect(failed).rejects.toThrow("example");
    await expect(db.count("snapshots")).resolves.toBe(0);
    db.close();
  });
});
