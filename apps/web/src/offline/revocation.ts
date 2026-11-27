import { addDenied, type AuthzRecord, type ListsRead, nextAuthz, withAuthzLock } from "./authz.ts";
import { seal, tagOf, unseal } from "./crypto.ts";
import { type HoldReason, nextSeq } from "./db.ts";
import { commitGuarded, type Guard, type GuardedTx } from "./guarded-commit.ts";
import type { OutboxBody } from "./outbox.ts";

// 段 1・段 5・403・404 の失効の反映。消す写しと保留に移す件と新しい記録を決め、1 つのトランザクションで書く

// プロジェクトをまたぐ写し。失ったプロジェクトの行を含みうるので、失効があれば丸ごと消す
const CROSS_PROJECT_KINDS = new Set(["approvals-list", "waiting-counts", "organizers", "notices"]);

export type LocalIndex = {
  prev: AuthzRecord | null;
  // projects.list が返したプロジェクトの ID から、平文の列に置く値へ
  tags: ReadonlyMap<string, string>;
  snapshots: { id: string; kind: string; projectTags: string[] }[];
  // keep は、受け入れ待ちの一覧で決める件（一度も送っていない割り当ての受け入れ）
  outbox: { answerTag: string; projectTag?: string; keep: boolean }[];
};

export type RevocationPlan = { deleteSnapshots: string[]; holdOutbox: string[]; authz: AuthzRecord };

export async function readLocalIndex(guard: Guard, read: ListsRead): Promise<LocalIndex> {
  const { db, keys, authz } = guard;
  const tags = new Map<string, string>();
  for (const { id } of read.projects) tags.set(id, await tagOf(keys.tagKey, id));
  const outbox: LocalIndex["outbox"] = [];
  for (const row of await db.getAll("outbox")) {
    const body = await unseal<OutboxBody>(keys.key, row).catch(() => null);
    outbox.push({ answerTag: row.answerTag, projectTag: row.projectTag, keep: body?.transfer !== undefined && !body.sendStarted });
  }
  const snapshots = (await db.getAll("snapshots")).map(({ id, kind, projectTags }) => ({ id, kind, projectTags }));
  return { prev: authz, tags, snapshots, outbox };
}

export function planRevocation(read: ListsRead, local: LocalIndex): RevocationPlan {
  const authz = nextAuthz(local.prev, read);
  const tagsFor = (ids: string[]) => new Set(ids.flatMap((id) => local.tags.get(id) ?? []));
  const allowed = tagsFor(authz.allowedProjectIds);
  const returned = tagsFor(read.projects.map((p) => p.id));
  const hidden = (s: LocalIndex["snapshots"][number]) => s.projectTags.some((tag) => !allowed.has(tag));
  const lost =
    local.snapshots.some(hidden) ||
    local.outbox.some((o) => o.projectTag !== undefined && !allowed.has(o.projectTag)) ||
    (local.prev?.allowedProjectIds ?? []).some((id) => !authz.allowedProjectIds.includes(id));
  return {
    deleteSnapshots: local.snapshots.filter((s) => hidden(s) || (lost && CROSS_PROJECT_KINDS.has(s.kind))).map((s) => s.id),
    // 食い違いのプロジェクトの件は残す。projects.list の結果そのものに無いものだけを移す
    holdOutbox: local.outbox
      .filter((o) => !o.keep && o.projectTag !== undefined && !returned.has(o.projectTag))
      .map((o) => o.answerTag),
    authz,
  };
}

type Write = (tx: GuardedTx) => Promise<boolean>;
type Notify = () => void;

async function moveRow(tx: GuardedTx, answerTag: string, reason: HoldReason): Promise<void> {
  const row = await tx.objectStore("outbox").get(answerTag);
  if (row === undefined) return;
  await tx.objectStore("held").put({ ...row, holdReason: reason });
  await tx.objectStore("outbox").delete(answerTag);
}

// places は場所の一覧の写しの置き換え。消した後に書くので、同じ行を消さない側に置く
export async function applyRevocation(
  guard: Guard,
  plan: RevocationPlan,
  o: { notify: Notify; places?: Write | null },
): Promise<"committed" | "stale"> {
  const sealed = { id: "authz" as const, ...(await seal(guard.keys.key, plan.authz)) };
  const result = await withAuthzLock("exclusive", () =>
    commitGuarded(guard, async (tx) => {
      for (const id of plan.deleteSnapshots) await tx.objectStore("snapshots").delete(id);
      if (o.places && !(await o.places(tx))) return false;
      for (const answerTag of plan.holdOutbox) await moveRow(tx, answerTag, "revoked");
      await tx.objectStore("authz").put(sealed);
      return true;
    }),
  );
  if (result === "committed") o.notify();
  return result;
}

export type DeniedItem = {
  answerTag: string;
  outcome: { kind: "remove" } | { kind: "hold"; reason: HoldReason; result?: OutboxBody["result"] };
};

const EMPTY: AuthzRecord = {
  generation: 0,
  allowedProjectIds: [],
  listedSeq: 0,
  mismatchProjectIds: [],
  mismatchSeq: null,
  denied: [],
};

// 権限の喪失を確かめたわけではないので、写しは消さずに記録で表示を保留する
export async function holdDenied(
  guard: Guard,
  o: { id: string; item?: DeniedItem; writes?: Write[]; notify: Notify },
): Promise<void> {
  const { db, keys } = guard;
  const authz = addDenied(guard.authz ?? EMPTY, o.id, await nextSeq(db));
  const sealed = { id: "authz" as const, ...(await seal(keys.key, authz)) };
  const { item } = o;
  // 拒まれた理由は、トランザクションの外で件に足して暗号化し直す
  let rewritten: Awaited<ReturnType<typeof seal>> | null = null;
  if (item?.outcome.kind === "hold" && item.outcome.result !== undefined) {
    const row = (await db.get("outbox", item.answerTag)) ?? (await db.get("held", item.answerTag));
    if (row !== undefined) {
      rewritten = await seal(keys.key, { ...(await unseal<OutboxBody>(keys.key, row)), result: item.outcome.result });
    }
  }
  const result = await withAuthzLock("exclusive", () =>
    commitGuarded(guard, async (tx) => {
      for (const write of o.writes ?? []) if (!(await write(tx))) return false;
      if (item !== undefined) {
        const queued = await tx.objectStore("outbox").get(item.answerTag);
        const row = queued ?? (await tx.objectStore("held").get(item.answerTag));
        if (row !== undefined && item.outcome.kind === "hold") {
          await tx.objectStore("held").put({ ...row, ...rewritten, holdReason: item.outcome.reason });
          await tx.objectStore("outbox").delete(item.answerTag);
        } else if (row !== undefined) {
          await tx.objectStore("outbox").delete(item.answerTag);
          await tx.objectStore("held").delete(item.answerTag);
        }
      }
      await tx.objectStore("authz").put(sealed);
      return true;
    }),
  );
  if (result === "committed") o.notify();
}
