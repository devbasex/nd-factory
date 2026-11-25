import { type OperationDef, OperationDefinitionError } from "../operation.ts";
import { DECISION_OPERATIONS } from "./decisions.ts";
import { AUDIT_OPERATIONS, DELEGATION_OPERATIONS } from "./delegations.ts";
import { EXECUTION_OPERATIONS } from "./execution.ts";
import { MACHINE_ENDPOINT_OPERATIONS } from "./machine-endpoint.ts";
import { MACHINE_OPERATIONS } from "./machines.ts";
import { NOTICE_OPERATIONS } from "./notices.ts";
import { PROJECT_OPERATIONS } from "./projects.ts";
import { RUNNER_OPERATIONS } from "./runner.ts";
import { SPRINT_OPERATIONS } from "./sprints.ts";
import { TEAM_OPERATIONS } from "./teams.ts";
import { USAGE_OPERATIONS } from "./usage.ts";
import { USER_OPERATIONS } from "./users.ts";

// 操作の表。全体の設計の操作の一覧の表の順（F1〜F20 の表の上から、続けてランナー・手元のマシン）に並べる
export const OPERATIONS = [
  ...USER_OPERATIONS,
  ...TEAM_OPERATIONS,
  ...PROJECT_OPERATIONS,
  ...SPRINT_OPERATIONS,
  ...DECISION_OPERATIONS,
  ...NOTICE_OPERATIONS,
  ...DELEGATION_OPERATIONS,
  ...EXECUTION_OPERATIONS,
  ...MACHINE_OPERATIONS,
  ...USAGE_OPERATIONS,
  ...AUDIT_OPERATIONS,
  ...RUNNER_OPERATIONS,
  ...MACHINE_ENDPOINT_OPERATIONS,
] as const;

export type Operation = (typeof OPERATIONS)[number];
export type OperationName = Operation["name"];

export type OperationIndex = {
  readonly byName: ReadonlyMap<string, OperationDef>;
  readonly byRoute: ReadonlyMap<string, OperationDef>;
};

// 名前と経路の引き当てを作る。どちらかが重なれば投げる（モジュールの読み込みで落ちる）
export function indexOperations(ops: readonly OperationDef[]): OperationIndex {
  const byName = new Map<string, OperationDef>();
  const byRoute = new Map<string, OperationDef>();
  for (const op of ops) {
    if (byName.has(op.name)) throw new OperationDefinitionError(`操作の名前が重なる: ${op.name}`);
    if (byRoute.has(op.route)) throw new OperationDefinitionError(`操作の経路が重なる: ${op.route}`);
    byName.set(op.name, op);
    byRoute.set(op.route, op);
  }
  return { byName, byRoute };
}

const INDEX = indexOperations(OPERATIONS);

export function operationByName(name: string): OperationDef | undefined {
  return INDEX.byName.get(name);
}

// /v1/... の経路で引く（readHttpCall が使う）
export function operationByRoute(path: string): OperationDef | undefined {
  return INDEX.byRoute.get(path);
}
