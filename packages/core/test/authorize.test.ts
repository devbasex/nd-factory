import { describe, expect, it } from "vitest";
import type { Principal } from "../src/auth/authenticate.ts";
import { authorize, visibleProjectIds, type AuthzDecision, type ItemAuthz } from "../src/authorize.ts";
import { createLogger } from "../src/log.ts";
import {
  delegationsCreate,
  machineLanesPull,
  projectsGet,
  projectsRename,
  questionsAnswer,
  runnerEventsAppend,
  sessionsCreate,
  sprintsCreate,
  teamsRename,
} from "./fixtures/operations.ts";
import { fakeScope, seedWorld } from "./fakes/scope.ts";
import { fakeTable } from "./fakes/table.ts";

// 偽の表と偽の索引の上の偽の ScopeReader で判定を照らす。DynamoDB は呼ばない

const id = <K extends string>(kind: K, n: number) => `${kind}_01890a5d-ac96-774b-bcce-${n.toString(16).padStart(12, "0")}` as `${K}_${string}`;

const OWNER = id("usr", 1);
const MEMBER = id("usr", 2);
const OUTSIDER = id("usr", 3);
const TEAM_A = id("team", 10);
const TEAM_B = id("team", 11);
const P_A = id("prj", 20); // チーム A に割り当て
const P_B = id("prj", 21); // チーム B に割り当て
const P_MISSING = id("prj", 22); // 無いプロジェクト
const P_MOVING = id("prj", 23); // チーム B からチーム A へ移す途中
const LANE = id("lane", 30);
const MACHINE = id("mch", 40);

const human = (userId: `usr_${string}`): Principal => ({ kind: "human", userId, cognitoSub: `cognito-${userId}`, sessionId: `session-${userId}`, boundAuthTime: "2026-11-20T00:00:00.000Z", authTime: 1_795_000_000 });
const delegation = (userId: `usr_${string}`, projectIds: `prj_${string}`[], operations: "read" | "run" | "manage" = "manage"): Principal => ({
  kind: "delegation",
  userId,
  delegationId: id("dlg", 50),
  scope: { projectIds, operations },
  clientName: "acme-agent",
});

function world() {
  const table = fakeTable();
  seedWorld(table, {
    seats: [
      { teamId: TEAM_A, userId: OWNER, role: "owner" },
      { teamId: TEAM_A, userId: MEMBER, role: "member" },
      { teamId: TEAM_B, userId: id("usr", 4), role: "owner" },
    ],
    projects: [
      { projectId: P_A, teamId: TEAM_A },
      { projectId: P_B, teamId: TEAM_B },
      { projectId: P_MOVING, teamId: TEAM_B, transferTo: TEAM_A },
    ],
  });
  return table;
}

const items = (decision: AuthzDecision): readonly ItemAuthz[] => {
  if (!("items" in decision)) throw new Error(`要求全体で断った: ${decision.reject}`);
  return decision.items;
};

const NOT_FOUND = { decision: "deny", status: 404, reason: "not_found" };

