import type { Clock } from "@nd-factory/core/clock";
import { newIdempotencyKey } from "@nd-factory/core/ids";
import { seal, tagOf, unseal } from "./crypto.ts";
import { type DeviceDb, type HeldRow, type HoldReason, nextSeq, type OutboxRow, readOwner } from "./db.ts";
import { commitGuarded, type GuardedTx, type Owner, prepareGuard, sameBytes } from "./guarded-commit.ts";
import { operationClassOf } from "./operation-classes.ts";

// 送る列（キャッシュして送ると確定待ち）。件は利用者の入力を持つので、端末の判断では消さず保留へ移す（IW13）

/** @internal */
export type Draft = {
  operation: string;
  targetId: string;
  projectId: string | null;
  input: unknown;
  // 確定待ちだけが持つ、読んだときの照合の値
  check?: Record<string, string | number>;
  // 割り当ての受け入れだけが持つ、押した時点の受け入れ先
  transfer?: { teamId: string; transferId: string };
  pressedFloor?: number | null;
};

/** 暗号文の中の項目（#12 の設計書の「送る列の 1 件の中身」） */
export type OutboxBody = Omit<Draft, "pressedFloor"> & {
  idempotencyKey: string;
  pressedAt: number;
  pressedFloor: number | null;
  seq: number;
  sendStarted: boolean;
  sentAt: number | null;
  // サーバーが拒んだ件を保留にするときに足す
  result?: { status: number; reason: string };
};

export type OutboxItem = OutboxBody & Pick<OutboxRow, "answerTag" | "targetTag" | "kind" | "projectTag" | "iv">;

type Outcome =
  | { kind: "remove" }
  | { kind: "keep" }
  | { kind: "hold"; reason: HoldReason; result?: OutboxBody["result"] };

export type Outbox = {
  // also は、件を足すのと同じトランザクションで書くもの
  enqueue(owner: Owner, draft: Draft, also?: (tx: GuardedTx) => Promise<boolean>): Promise<OutboxItem>;
  find(answerTag: string): Promise<{ item: OutboxItem; held: boolean } | null>;
  // 読んだときから行が変わっていないときだけ、送る列から消すか保留に移す
  takeBack(item: OutboxItem, outcome: Exclude<Outcome, { kind: "keep" }>): Promise<boolean>;
  readBatch(): Promise<{ items: OutboxItem[]; unreadable: string[] }>;
  markSendStarted(item: OutboxItem, sentAt: number | null): Promise<OutboxItem | null>;
  // 印を戻した件を返す。置き換えられて消えたか、行が変わっていれば null
  unmarkSendStarted(item: OutboxItem): Promise<OutboxItem | null>;
  settle(item: OutboxItem, outcome: Outcome): Promise<"removed" | "held" | "kept" | "missing">;
  moveToHeld(answerTags: string[], reason: HoldReason): Promise<number>;
  countPending(owner: Owner): Promise<{ confirm: number; queued: number; held: number }>;
};

// 後から押した件の番号が、先に押した件の保存より先に取られないようにする錠。持つ間はネットワークを待たない
const locked = async <T>(fn: () => Promise<T>): Promise<T> => await navigator.locks.request("nd-outbox", fn);

