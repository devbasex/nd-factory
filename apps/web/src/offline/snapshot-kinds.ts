// 写しにする種類の表（#12 の設計書の「写しにする種類の表」）。表に無いレスポンスは端末に置かない。
// 操作のレスポンスの形は #28 が決めるまで未定なので、プロジェクトの ID は中身の `project_id` の項目から集める

type KindDef = {
  operations: readonly string[];
  // 1 件の写しに残す項目の数の上限（画面の文書の「端末に保存するもの」）
  limit?: number;
  // 対象が入る一覧の種類。一覧の記録より古い詳細は採らない
  list?: string;
};

const SNAPSHOT_KINDS = {
  organizers: { operations: ["organizers.list", "organizers.get"] },
  "organizer-messages": { operations: ["organizer_messages.list"], limit: 200 },
  "approvals-list": { operations: ["approvals.list", "questions.list"] },
  "waiting-counts": { operations: ["waiting_counts.get"] },
  "sprint-list": { operations: ["sprints.list"], limit: 50 },
  sprint: { operations: ["sprints.get", "lanes.list", "progress_events.list"], list: "sprint-list" },
  approval: { operations: ["approvals.get"] },
  question: { operations: ["questions.get"] },
  notices: { operations: ["notices.list"], limit: 100 },
  // teams.list と projects.list から段 1 が作る
  places: { operations: [] },
  self: { operations: ["users.get"] },
  // ここから下は画面の状態
  "last-project": { operations: [] },
  "last-conversation": { operations: [] },
  section: { operations: [] },
} satisfies Record<string, KindDef>;

export type SnapshotKind = keyof typeof SNAPSHOT_KINDS;

export function kindDefOf(kind: string): KindDef | null {
  return Object.hasOwn(SNAPSHOT_KINDS, kind) ? SNAPSHOT_KINDS[kind as SnapshotKind] : null;
}

export function snapshotKindOf(operation: string): SnapshotKind | null {
  const found = Object.entries(SNAPSHOT_KINDS).find(([, def]) => (def.operations as readonly string[]).includes(operation));
  return found === undefined ? null : (found[0] as SnapshotKind);
}

export function projectIdsOf(_kind: SnapshotKind, value: unknown): string[] {
  const ids = new Set<string>();
  const visit = (node: unknown) => {
    if (node === null || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (key === "project_id" && typeof child === "string") ids.add(child);
      else visit(child);
    }
  };
  visit(value);
  return [...ids];
}
