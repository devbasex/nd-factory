import { type DBSchema, openDB } from "idb";
import { seal, tagOf, unseal } from "./crypto.ts";
import { type DeviceDb, type HeldRow, type HoldReason, nextSeq, type OutboxRow, readOwner } from "./db.ts";
import type { OutboxBody } from "./outbox.ts";

// データベースを消す必要があるのに、持ち主が破棄を確認していない件を、別の IndexedDB に暗号文のまま残す（IW7・IW13）

const QUARANTINE_DB_NAME = "nd-quarantine";

/** サインインとサインアウトが使う、アプリに 1 つの錠（画面の文書の「実行の排他と照合」。#4 と共有する） */
export const SIGNIN_LOCK = "nd-factory";

type OwnerRow = { ownerTag: string; key: CryptoKey; tagKey: CryptoKey; version: number };
type Item = HeldRow & { ownerTag: string; store: "outbox" | "held" };
// 保留の理由は保留の件だけが持つ
type Quarantined = Omit<Item, "holdReason"> & { holdReason?: HoldReason };

interface QuarantineSchema extends DBSchema {
  owners: { key: string; value: OwnerRow };
  items: { key: string; value: Quarantined; indexes: { ownerTag: string } };
}

const openQuarantine = () =>
  openDB<QuarantineSchema>(QUARANTINE_DB_NAME, 1, {
    upgrade(db) {
      db.createObjectStore("owners", { keyPath: "ownerTag" });
      db.createObjectStore("items", { keyPath: "answerTag" }).createIndex("ownerTag", "ownerTag");
    },
  });

async function withQuarantine<T>(fn: (q: Awaited<ReturnType<typeof openQuarantine>>) => Promise<T>): Promise<T> {
  const q = await openQuarantine();
  try {
    return await fn(q);
  } finally {
    q.close();
  }
}

/** 隔離に写し終えた件の主キー */
export const quarantinedTags = () => withQuarantine(async (q) => new Set(await q.getAllKeys("items")));

export async function quarantinePending(db: DeviceDb, o: { drop: ReadonlySet<string> }): Promise<void> {
  const marking = db.transaction("keys", "readwrite");
  const keys = await marking.store.get("main");
  // 隔離している間は、送る列と保留の件へ書けないようにする
  if (keys !== undefined) await marking.store.put({ ...keys, switching: true });
  await marking.done;

  const rows = [
    ...(await db.getAll("outbox")).map((row) => ({ ...row, store: "outbox" as const })),
    ...(await db.getAll("held")).map((row) => ({ ...row, store: "held" as const })),
  ].filter((row) => !o.drop.has(row.answerTag));
  if (rows.length === 0) return;
  // キーの行が無い件は、持ち主の分からない件として残し、どの利用者にも出さない
  const ownerTag = keys?.ownerTag ?? "";
  await withQuarantine(async (q) => {
    const tx = q.transaction(["owners", "items"], "readwrite");
    if (keys !== undefined) {
      await tx.objectStore("owners").put({ ownerTag, key: keys.key, tagKey: keys.tagKey, version: keys.migrated.outbox });
    }
    for (const row of rows) await tx.objectStore("items").put({ ...row, ownerTag });
    await tx.done;
  });
}

// 利用者の持ち主の行。同じ利用者でもキーを作り直すたびに行が増える
async function ownersOf(q: Awaited<ReturnType<typeof openQuarantine>>, userId: string): Promise<OwnerRow[]> {
  const found: OwnerRow[] = [];
  for (const owner of await q.getAll("owners")) {
    if ((await tagOf(owner.tagKey, userId)) === owner.ownerTag) found.push(owner);
  }
  return found;
}

// 件を消し、件が無くなった持ち主の行も消す
async function removeItems(q: Awaited<ReturnType<typeof openQuarantine>>, ownerTag: string, answerTags: string[]) {
  const tx = q.transaction(["owners", "items"], "readwrite");
  for (const answerTag of answerTags) await tx.objectStore("items").delete(answerTag);
  if ((await tx.objectStore("items").index("ownerTag").count(ownerTag)) === 0) {
    await tx.objectStore("owners").delete(ownerTag);
  }
  await tx.done;
}

// 戻した件の戻し先。再びサインインしただけでは、隔離の前に押した確定待ちを送らない
function destinationOf(item: Quarantined, body: OutboxBody): "outbox" | HoldReason {
  if (item.store === "held") return item.holdReason ?? "restored";
  if (item.kind === "queued") return "outbox";
  return body.sendStarted ? "unknown-result" : "restored";
}