// 受け入れ条件 3（I2）
describe("authorize: 割り当ての外の主体には存在しないときと同じ答え", () => {
  it("席のチームに割り当てたプロジェクトの要素は allow で、役割を持つ", async () => {
    const table = world();
    const result = items(await authorize(human(OWNER), projectsGet, [{ project_id: P_A }], fakeScope(table)));
    expect(result).toEqual([{ decision: "allow", projectId: P_A, role: "owner" }]);
  });

  it("割り当ての外の要素は 404 not_found で、無いプロジェクトと同じ答えになり、見えるときの答えと違う", async () => {
    const table = world();
    const scope = fakeScope(table);
    const outside = items(await authorize(human(OUTSIDER), projectsGet, [{ project_id: P_A }], scope));
    const missing = items(await authorize(human(OWNER), projectsGet, [{ project_id: P_MISSING }], scope));
    const visible = items(await authorize(human(OWNER), projectsGet, [{ project_id: P_A }], scope));
    expect(outside).toEqual([NOT_FOUND]);
    expect(outside).toEqual(missing);
    expect(JSON.stringify(outside)).toBe(JSON.stringify(missing));
    expect(outside).not.toEqual(visible);
  });

  it("別のチームに割り当てたプロジェクトは、席を持つ人にも 404", async () => {
    const table = world();
    expect(items(await authorize(human(OWNER), projectsGet, [{ project_id: P_B }], fakeScope(table)))).toEqual([NOT_FOUND]);
  });

  it("見える要素と見えない要素が混ざると、見えない要素だけが 404", async () => {
    const table = world();
    const result = items(await authorize(human(MEMBER), projectsGet, [{ project_id: P_A }, { project_id: P_B }, { project_id: P_MISSING }], fakeScope(table)));
    expect(result).toEqual([{ decision: "allow", projectId: P_A, role: "member" }, NOT_FOUND, NOT_FOUND]);
  });

  it("見えない要素では役割の 403 を返さない（持ち主だけの操作でも 404）", async () => {
    const table = world();
    expect(items(await authorize(human(OUTSIDER), projectsRename, [{ project_id: P_A }], fakeScope(table)))).toEqual([NOT_FOUND]);
    expect(items(await authorize(human(MEMBER), projectsRename, [{ project_id: P_B }], fakeScope(table)))).toEqual([NOT_FOUND]);
  });

  it("見える要素でメンバーが持ち主だけの操作を呼ぶと 403 role_insufficient、持ち主は allow", async () => {
    const table = world();
    const scope = fakeScope(table);
    expect(items(await authorize(human(MEMBER), projectsRename, [{ project_id: P_A }], scope))).toEqual([{ decision: "deny", status: 403, reason: "role_insufficient" }]);
    expect(items(await authorize(human(OWNER), projectsRename, [{ project_id: P_A }], scope))).toEqual([{ decision: "allow", projectId: P_A, role: "owner" }]);
  });

  it("ID の種類の頭が操作と合わない要素は 404", async () => {
    const table = world();
    expect(items(await authorize(human(OWNER), projectsGet, [{ project_id: id("team", 10) }, { project_id: "prj_x" }], fakeScope(table)))).toEqual([NOT_FOUND, NOT_FOUND]);
  });

  it("要素ごとの照らしは本体を強い整合で読む", async () => {
    const table = world();
    await authorize(human(OWNER), projectsGet, [{ project_id: P_A }], fakeScope(table));
    expect(table.reads.length).toBeGreaterThan(0);
    expect(table.reads.every((r) => r.consistent)).toBe(true);
  });
});

// 決定 14: 索引の遅れで、外した席や移した割り当てが見えない
describe("authorize: 索引に残った古い行で見せない", () => {
  it("索引に残った外した席（本体から消した）ではプロジェクトが見えない", async () => {
    const table = world();
    // 本体から席を消し、索引には残す
    table.remove("teams", { pk: `TEAM#${TEAM_A}`, sk: `SEAT#${MEMBER}` });
    const result = items(await authorize(human(MEMBER), projectsGet, [{ project_id: P_A }], fakeScope(table)));
    expect(result).toEqual([NOT_FOUND]);
    expect(await visibleProjectIds(human(MEMBER), fakeScope(table))).toEqual([]);
  });

  it("索引に残った移す前の割り当てでは、索引の値を信じる読み手でも見えない（要素ごとに本体を読む）", async () => {
    const table = world();
    // P_A を本体ではチーム B へ移し、索引にはチーム A のまま残す
    table.seed("projects", { pk: `PROJECT#${P_A}`, sk: "PROJECT", schema_version: 1, version: 2, project_id: P_A, current_team_id: TEAM_B });
    for (const scope of [fakeScope(table), fakeScope(table, { trustIndex: true })]) {
      expect(items(await authorize(human(OWNER), projectsGet, [{ project_id: P_A }], scope))).toEqual([NOT_FOUND]);
    }
  });

  it("閉じたプロジェクト（今の割り当てが無い）はだれにも見えない", async () => {
    const table = world();
    table.seed("projects", { pk: `PROJECT#${P_A}`, sk: "PROJECT", schema_version: 1, version: 2, project_id: P_A });
    expect(items(await authorize(human(OWNER), projectsGet, [{ project_id: P_A }], fakeScope(table, { trustIndex: true })))).toEqual([NOT_FOUND]);
  });
});

