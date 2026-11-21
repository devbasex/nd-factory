import type { OperationDef } from "@nd-factory/contracts/operation";
import type { LaneAssignment, ScopeReader, Seat, SeatRole, Target, TeamId, TeamProject } from "../../src/authorize.ts";
import { parseId, type Id } from "../../src/ids.ts";
import type { FakeTable } from "./table.ts";

// 偽の ScopeReader。表の持ち主の子（#4・#5）が書く読み手の約束（決定 14）を、偽の表と偽の索引の上で満たす:
// 索引（user-seats・team-projects）で候補を読み、候補ごとに表の本体を強い整合で読み直して、今も成り立つものだけを返す。
// trustIndex を真にすると、約束を守らない読み手（索引の値をそのまま返す）になる。authorize が要素ごとの本体の読みで守るかを確かめる

export type FakeLane = { laneId: Id<"lane">; projectId: Id<"prj">; machineId?: Id<"mch"> };

export type FakeScopeOptions = {
  trustIndex?: boolean;
  lanes?: FakeLane[];
  // 名前だけを読む操作（I2 の例外の対象）
  nameOnlyOperations?: string[];
  // 読み手の失敗
  fail?: Error;
};

function record(item: unknown): Record<string, unknown> {
  return item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
}

export function fakeScope(table: FakeTable, options: FakeScopeOptions = {}): ScopeReader & { calls: string[] } {
  const calls: string[] = [];
  const guard = (name: string): void => {
    calls.push(name);
    if (options.fail !== undefined) throw options.fail;
  };

  return {
    calls,
    async seatsOf(userId) {
      guard("seatsOf");
      const candidates = await table.db.queryIndex("teams", "user-seats", { partition: { column: "user_id", value: userId } }, {});
      const seats: Seat[] = [];
      for (const c of candidates.items) {
        const teamId = c["team_id"] as TeamId;
        if (options.trustIndex === true) {
          seats.push({ teamId, role: c["role"] as SeatRole });
          continue;
        }
        const row = await table.db.get("teams", { pk: `TEAM#${teamId}`, sk: `SEAT#${userId}` }, true);
        if (row !== null) seats.push({ teamId, role: row["role"] as SeatRole });
      }
      return seats;
    },
    async projectsOfTeams(teamIds) {
      guard("projectsOfTeams");
      const out: TeamProject[] = [];
      for (const teamId of teamIds) {
        const candidates = await table.db.queryIndex("projects", "team-projects", { partition: { column: "current_team_id", value: teamId } }, {});
        for (const c of candidates.items) {
          const projectId = c["project_id"] as Id<"prj">;
          if (options.trustIndex === true) {
            out.push({ projectId, teamId });
            continue;
          }
          const row = await table.db.get("projects", { pk: `PROJECT#${projectId}`, sk: "PROJECT" }, true);
          if (row !== null && row["current_team_id"] === teamId) out.push({ projectId, teamId });
        }
      }
      return out;
    },
    async projectOfTarget(_op: OperationDef, item: unknown): Promise<Target | null> {
      guard("projectOfTarget");
      const fields = record(item);
      if ("project_id" in fields) {
        const projectId = parseId("prj", String(fields["project_id"]));
        if (projectId === null) return null;
        const row = await table.db.get("projects", { pk: `PROJECT#${projectId}`, sk: "PROJECT" }, true);
        if (row === null) return null;
        const team = row["current_team_id"];
        return { kind: "project", projectId, teamId: typeof team === "string" ? (team as TeamId) : null };
      }
      if ("team_id" in fields) {
        const teamId = parseId("team", String(fields["team_id"]));
        return teamId === null ? null : { kind: "team", teamId };
      }
      if ("user_id" in fields) {
        const userId = parseId("usr", String(fields["user_id"]));
        return userId === null ? null : { kind: "user", userId };
      }
      return { kind: "none" };
    },
    async laneOf(principal): Promise<readonly LaneAssignment[]> {
      guard("laneOf");
      const lanes = options.lanes ?? [];
      const mine = principal.kind === "runner" ? lanes.filter((l) => l.laneId === principal.laneId) : lanes.filter((l) => l.machineId === principal.machineId);
      return mine.map((l) => ({ laneId: l.laneId, projectId: l.projectId }));
    },
    async transferTargetOf(op, item) {
      guard("transferTargetOf");
      if (!(options.nameOnlyOperations ?? []).includes(op.name)) return null;
      const projectId = parseId("prj", String(record(item)["project_id"]));
      if (projectId === null) return null;
      const row = await table.db.get("projects", { pk: `PROJECT#${projectId}`, sk: "PROJECT" }, true);
      const to = record(row?.["transfer"])["to_team_id"];
      return typeof to === "string" ? { projectId, toTeamId: to as TeamId } : null;
    },
    async isHumanOnlyItem(_op, item) {
      guard("isHumanOnlyItem");
      const fields = record(item);
      const row = await table.db.get("decisions", { pk: `PROJECT#${String(fields["project_id"])}`, sk: `QUESTION#${String(fields["question_id"])}` }, true);
      return row?.["human_only"] === true;
    },
  };
}

// 偽の表へ席と割り当てを置く。索引も本体と同じに置く（遅れを真似るテストは後から索引だけを残す）
export function seedWorld(table: FakeTable, world: { seats: { teamId: TeamId; userId: Id<"usr">; role: SeatRole }[]; projects: { projectId: Id<"prj">; teamId: TeamId | null; transferTo?: TeamId }[] }): void {
  for (const s of world.seats) table.seed("teams", { pk: `TEAM#${s.teamId}`, sk: `SEAT#${s.userId}`, schema_version: 1, version: 1, team_id: s.teamId, user_id: s.userId, role: s.role });
  for (const p of world.projects) {
    table.seed("projects", {
      pk: `PROJECT#${p.projectId}`,
      sk: "PROJECT",
      schema_version: 1,
      version: 1,
      project_id: p.projectId,
      name: "acme",
      ...(p.teamId === null ? {} : { current_team_id: p.teamId }),
      ...(p.transferTo === undefined ? {} : { transfer: { to_team_id: p.transferTo } }),
    });
  }
  table.setIndex("teams", "user-seats", world.seats.map((s) => ({ user_id: s.userId, team_id: s.teamId, role: s.role })));
  table.setIndex("projects", "team-projects", world.projects.filter((p) => p.teamId !== null).map((p) => ({ current_team_id: p.teamId, project_id: p.projectId, name: "acme" })));
}
