import type { OperationDef } from "@nd-factory/contracts/operation";
import { OPERATIONS } from "@nd-factory/contracts/operations";
import type { Logger } from "@nd-factory/core/log";
import { type ApiReply, type ApiSender, DEADLINE_MS, type SessionOwner } from "./api-transport.ts";
import type { CacheStore } from "./cache-store.ts";
import type { DeviceDb, HoldReason } from "./db.ts";
import { commitGuarded, type GuardedTx, type Owner, prepareGuard } from "./guarded-commit.ts";
import { missingChecks, type OperationClass, operationClassOf } from "./operation-classes.ts";
import { type Outbox, type OutboxItem, SessionChangedError } from "./outbox.ts";
import { holdDenied } from "./revocation.ts";
import { retryUntilFrom, type SendWait } from "./send-wait.ts";
import { SIGNIN_LOCK } from "./quarantine.ts";

// そろえ方の段 2（送る列を送る）と取り下げ（#12 の設計書の「段 2 の結果ごとの扱い」「確定待ちの取り下げ」）

const API_DEADLINE_MS = DEADLINE_MS - 2 * 60 * 1000;
// 冪等キーの 24 時間の保持期間より、1 時間手前で送り直しをやめる
const KEY_RESEND_MS = 23 * 60 * 60 * 1000;

type Result = { status: number; reason: string };

type SendDecision =
  | { kind: "done" }
  | { kind: "reject"; hold: boolean; deny: boolean; result: Result }
  | { kind: "unknown"; deny: boolean; stop: boolean; result?: Result }
  | { kind: "retry"; rateLimited: boolean; unsent: boolean }
  | { kind: "auth" };

type Answered = Exclude<ApiReply, { kind: "aborted" }>;

/** @internal */
export function classifyResult(input: {
  cls: OperationClass;
  resent: boolean;
  idempotent: boolean;
  hasInput: boolean;
  reply: Answered;
}): SendDecision {
  const { cls, resent, idempotent, hasInput, reply } = input;
  // 同じキーで 1 回目の結果を引けない操作は、2 回実行しても変わらないものだけを送り直す
  const resendable = idempotent || (cls.class === "queued" && cls.resendableWithoutKey);
  const temporary: SendDecision = resendable
    ? { kind: "retry", rateLimited: false, unsent: false }
    : { kind: "unknown", deny: false, stop: true };
  const rejected = (result: Result, deny: boolean): SendDecision => ({
    kind: "reject",
    hold: cls.class === "confirm" || hasInput,
    deny,
    result,
  });
  const forbidden = (result: Result) => result.status === 403 || result.status === 404;
  const byStatus = (result: Result): SendDecision => {
    if (forbidden(result)) return resent ? { kind: "unknown", deny: true, stop: false, result } : rejected(result, true);
    return rejected(result, false);
  };

  if (reply.kind === "network") return temporary;
  if (reply.status === 401) return { kind: "auth" };
  if (reply.status === 429) return { kind: "retry", rateLimited: true, unsent: true };
  if (reply.status === 503) return temporary;
  if (reply.status !== 200) {
    // 本文が API の形でなければ、API の答えと確かめられない
    const answer = reply.result;
    if (answer.ok || answer.status === 0 || answer.status >= 500) return temporary;
    return byStatus(answer);
  }
  if (!reply.result.ok) return temporary;
  const item = reply.result.results[0] as { ok: boolean; status?: number; reason?: string } | undefined;
  if (item === undefined) return temporary;
  if (item.ok) return { kind: "done" };
  const result = { status: item.status ?? 0, reason: item.reason ?? "" };
  if (result.reason === "in_progress") return { kind: "retry", rateLimited: false, unsent: false };
  if (result.status === 422) return { kind: "unknown", deny: false, stop: false, result };
  if (result.status === 429 || result.status >= 500) return temporary;
  return byStatus(result);
}

