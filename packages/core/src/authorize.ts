import type { DelegationKind, OperationDef } from "@nd-factory/contracts/operation";
import { SESSIONS_CREATE, type Principal } from "./auth/authenticate.ts";
import type { Id } from "./ids.ts";
import type { Logger } from "./log.ts";

// 認可の判定（docs/design/api.md の「認可」、I2）。操作の表の印と主体から、要求全体と要素ごとに通すかを 1 か所で決める。
// 見えない要素は存在しないときと同じ 404 not_found で返し、見えない要素の役割を照らさない（403 で存在を明かさない）。
// 索引は候補を出すだけで、要素ごとの照らしは表の本体を強い整合で読んだ値（ScopeReader.projectOfTarget）で行う（決定 14）

export type ProjectId = Id<"prj">;
export type TeamId = Id<"team">;

export type SeatRole = "owner" | "member";

export type Seat = { readonly teamId: TeamId; readonly role: SeatRole };

// チームに今割り当てたプロジェクト（本体を強い整合で読み直した値）
export type TeamProject = { readonly projectId: ProjectId; readonly teamId: TeamId };

// 要素の対象。project は対象のプロジェクトの行を強い整合で読んだ値で、teamId は今の割り当てのチーム（閉じたら null）
export type Target =
  | { readonly kind: "project"; readonly projectId: ProjectId; readonly teamId: TeamId | null }
  | { readonly kind: "team"; readonly teamId: TeamId }
  | { readonly kind: "user"; readonly userId: Id<"usr"> }
  // 今ある対象を指さない要素（作る操作・見える集まりで引く一覧）
  | { readonly kind: "none" };

// ランナーか手元のマシンに今割り当てたレーン
export type LaneAssignment = { readonly laneId: Id<"lane">; readonly projectId: ProjectId };

// 割り当てを移す途中のプロジェクトの、移す先のチーム
export type TransferTarget = { readonly projectId: ProjectId; readonly toTeamId: TeamId };

export type RunnerOrMachine = Extract<Principal, { kind: "runner" } | { kind: "machine" }>;

// 読み手（ポート）。中身は表の持ち主の子が apps/api/src/modules/ に書く（seatsOf は #4、laneOf は #6、isHumanOnlyItem は #8、
// projectsOfTeams・projectOfTarget・transferTargetOf は #5）。どれも、見えるべきでないものを返さない
// （索引の候補は表の本体を強い整合で読み直し、今も成り立つものだけを返す。迷うときは見せない）
export type ScopeReader = {
  // 利用者が今持つ席。user-seats の索引の候補を、席の行の強い整合の読みで確かめた分だけ
  seatsOf(userId: Id<"usr">): Promise<readonly Seat[]>;
  // チームに今割り当てたプロジェクト。team-projects の索引の候補を、プロジェクトの行の強い整合の読みで確かめた分だけ
  projectsOfTeams(teamIds: readonly TeamId[]): Promise<readonly TeamProject[]>;
  // 要素の対象。ID の形が操作と合わない・対象が無いときは null
  projectOfTarget(op: OperationDef, item: unknown): Promise<Target | null>;
  // ランナーか手元のマシンに今割り当てたレーン（レーンの行を強い整合で読む）
  laneOf(principal: RunnerOrMachine): Promise<readonly LaneAssignment[]>;
  // 要素が、割り当てを移す途中のプロジェクトの名前だけを読む要素なら、その移す先。ほかは null
  transferTargetOf(op: OperationDef, item: unknown): Promise<TransferTarget | null>;
  // 要素だけ人だけか（レッドラインに当たる問いなど）
  isHumanOnlyItem(op: OperationDef, item: unknown): Promise<boolean>;
};

export type ItemDenyReason = "not_found" | "role_insufficient" | "human_only";

export type ItemAuthz =
  | { readonly decision: "allow"; readonly projectId: ProjectId | null; readonly role: SeatRole | null }
  | { readonly decision: "deny"; readonly status: 404 | 403; readonly reason: ItemDenyReason };