describe("authorize: 委任", () => {
  it("委任した人の集まりと委任の範囲の重なりだけが見える", async () => {
    const table = world();
    const scope = fakeScope(table);
    const result = items(await authorize(delegation(OWNER, [P_B, P_A]), projectsGet, [{ project_id: P_A }], scope));
    expect(result).toEqual([{ decision: "allow", projectId: P_A, role: "owner" }]);
    // 範囲の外は委任した人に見えても 404
    expect(items(await authorize(delegation(OWNER, []), projectsGet, [{ project_id: P_A }], scope))).toEqual([NOT_FOUND]);
  });

  it("委任した人がチームを外れた次の要求から見えない", async () => {
    const table = world();
    const scope = fakeScope(table);
    const principal = delegation(MEMBER, [P_A]);
    expect(items(await authorize(principal, projectsGet, [{ project_id: P_A }], scope))[0]).toMatchObject({ decision: "allow" });
    table.remove("teams", { pk: `TEAM#${TEAM_A}`, sk: `SEAT#${MEMBER}` });
    expect(items(await authorize(principal, projectsGet, [{ project_id: P_A }], scope))).toEqual([NOT_FOUND]);
  });

  it("人だけの操作は要求全体の 403 human_only で、読み手を呼ばない", async () => {
    const table = world();
    const scope = fakeScope(table);
    expect(await authorize(delegation(OWNER, [P_A]), delegationsCreate, [{}], scope)).toEqual({ reject: "human_only" });
    expect(scope.calls).toEqual([]);
  });

  it("委任の種類が操作の印より弱いと要求全体の 403 scope_insufficient", async () => {
    const table = world();
    const scope = fakeScope(table);
    expect(await authorize(delegation(OWNER, [P_A], "read"), sprintsCreate, [{ project_id: P_A }], scope)).toEqual({ reject: "scope_insufficient" });
    expect(await authorize(delegation(OWNER, [P_A], "run"), projectsRename, [{ project_id: P_A }], scope)).toEqual({ reject: "scope_insufficient" });
    expect(items(await authorize(delegation(OWNER, [P_A], "run"), sprintsCreate, [{ project_id: P_A }], scope))[0]).toMatchObject({ decision: "allow" });
  });

  it("要素だけ人だけのものは委任に 403 human_only、人には allow、見えない要素は 404 のまま", async () => {
    const table = world();
    const question = id("qst", 60);
    table.seed("decisions", { pk: `PROJECT#${P_A}`, sk: `QUESTION#${question}`, schema_version: 1, version: 1, human_only: true });
    table.seed("decisions", { pk: `PROJECT#${P_B}`, sk: `QUESTION#${question}`, schema_version: 1, version: 1, human_only: true });
    const scope = fakeScope(table);
    const item = { project_id: P_A, question_id: question };
    expect(items(await authorize(delegation(MEMBER, [P_A, P_B]), questionsAnswer, [item, { project_id: P_B, question_id: question }], scope))).toEqual([
      { decision: "deny", status: 403, reason: "human_only" },
      NOT_FOUND,
    ]);
    expect(items(await authorize(human(MEMBER), questionsAnswer, [item], scope))[0]).toMatchObject({ decision: "allow" });
  });
});

