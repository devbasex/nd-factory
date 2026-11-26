// @vitest-environment node
import { createClock } from "@nd-factory/core/clock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceView, type DeviceViewDeps } from "../../src/app/device-view.ts";
import type { ListResult, ScreenRead } from "../../src/offline/sync.ts";
import { NOW, OPS, sendSetup } from "./send-support.ts";
import { freshIndexedDb } from "./support.ts";

// 画面と端末のデータをつなぐ部品。押す・送る・確定と食い違い・取り下げ・保留の件数を、画面が読む形で確かめる

beforeEach(freshIndexedDb);

const found = <T>(items: T[]): ListResult<T> => ({ kind: "ok", items });
const empty: ScreenRead = { kind: "ok", snapshots: [], lists: [], missing: [] };

async function setup({ apiTime = NOW as number | null } = {}) {
  const t = await sendSetup();
  // 前に受けた API の Date。押したときの期限の下限になる
  if (apiTime !== null) await t.wait.writeApiTime(apiTime);
  let online = true;
  const listeners = new Set<() => void>();
  const channel = new Set<() => void>();
  const posted: number[] = [];
  const deps: DeviceViewDeps = {
    db: t.db,
    clock: { ...createClock(), epochMs: () => t.state.wall },
    perfNow: () => t.state.perf,
    owner: t.owner,
    send: t.sender,
    ops: OPS,
    readers: {
      projects: async () => found([{ id: "p-example", teamId: "t-a" }]),
      teams: async () => found([{ id: "t-a" }]),
      transfers: async () => found([]),
      screen: async () => empty,
      lists: async () => empty,
      target: async () => "temporary",
    },
    connectivity: {
      online: () => online,
      subscribe: (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
    },
    document: { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} },
    timers: { setInterval: () => 1, clearInterval: () => {} },
    channel: {
      post: () => void posted.push(1),
      subscribe: (fn) => (channel.add(fn), () => void channel.delete(fn)),
    },
    log: { info: () => {}, warn: () => {} },
    onAuth: () => {},
    onStale: () => {},
  };
  const view = createDeviceView(deps);
  const draft = (targetId: string, operation = "questions.answer") => ({
    operation,
    targetId,
    projectId: "p-example",
    input: { text: targetId },
    check: { version: 3 },
  });
  const connect = async (value: boolean) => {
    online = value;
    for (const fn of listeners) fn();
    await view.idle();
  };
  return { ...t, view, draft, connect, channel };
}

describe("画面と端末のデータ", () => {
  it("つながっていないときに押すと確定待ちになり、送らず、確定と出さない。期限は押してから 24 時間", async () => {
    const t = await setup();
    const stop = t.view.start();
    await t.connect(false);
    await t.view.press(t.draft("q-1"));
    await t.view.idle();
    expect(t.writes()).toEqual([]);
    expect(t.view.snapshot().pending).toMatchObject([
      { targetId: "q-1", operation: "questions.answer", deadline: new Date(NOW + 24 * 3600_000).toISOString() },
    ]);
    expect(t.view.snapshot().results).toEqual([]);
    stop();
    t.db.close();
  });

  it("つながった後に読んだときの version を付けて送り、確定と出して確定待ちから消す", async () => {
    const t = await setup();
    const stop = t.view.start();
    await t.connect(false);
    await t.view.press(t.draft("q-1"));
    await t.connect(true);
    expect(t.writes()).toMatchObject([{ name: "questions.answer", items: [{ id: "q-1", version: 3 }] }]);
    expect(t.view.snapshot().pending).toEqual([]);
    expect(t.view.snapshot().results).toMatchObject([{ kind: "confirmed", targetId: "q-1" }]);
    stop();
    t.db.close();
  });

  it("状態が変わっていれば食い違いを出し、保留の件数に入れる", async () => {
    const t = await setup();
    const stop = t.view.start();
    await t.connect(false);
    await t.view.press(t.draft("q-1"));
    t.replies.push(() => new Response(JSON.stringify([{ ok: false, status: 409, reason: "state_mismatch" }])));
    await t.connect(true);
    expect(t.view.snapshot().results).toMatchObject([{ kind: "rejected", targetId: "q-1", reason: "state_mismatch" }]);
    expect(t.view.snapshot().held).toBe(1);
    expect((await t.view.heldStore.list())[0]?.body?.input).toEqual({ text: "q-1" });
    expect(await t.view.readRecord()).toMatchObject({ allowedProjectIds: ["p-example"] });
    stop();
    t.db.close();
  });

  it("キャッシュして送るは、つながった後に押した順で送る", async () => {
    const t = await setup();
    const stop = t.view.start();
    await t.connect(false);
    for (const id of ["n-1", "n-2", "n-3"]) await t.view.press(t.draft(id, "notices.mark_read"));
    expect(t.view.snapshot().queued).toBe(3);
    await t.connect(true);
    expect(t.writes().map((r) => r.items[0]?.["id"])).toEqual(["n-1", "n-2", "n-3"]);
    expect(t.view.snapshot().queued).toBe(0);
    stop();
    t.db.close();
  });

  it("つながっているときに押すと、30 秒を待たずに送る", async () => {
    const t = await setup();
    await t.view.press(t.draft("q-1"));
    await t.view.idle();
    expect(t.writes()).toHaveLength(1);
    t.db.close();
  });

  it("API の Date を一度も受けていない端末で押した確定待ちは、送らずに期限切れの保留にする", async () => {
    const t = await setup({ apiTime: null });
    const stop = t.view.start();
    await t.connect(false);
    await t.view.press(t.draft("q-1"));
    await t.connect(true);
    expect(t.writes()).toEqual([]);
    expect(t.view.snapshot().results).toMatchObject([{ kind: "expired", targetId: "q-1" }]);
    expect(t.view.snapshot().held).toBe(1);
    stop();
    t.db.close();
  });

  it("取り下げた確定待ちは送らない", async () => {
    const t = await setup();
    const stop = t.view.start();
    await t.connect(false);
    await t.view.press(t.draft("q-1"));
    await t.view.withdraw(t.view.snapshot().pending[0]!.answerTag);
    expect(t.view.snapshot().pending).toEqual([]);
    await t.connect(true);
    expect(t.writes()).toEqual([]);
    stop();
    t.db.close();
  });

  it("保存できなければ保存の失敗を出し、先に進まない", async () => {
    const t = await setup();
    await t.view.press(t.draft("x", "teams.create"));
    expect(t.view.snapshot().results).toMatchObject([{ kind: "save-failed", targetId: "x" }]);
    expect(t.writes()).toEqual([]);
    t.db.close();
  });

  it("ほかのタブの知らせで読み直し、購読者へ知らせる", async () => {
    const t = await setup();
    const stop = t.view.start();
    await t.connect(false);
    await t.view.idle();
    const heard = vi.fn();
    t.view.subscribe(heard);
    // ほかのタブが足した件
    await t.outbox.enqueue(t.owner, t.draft("q-other"));
    for (const fn of t.channel) fn();
    await vi.waitFor(() => expect(t.view.snapshot().pending).toHaveLength(1));
    expect(heard).toHaveBeenCalled();
    stop();
    expect(t.channel.size).toBe(0);
    t.db.close();
  });
});
