import { describe, expect, it } from "vitest";
import {
  DB_PREP_FAILURE_REASONS,
  DB_PREP_TIMING,
  type DbPrepTiming,
  PROGRESS_DB_IDENT_SHAPE,
  dbPrepInvocation,
  dbPrepOutcome,
} from "../src/db-prep.ts";

const PROJECT_ID = "prj_01935b4e-7c2a-7d10-8f3e-2b6f0c9a1d42";
const PREP_ID = "prep-00000000-0000-4000-8000-000000000001";

function create(): Record<string, unknown> {
  return { prep_id: PREP_ID, project_id: PROJECT_ID, kind: "create" };
}

function rotate(): Record<string, unknown> {
  return { prep_id: PREP_ID, project_id: PROJECT_ID, kind: "rotate", rotation_seq: 3 };
}

describe("dbPrepInvocation", () => {
  it("作るの呼び出しを受ける", () => {
    expect(dbPrepInvocation.parse(create())).toEqual(create());
  });

  it("差し替えの呼び出しを番号つきで受ける", () => {
    expect(dbPrepInvocation.parse(rotate())).toEqual(rotate());
    expect(dbPrepInvocation.safeParse({ ...rotate(), rotation_seq: 1 }).success).toBe(true);
  });

  it("作るで rotation_seq を持てば誤りにする", () => {
    expect(dbPrepInvocation.safeParse({ ...create(), rotation_seq: 1 }).success).toBe(false);
  });

  it("差し替えで rotation_seq が無ければ誤りにする", () => {
    const { rotation_seq: _seq, ...rest } = rotate();
    expect(dbPrepInvocation.safeParse(rest).success).toBe(false);
  });

  it.each([0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1])("差し替えの番号が 1 以上の整数でなければ誤りにする（%s）", (rotation_seq) => {
    expect(dbPrepInvocation.safeParse({ ...rotate(), rotation_seq }).success).toBe(false);
  });

  it.each([
    ["password", "example-password"],
    ["admin_secret", "example-admin"],
    ["database", "pdb_example1"],
    ["role", "prl_example1"],
    ["url", "postgresql://example.invalid/db"],
  ])("ほかの項目（%s）を持てば誤りにする", (key, value) => {
    expect(dbPrepInvocation.safeParse({ ...create(), [key]: value }).success).toBe(false);
    expect(dbPrepInvocation.safeParse({ ...rotate(), [key]: value }).success).toBe(false);
  });

  it("一覧に無い種類を誤りにする", () => {
    expect(dbPrepInvocation.safeParse({ ...create(), kind: "delete" }).success).toBe(false);
  });

  it.each(["", "team_01935b4e-7c2a-7d10-8f3e-2b6f0c9a1d42", "prj_01935b4e-7c2a-4d10-8f3e-2b6f0c9a1d42", "PRJ_01935B4E-7C2A-7D10-8F3E-2B6F0C9A1D42", 1])(
    "プロジェクトの ID の形でないと誤りにする（%s）",
    (project_id) => {
      expect(dbPrepInvocation.safeParse({ ...create(), project_id }).success).toBe(false);
    },
  );

  it.each(["", "a".repeat(129), "prep id", "prep/1", 1])("用意の ID の形でないと誤りにする（%s）", (prep_id) => {
    expect(dbPrepInvocation.safeParse({ ...create(), prep_id }).success).toBe(false);
  });

  it("用意の ID は 1 文字と 128 文字で通る", () => {
    expect(dbPrepInvocation.safeParse({ ...create(), prep_id: "a" }).success).toBe(true);
    expect(dbPrepInvocation.safeParse({ ...create(), prep_id: "a".repeat(128) }).success).toBe(true);
  });

  it("必須の項目が無ければ誤りにする", () => {
    for (const key of ["prep_id", "project_id", "kind"]) {
      const value = create();
      delete value[key];
      expect(dbPrepInvocation.safeParse(value).success).toBe(false);
    }
  });
});

describe("dbPrepOutcome", () => {
  it("3 つの result を受ける", () => {
    expect(dbPrepOutcome.parse({ result: "applied" })).toEqual({ result: "applied" });
    expect(dbPrepOutcome.parse({ result: "rotation_superseded", recorded_seq: 4 })).toEqual({
      result: "rotation_superseded",
      recorded_seq: 4,
    });
    expect(dbPrepOutcome.parse({ result: "failed", reason: "guard_conflict" })).toEqual({
      result: "failed",
      reason: "guard_conflict",
    });
  });

  it.each(DB_PREP_FAILURE_REASONS)("失敗の理由 %s を受ける", (reason) => {
    expect(dbPrepOutcome.safeParse({ result: "failed", reason }).success).toBe(true);
  });

  it("rotation_superseded で recorded_seq が無ければ誤りにする", () => {
    expect(dbPrepOutcome.safeParse({ result: "rotation_superseded" }).success).toBe(false);
  });

  it.each([0, 1.5, "4"])("recorded_seq が 1 以上の整数でなければ誤りにする（%s）", (recorded_seq) => {
    expect(dbPrepOutcome.safeParse({ result: "rotation_superseded", recorded_seq }).success).toBe(false);
  });

  it("failed で reason が無ければ誤りにする", () => {
    expect(dbPrepOutcome.safeParse({ result: "failed" }).success).toBe(false);
  });

  it("一覧に無い理由を誤りにする", () => {
    expect(dbPrepOutcome.safeParse({ result: "failed", reason: "timeout" }).success).toBe(false);
  });

  it("result に合わない項目を持てば誤りにする", () => {
    expect(dbPrepOutcome.safeParse({ result: "applied", recorded_seq: 1 }).success).toBe(false);
    expect(dbPrepOutcome.safeParse({ result: "applied", reason: "sql_failed" }).success).toBe(false);
    expect(dbPrepOutcome.safeParse({ result: "rotation_superseded", recorded_seq: 1, reason: "sql_failed" }).success).toBe(false);
    expect(dbPrepOutcome.safeParse({ result: "failed", reason: "sql_failed", recorded_seq: 1 }).success).toBe(false);
    expect(dbPrepOutcome.safeParse({ result: "failed", reason: "sql_failed", password: "example-password" }).success).toBe(false);
  });

  it("一覧に無い result を誤りにする", () => {
    expect(dbPrepOutcome.safeParse({ result: "skipped" }).success).toBe(false);
  });
});

