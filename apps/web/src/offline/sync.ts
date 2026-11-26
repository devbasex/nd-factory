import type { OperationDef } from "@nd-factory/contracts/operation";
import { OPERATIONS } from "@nd-factory/contracts/operations";
import type { Logger } from "@nd-factory/core/log";
import { addDenied, type ListsRead } from "./authz.ts";
import type { SessionOwner } from "./api-transport.ts";
import type { CacheStore } from "./cache-store.ts";
import type { Connectivity } from "./connectivity.ts";
import { type DeviceDb, nextSeq } from "./db.ts";
import { commitGuarded, type Guard, type Owner, prepareGuard } from "./guarded-commit.ts";
import { operationClassOf } from "./operation-classes.ts";
import type { Outbox, OutboxItem } from "./outbox.ts";
import { applyRevocation, holdDenied, planRevocation, readLocalIndex } from "./revocation.ts";
import type { QueueSender, Round, SendEvent } from "./send.ts";
import type { SendWait } from "./send-wait.ts";
import type { SnapshotKind } from "./snapshot-kinds.ts";

// そろえ方の起動と段の順（#12 の設計書の「処理の流れ」）。段 1 で見られる範囲をそろえ、段 2 で送り、段 3〜5 で読み直す

const RELOAD_INTERVAL_MS = 30_000;
const SYNC_LOCK = "nd-sync";

// 一覧は全ページを読み終えた結果にする
/** @internal */
export type ListResult<T> = { kind: "ok"; items: T[] } | { kind: "denied" } | { kind: "temporary" } | { kind: "auth" };

type Snapshot = { kind: SnapshotKind; targetId: string; value: unknown };

/** @internal */
export type ScreenRead =
  | {
      kind: "ok";
      snapshots: Snapshot[];
      // 全ページ読めた一覧。返らなかった行を消す
      lists: { scope: { kind: SnapshotKind; projectId: string }; ids: string[] }[];
      // アイテムの 404 を受けた対象
      missing: { kind: SnapshotKind; targetId: string; projectId: string }[];
    }
  | { kind: "temporary" }
  | { kind: "auth" };

// 読み出しの形は操作を持つ課題が決めるので、関数で受け取る
export type SyncReaders = {
  projects(owner: Owner): Promise<ListResult<{ id: string; teamId: string }>>;
  teams(owner: Owner): Promise<ListResult<{ id: string }>>;
  transfers(owner: Owner, teamId: string): Promise<ListResult<{ id: string }>>;
  screen(owner: Owner): Promise<ScreenRead>;
  lists(owner: Owner): Promise<ScreenRead>;
  // 件の対象の 1 件。value が null なら写しの対象だけを返す（読み直せなかった）
  target(owner: Owner, item: OutboxItem): Promise<Snapshot | "temporary" | null>;
};

type RoundReport =
  | { kind: "busy" | "flagged" | "offline" | "no-owner" }
  | { kind: "done" | "stopped" | "failed"; sent: "done" | "stopped" | "skipped"; reloadFailedAt: number | null };

export type SyncDeps = {
  db: DeviceDb;
  outbox: Outbox;
  wait: SendWait;
  cache: CacheStore;
  sender: QueueSender;
  readers: SyncReaders;
  ops?: readonly OperationDef[];
  // このタブのメモリの利用者とセッション
  owner: () => Owner | null;
  // 送る列のキャッシュして送るの件を、読み直した値へ重ねる。無ければ入力の項目を上書きする
  overlay?: (item: OutboxItem, value: unknown) => unknown;
  connectivity: Connectivity;
  document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  timers: { setInterval(fn: () => void, ms: number): number; clearInterval(id: number): void };
  wallNow: () => number;
  log: Pick<Logger, "info" | "warn">;
  // 記録が新しくなったことを全タブへ知らせる
  notify: () => void;
  onAuth: (owner: SessionOwner) => void;
  onEvent: (event: SendEvent) => void;
  // 回を通し終えた。画面は端末のデータを読み直す
  onRound?: () => void;
};

export type Sync = {
  start(): () => void;
  runOnce(): Promise<RoundReport>;
  /** @internal 起こした回が終わるのを待つ */
  idle(): Promise<void>;
};

// 回を止める理由
class Stop extends Error {
  override name = "Stop";
}

