import type { ProjectId, ScopeReader, SeatRole, TeamId } from "./authorize.ts";
import type { Id } from "./ids.ts";

// 人（委任した人を含む）の今の席と、席のチームに今割り当てたプロジェクト。認可（authorize）と委任の認証の使った時刻の照らしが同じ式で読む。
// 要求をまたいで控えない
export type PersonScope = Pick<ScopeReader, "seatsOf" | "projectsOfTeams">;

export async function personView(userId: Id<"usr">, scope: PersonScope): Promise<{ seats: Map<TeamId, SeatRole>; visible: Set<ProjectId> }> {
  const seats = new Map((await scope.seatsOf(userId)).map((s) => [s.teamId, s.role] as const));
  const projects = seats.size === 0 ? [] : await scope.projectsOfTeams([...seats.keys()]);
  // 読み手が席の外のチームの行を返しても通さない
  const visible = new Set(projects.filter((p) => seats.has(p.teamId)).map((p) => p.projectId));
  return { seats, visible };
}
