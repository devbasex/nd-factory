import type { OperationDef } from "@nd-factory/contracts/operation";
import type { Clock } from "@nd-factory/core/clock";
import type { Logger } from "@nd-factory/core/log";
import type { ApiSender, SessionOwner } from "../offline/api-transport.ts";
import { DEADLINE_MS } from "../offline/api-transport.ts";
import { type AuthzRecord, withAuthzLock } from "../offline/authz.ts";
import { createCacheStore } from "../offline/cache-store.ts";
import type { Connectivity } from "../offline/connectivity.ts";
import { unseal } from "../offline/crypto.ts";
import { type DeviceDb, readOwner } from "../offline/db.ts";
import type { Owner } from "../offline/guarded-commit.ts";
import { createHeldStore, type HeldStore } from "../offline/held-store.ts";
import { createOutbox, type Draft } from "../offline/outbox.ts";
import { unreadableQuarantine } from "../offline/quarantine.ts";
import { createSender, type SendEvent } from "../offline/send.ts";
import { createSendWait } from "../offline/send-wait.ts";
import { createSync, type SyncDeps, type SyncReaders } from "../offline/sync.ts";

// 画面と端末のデータをつなぐ。送る列・そろえ方を組み、画面が出す確定待ち・保留の件数・操作の結果を 1 つの値にする

type Quarantined = Extract<Awaited<ReturnType<typeof unreadableQuarantine>>, object>;

type PendingEntry = { answerTag: string; operation: string; targetId: string; deadline: string };

type ResultEntry = {
  // 画面の並びの鍵
  key: number;
  kind: SendEvent["kind"] | "save-failed";
  operation: string;
  targetId: string;
  reason?: string;
};

export type DeviceSnapshot = {
  pending: readonly PendingEntry[];
  // 送る列にあるキャッシュして送るの件の数
  queued: number;
  // 保留の件と、持ち主の読めない隔離の件の数
  held: number;
  quarantined: Quarantined | null;
  results: readonly ResultEntry[];
};

export const EMPTY_DEVICE: DeviceSnapshot = { pending: [], queued: 0, held: 0, quarantined: null, results: [] };

export type DeviceViewDeps = {
  db: DeviceDb;
  clock: Clock;
  // 送り方と同じ単調な時計を渡す
  perfNow: () => number;
  owner: Owner;
  send: ApiSender;
  ops?: readonly OperationDef[];
  readers: SyncReaders;
  connectivity: Connectivity;
  document: SyncDeps["document"];
  timers: SyncDeps["timers"];
  // タブをまたぐ知らせ。中身は載せない
  channel: { post(): void; subscribe(listener: () => void): () => void };
  log: Pick<Logger, "info" | "warn">;
  onAuth: (owner: SessionOwner) => void;
  // このタブの利用者かセッションが替わっていた。起動の照合からやり直す
  onStale: () => void;
};

export type DeviceView = {
  snapshot(): DeviceSnapshot;
  subscribe(listener: () => void): () => void;
  start(): () => void;
  refresh(): Promise<void>;
  press(draft: Draft): Promise<void>;
  withdraw(answerTag: string): Promise<void>;
  heldStore: HeldStore;
  readRecord(): Promise<AuthzRecord | null>;
  stale(): void;
  /** @internal 起こした回と読み直しが終わるのを待つ */
  idle(): Promise<void>;
};

const RESULT_LIMIT = 5;