// apiNowMs は件ごとに読み直した API の時刻。送り直しでない「キャッシュして送る」には呼ばない
/** @internal */
export function checkDeadline(item: OutboxItem, apiNowMs: number | null, wallNowMs: number): "send" | "expired" | "unknown" {
  if (item.kind === "confirm") {
    const late =
      wallNowMs - item.pressedAt >= DEADLINE_MS ||
      item.pressedFloor === null ||
      apiNowMs === null ||
      apiNowMs - item.pressedFloor >= API_DEADLINE_MS;
    if (late) return item.sendStarted ? "unknown" : "expired";
  }
  if (!item.sendStarted) return "send";
  return item.sentAt === null || apiNowMs === null || apiNowMs - item.sentAt >= KEY_RESEND_MS ? "unknown" : "send";
}

export type SendEvent = {
  kind: "confirmed" | "rejected" | "unknown" | "expired";
  answerTag: string;
  operation: string;
  reason?: string;
};

export type Round = {
  owner: Owner;
  mismatchProjectIds: ReadonlySet<string>;
  // この回で最後に受けた応答の Date
  apiNow: number | null;
  // 拒まれた「キャッシュして送る」の対象を読み直し、先映しを取り消す
  revert(item: OutboxItem): Promise<void>;
  // 403・404 の後に projects.list と teams.list を読み直して確かめる
  reconfirm(): Promise<void>;
  onAuth(owner: SessionOwner): void;
  report(event: SendEvent): void;
};

type Conversation = { organizerId: string; projectId: string };

export type SendDeps = {
  db: DeviceDb;
  outbox: Outbox;
  wait: SendWait;
  cache: CacheStore;
  send: ApiSender;
  ops?: readonly OperationDef[];
  perfNow: () => number;
  wallNow: () => number;
  log: Pick<Logger, "info" | "warn">;
  notify: () => void;
};

export type QueueSender = {
  sendQueue(round: Round, batch: OutboxItem[]): Promise<"done" | "stopped">;
  withdraw(
    owner: Owner,
    answerTag: string,
    conversation?: Conversation,
  ): Promise<"removed" | "held" | "enqueued" | "unconfirmed">;
};

type Conversing = { items?: { answer_tag?: string; id?: string }[] };
type TimeRead = { apiNow: number | null; since: { perf: number; wall: number } };
type Next = "next" | "stop";

const WITHDRAW = "organizer_messages.withdraw";
const CREATE = "organizer_messages.create";
// 自分の設定は、表示の保留の対象にしない
const OWN_SETTINGS = new Set(["users.update", "notices.mark_read"]);

const dateOf = (header: string | null) => {
  const ms = header === null ? Number.NaN : Date.parse(header);
  return Number.isNaN(ms) ? null : ms;
};

