// @vitest-environment node
import { defineOperation, okList } from "@nd-factory/contracts/operation";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApiSender } from "../../src/offline/api-transport.ts";
import { tagOf } from "../../src/offline/crypto.ts";
import { createSendWait, retryUntilFrom } from "../../src/offline/send-wait.ts";
import { freshIndexedDb, openDb, signedIn, USER } from "./support.ts";

beforeEach(freshIndexedDb);

const LIST = defineOperation({
  name: "projects.list",
  features: ["F1"],
  access: "read",
  delegationKind: "read",
  item: z.object({}),
  result: okList(z.object({ id: z.string() })),
  owner: "#1",
});

async function setup(over: Partial<Parameters<typeof createApiSender>[0]> = {}) {
  const db = await openDb();
  await signedIn(db);
  const calls: { url: string; auth: string | null }[] = [];
  let flagged = false;
  const times = { perf: 0, wall: 1_000_000 };
  const deps: Parameters<typeof createApiSender>[0] = {
    db,
    baseUrl: "https://api.example.invalid",
    ops: [LIST],
    flagged: () => flagged,
    session: async () => ({ accessToken: "token-a", userId: USER, fingerprint: "fp-example" }),
    memory: () => ({ userId: USER, fingerprint: "fp-example" }),
    perfNow: () => times.perf,
    wallNow: () => times.wall,
    fetch: async (url, init) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify([{ ok: true, items: [], next_cursor: null }]), {
        headers: { date: "Thu, 26 Nov 2026 00:00:00 GMT" },
      });
    },
    ...over,
  };
  const send = createApiSender(deps);
  return { db, send, calls, times, setFlag: () => void (flagged = true) };
}

const call = { name: "projects.list", items: [{}] };

describe("API への送り方", () => {
  it("照合した token をそのまま送り、状態と Date と持ち主を返す", async () => {
    const { db, send, calls } = await setup();
    const reply = await send(call);
    expect(calls).toEqual([{ url: "https://api.example.invalid/v1/projects/list", auth: "Bearer token-a" }]);
    expect(reply).toMatchObject({
      kind: "response",
      status: 200,
      date: "Thu, 26 Nov 2026 00:00:00 GMT",
      owner: { userId: USER, fingerprint: "fp-example" },
      result: { ok: true },
    });
    db.close();
  });

  it("フラグ・指紋の違いでは fetch を呼ばない", async () => {
    const flaggedCase = await setup();
    flaggedCase.setFlag();
    expect(await flaggedCase.send(call)).toEqual({ kind: "aborted", reason: "session" });
    expect(flaggedCase.calls).toEqual([]);
    flaggedCase.db.close();

    freshIndexedDb();
    const other = await setup({ session: async () => ({ accessToken: "t", userId: USER, fingerprint: "fp-other" }) });
    expect(await other.send(call)).toEqual({ kind: "aborted", reason: "session" });
    expect(other.calls).toEqual([]);
    other.db.close();
  });

  it("回の持ち主と違うセッションでは送らない", async () => {
    const { db, send, calls } = await setup();
    const reply = await send({ ...call, round: { userId: USER, fingerprint: "fp-old" } });
    expect(reply).toEqual({ kind: "aborted", reason: "session" });
    expect(calls).toEqual([]);
    db.close();
  });

  it("送る列に件が無ければ gone を返す", async () => {
    const { db, send, calls } = await setup();
    const keys = (await db.get("keys", "main"))!;
    expect(await send({ ...call, answerTag: await tagOf(keys.tagKey, "missing") })).toEqual({ kind: "aborted", reason: "gone" });
    expect(calls).toEqual([]);
    db.close();
  });

  it("時刻の読み出しから 60 秒以上たったか、端末の時刻が戻っていれば送らない", async () => {
    const { db, send, times, calls } = await setup();
    const timed = { since: { perf: 0, wall: 1_000_000 } };
    times.perf = 59_999;
    expect(await send({ ...call, timed })).toMatchObject({ kind: "response" });
    times.perf = 60_000;
    expect(await send({ ...call, timed })).toEqual({ kind: "aborted", reason: "stale-time" });
    times.perf = 0;
    times.wall = 999_999;
    expect(await send({ ...call, timed })).toEqual({ kind: "aborted", reason: "stale-time" });
    expect(calls).toHaveLength(1);
    db.close();
  });

  it("確定待ちは押してから 24 時間に達したら送らない（時刻の合わなさより先に当てる）", async () => {
    const { db, send, times, calls } = await setup();
    times.wall = 24 * 3_600_000;
    times.perf = 70_000;
    const reply = await send({ ...call, timed: { since: { perf: 0, wall: 0 } }, pressedAt: 0 });
    expect(reply).toEqual({ kind: "aborted", reason: "deadline" });
    expect(calls).toEqual([]);
    db.close();
  });

  it("本文が違う 429・503・401 でも HTTP の状態を残し、通信の失敗は network にする", async () => {
    for (const status of [401, 429, 503]) {
      freshIndexedDb();
      const { db, send } = await setup({ fetch: async () => new Response("<html>", { status, headers: { "retry-after": "5" } }) });
      expect(await send(call)).toMatchObject({ kind: "response", status, retryAfter: "5" });
      db.close();
    }
    freshIndexedDb();
    const { db, send } = await setup({
      fetch: async () => {
        throw new TypeError("offline");
      },
    });
    expect(await send(call)).toMatchObject({ kind: "network" });
    db.close();
  });
});