describe("authorize: 割り当てを移す途中（I2 の例外）", () => {
  it("移す先のチームの持ち主は、名前だけを読む操作の要素だけ通る", async () => {
    const table = world();
    const scope = fakeScope(table, { nameOnlyOperations: ["projects.get"] });
    expect(items(await authorize(human(OWNER), projectsGet, [{ project_id: P_MOVING }], scope))).toEqual([{ decision: "allow", projectId: P_MOVING, role: "owner" }]);
    expect(items(await authorize(human(OWNER), projectsRename, [{ project_id: P_MOVING }], scope))).toEqual([NOT_FOUND]);
    // 移す先のチームのメンバーと、移さないプロジェクトには効かない
    expect(items(await authorize(human(MEMBER), projectsGet, [{ project_id: P_MOVING }], scope))).toEqual([NOT_FOUND]);
    expect(items(await authorize(human(OWNER), projectsGet, [{ project_id: P_B }], scope))).toEqual([NOT_FOUND]);
  });

  it("移す先のチームの持ち主の委任には、委任の範囲に入れても通さない", async () => {
    const table = world();
    const scope = fakeScope(table, { nameOnlyOperations: ["projects.get"] });
    expect(items(await authorize(delegation(OWNER, [P_MOVING]), projectsGet, [{ project_id: P_MOVING }], scope))).toEqual([NOT_FOUND]);
  });
});

describe("authorize: チームと本人の対象", () => {
  it("チームの操作は席で判定し、席の無いチームは 404、メンバーの持ち主だけの操作は 403", async () => {
    const table = world();
    const scope = fakeScope(table);
    expect(items(await authorize(human(OWNER), teamsRename, [{ team_id: TEAM_A }], scope))).toEqual([{ decision: "allow", projectId: null, role: "owner" }]);
    expect(items(await authorize(human(OWNER), teamsRename, [{ team_id: TEAM_B }], scope))).toEqual([NOT_FOUND]);
    expect(items(await authorize(human(MEMBER), teamsRename, [{ team_id: TEAM_A }], scope))).toEqual([{ decision: "deny", status: 403, reason: "role_insufficient" }]);
  });

  it("本人の対象は本人だけが見え、ほかの人は 404", async () => {
    const table = world();
    const scope = fakeScope(table);
    expect(items(await authorize(human(MEMBER), projectsGet, [{ user_id: MEMBER }], scope))[0]).toMatchObject({ decision: "allow" });
    expect(items(await authorize(human(MEMBER), projectsGet, [{ user_id: OWNER }], scope))).toEqual([NOT_FOUND]);
  });
});