export type AuthzDecision = { readonly reject: "human_only" | "scope_insufficient" } | { readonly items: readonly ItemAuthz[] };

// 見えない要素と無い要素は同じ値（本文も同じ）
const NOT_FOUND: ItemAuthz = Object.freeze({ decision: "deny", status: 404, reason: "not_found" });
const ROLE_INSUFFICIENT: ItemAuthz = Object.freeze({ decision: "deny", status: 403, reason: "role_insufficient" });
const HUMAN_ONLY: ItemAuthz = Object.freeze({ decision: "deny", status: 403, reason: "human_only" });

const DELEGATION_RANK: Record<DelegationKind, number> = { read: 0, run: 1, manage: 2 };

async function humanView(userId: Id<"usr">, scope: ScopeReader): Promise<{ seats: Map<TeamId, SeatRole>; visible: Set<ProjectId> }> {
  const seats = new Map((await scope.seatsOf(userId)).map((s) => [s.teamId, s.role] as const));
  const projects = seats.size === 0 ? [] : await scope.projectsOfTeams([...seats.keys()]);
  // 読み手が席の外のチームの行を返しても通さない
  const visible = new Set(projects.filter((p) => seats.has(p.teamId)).map((p) => p.projectId));
  return { seats, visible };
}

async function laneProjects(principal: RunnerOrMachine, scope: ScopeReader): Promise<Set<ProjectId>> {
  const lanes = await scope.laneOf(principal);
  // ランナーは自分のレーンの、token に結んだプロジェクトだけ
  const mine = principal.kind === "runner" ? lanes.filter((l) => l.laneId === principal.laneId && l.projectId === principal.projectId) : lanes;
  return new Set(mine.map((l) => l.projectId));
}

export async function visibleProjectIds(principal: Principal, scope: ScopeReader): Promise<readonly ProjectId[]> {
  switch (principal.kind) {
    case "human":
      return [...(await humanView(principal.userId, scope)).visible];
    case "delegation": {
      // 委任した人の今の集まりと委任の範囲の重なり。要求をまたいで控えない
      const { visible } = await humanView(principal.userId, scope);
      return principal.scope.projectIds.filter((id, i, all) => visible.has(id) && all.indexOf(id) === i);
    }
    case "runner":
    case "machine":
      return [...(await laneProjects(principal, scope))];
    case "db_prep":
      return [principal.projectId];
    case "newcomer":
    case "github":
    case "patrol":
      return [];
  }
}

// 要求全体の拒み。主体ごとに呼べる受け口と、委任の人だけ・種類の照らし
function requestReject(principal: Principal, op: OperationDef): "human_only" | "scope_insufficient" | null {
  switch (principal.kind) {
    case "human":
      return op.endpoint === "user" ? null : "scope_insufficient";
    case "delegation":
      if (op.endpoint !== "user") return "scope_insufficient";
      if (op.humanOnly === "always") return "human_only";
      if (op.delegationKind === null) return "human_only";
      return DELEGATION_RANK[principal.scope.operations] >= DELEGATION_RANK[op.delegationKind] ? null : "scope_insufficient";
    case "runner":
    case "machine":
    case "db_prep":
      return op.endpoint === principal.kind ? null : "scope_insufficient";
    case "newcomer":
      // まだ利用者へ結んでいない人は、利用者を作る sessions.create だけ
      return op.name === SESSIONS_CREATE ? null : "scope_insufficient";
    case "github":
    case "patrol":
      // 利用者向けの操作と、ほかの主体向けの経路を呼べない
      return "scope_insufficient";
  }
}

type View =
  | { readonly kind: "person"; readonly principal: Extract<Principal, { kind: "human" } | { kind: "delegation" }>; readonly seats: Map<TeamId, SeatRole>; readonly visible: Set<ProjectId> }
  | { readonly kind: "bound"; readonly visible: Set<ProjectId> };