describe("DB_PREP_FAILURE_REASONS", () => {
  it("4 つの理由をこの順で持つ", () => {
    expect(DB_PREP_FAILURE_REASONS).toEqual(["data_api_unavailable", "guard_conflict", "connections_remain", "sql_failed"]);
  });
});

describe("PROGRESS_DB_IDENT_SHAPE", () => {
  it.each(["pdb_abcd", "a1234567", `a${"b".repeat(62)}`, "role_0123456789"])("名前の形に合う（%s）", (name) => {
    expect(PROGRESS_DB_IDENT_SHAPE.test(name)).toBe(true);
  });

  it.each(["abcdefg", `a${"b".repeat(63)}`, "1abcdefgh", "_abcdefgh", "Abcdefgh", "abcd-efgh", "abcd efgh", "abcdefgh\n", "postgres;drop"])(
    "名前の形に合わない（%j）",
    (name) => {
      expect(PROGRESS_DB_IDENT_SHAPE.test(name)).toBe(false);
    },
  );
});

describe("DB_PREP_TIMING", () => {
  // 見回りの間隔（決定 9）。期限を過ぎた行を見回りが拾う前に、前の呼び出しが DB へ働き終えている余裕として照らす
  const PATROL_INTERVAL_SECONDS = 300;
  // Lambda の非同期の呼び出しの MaximumEventAgeInSeconds の最小
  const MIN_EVENT_AGE_SECONDS = 60;

  function latestEffectSeconds(t: DbPrepTiming): number {
    return t.maxEventAgeSeconds + t.functionTimeoutSeconds + Math.max(t.dataApiCallSeconds, t.dataApiTxIdleSeconds);
  }

  function holds(t: DbPrepTiming): boolean {
    return latestEffectSeconds(t) < t.prepDeadlineSeconds && t.prepDeadlineSeconds - latestEffectSeconds(t) >= PATROL_INTERVAL_SECONDS;
  }

  it("値は設計の表のとおり", () => {
    expect(DB_PREP_TIMING).toEqual({
      maxEventAgeSeconds: 60,
      functionTimeoutSeconds: 300,
      dataApiCallSeconds: 45,
      dataApiTxIdleSeconds: 180,
      prepDeadlineSeconds: 900,
    });
  });

  it("前の呼び出しが DB へ働きうる最も遅い時刻（540 秒）は期限（900 秒）より短い", () => {
    expect(latestEffectSeconds(DB_PREP_TIMING)).toBe(540);
    expect(latestEffectSeconds(DB_PREP_TIMING)).toBeLessThan(DB_PREP_TIMING.prepDeadlineSeconds);
  });

  it("待ち行列の最大の年齢は MaximumEventAgeInSeconds の最小の 60 秒", () => {
    expect(DB_PREP_TIMING.maxEventAgeSeconds).toBe(MIN_EVENT_AGE_SECONDS);
  });

  it("期限と最も遅い時刻の差は見回りの間隔 300 秒以上", () => {
    expect(DB_PREP_TIMING.prepDeadlineSeconds - latestEffectSeconds(DB_PREP_TIMING)).toBeGreaterThanOrEqual(PATROL_INTERVAL_SECONDS);
    expect(holds(DB_PREP_TIMING)).toBe(true);
  });

  it.each([540, 500, 839])("期限を %s 秒に縮めると照らしが落ちる", (prepDeadlineSeconds) => {
    expect(holds({ ...DB_PREP_TIMING, prepDeadlineSeconds })).toBe(false);
  });

  it.each([541, 600])("関数の時間切れを %s 秒に延ばすと照らしが落ちる", (functionTimeoutSeconds) => {
    expect(holds({ ...DB_PREP_TIMING, functionTimeoutSeconds })).toBe(false);
  });

  it("変えられない値にしてある", () => {
    expect(Object.isFrozen(DB_PREP_TIMING)).toBe(true);
    expect(Object.isFrozen(DB_PREP_FAILURE_REASONS)).toBe(true);
  });
});