export function createSender(d: SendDeps): QueueSender {
  const idempotentOf = (operation: string) =>
    (d.ops ?? (OPERATIONS as readonly OperationDef[])).some((op) => op.name === operation && op.idempotencyKey);

  // アイテムの形は操作を持つ課題が決める。未定の間は、対象の ID・入力・照合の値を並べる
  const bodyOf = (item: OutboxItem, idempotent: boolean) => ({
    id: item.targetId,
    ...(item.input as object),
    ...item.check,
    ...(item.transfer === undefined ? {} : { transfer_id: item.transfer.transferId }),
    ...(idempotent ? { idempotency_key: item.idempotencyKey } : {}),
  });

  function report(round: Round, item: OutboxItem, kind: SendEvent["kind"], reason?: string): void {
    round.report({ kind, answerTag: item.answerTag, operation: item.operation, reason });
    d.log.info("送る列の件を扱った", { operation: item.operation, result: kind, reason });
  }

  // 偽なら、応答を待つ間に別のタブでセッションが替わったので書いていない。その応答は反映しない
  async function note(round: Round, date: string | null): Promise<boolean> {
    const ms = dateOf(date);
    if (ms === null) return true;
    if (!(await d.wait.writeApiTime(round.owner, ms))) return false;
    round.apiNow = ms;
    return true;
  }

  // 待機の期限は、その 429 を受けたセッションの照合と同じトランザクションで書く
  async function rateLimit(round: Round, retryAfter: string | null, date: string | null): Promise<void> {
    const current = await d.wait.read();
    await d.wait.write(round.owner, retryUntilFrom(retryAfter, date, d.wallNow(), current?.backoffMs ?? 0));
  }

  // 件ごとに送る直前に API の今の時刻を読む。この回で前に受けた Date は使わない
  async function readTime(round: Round): Promise<TimeRead | null> {
    const since = { perf: d.perfNow(), wall: d.wallNow() };
    const reply = await d.send({ name: "projects.list", items: [{}], round: round.owner });
    if (reply.kind !== "response") return null;
    if (reply.status === 401) round.onAuth(reply.owner);
    if (reply.status === 429) await rateLimit(round, reply.retryAfter, reply.date);
    if (reply.status !== 200 || !reply.result.ok) return null;
    if (!(await note(round, reply.date))) return null;
    return { apiNow: dateOf(reply.date), since };
  }

  async function giveUp(round: Round, item: OutboxItem, why: "expired" | "unknown"): Promise<void> {
    const reason: HoldReason = why === "expired" ? "expired" : "unknown-result";
    await d.outbox.settle(item, { kind: "hold", reason });
    report(round, item, why);
    if (why === "unknown" && item.kind === "queued") await round.revert(item);
  }

  // 会話の写しの先映しした項目に、成功の項目の ID を書く
  async function sentIdWrite(owner: Owner, item: OutboxItem, itemId: string) {
    const guard = await prepareGuard(d.db, owner);
    const found = await d.cache.read("organizer-messages", item.targetId);
    if (guard === null || found === null) return null;
    const value = found.value as Conversing;
    const items = value.items?.map((i) => (i.answer_tag === item.answerTag ? { ...i, id: itemId } : i));
    return d.cache.prepareReplace(guard, "organizer-messages", item.targetId, { ...value, items }, found.fetchSeq);
  }

  // 件を消すのと会話の写しと待機の解除を 1 度に書く。取り下げた後の成功なら、返った項目の取り下げを足す
  async function created(round: Round, item: OutboxItem, itemId: string, waitSeen: Uint8Array | null): Promise<boolean> {
    // 読んだ後に取り下げが保留へ移すことがあるので、所属は書き込みの中で確かめ、変わっていれば読み直す
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const found = await d.outbox.find(item.answerTag);
      if (found === null) return d.wait.clear(round.owner, waitSeen);
      const conversation = await sentIdWrite(round.owner, item, itemId);
      const writeConversation = async (tx: GuardedTx) => conversation === null || (await conversation(tx));
      if (found.held) {
        // 保留から先へは移らないので、取り下げを足すのと同じトランザクションで保留の件を消す
        const draft = { operation: WITHDRAW, targetId: itemId, projectId: item.projectId, input: {} };
        let refused = false;
        try {
          await d.outbox.enqueue(round.owner, draft, async (tx) => {
            if (!(await writeConversation(tx))) {
              refused = true;
              return false;
            }
            await tx.objectStore("held").delete(item.answerTag);
            await d.wait.clearIn(tx, waitSeen);
            return true;
          });
        } catch (error) {
          // セッションが替わったか、会話の写しが読んだ後に変わったときは、何も変えずに回を止める。
          // それ以外（保存の失敗）はそのまま投げる
          if (error instanceof SessionChangedError || refused) return false;
          throw error;
        }
        return true;
      }
      const guard = await prepareGuard(d.db, round.owner);
      if (guard === null) return false;
      let moved = false;
      const result = await commitGuarded(guard, async (tx) => {
        moved = (await tx.objectStore("outbox").get(item.answerTag)) === undefined;
        if (moved || !(await writeConversation(tx))) return false;
        await tx.objectStore("outbox").delete(item.answerTag);
        await d.wait.clearIn(tx, waitSeen);
        return true;
      });
      if (result === "committed") return true;
      if (!moved) return false;
    }
    return false;
  }

  // 成功した件を送る列（取り下げで移っていれば保留）から消すのと待機の解除を、セッションの照合と同じトランザクションで行う。
  // 偽なら照合が外れたので、件も待機の行も変えていない
  async function removeSent(round: Round, item: OutboxItem, waitSeen: Uint8Array | null): Promise<boolean> {
    const guard = await prepareGuard(d.db, round.owner);
    if (guard === null) return false;
    const result = await commitGuarded(guard, async (tx) => {
      await d.outbox.removeIn(tx, item.answerTag);
      await d.wait.clearIn(tx, waitSeen);
      return true;
    });
    return result === "committed";
  }

  async function apply(
    round: Round,
    item: OutboxItem,
    decision: SendDecision,
    reply: Answered,
    waitSeen: Uint8Array | null,
  ): Promise<Next> {
    if (decision.kind === "auth" || decision.kind === "retry") {
      // 処理の前の拒否は実行していないと分かるので、キーの無い操作は印を戻す
      const refused = decision.kind === "auth" || decision.unsent;
      if (refused && !idempotentOf(item.operation) && !item.sendStarted) {
        const found = await d.outbox.find(item.answerTag);
        if (found !== null && !found.held) await d.outbox.unmarkSendStarted(found.item);
      }
      if (decision.kind === "auth") round.onAuth(reply.owner);
      else if (decision.rateLimited && reply.kind === "response") await rateLimit(round, reply.retryAfter, reply.date);
      return "stop";
    }
    if (decision.kind === "done") {
      const result = reply.kind === "response" && reply.result.ok ? reply.result.results[0] : undefined;
      const itemId = (result as { item?: { id?: string } } | undefined)?.item?.id;
      // 件の反映と待機の解除は、この応答を受けたセッションの照合と同じトランザクションで行う。
      // 照合が外れたら、どちらも変えずに回を止める
      const settled =
        item.operation === CREATE && itemId !== undefined
          ? await created(round, item, itemId, waitSeen)
          : await removeSent(round, item, waitSeen);
      if (!settled) return "stop";
      if (item.kind === "confirm") report(round, item, "confirmed");
      return "next";
    }

    const outcome =
      decision.kind === "unknown"
        ? { kind: "hold" as const, reason: "unknown-result" as const, result: decision.result }
        : decision.hold
          ? { kind: "hold" as const, reason: "rejected" as const, result: decision.result }
          : { kind: "remove" as const };
    const denied = item.transfer?.teamId ?? item.projectId;
    const deny = decision.deny && denied !== null && !OWN_SETTINGS.has(item.operation);
    if (deny) {
      const guard = await prepareGuard(d.db, round.owner);
      if (guard === null) return "stop";
      await holdDenied(guard, { id: denied, item: { answerTag: item.answerTag, outcome }, notify: d.notify });
    } else await d.outbox.settle(item, outcome);
    report(round, item, decision.kind === "unknown" ? "unknown" : "rejected", decision.result?.reason);
    if (item.kind === "queued") await round.revert(item);
    if (deny) await round.reconfirm();
    return decision.kind === "unknown" && decision.stop ? "stop" : "next";
  }

  async function sendOne(round: Round, original: OutboxItem): Promise<Next> {
    const cls = operationClassOf(original.operation);
    const idempotent = idempotentOf(original.operation);
    const resent = original.sendStarted;
    let item = original;
    // 照合の値がそろわない確定待ちは送らない。読んだときの値が無ければ、サーバーは古い判断を拒めない
    if (missingChecks(item.operation, item.check).length > 0) {
      await d.outbox.settle(item, { kind: "hold", reason: resent ? "unknown-result" : "unmigrated" });
      d.log.warn("照合の値の無い確定待ちを送らなかった", { operation: item.operation });
      d.notify();
      return "next";
    }
    if (resent && !idempotent && !(cls.class === "queued" && cls.resendableWithoutKey)) {
      await giveUp(round, item, "unknown");
      return "next";
    }
    const timedSend = item.kind === "confirm" || (resent && idempotent);

    // 時刻の読み直しは 1 件につき 1 回まで
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let time: TimeRead | null = null;
      if (timedSend) {
        time = await readTime(round);
        if (time === null) return "stop";
        const verdict = checkDeadline(item, time.apiNow, d.wallNow());
        if (verdict !== "send") {
          await giveUp(round, item, verdict);
          return "next";
        }
      }
      let markedNow = false;
      if (!resent) {
        const marked = await d.outbox.markSendStarted(item, round.apiNow);
        // 取り下げで消えたか置き換わった
        if (marked === null) return "next";
        item = marked;
        markedNow = true;
      }
      // 解除してよいのは、送る前に見た待機の行だけ。応答を待つ間に別のタブが書いた期限は残す
      const waitSeen = await d.wait.seen();
      const reply = await d.send({
        name: item.operation,
        items: [bodyOf(item, idempotent)],
        round: round.owner,
        answerTag: item.answerTag,
        timed: time === null ? undefined : { since: time.since },
        pressedAt: item.kind === "confirm" ? item.pressedAt : undefined,
      });

      if (reply.kind === "aborted") {
        if (reply.reason === "gone") {
          // 照合は送信の開始の前に行うので、送っていない。この回で印を付けた件が取り下げで保留へ移っていれば消す
          if (markedNow && (await d.outbox.dropWithdrawnUnsent(item))) d.notify();
          return "next";
        }
        const restored = markedNow ? await d.outbox.unmarkSendStarted(item) : item;
        if (restored === null) return "next";
        item = restored;
        if (reply.reason === "session") return "stop";
        if (reply.reason === "deadline") {
          await giveUp(round, item, item.sendStarted ? "unknown" : "expired");
          return "next";
        }
        continue;
      }
      // レスポンスを反映する前に持ち主を照合し直す
      // 時刻の保存がセッションの変更で中止されたときも、旧い応答を反映しない
      if ((await prepareGuard(d.db, round.owner)) === null) return "stop";
      if (reply.kind === "response" && !(await note(round, reply.date))) return "stop";
      const decision = classifyResult({
        cls,
        resent,
        idempotent,
        hasInput: cls.class === "queued" && cls.keepsInput,
        reply,
      });
      // 印を戻す判断は、送る前の印で行う
      return apply(round, { ...item, sendStarted: resent }, decision, reply, waitSeen);
    }
    return "stop";
  }

  async function sentId(answerTag: string, conversation: Conversation): Promise<string | null> {
    const found = await d.cache.read("organizer-messages", conversation.organizerId);
    return (found?.value as Conversing | undefined)?.items?.find((i) => i.answer_tag === answerTag)?.id ?? null;
  }

  return {
    async sendQueue(round, batch) {
      for (const item of [...batch].sort((a, b) => a.seq - b.seq)) {
        if (item.projectId !== null && round.mismatchProjectIds.has(item.projectId)) return "stopped";
        const found = await d.outbox.find(item.answerTag);
        if (found === null || found.held) continue;
        if ((await sendOne(round, found.item)) === "stop") return "stopped";
      }
      return "done";
    },

    // 送信の開始と同じ錠で、1 つずつ行う
    withdraw: (owner, answerTag, conversation) =>
      navigator.locks.request(SIGNIN_LOCK, async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const found = await d.outbox.find(answerTag);
          if (found === null) break;
          if (found.held) return "held";
          const { item } = found;
          const outcome = item.sendStarted
            ? { kind: "hold" as const, reason: "unknown-result" as const }
            : { kind: "remove" as const };
          if (await d.outbox.takeBack(item, outcome)) return item.sendStarted ? "held" : "removed";
        }
        const itemId = conversation === undefined ? null : await sentId(answerTag, conversation);
        if (itemId === null) return "unconfirmed";
        await d.outbox.enqueue(owner, {
          operation: WITHDRAW,
          targetId: itemId,
          projectId: conversation!.projectId,
          input: {},
        });
        return "enqueued";
      }),
  };
}