async function viewOf(principal: Principal, scope: ScopeReader): Promise<View> {
  if (principal.kind === "human" || principal.kind === "delegation") {
    const { seats, visible } = await humanView(principal.userId, scope);
    const inScope = principal.kind === "delegation" ? new Set(principal.scope.projectIds) : null;
    return { kind: "person", principal, seats, visible: inScope === null ? visible : new Set([...visible].filter((id) => inScope.has(id))) };
  }
  return { kind: "bound", visible: new Set(await visibleProjectIds(principal, scope)) };
}

// 見えるか。見えれば対象のプロジェクトと役割、見えなければ null
async function visibility(view: View, op: OperationDef, item: unknown, target: Target, scope: ScopeReader): Promise<{ projectId: ProjectId | null; role: SeatRole | null } | null> {
  if (view.kind === "bound") {
    if (target.kind === "project") return view.visible.has(target.projectId) ? { projectId: target.projectId, role: null } : null;
    return target.kind === "none" ? { projectId: null, role: null } : null;
  }
  switch (target.kind) {
    case "project": {
      // 見える集まりに入り、かつ本体の今の割り当てのチームに席がある（索引の値だけで通さない）
      const role = target.teamId === null ? undefined : view.seats.get(target.teamId);
      if (view.visible.has(target.projectId) && role !== undefined) return { projectId: target.projectId, role };
      // I2 の例外: 割り当てを移す途中のプロジェクトの名前だけを読む要素は、移す先のチームの持ち主に通す
      const transfer = await scope.transferTargetOf(op, item);
      const inScope = view.principal.kind === "human" || view.principal.scope.projectIds.includes(target.projectId);
      if (transfer !== null && transfer.projectId === target.projectId && view.seats.get(transfer.toTeamId) === "owner" && inScope) {
        return { projectId: target.projectId, role: "owner" };
      }
      return null;
    }
    case "team": {
      const role = view.seats.get(target.teamId);
      return role === undefined ? null : { projectId: null, role };
    }
    case "user":
      return target.userId === view.principal.userId ? { projectId: null, role: null } : null;
    case "none":
      return { projectId: null, role: null };
  }
}

// 要素ごと: 見えない → 人だけの要素 → 役割 の順。見えない要素は役割を照らさない
async function itemAuthz(principal: Principal, view: View, op: OperationDef, item: unknown, scope: ScopeReader): Promise<ItemAuthz> {
  const target = await scope.projectOfTarget(op, item);
  if (target === null) return NOT_FOUND;
  const seen = await visibility(view, op, item, target, scope);
  if (seen === null) return NOT_FOUND;
  if (op.humanOnly === "per_item" && principal.kind === "delegation" && (await scope.isHumanOnlyItem(op, item))) return HUMAN_ONLY;
  if (op.ownerOnly && seen.role !== "owner") return ROLE_INSUFFICIENT;
  return { decision: "allow", projectId: seen.projectId, role: seen.role };
}

export async function authorize(principal: Principal, op: OperationDef, items: readonly unknown[], scope: ScopeReader, log?: Logger): Promise<AuthzDecision> {
  const reject = requestReject(principal, op);
  if (reject !== null) {
    log?.info("認可で要求全体を断った", { operation: op.name, principal: principal.kind, items: items.length, reason: reject });
    return { reject };
  }
  // 見える集まりは要求ごとに 1 回だけ求め、要素ごとに求め直さない
  const view = await viewOf(principal, scope);
  const results = await Promise.all(items.map((item) => itemAuthz(principal, view, op, item, scope)));
  const denied = results.filter((r): r is Extract<ItemAuthz, { decision: "deny" }> => r.decision === "deny");
  // 見えないプロジェクトの ID と絞る前の数は出さない（I2 の件数の出口）
  log?.info("認可を判定した", { operation: op.name, principal: principal.kind, items: items.length, denied: denied.length, reasons: [...new Set(denied.map((d) => d.reason))] });
  return { items: results };
}