export function createOutbox({ db, clock }: { db: DeviceDb; clock: Clock }): Outbox {
  async function ownerKeys() {
    const owner = await readOwner(db);
    if (owner === null) throw new Error("端末のデータベースに持ち主がいない");
    return owner;
  }

  // 送る列と保留の件を書くトランザクション。隔離している間は書かない
  async function writing() {
    const tx = db.transaction(["keys", "outbox", "held"], "readwrite");
    const keys = await tx.objectStore("keys").get("main");
    if (keys === undefined || keys.switching === true) {
      tx.abort();
      await tx.done.catch(() => {});
      throw new Error("送る列を書けない（持ち主がいないか、隔離している）");
    }
    return tx;
  }

  async function itemOf(key: CryptoKey, row: OutboxRow): Promise<OutboxItem> {
    const { data: _data, ...columns } = row;
    return { ...(await unseal<OutboxBody>(key, row)), ...columns };
  }

  // 件の中身を書き直す。読んだ後に行が変わっていれば null
  async function rewrite(item: OutboxItem, change: Partial<OutboxBody>): Promise<OutboxItem | null> {
    const { key } = await ownerKeys();
    const row = await db.get("outbox", item.answerTag);
    if (row === undefined || !sameBytes(row.iv, item.iv)) return null;
    const body: OutboxBody = { ...(await unseal<OutboxBody>(key, row)), ...change };
    const next: OutboxRow = { ...row, ...(await seal(key, body)) };
    const tx = await writing();
    const current = await tx.objectStore("outbox").get(item.answerTag);
    const unchanged = current !== undefined && sameBytes(current.iv, item.iv);
    if (unchanged) await tx.objectStore("outbox").put(next);
    await tx.done;
    return unchanged ? itemOf(key, next) : null;
  }

  async function moveToHeld(answerTags: string[], reason: HoldReason): Promise<number> {
    const tx = await writing();
    let moved = 0;
    for (const answerTag of answerTags) {
      const row = await tx.objectStore("outbox").get(answerTag);
      if (row === undefined) continue;
      await tx.objectStore("held").put({ ...row, holdReason: reason });
      await tx.objectStore("outbox").delete(answerTag);
      moved += 1;
    }
    await tx.done;
    return moved;
  }

  // 同じ対象の、まだ送り始めていない確定待ち（後から押した件で置き換える。IW3）
  async function unsentConfirms(key: CryptoKey, targetTag: string): Promise<OutboxRow[]> {
    const found: OutboxRow[] = [];
    for (const row of await db.getAllFromIndex("outbox", "targetTag", targetTag)) {
      const body = await unseal<OutboxBody>(key, row).catch(() => null);
      if (row.kind === "confirm" && body?.sendStarted === false) found.push(row);
    }
    return found;
  }

  return {
    async find(answerTag) {
      const { key } = await ownerKeys();
      const queued = await db.get("outbox", answerTag);
      if (queued !== undefined) return { item: await itemOf(key, queued), held: false };
      const row = await db.get("held", answerTag);
      if (row === undefined) return null;
      const { holdReason: _reason, ...rest } = row;
      return { item: await itemOf(key, rest), held: true };
    },

    async takeBack(item, outcome) {
      const tx = await writing();
      const row = await tx.objectStore("outbox").get(item.answerTag);
      const unchanged = row !== undefined && sameBytes(row.iv, item.iv);
      if (unchanged) {
        if (outcome.kind === "hold") await tx.objectStore("held").put({ ...row, holdReason: outcome.reason });
        await tx.objectStore("outbox").delete(item.answerTag);
      }
      await tx.done;
      return unchanged;
    },

    async enqueue(owner, draft, also) {
      const found = operationClassOf(draft.operation);
      if (found.class === "online") throw new Error(`つながってから押す操作は送る列に入れない: ${draft.operation}`);
      return locked(async () => {
        const seq = await nextSeq(db);
        const body: OutboxBody = {
          ...draft,
          idempotencyKey: newIdempotencyKey(clock),
          pressedAt: clock.epochMs(),
          pressedFloor: draft.pressedFloor ?? null,
          seq,
          sendStarted: false,
          sentAt: null,
        };
        // ログインの行は token の取り直しでも書き換わるので、照合からやり直す
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const guard = await prepareGuard(db, owner);
          if (guard === null) break;
          const { key, tagKey } = guard.keys;
          const row: OutboxRow = {
            answerTag: await tagOf(tagKey, body.idempotencyKey),
            targetTag: await tagOf(tagKey, draft.operation, draft.targetId),
            kind: found.class,
            ...(draft.projectId === null ? {} : { projectTag: await tagOf(tagKey, draft.projectId) }),
            ...(await seal(key, body)),
          };
          const replaced = found.class === "confirm" ? await unsentConfirms(key, row.targetTag) : [];
          const result = await commitGuarded(guard, async (tx) => {
            for (const old of replaced) {
              const current = await tx.objectStore("outbox").get(old.answerTag);
              if (current === undefined || !sameBytes(current.iv, old.iv)) return false;
              await tx.objectStore("outbox").delete(old.answerTag);
            }
            await tx.objectStore("outbox").add(row);
            return also === undefined ? true : also(tx);
          });
          if (result === "committed") return itemOf(key, row);
        }
        throw new Error("操作を保存できない");
      });
    },

    readBatch: () =>
      locked(async () => {
        const owner = await readOwner(db);
        const items: OutboxItem[] = [];
        const unreadable: string[] = [];
        if (owner === null) return { items, unreadable };
        for (const row of await db.getAll("outbox")) {
          try {
            items.push(await itemOf(owner.key, row));
          } catch {
            unreadable.push(row.answerTag);
          }
        }
        if (unreadable.length > 0) await moveToHeld(unreadable, "unreadable");
        return { items: items.sort((a, b) => a.seq - b.seq), unreadable };
      }),

    // 送り始めた時刻は 1 回目だけ書く。書き直すと冪等キーの保持期間が延びる
    markSendStarted: (item, sentAt) => rewrite(item, item.sendStarted ? {} : { sendStarted: true, sentAt }),

    async unmarkSendStarted(item) {
      const same = await db.getAllFromIndex("outbox", "targetTag", item.targetTag);
      const { key } = await ownerKeys();
      let replaced = false;
      for (const row of same) {
        if (item.kind !== "confirm" || row.answerTag === item.answerTag) continue;
        if ((await unseal<OutboxBody>(key, row)).seq > item.seq) replaced = true;
      }
      if (!replaced) return rewrite(item, { sendStarted: false, sentAt: null });
      const tx = await writing();
      await tx.objectStore("outbox").delete(item.answerTag);
      await tx.done;
      return null;
    },

    // 結果は同じ答えの 1 件にだけ当てる（IW8）
    async settle(item, outcome) {
      const { key } = await ownerKeys();
      // 拒まれた件は、結果を足して暗号化し直してから移す
      let sealed: Awaited<ReturnType<typeof seal>> | null = null;
      if (outcome.kind === "hold" && outcome.result !== undefined) {
        const row = (await db.get("outbox", item.answerTag)) ?? (await db.get("held", item.answerTag));
        if (row !== undefined) {
          sealed = await seal(key, { ...(await unseal<OutboxBody>(key, row)), result: outcome.result });
        }
      }
      const tx = await writing();
      const queued = await tx.objectStore("outbox").get(item.answerTag);
      const row = queued ?? (await tx.objectStore("held").get(item.answerTag));
      let done: "removed" | "held" | "kept" | "missing" = row === undefined ? "missing" : "kept";
      if (row !== undefined && outcome.kind === "remove") {
        await tx.objectStore(queued === undefined ? "held" : "outbox").delete(item.answerTag);
        done = "removed";
      } else if (row !== undefined && outcome.kind === "hold") {
        const held: HeldRow = { ...row, ...sealed, holdReason: outcome.reason };
        await tx.objectStore("held").put(held);
        await tx.objectStore("outbox").delete(item.answerTag);
        done = "held";
      }
      await tx.done;
      return done;
    },

    moveToHeld,

    async countPending(owner) {
      const none = { confirm: 0, queued: 0, held: 0 };
      const keys = await readOwner(db);
      if (keys === null || (await tagOf(keys.tagKey, owner.userId)) !== keys.ownerTag) return none;
      const rows = await db.getAll("outbox");
      return {
        confirm: rows.filter((r) => r.kind === "confirm").length,
        queued: rows.filter((r) => r.kind === "queued").length,
        held: await db.count("held"),
      };
    },
  };
}