describe("待機の期限", () => {
  it("秒数と日付の Retry-After を端末の時刻の期限にする", () => {
    expect(retryUntilFrom("30", null, 1_000, 0)).toEqual({ retryUntil: 31_000, backoffMs: 0 });
    expect(retryUntilFrom("Thu, 26 Nov 2026 00:00:10 GMT", "Thu, 26 Nov 2026 00:00:00 GMT", 5_000, 0).retryUntil).toBe(15_000);
    expect(retryUntilFrom("Thu, 26 Nov 2026 00:00:10 GMT", null, 5_000, 0).retryUntil).toBe(Date.parse("2026-11-26T00:00:10Z"));
  });

  it("読めなければ 60 秒から 2 倍にし、15 分で止める", () => {
    expect(retryUntilFrom(null, null, 0, 0)).toEqual({ retryUntil: 60_000, backoffMs: 60_000 });
    expect(retryUntilFrom("soon", null, 0, 60_000)).toEqual({ retryUntil: 120_000, backoffMs: 120_000 });
    expect(retryUntilFrom(null, null, 0, 600_000).backoffMs).toBe(900_000);
  });

  it("後の期限だけを書き、暗号化して残し、API の時刻は後の値だけにする", async () => {
    const db = await openDb();
    const { owner } = await signedIn(db);
    const wait = createSendWait({ db });
    await wait.write({ retryUntil: 2_000, backoffMs: 60_000 });
    await wait.write({ retryUntil: 1_000, backoffMs: 0 });
    expect(await wait.read()).toEqual({ retryUntil: 2_000, backoffMs: 60_000 });
    await wait.writeApiTime(owner, 500);
    await wait.writeApiTime(owner, 400);
    expect(await wait.readApiTime()).toBe(500);
    expect(new TextDecoder().decode((await db.get("wait", "retry"))!.data)).not.toContain("2000");
    await wait.clear();
    expect(await wait.read()).toBeNull();
    db.close();
  });

  it("API の時刻は、その応答を受けたセッションが端末のログインの行に合うときだけ書く", async () => {
    const db = await openDb();
    const { owner } = await signedIn(db);
    const wait = createSendWait({ db });
    // 別のタブで入り直した後に、旧いセッションの応答の時刻が届く
    await wait.writeApiTime({ ...owner, fingerprint: "fp-other" }, 500);
    expect(await wait.readApiTime()).toBeNull();
    // 利用者の切り替えに伴う隔離の間も書かない
    const keys = (await db.get("keys", "main"))!;
    await db.put("keys", { ...keys, switching: true });
    await wait.writeApiTime(owner, 600);
    expect(await db.get("wait", "api-time")).toBeUndefined();
    db.close();
  });

  it("復号できない行は消して無いものにする", async () => {
    const db = await openDb();
    await signedIn(db);
    await db.put("wait", { id: "retry", iv: new Uint8Array(12), data: new ArrayBuffer(16) });
    expect(await createSendWait({ db }).read()).toBeNull();
    expect(await db.get("wait", "retry")).toBeUndefined();
    db.close();
  });
});
