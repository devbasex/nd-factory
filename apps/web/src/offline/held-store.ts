import { type AuthzRecord, judgeVisibility, type Target } from "./authz.ts";
import { unseal } from "./crypto.ts";
import { type DeviceDb, type HoldReason, type OutboxRow, readOwner } from "./db.ts";
import type { OutboxBody } from "./outbox.ts";

// 保留の件の読み出しと、確認の後の破棄。利用者が破棄を確認するまで残す

export type HeldItem = {
  answerTag: string;
  holdReason: HoldReason;
  kind: OutboxRow["kind"];
  // 復号できなければ null
  body: OutboxBody | null;
};

export type HeldView = {
  answerTag: string;
  holdReason: HoldReason;
  operation?: string;
  pressedAt?: number;
  unreadableKind?: OutboxRow["kind"];
  // 対象を今の権限で見られると確かめられなければ null
  content: Pick<OutboxBody, "input" | "targetId" | "projectId" | "check" | "transfer" | "result"> | null;
};

export type HeldStore = {
  count(): Promise<number>;
  list(): Promise<HeldItem[]>;
  discard(answerTag: string): Promise<void>;
};

export function createHeldStore({ db }: { db: DeviceDb }): HeldStore {
  return {
    count: () => db.count("held"),
    async list() {
      const owner = await readOwner(db);
      const rows = await db.getAll("held");
      return Promise.all(
        rows.map(async ({ answerTag, holdReason, kind, iv, data }) => ({
          answerTag,
          holdReason,
          kind,
          body: owner === null ? null : await unseal<OutboxBody>(owner.key, { iv, data }).catch(() => null),
        })),
      );
    },
    discard: (answerTag) => db.delete("held", answerTag),
  };
}

// 自分の設定の操作は、常に見られる
const OWN_SETTINGS = new Set(["users.update", "notices.mark_read"]);

function targetOf(body: OutboxBody): Target | null {
  // 受け入れるプロジェクトはまだ割り当てられていないので、受け入れ先のチームで確かめる
  if (body.transfer !== undefined) return { team: body.transfer.teamId };
  return body.projectId === null ? null : { project: body.projectId };
}

// 記録が無いか確かめられなければ、見られないとして扱う（割り当ての外のプロジェクトの中身を出さない）
function readable(body: OutboxBody, record: AuthzRecord | null): boolean {
  const target = targetOf(body);
  if (target === null) return OWN_SETTINGS.has(body.operation);
  if (record === null || (record.allowedTeamIds === undefined && "team" in target)) return false;
  return judgeVisibility(record, target, 0) === "show";
}

export function visibleFieldsOf(item: HeldItem, record: AuthzRecord | null): HeldView {
  const { answerTag, holdReason, body } = item;
  if (body === null) return { answerTag, holdReason, unreadableKind: item.kind, content: null };
  const { operation, pressedAt, input, targetId, projectId, check, transfer, result } = body;
  const content = readable(body, record) ? { input, targetId, projectId, check, transfer, result } : null;
  return { answerTag, holdReason, operation, pressedAt, content };
}