export function createDeviceView(d: DeviceViewDeps): DeviceView {
  const { db, log, owner } = d;
  const wallNow = () => d.clock.epochMs();
  const listeners = new Set<() => void>();
  let state = EMPTY_DEVICE;
  let sequence = 0;
  // 送った件の対象。結果の知らせは対象の ID を持たないので、読んだ件から引く
  const targets = new Map<string, string>();

  const publish = (next: Partial<DeviceSnapshot>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const addResult = (entry: Omit<ResultEntry, "key">) =>
    publish({ results: [{ key: ++sequence, ...entry }, ...state.results].slice(0, RESULT_LIMIT) });

  const outbox = createOutbox({ db, clock: d.clock });
  const wait = createSendWait({ db });
  const cache = createCacheStore({ db, wallNow, log, notify: () => d.channel.post() });
  const heldStore = createHeldStore({ db });

  // このタブが最後に受けた API の Date と、受けた時点
  let lastDate: { ms: number; since: number } | null = null;
  const send: ApiSender = async (call) => {
    const reply = await d.send(call);
    const ms = reply.kind === "response" && reply.date !== null ? Date.parse(reply.date) : Number.NaN;
    if (!Number.isNaN(ms)) lastDate = { ms, since: d.perfNow() };
    return reply;
  };

  // 実際に押した時刻より後にならない API の時刻。どちらも無ければ空で、確定待ちは送らない
  async function pressedFloor(): Promise<number | null> {
    const stored = await wait.readApiTime();
    const inTab = lastDate === null ? null : lastDate.ms + (d.perfNow() - lastDate.since);
    const known = [stored, inTab].filter((ms) => ms !== null);
    return known.length === 0 ? null : Math.floor(Math.max(...known));
  }

  async function reread(): Promise<void> {
    const { items } = await outbox.readBatch();
    for (const item of items) targets.set(item.answerTag, item.targetId);
    const found = await unreadableQuarantine(db, owner.userId, () => owner.fingerprint, owner.flagged);
    if (found === "stale") d.onStale();
    const quarantined = typeof found === "string" ? null : found;
    const held = (await heldStore.count()) + (quarantined?.items.length ?? 0);
    publish({
      pending: items
        .filter((item) => item.kind === "confirm")
        .map(({ answerTag, operation, targetId, pressedAt }) => ({
          answerTag,
          operation,
          targetId,
          deadline: new Date(pressedAt + DEADLINE_MS).toISOString(),
        })),
      queued: items.filter((item) => item.kind === "queued").length,
      held,
      quarantined,
    });
  }

  // 読み直しは 1 つずつ行う。後に始めた読み直しが、先の古い結果で上書きされないようにする
  let reading: Promise<void> = Promise.resolve();
  const refresh = (): Promise<void> => {
    reading = reading.then(reread).catch((error: unknown) => {
      log.warn("端末のデータを読めない", { error: error instanceof Error ? error.name : "unknown" });
    });
    return reading;
  };

  const notify = () => {
    d.channel.post();
    void refresh();
  };

  const sender = createSender({
    db,
    outbox,
    wait,
    cache,
    send,
    ops: d.ops,
    perfNow: d.perfNow,
    wallNow,
    log,
    notify,
  });
  const sync = createSync({
    db,
    outbox,
    wait,
    cache,
    sender,
    readers: d.readers,
    ops: d.ops,
    owner: () => owner,
    connectivity: d.connectivity,
    document: d.document,
    timers: d.timers,
    wallNow,
    log,
    notify,
    onAuth: d.onAuth,
    onEvent: ({ kind, answerTag, operation, reason }) =>
      addResult({ kind, operation, targetId: targets.get(answerTag) ?? "", reason }),
    onRound: () => void refresh(),
  });

  let sending: Promise<void> = Promise.resolve();
  // つながっている間に押した件は、次の起動の元を待たずに送る。ほかの回が通していれば何もしない
  const sendNow = () => {
    sending = sync.runOnce().then(
      () => {},
      (error: unknown) => log.warn("そろえ方の回が失敗した", { error: error instanceof Error ? error.name : "unknown" }),
    );
  };

  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    start() {
      const unsubscribe = d.channel.subscribe(() => void refresh());
      const stop = sync.start();
      void refresh();
      return () => {
        unsubscribe();
        stop();
      };
    },
    refresh,
    async press(draft) {
      try {
        const item = await outbox.enqueue(owner, { ...draft, pressedFloor: await pressedFloor() });
        targets.set(item.answerTag, item.targetId);
      } catch (error) {
        log.warn("操作を保存できない", { operation: draft.operation, error: error instanceof Error ? error.name : "unknown" });
        addResult({ kind: "save-failed", operation: draft.operation, targetId: draft.targetId });
        return;
      }
      await refresh();
      d.channel.post();
      if (d.connectivity.online()) sendNow();
    },
    async withdraw(answerTag) {
      await sender.withdraw(owner, answerTag);
      await refresh();
      d.channel.post();
    },
    heldStore,
    // 画面へ反映する側は shared の錠で読む
    readRecord: () =>
      withAuthzLock("shared", async () => {
        const keys = await readOwner(db);
        const row = await db.get("authz", "authz");
        if (keys === null || row === undefined) return null;
        return unseal<AuthzRecord>(keys.key, row).catch(() => null);
      }),
    stale: () => d.onStale(),
    async idle() {
      await sending;
      await sync.idle();
      await reading;
    },
  };
}
