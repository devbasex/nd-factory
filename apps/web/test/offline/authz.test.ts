// @vitest-environment node
import { describe, expect, it } from "vitest";
import { addDenied, type AuthzRecord, judgeVisibility, type ListsRead, nextAuthz, withAuthzLock } from "../../src/offline/authz.ts";

const record = (over: Partial<AuthzRecord> = {}): AuthzRecord => ({
  generation: 1,
  allowedProjectIds: ["p-a"],
  listedSeq: 10,
  mismatchProjectIds: ["p-m"],
  mismatchSeq: 12,
  allowedTeamIds: ["t-a"],
  teamsSeq: 11,
  denied: [],
  ...over,
});

describe("記録との照合の表", () => {
  it.each([
    ["許すプロジェクトは番号によらず出す", { project: "p-a" }, 1, "show"],
    ["食い違いは mismatchSeq より後だけ", { project: "p-m" }, 13, "show"],
    ["食い違いの mismatchSeq の前は捨てる", { project: "p-m" }, 11, "drop"],
    ["どちらにも無いプロジェクトは listedSeq の後だけ", { project: "p-x" }, 11, "show"],
    ["listedSeq の前は捨てる", { project: "p-x" }, 9, "drop"],
    ["席のあるチームは出す", { team: "t-a" }, 1, "show"],
    ["席の無いチームは teamsSeq の後だけ", { team: "t-x" }, 12, "show"],
    ["teamsSeq の前は捨てる", { team: "t-x" }, 10, "drop"],
  ] as const)("%s", (_, target, fetchSeq, expected) => {
    expect(judgeVisibility(record(), target, fetchSeq)).toBe(expected);
  });

  it("denied は許す並びにあっても保留する", () => {
    const denied = record({ denied: [{ id: "p-a", deniedSeq: 5 }, { id: "t-a", deniedSeq: 5 }], allowedTeamIds: undefined });
    expect(judgeVisibility(denied, { project: "p-a" }, 100)).toBe("hold");
    expect(judgeVisibility(denied, { team: "t-a" }, 100)).toBe("hold");
  });

  it("記録が無ければ出し、allowedTeamIds が無ければチーム単位だけ照合しない", () => {
    expect(judgeVisibility(null, { project: "p-x" }, 0)).toBe("show");
    const noTeams = record({ allowedTeamIds: undefined, teamsSeq: undefined });
    expect(judgeVisibility(noTeams, { team: "t-x" }, 0)).toBe("show");
    expect(judgeVisibility(noTeams, { project: "p-x" }, 0)).toBe("drop");
  });
});

const read = (over: Partial<ListsRead> = {}): ListsRead => ({
  projects: [{ id: "p-a", teamId: "t-a" }],
  projectsStartSeq: 20,
  listedSeq: 21,
  teams: { ids: ["t-a"], startSeq: 22, endSeq: 23 },
  mismatchSeq: 24,
  ...over,
});

describe("記録の作り直し", () => {
  it("チームが無いプロジェクトは食い違いとして許す並びから外し、後の回で一致すれば解く", () => {
    const first = nextAuthz(null, read({ projects: [{ id: "p-a", teamId: "t-a" }, { id: "p-b", teamId: "t-gone" }] }));
    expect(first).toMatchObject({ generation: 1, allowedProjectIds: ["p-a"], mismatchProjectIds: ["p-b"], mismatchSeq: 24 });

    // 返らない回があっても食い違いに残す
    const second = nextAuthz(first, read());
    expect(second.mismatchProjectIds).toEqual(["p-b"]);

    const third = nextAuthz(second, read({ projects: [{ id: "p-b", teamId: "t-a" }] }));
    expect(third).toMatchObject({ generation: 3, allowedProjectIds: ["p-b"], mismatchProjectIds: [], mismatchSeq: null });
  });

  it("teams.list が一時の失敗なら食い違いとチームを引き継ぎ、mismatchSeq は listedSeq にする", () => {
    const prev = record();
    const next = nextAuthz(prev, read({ teams: null, projects: [{ id: "p-a", teamId: "t-a" }, { id: "p-m", teamId: "t-a" }] }));
    expect(next).toMatchObject({
      allowedProjectIds: ["p-a"],
      mismatchProjectIds: ["p-m"],
      mismatchSeq: 21,
      allowedTeamIds: ["t-a"],
      teamsSeq: 11,
    });
  });

  it("denied は、足した後に始めた読み出しで返ったものだけ除く", () => {
    const prev = addDenied(addDenied(record(), "p-a", 19), "t-a", 30);
    expect(prev.generation).toBe(3);
    const next = nextAuthz(prev, read());
    expect(next.denied).toEqual([{ id: "t-a", deniedSeq: 30 }]);
    expect(nextAuthz(addDenied(record(), "p-a", 20), read()).denied).toEqual([{ id: "p-a", deniedSeq: 20 }]);
    expect(nextAuthz(addDenied(record(), "t-a", 1), read({ teams: null })).denied).toHaveLength(1);
  });

  it("同じ ID を足し直すと番号を書き換える", () => {
    expect(addDenied(addDenied(record(), "p-a", 1), "p-a", 2).denied).toEqual([{ id: "p-a", deniedSeq: 2 }]);
  });
});

describe("nd-authz の錠", () => {
  it("exclusive と shared は重ならず、例外でも放す", async () => {
    const order: string[] = [];
    const writer = withAuthzLock("exclusive", async () => {
      order.push("write-start");
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      order.push("write-end");
      throw new Error("example");
    });
    const reader = withAuthzLock("shared", async () => order.push("read"));
    await expect(writer).rejects.toThrow("example");
    await reader;
    expect(order).toEqual(["write-start", "write-end", "read"]);
  });
});