describe("authorize: ランナー・手元のマシン・DB セットアップ関数・GitHub・見回り", () => {
  const runner: Principal = { kind: "runner", laneId: LANE, projectId: P_A, generation: 1 };

  it("ランナーは自分向けの経路の、自分のレーンのプロジェクトの要素だけ", async () => {
    const table = world();
    const scope = fakeScope(table, { lanes: [{ laneId: LANE, projectId: P_A }] });
    expect(items(await authorize(runner, runnerEventsAppend, [{ project_id: P_A }], scope))).toEqual([{ decision: "allow", projectId: P_A, role: null }]);
    expect(items(await authorize(runner, runnerEventsAppend, [{ project_id: P_B }], scope))).toEqual([NOT_FOUND]);
    expect(await authorize(runner, projectsGet, [{ project_id: P_A }], scope)).toEqual({ reject: "scope_insufficient" });
  });

  it("手元のマシンは自分に割り当てたレーンのプロジェクトだけ", async () => {
    const table = world();
    const machine: Principal = { kind: "machine", teamId: TEAM_A, machineId: MACHINE };
    const scope = fakeScope(table, { lanes: [{ laneId: LANE, projectId: P_A, machineId: MACHINE }] });
    expect(await visibleProjectIds(machine, scope)).toEqual([P_A]);
    expect(items(await authorize(machine, machineLanesPull, [{ project_id: P_B }], scope))).toEqual([NOT_FOUND]);
  });

  it("DB セットアップ関数は呼び出しで渡されたプロジェクトだけが見え、操作の表の操作を呼べない", async () => {
    const table = world();
    const prep: Principal = { kind: "db_prep", projectId: P_A, prepId: "prep-1" };
    expect(await visibleProjectIds(prep, fakeScope(table))).toEqual([P_A]);
    expect(await authorize(prep, runnerEventsAppend, [{ project_id: P_A }], fakeScope(table))).toEqual({ reject: "scope_insufficient" });
    expect(await authorize(prep, projectsGet, [{ project_id: P_A }], fakeScope(table))).toEqual({ reject: "scope_insufficient" });
  });

  it("まだ結んでいない人は sessions.create だけを通り、見えるプロジェクトを持たない", async () => {
    const table = world();
    const newcomer: Principal = { kind: "newcomer", login: { cognitoSub: "cognito-sub-new", username: "google_cognito-sub-new", sessionId: "session-1", idp: "google", subject: "1234567890", authTime: 0 } };
    expect(await visibleProjectIds(newcomer, fakeScope(table))).toEqual([]);
    expect(items(await authorize(newcomer, sessionsCreate, [{}], fakeScope(table)))).toEqual([{ decision: "allow", projectId: null, role: null }]);
    expect(await authorize(newcomer, projectsGet, [{ project_id: P_A }], fakeScope(table))).toEqual({ reject: "scope_insufficient" });
  });

  it("GitHub と見回りは利用者向けの操作を要求全体で断られる", async () => {
    const table = world();
    for (const principal of [{ kind: "github" }, { kind: "patrol" }] as Principal[]) {
      expect(await authorize(principal, projectsGet, [{ project_id: P_A }], fakeScope(table))).toEqual({ reject: "scope_insufficient" });
    }
  });
});

describe("authorize: 読み手の失敗とログ", () => {
  it("読み手の失敗は投げる（呼び手が 503 unavailable にする）", async () => {
    const table = world();
    await expect(authorize(human(OWNER), projectsGet, [{ project_id: P_A }], fakeScope(table, { fail: new Error("down") }))).rejects.toThrow("down");
  });

  it("ログは操作の名前・要素の数・拒んだ数と理由だけで、プロジェクトの ID を出さない", async () => {
    const table = world();
    const lines: string[] = [];
    const log = createLogger({ request_id: "req-1", fn: "api", endpoint: "user" }, (l) => lines.push(l));
    await authorize(human(MEMBER), projectsGet, [{ project_id: P_A }, { project_id: P_B }], fakeScope(table), log);
    const record = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
    expect(record).toMatchObject({ operation: "projects.get", items: 2, denied: 1, reasons: ["not_found"] });
    expect(lines.join("\n")).not.toContain(P_A);
    expect(lines.join("\n")).not.toContain(P_B);
  });
});

describe("visibleProjectIds", () => {
  it("人は席を持つチームに今割り当てたプロジェクト、委任はその範囲との重なり", async () => {
    const table = world();
    const scope = fakeScope(table);
    expect([...(await visibleProjectIds(human(OWNER), scope))].sort()).toEqual([P_A].sort());
    expect(await visibleProjectIds(human(OUTSIDER), scope)).toEqual([]);
    expect(await visibleProjectIds(delegation(OWNER, [P_A, P_B, P_A]), scope)).toEqual([P_A]);
  });

  it("ランナーは自分のレーンのプロジェクトだけ（ほかのレーンを返しても入れない）", async () => {
    const table = world();
    const runner: Principal = { kind: "runner", laneId: LANE, projectId: P_A, generation: 1 };
    expect(await visibleProjectIds(runner, fakeScope(table, { lanes: [{ laneId: LANE, projectId: P_A }] }))).toEqual([P_A]);
    expect(await visibleProjectIds(runner, fakeScope(table, { lanes: [] }))).toEqual([]);
  });

  it("読み手の失敗を投げる", async () => {
    const table = world();
    await expect(visibleProjectIds(human(OWNER), fakeScope(table, { fail: new Error("down") }))).rejects.toThrow("down");
  });
});
