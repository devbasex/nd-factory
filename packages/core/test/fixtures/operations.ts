import { defineOperation, pendingShape } from "@nd-factory/contracts/operation";

// 判定と記録のテストが使う作り物の操作。要素と結果の形はこのテストの範囲の外のため形の未定にし、印だけを持つ

const pending = { item: pendingShape("#2"), result: pendingShape("#2"), owner: "#2" } as const;

// 読む操作。委任の read から呼べる
export const projectsGet = defineOperation({ ...pending, name: "projects.get", features: ["F3"], access: "read", delegationKind: "read", auditKeys: ["project_id"] });

// 持ち主だけの書く操作。委任の manage から呼べる
export const projectsRename = defineOperation({
  ...pending,
  name: "projects.rename",
  features: ["F3"],
  access: "write",
  delegationKind: "manage",
  ownerOnly: true,
  idempotencyKey: true,
  auditKeys: ["project_id"],
});

// 委任の run から呼べる書く操作
export const sprintsCreate = defineOperation({
  ...pending,
  name: "sprints.create",
  features: ["F7"],
  access: "write",
  delegationKind: "run",
  idempotencyKey: true,
  auditKeys: ["project_id", "sprint_id"],
});

// 要素によって人だけになる操作
export const questionsAnswer = defineOperation({ ...pending, name: "questions.answer", features: ["F10"], access: "write", humanOnly: "per_item", delegationKind: "run", auditKeys: ["project_id", "question_id"] });

// 初めてのサインインで利用者を作る人だけの操作（まだ結んでいない人の主体を受ける）
export const sessionsCreate = defineOperation({ ...pending, name: "sessions.create", features: ["F1"], access: "write", humanOnly: "always", idempotencyKey: true, mcpRead: "users.get" });

// 人だけの操作
export const delegationsCreate = defineOperation({ ...pending, name: "delegations.create", features: ["F16"], access: "write", humanOnly: "always", mcpRead: "delegations.list" });

// チームの持ち主だけの操作
export const teamsRename = defineOperation({ ...pending, name: "teams.rename", features: ["F2"], access: "write", delegationKind: "manage", ownerOnly: true, auditKeys: ["team_id"] });

// ランナー向けの経路
export const runnerEventsAppend = defineOperation({ ...pending, name: "runner.events.append", endpoint: "runner", access: "write", auditKeys: ["lane_id"] });

// 手元のマシン向けの経路
export const machineLanesPull = defineOperation({ ...pending, name: "machine.lanes.pull", endpoint: "machine", access: "read" });

// DB の用意のタスク向けの経路
export const dbPrepSecretsGet = defineOperation({ ...pending, name: "db_prep.secrets.get", endpoint: "db_prep", access: "read" });
