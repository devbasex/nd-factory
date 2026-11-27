// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { seal, unseal } from "../../src/offline/crypto.ts";
import { createOwner, type DeviceDb, type KeyRow, readOwner } from "../../src/offline/db.ts";
import { type MigrationPlan, runMigrations } from "../../src/offline/migrate.ts";
import { freshIndexedDb, openDb, USER } from "./support.ts";

beforeEach(freshIndexedDb);

type Body = { v: number; text: string; sendStarted?: boolean };

// 版 2 への移行の作り物。text が "broken" の値は移せない
const toV2 = (value: unknown) => {
  const body = value as Body;
  if (body.text === "broken") throw new TypeError("example");
  return { ...body, v: 2 };
};
const PLAN: MigrationPlan = { version: 2, convert: { outbox: toV2, login: toV2, pending: toV2, wait: toV2, authz: toV2 } };

async function seed(): Promise<{ db: DeviceDb; owner: KeyRow }> {
  const db = await openDb();
  const owner = await createOwner(db, USER);
  return { db, owner };
}

const sealed = (owner: KeyRow, text: string, extra: Partial<Body> = {}) => seal(owner.key, { v: 1, text, ...extra });

async function putOutbox(db: DeviceDb, owner: KeyRow, answerTag: string, text: string, extra: Partial<Body> = {}) {
  await db.put("outbox", { answerTag, targetTag: `t-${answerTag}`, kind: "confirm", ...(await sealed(owner, text, extra)) });
}

describe("版の上げ", () => {
  it("今の版のままなら行を書き換えない", async () => {
    const { db, owner } = await seed();
    await putOutbox(db, owner, "a", "keep");
    const before = await db.get("outbox", "a");
    await runMigrations(db, {});
    await expect(db.get("outbox", "a")).resolves.toEqual(before);
    db.close();
  });

  it("移せる件は送る列に残り、移せない件は暗号文のまま保留へ移る", async () => {
    const { db, owner } = await seed();
    await putOutbox(db, owner, "ok", "keep");
    await putOutbox(db, owner, "ng", "broken");
    await putOutbox(db, owner, "sent", "broken", { sendStarted: true });
    await db.put("outbox", { answerTag: "garbled", targetTag: "t", kind: "queued", iv: new Uint8Array(12), data: new ArrayBuffer(32) });
    const original = await db.get("outbox", "ng");

    await runMigrations(db, { plan: PLAN });

    expect((await db.getAllKeys("outbox")).sort()).toEqual(["ok"]);
    const moved = (await db.get("outbox", "ok"))!;
    await expect(unseal(owner.key, moved)).resolves.toMatchObject({ v: 2, text: "keep" });
    await expect(db.get("held", "ng")).resolves.toEqual({ ...original, holdReason: "unmigrated" });
    await expect(db.get("held", "sent")).resolves.toMatchObject({ holdReason: "unknown-result" });
    await expect(db.get("held", "garbled")).resolves.toMatchObject({ holdReason: "unmigrated" });
    expect((await readOwner(db))?.migrated.outbox).toBe(2);
    db.close();
  });

  it("写しは移さずに消し、移せないログインと待機の行も消す。移せない途中の記録は残す", async () => {
    const { db, owner } = await seed();
    await db.put("snapshots", { id: "s", kind: "self", receivedAt: 1, projectTags: [], ...(await sealed(owner, "x")) });
    await db.put("login", { id: "login", userTag: "u", fingerprintTag: "f", ...(await sealed(owner, "broken")) });
    await db.put("pending", { id: "signout-proof", fingerprintTag: "f", ...(await sealed(owner, "broken")) });
    await db.put("wait", { id: "retry", ...(await sealed(owner, "broken")) });

    await runMigrations(db, { plan: PLAN });

    await expect(db.count("snapshots")).resolves.toBe(0);
    await expect(db.count("login")).resolves.toBe(0);
    await expect(db.count("wait")).resolves.toBe(0);
    await expect(db.count("pending")).resolves.toBe(1);
    db.close();
  });

  it("見られるプロジェクトの記録を移せなければ、記録と写しを一緒に消す", async () => {
    const { db, owner } = await seed();
    await db.put("authz", { id: "authz", ...(await sealed(owner, "broken")) });
    await db.put("snapshots", { id: "s", kind: "self", receivedAt: 1, projectTags: [], ...(await sealed(owner, "x")) });

    await runMigrations(db, { plan: PLAN, only: ["authz"] });

    await expect(db.count("authz")).resolves.toBe(0);
    await expect(db.count("snapshots")).resolves.toBe(0);
    expect((await readOwner(db))?.migrated).toMatchObject({ authz: 2, snapshots: 2, outbox: 1 });
    db.close();
  });

  it("only の保存先だけを移し、後の起動で残りを続きから移す", async () => {
    const { db, owner } = await seed();
    await db.put("login", { id: "login", userTag: "u", fingerprintTag: "f", ...(await sealed(owner, "login")) });
    await putOutbox(db, owner, "a", "keep");
    const outboxBefore = await db.get("outbox", "a");

    await runMigrations(db, { plan: PLAN, only: ["pending", "login"] });
    await expect(db.get("outbox", "a")).resolves.toEqual(outboxBefore);
    const login = (await db.get("login", "login"))!;
    expect(login).toMatchObject({ userTag: "u", fingerprintTag: "f" });

    await runMigrations(db, { plan: PLAN });
    // 移し終えた保存先は書き直さない
    await expect(db.get("login", "login")).resolves.toEqual(login);
    await expect(unseal(owner.key, (await db.get("outbox", "a"))!)).resolves.toMatchObject({ v: 2 });
    db.close();
  });

  it("2 つの接続で同時に移しても、各行は 1 回だけ移り件は減らない", async () => {
    const { db, owner } = await seed();
    const other = await openDb();
    await putOutbox(db, owner, "a", "keep");
    await putOutbox(db, owner, "b", "broken");
    const twice: MigrationPlan = {
      version: 2,
      convert: {
        outbox: (value) => {
          if ((value as Body).v !== 1) throw new TypeError("2 回目の移行");
          return toV2(value);
        },
      },
    };

    await Promise.all([runMigrations(db, { plan: twice }), runMigrations(other, { plan: twice })]);

    await expect(db.getAllKeys("outbox")).resolves.toEqual(["a"]);
    await expect(db.getAllKeys("held")).resolves.toEqual(["b"]);
    db.close();
    other.close();
  });

  it("持ち主がいなければ何もしない", async () => {
    const db = await openDb();
    await expect(runMigrations(db, { plan: PLAN })).resolves.toBeUndefined();
    db.close();
  });
});