export async function restoreQuarantined(db: DeviceDb, userId: string): Promise<void> {
  const current = await readOwner(db);
  if (current === null) throw new Error("戻し先の持ち主がいない");
  await withQuarantine(async (q) => {
    for (const owner of await ownersOf(q, userId)) {
      const readable: { item: Quarantined; body: OutboxBody }[] = [];
      for (const item of await q.getAllFromIndex("items", "ownerTag", owner.ownerTag)) {
        // 復号できない件は戻さず、隔離に残す
        const body = await unseal<OutboxBody>(owner.key, item).catch(() => null);
        if (body !== null) readable.push({ item, body });
      }
      for (const { item, body } of readable.sort((a, b) => a.body.seq - b.body.seq)) {
        const next: OutboxBody = { ...body, seq: await nextSeq(db) };
        // 答えの ID から作り直すので、やり直しても 2 件にならない
        const row: OutboxRow = {
          answerTag: await tagOf(current.tagKey, body.idempotencyKey),
          targetTag: await tagOf(current.tagKey, body.operation, body.targetId),
          kind: item.kind,
          ...(body.projectId === null ? {} : { projectTag: await tagOf(current.tagKey, body.projectId) }),
          ...(await seal(current.key, next)),
        };
        const destination = destinationOf(item, body);
        if (destination === "outbox") await db.put("outbox", row);
        else await db.put("held", { ...row, holdReason: destination });
        await removeItems(q, owner.ownerTag, [item.answerTag]);
      }
    }
  });
}

// 中断した隔離は元のデータベースを正とし、元にも残る件の複製を消す
export async function rollbackQuarantine(db: DeviceDb): Promise<void> {
  const keys = await readOwner(db);
  if (keys?.switching !== true) return;
  const originals = [...(await db.getAllKeys("outbox")), ...(await db.getAllKeys("held"))];
  await withQuarantine((q) => removeItems(q, keys.ownerTag, originals));
  const tx = db.transaction("keys", "readwrite");
  const current = await tx.store.get("main");
  if (current !== undefined) {
    const { switching: _switching, ...rest } = current;
    await tx.store.put(rest);
  }
  await tx.done;
}

type Unreadable = {
  items: ReadonlyArray<{ answerTag: string; kind: OutboxRow["kind"] }>;
  discard: (answerTag: string) => Promise<"deleted" | "kept" | "stale">;
};

// 持ち主の復号できない件の一覧と破棄。別のタブでセッションが替わった後の古いタブには読ませず消させない
export async function unreadableQuarantine(
  db: DeviceDb,
  userId: string,
  readFingerprint: () => string | null,
  flagged: () => boolean,
): Promise<"no-token" | "stale" | Unreadable> {
  // タブの指紋がログインの行と合い、行の持ち主が利用者のときだけ、その行の指紋のタグを返す
  async function session(): Promise<string | null> {
    const fingerprint = readFingerprint();
    const keys = await readOwner(db);
    const login = await db.get("login", "login");
    if (flagged() || fingerprint === null || keys === null || login === undefined) return null;
    if ((await tagOf(keys.tagKey, fingerprint)) !== login.fingerprintTag) return null;
    if (login.userTag !== keys.ownerTag || (await tagOf(keys.tagKey, userId)) !== keys.ownerTag) return null;
    return login.fingerprintTag;
  }

  if (readFingerprint() === null) return "no-token";
  const seen = await session();
  if (seen === null) return "stale";

  const items = await withQuarantine(async (q) => {
    const found: { answerTag: string; kind: OutboxRow["kind"] }[] = [];
    for (const owner of await ownersOf(q, userId)) {
      for (const item of await q.getAllFromIndex("items", "ownerTag", owner.ownerTag)) {
        const readable = await unseal(owner.key, item).then(
          () => true,
          () => false,
        );
        if (!readable) found.push({ answerTag: item.answerTag, kind: item.kind });
      }
    }
    return found;
  });

  const discard = (answerTag: string) =>
    navigator.locks.request(SIGNIN_LOCK, async () => {
      if ((await session()) !== seen) return "stale" as const;
      return withQuarantine(async (q) => {
        const item = await q.get("items", answerTag);
        if (item === undefined || !(await ownersOf(q, userId)).some((o) => o.ownerTag === item.ownerTag)) return "kept";
        await removeItems(q, item.ownerTag, [answerTag]);
        return "deleted";
      });
    });

  return { items, discard };
}