export function createSync(d: SyncDeps): Sync {
  const idempotentOf = (operation: string) =>
    (d.ops ?? (OPERATIONS as readonly OperationDef[])).some((op) => op.name === operation && op.idempotencyKey);

  const overlay =
    d.overlay ?? ((item: OutboxItem, value: unknown) => ({ ...(value as object), ...(item.input as object) }));

  async function guardOf(owner: Owner): Promise<Guard> {
    const guard = await prepareGuard(d.db, owner);
    if (guard === null) throw new Stop("持ち主の照合が外れた");
    return guard;
  }

  function checked<T extends { kind: string }>(result: T, owner: Owner): Exclude<T, { kind: "auth" }> {
    if (result.kind === "auth") {
      d.onAuth(owner);
      throw new Stop("認証の回復を待つ");
    }
    return result as Exclude<T, { kind: "auth" }>;
  }

  // projects.list と teams.list を読んで、見られる範囲をそろえる。読み切れなければ null
  async function refresh(owner: Owner, deniedTeams: string[] = []): Promise<{ mismatch: Set<string> } | null> {
    const projectsStartSeq = await nextSeq(d.db);
    const projects = checked(await d.readers.projects(owner), owner);
    const listedSeq = await nextSeq(d.db);
    if (projects.kind !== "ok") return null;
    const teamsStartSeq = await nextSeq(d.db);
    const teams = checked(await d.readers.teams(owner), owner);
    const teamsEndSeq = await nextSeq(d.db);
    const read: ListsRead = {
      projects: projects.items,
      projectsStartSeq,
      listedSeq,
      teams: teams.kind === "ok" ? { ids: teams.items.map((t) => t.id), startSeq: teamsStartSeq, endSeq: teamsEndSeq } : null,
      mismatchSeq: teamsEndSeq,
    };

    const guard = await guardOf(owner);
    const plan = planRevocation(read, await readLocalIndex(guard, read));
    // 認可を失ったチームと、そのプロジェクトの表示を保留する。番号はこの書き込みのときに取る
    for (const teamId of deniedTeams) {
      for (const id of [teamId, ...projects.items.filter((p) => p.teamId === teamId).map((p) => p.id)]) {
        plan.authz = addDenied(plan.authz, id, await nextSeq(d.db));
      }
    }
    const visible = projects.items.filter((p) => plan.authz.allowedProjectIds.includes(p.id));
    const teamIds = read.teams?.ids ?? [...new Set(visible.map((p) => p.teamId))];
    const places = {
      teams: teamIds.map((id) => ({ id })),
      projects: visible.map((p) => ({ project_id: p.id, team_id: p.teamId })),
    };
    // 場所の一覧は新しい記録に合わせて作ったので、古い記録とは照合しない
    const write = await d.cache.prepareReplace({ ...guard, authz: null }, "places", "places", places, listedSeq);
    if ((await applyRevocation(guard, plan, { notify: d.notify, places: write })) === "stale") {
      throw new Stop("別の書き込みと重なった");
    }
    return { mismatch: new Set(plan.authz.mismatchProjectIds) };
  }

  async function hold(item: OutboxItem, reason: "unknown-result" | "transfer-unavailable"): Promise<void> {
    await d.outbox.settle(item, { kind: "hold", reason });
    if (reason === "unknown-result") d.onEvent({ kind: "unknown", answerTag: item.answerTag, operation: item.operation });
  }

  // 同じキーで引けない操作で、送り始めたまま結果の無い件は送り直さない
  function unconfirmable(item: OutboxItem): boolean {
    const cls = operationClassOf(item.operation);
    return item.sendStarted && !idempotentOf(item.operation) && !(cls.class === "queued" && cls.resendableWithoutKey);
  }

  // 段 1。受け入れの確定待ちは、受け入れ先のチームの受け入れ待ちの一覧で決める
  async function stage1(owner: Owner, batch: OutboxItem[]) {
    for (const item of batch.filter(unconfirmable)) await hold(item, "unknown-result");
    const accepts = batch.filter((item) => item.transfer !== undefined && !item.sendStarted);
    const unavailable: OutboxItem[] = [];
    const deniedTeams: string[] = [];
    let unverified = false;
    // projects.list を読めない回は、何も移さない
    for (const teamId of new Set(accepts.map((item) => item.transfer!.teamId))) {
      const result = checked(await d.readers.transfers(owner, teamId), owner);
      const mine = accepts.filter((item) => item.transfer!.teamId === teamId);
      if (result.kind === "temporary") unverified = true;
      else if (result.kind === "denied") {
        deniedTeams.push(teamId);
        unavailable.push(...mine);
      } else unavailable.push(...mine.filter((item) => !result.items.some((t) => t.id === item.transfer!.transferId)));
    }
    const refreshed = await refresh(owner, deniedTeams);
    if (refreshed === null) return null;
    for (const item of unavailable) await hold(item, "transfer-unavailable");
    if (deniedTeams.length > 0) await refresh(owner);
    return { ...refreshed, unverified };
  }

  // 読み直した値に送る列の件を重ねて書く。読んだ後に送る列が変わっていれば書かない
  async function replace(owner: Owner, snapshot: Snapshot, fetchSeq: number): Promise<void> {
    const queued = (await d.outbox.readBatch()).items;
    const mine = queued.filter((item) => item.kind === "queued" && item.targetId === snapshot.targetId);
    const value = mine.reduce((current, item) => overlay(item, current), snapshot.value);
    const guard = await guardOf(owner);
    const write = await d.cache.prepareReplace(guard, snapshot.kind, snapshot.targetId, value, fetchSeq);
    if (write === null) return;
    const tags = queued.map((item) => item.answerTag).sort();
    await commitGuarded(guard, async (tx) => {
      if (mine.length > 0 && (await tx.objectStore("outbox").getAllKeys()).join() !== tags.join()) return false;
      return write(tx);
    });
  }

  // 段 5。アイテムの 404 だけではプロジェクトの失効と決めないので、一覧を読み直す
  async function missing(owner: Owner, target: { kind: SnapshotKind; targetId: string; projectId: string }, seq: number) {
    const guard = await guardOf(owner);
    const write = await d.cache.prepareGone(guard, target.kind, target.targetId, seq);
    // 保存済みの行より古い 404 は反映しない
    if (write === null) return;
    await holdDenied(guard, { id: target.projectId, writes: [write], notify: d.notify });
    await refresh(owner);
  }

  // 段 3・段 4。読めなければ前の写しを残す
  async function reload(owner: Owner, reader: (owner: Owner) => Promise<ScreenRead>): Promise<boolean> {
    const fetchSeq = await nextSeq(d.db);
    const result = checked(await reader(owner), owner);
    if (result.kind !== "ok") return false;
    for (const snapshot of result.snapshots) await replace(owner, snapshot, fetchSeq);
    for (const list of result.lists) await d.cache.recordList(await guardOf(owner), list.scope, list.ids, fetchSeq);
    for (const target of result.missing) await missing(owner, target, fetchSeq);
    return true;
  }

  function roundOf(owner: Owner, mismatch: Set<string>): Round {
    const round: Round = {
      owner,
      mismatchProjectIds: mismatch,
      apiNow: null,
      // 先映しした値を、反映されたかのように出し続けない
      async revert(item) {
        const fetchSeq = await nextSeq(d.db);
        const target = await d.readers.target(owner, item);
        if (target === null || target === "temporary") return;
        if (target.value !== null) await replace(owner, target, fetchSeq);
        else await d.cache.markGone(await guardOf(owner), target.kind, target.targetId, fetchSeq);
      },
      async reconfirm() {
        const refreshed = await refresh(owner);
        if (refreshed !== null) round.mismatchProjectIds = refreshed.mismatch;
      },
      onAuth: d.onAuth,
      report: d.onEvent,
    };
    return round;
  }

  async function run(owner: Owner): Promise<RoundReport> {
    let sent: "done" | "stopped" | "skipped" = "skipped";
    let reloadFailedAt: number | null = null;
    let stage = 1;
    try {
      // この回の対象は段 1 の初めに決める。後から足された件は次の回に回す
      const batch = (await d.outbox.readBatch()).items;
      const first = await stage1(owner, batch);
      if (first === null) {
        d.log.warn("一覧を読めないため、回を終えた", { stage });
        return { kind: "failed", sent, reloadFailedAt: d.wallNow() };
      }
      stage = 2;
      const waiting = await d.wait.read();
      if (!first.unverified && (waiting === null || d.wallNow() >= waiting.retryUntil)) {
        sent = await d.sender.sendQueue(roundOf(owner, first.mismatch), batch);
      }
      for (const [number, reader] of [
        [3, d.readers.screen],
        [4, d.readers.lists],
      ] as const) {
        stage = number;
        if (!(await reload(owner, reader))) reloadFailedAt = d.wallNow();
      }
      d.log.info("そろえ方の回を終えた", { count: batch.length, sent, reloaded: reloadFailedAt === null });
      return { kind: "done", sent, reloadFailedAt };
    } catch (error) {
      if (!(error instanceof Stop)) throw error;
      d.log.info("そろえ方の回を止めた", { stage, reason: error.message });
      return { kind: "stopped", sent, reloadFailedAt };
    }
  }

  const runOnce = (): Promise<RoundReport> =>
    navigator.locks.request(SYNC_LOCK, { ifAvailable: true }, async (lock): Promise<RoundReport> => {
      if (lock === null) return { kind: "busy" };
      const owner = d.owner();
      if (owner === null) return { kind: "no-owner" };
      if (owner.flagged()) return { kind: "flagged" };
      if (!d.connectivity.online()) return { kind: "offline" };
      if ((await prepareGuard(d.db, owner)) === null) return { kind: "no-owner" };
      try {
        return await run(owner);
      } finally {
        d.onRound?.();
      }
    });

  let running: Promise<void> = Promise.resolve();
  const tick = () => {
    const next = runOnce().then(
      () => {},
      (error: unknown) => d.log.warn("そろえ方の回が失敗した", { error: error instanceof Error ? error.name : "unknown" }),
    );
    running = Promise.all([running, next]).then(() => {});
  };

  return {
    runOnce,
    idle: () => running,
    start() {
      const visible = () => {
        if (d.document.visibilityState === "visible") tick();
      };
      const unsubscribe = d.connectivity.subscribe(() => {
        if (d.connectivity.online()) tick();
      });
      d.document.addEventListener("visibilitychange", visible);
      const timer = d.timers.setInterval(tick, RELOAD_INTERVAL_MS);
      tick();
      return () => {
        unsubscribe();
        d.document.removeEventListener("visibilitychange", visible);
        d.timers.clearInterval(timer);
      };
    },
  };
}
