// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { createSender } from "../../src/offline/send.ts";
import { createSync, type ListResult, type ScreenRead, type SyncDeps } from "../../src/offline/sync.ts";
import { denied, NOW, OPS, sendSetup } from "./send-support.ts";
import { freshIndexedDb } from "./support.ts";

beforeEach(freshIndexedDb);

const found = <T>(items: T[]): ListResult<T> => ({ kind: "ok", items });
const empty: ScreenRead = { kind: "ok", snapshots: [], lists: [], missing: [] };

async function setup() {
  const t = await sendSetup();
  const order: string[] = [];
  const logs: unknown[] = [];
  let online = true;
  const listeners = new Set<() => void>();
  const timers: { fn: () => void; ms: number }[] = [];
  const visibility = new Set<() => void>();
  const readers: SyncDeps["readers"] = {
    projects: async () => (order.push("projects"), found([{ id: "p-example", teamId: "t-a" }])),
    teams: async () => (order.push("teams"), found([{ id: "t-a" }])),
    transfers: async () => (order.push("transfers"), found([{ id: "tr-1" }])),
    screen: async () => (order.push("screen"), empty),
    lists: async () => (order.push("lists"), empty),
    target: async () => "temporary",
  };
  const log = {
    info: (message: string, fields?: unknown) => void logs.push([message, fields]),
    warn: (message: string, fields?: unknown) => void logs.push([message, fields]),
  };
  const sender = createSender({
    db: t.db,
    outbox: t.outbox,
    wait: t.wait,
    cache: t.cache,
    send: t.sender,
    ops: OPS,
    perfNow: () => t.state.perf,
    wallNow: () => t.state.wall,
    log,
    notify: () => {},
  });
  const sync = createSync({
    db: t.db,
    outbox: t.outbox,
    wait: t.wait,
    cache: t.cache,
    sender,
    readers,
    ops: OPS,
    owner: () => t.owner,
    connectivity: {
      online: () => online,
      subscribe: (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
    },
    document: {
      visibilityState: "visible",
      addEventListener: (_type: string, fn: () => void) => void visibility.add(fn),
      removeEventListener: (_type: string, fn: () => void) => void visibility.delete(fn),
    } as unknown as SyncDeps["document"],
    timers: {
      setInterval: (fn, ms) => timers.push({ fn, ms }),
      clearInterval: () => void (timers.length = 0),
    },
    wallNow: () => t.state.wall,
    log,
    notify: () => {},
    onAuth: () => {},
    onEvent: () => {},
  });
  const held = async () => (await t.db.getAll("held")).map((r) => r.holdReason);
  return { ...t, sync, readers, order, logs, timers, listeners, visibility, held, setOnline: (v: boolean) => void (online = v) };
}

const accept = { transfer: { teamId: "t-new", transferId: "tr-1" }, projectId: "p-new" };

describe("そろえ方", () => {
  it("段 1、段 2、段 3、段 4 の順に打つ", async () => {
    const t = await setup();
    await t.enqueue("questions.answer");
    t.replies.push(() => void t.order.push("send"));
    expect(await t.sync.runOnce()).toMatchObject({ kind: "done", sent: "done", reloadFailedAt: null });
    expect(t.order).toEqual(["projects", "teams", "send", "screen", "lists"]);
    t.db.close();
  });

  it("つながっていなければ確定待ちを送らず、つながった後に送る", async () => {
    const t = await setup();
    await t.enqueue("questions.answer");
    t.setOnline(false);
    expect(await t.sync.runOnce()).toEqual({ kind: "offline" });
    expect(t.requests).toEqual([]);
    expect(await t.db.count("outbox")).toBe(1);
    t.setOnline(true);
    await t.sync.runOnce();
    expect(await t.db.count("outbox")).toBe(0);
    t.db.close();
  });

  it("projects.list を読み切れなければ、何も消さず送らない", async () => {
    const t = await setup();
    await t.enqueue("questions.answer", "q", { projectId: "p-other" });
    t.readers.projects = async () => ({ kind: "temporary" });
    expect(await t.sync.runOnce()).toMatchObject({ kind: "failed", reloadFailedAt: NOW });
    expect(await t.db.count("outbox")).toBe(1);
    expect(t.writes()).toEqual([]);
    t.db.close();
  });

  it("見られなくなったプロジェクトの件は送らず保留に移し、場所の一覧を置き換える", async () => {
    const t = await setup();
    await t.enqueue("questions.answer", "q", { projectId: "p-lost" });
    await t.sync.runOnce();
    expect(t.writes()).toEqual([]);
    expect(await t.held()).toEqual(["revoked"]);
    expect((await t.cache.read("places", "places"))?.value).toEqual({
      teams: [{ id: "t-a" }],
      projects: [{ project_id: "p-example", team_id: "t-a" }],
    });
    t.db.close();
  });

  it("受け入れは、受け入れ待ちに移行があれば送り、無ければ保留にする", async () => {
    const t = await setup();
    await t.enqueue("projects.close", "kept", accept);
    await t.enqueue("projects.close", "gone", { ...accept, transfer: { teamId: "t-new", transferId: "tr-gone" } });
    await t.sync.runOnce();
    expect(t.writes().map((r) => (r.items[0] as { text: string }).text)).toEqual(["kept"]);
    expect(await t.held()).toEqual(["transfer-unavailable"]);
    t.db.close();
  });

  it("受け入れ待ちの一覧が一時の失敗なら件を残して送らず、403 ならチームの表示を保留する", async () => {
    const t = await setup();
    await t.enqueue("projects.close", "a", accept);
    t.readers.transfers = async () => ({ kind: "temporary" });
    expect(await t.sync.runOnce()).toMatchObject({ sent: "skipped" });
    expect(await t.db.count("outbox")).toBe(1);

    t.readers.transfers = async () => ({ kind: "denied" });
    await t.sync.runOnce();
    expect(await t.held()).toEqual(["transfer-unavailable"]);
    const { unseal } = await import("../../src/offline/crypto.ts");
    const record = await unseal<{ denied: { id: string }[] }>(t.keys.key, (await t.db.get("authz", "authz"))!);
    expect(record.denied.map((d) => d.id)).toContain("t-new");
    t.db.close();
  });

  it("待機の期限までは段 2 だけを打たない", async () => {
    const t = await setup();
    await t.enqueue("questions.answer");
    await t.wait.write({ retryUntil: NOW + 1, backoffMs: 0 });
    expect(await t.sync.runOnce()).toMatchObject({ sent: "skipped" });
    expect(t.order).toEqual(["projects", "teams", "screen", "lists"]);
    t.state.wall = NOW + 1;
    expect(await t.sync.runOnce()).toMatchObject({ sent: "done" });
    t.db.close();
  });

  it("錠を取れない回は何もせず、フラグがあれば読まない", async () => {
    const t = await setup();
    await navigator.locks.request("nd-sync", async () => {
      expect(await t.sync.runOnce()).toEqual({ kind: "busy" });
    });
    t.state.flagged = true;
    expect(await t.sync.runOnce()).toEqual({ kind: "flagged" });
    expect(t.order).toEqual([]);
    t.db.close();
  });

  it("読めた写しに、送る列に残るキャッシュして送るの件を重ねて書き、返らない行を消す", async () => {
    const t = await setup();
    await t.enqueue("users.update", "me", { projectId: null, input: { name: "new" } });
    t.replies.push(() => new TypeError("offline"));
    t.readers.screen = async () => ({
      ...empty,
      kind: "ok",
      snapshots: [{ kind: "self", targetId: "me", value: { name: "old" } }],
    });
    await t.sync.runOnce();
    expect((await t.cache.read("self", "me"))?.value).toEqual({ name: "new" });
    t.db.close();
  });

  it("アイテムの 404 は 1 件の写しを消して表示を保留し、一覧を読み直して確かめる", async () => {
    const t = await setup();
    t.readers.screen = async () => ({
      kind: "ok",
      snapshots: [{ kind: "sprint", targetId: "s1", value: { project_id: "p-example" } }],
      lists: [],
      missing: [],
    });
    await t.sync.runOnce();
    t.order.length = 0;
    t.readers.screen = async () => ({
      kind: "ok",
      snapshots: [],
      lists: [],
      missing: [{ kind: "sprint", targetId: "s1", projectId: "p-example" }],
    });
    await t.sync.runOnce();
    expect(await t.cache.read("sprint", "s1")).toBeNull();
    expect(t.order.filter((name) => name === "projects")).toHaveLength(2);
    t.db.close();
  });

  it("拒まれたキャッシュして送るの対象を読み直せなければ、写しを消す", async () => {
    const t = await setup();
    t.readers.screen = async () => ({ ...empty, kind: "ok", snapshots: [{ kind: "self", targetId: "me", value: { name: "x" } }] });
    await t.sync.runOnce();
    t.readers.screen = async () => ({ kind: "temporary" });
    t.readers.target = async () => ({ kind: "self", targetId: "me", value: null });
    await t.enqueue("users.update", "me", { projectId: null });
    t.replies.push(() => denied(409, "state_mismatch"));
    await t.sync.runOnce();
    expect(await t.cache.read("self", "me")).toBeNull();
    t.db.close();
  });

  it("開いたとき・つながったとき・見えるようになったとき・30 秒ごとに起こし、止められる", async () => {
    const t = await setup();
    const stop = t.sync.start();
    expect(t.timers.map((timer) => timer.ms)).toEqual([30_000]);
    expect(t.listeners.size).toBe(1);
    expect(t.visibility.size).toBe(1);
    await t.sync.idle();
    t.order.length = 0;
    t.timers[0]!.fn();
    await t.sync.idle();
    expect(t.order[0]).toBe("projects");
    stop();
    expect([t.timers.length, t.listeners.size, t.visibility.size]).toEqual([0, 0, 0]);
    t.db.close();
  });

  it("ログに ID と入力を出さない", async () => {
    const t = await setup();
    await t.enqueue("questions.answer", "secret-input");
    t.replies.push(() => denied(409, "state_mismatch"));
    await t.sync.runOnce();
    const text = JSON.stringify(t.logs);
    expect(t.logs.length).toBeGreaterThan(0);
    for (const secret of ["secret-input", "p-example", "target-example", "token-a", "usr_example-a"]) {
      expect(text).not.toContain(secret);
    }
    t.db.close();
  });
});
