import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type RowKey, SEQ_DIGITS, seqKey } from "../src/rows/common.ts";
import { decisionState, deliveryState } from "../src/rows/decisions.ts";
import { destinationKind, noticeKind } from "../src/rows/notices.ts";
import { segmentResult, sprintState } from "../src/rows/sprints.ts";
import { seatRole } from "../src/rows/teams.ts";
import { usageKind } from "../src/rows/usage.ts";
import { idp } from "../src/rows/users.ts";
import { defineTables, TABLE_PURPOSES, TABLES, type TableSpec, TableSpecError } from "../src/tables.ts";
import { AT, id, LANE, PRJ, ROW_CASES, USR } from "./fixtures/rows.ts";

// 19 の行と、全体の設計が列を決めた 6 つの行（IdP の主体の一意の行・プロジェクト・割り当て・レーン・承認の依頼・操作の記録）
const DETAIL_ROWS = [
  "user",
  "login",
  "delegation",
  "team",
  "seat",
  "invitation",
  "machine",
  "usage_month",
  "repository",
  "github_token",
  "sprint",
  "segment",
  "progress_event",
  "question",
  "answer",
  "notice",
  "destination",
  "cost_record",
  "idempotency",
];
const OVERALL_ROWS = ["login_subject", "project", "assignment", "lane", "approval", "audit"];
// 認証（Cognito の sub から利用者を引く読み手）のために足した行。19 の行に数えない
const AUTH_ROWS = ["cognito_subject"];

const ajv = new Ajv2020({ strict: true, validateFormats: false });

function without(row: Readonly<Record<string, unknown>>, column: string): Record<string, unknown> {
  const { [column]: _dropped, ...rest } = row;
  return rest;
}

function keyOf(name: string, row: unknown): RowKey {
  const c = ROW_CASES[name];
  if (c === undefined) throw new Error(`行の種類が無い: ${name}`);
  return (c.keyOf as (r: unknown) => RowKey)(row);
}

function tableOfRow(name: string): TableSpec {
  const spec = Object.values(TABLES).find((t) => t.rows.some((r) => r.name === name));
  if (spec === undefined) throw new Error(`行の種類の表が無い: ${name}`);
  return spec;
}

const cases = Object.entries(ROW_CASES);

describe("行の形（受け入れ条件 8）", () => {
  it("19 の行と全体の設計の 6 つの行と認証の行がそろい、どの表の行の種類とも 1 対 1 に当たる", () => {
    expect(DETAIL_ROWS).toHaveLength(19);
    expect(Object.keys(ROW_CASES).sort()).toEqual([...DETAIL_ROWS, ...OVERALL_ROWS, ...AUTH_ROWS].sort());
    const specRows = Object.values(TABLES).flatMap((t) => t.rows.map((r) => r.name));
    expect(specRows.sort()).toEqual(Object.keys(ROW_CASES).sort());
  });

  it.each(cases)("%s: 作り物の行が通り、JSON Schema の検証と結果が合う", (_name, c) => {
    expect(c.schema.safeParse(c.sample).success).toBe(true);
    const validate = ajv.compile(z.toJSONSchema(c.schema));
    expect(validate(c.sample)).toBe(true);
  });

  it.each(cases)("%s: schema_version の無い行が落ちる", (_name, c) => {
    const row = without(c.sample, "schema_version");
    expect(c.schema.safeParse(row).success).toBe(false);
    expect(ajv.compile(z.toJSONSchema(c.schema))(row)).toBe(false);
  });

  it.each(cases.filter(([, c]) => c.overwrite))("%s: 上書きの行で version の無い行が落ちる", (_name, c) => {
    const row = without(c.sample, "version");
    expect(c.schema.safeParse(row).success).toBe(false);
    expect(ajv.compile(z.toJSONSchema(c.schema))(row)).toBe(false);
  });

  it("上書きの行は表の仕様の overwrite の行と一致する", () => {
    const overwrite = Object.values(TABLES).flatMap((t) => t.rows.filter((r) => r.writes === "overwrite").map((r) => r.name));
    expect(overwrite.sort()).toEqual(cases.filter(([, c]) => c.overwrite).map(([name]) => name).sort());
  });

  it.each(cases)("%s: 知らない列を落として読む", (_name, c) => {
    const parsed = c.schema.parse({ ...c.sample, next_only: "x" }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("next_only");
  });

  it.each(cases)("%s: 鍵を組めて、並びの鍵が表の行の種類のうち最初に当たるものが自分である", (name, c) => {
    const key = keyOf(name, c.schema.parse(c.sample));
    const spec = tableOfRow(name);
    expect(key.pk.length).toBeGreaterThan(0);
    if (spec.sortKey === null) {
      expect(key.sk).toBeNull();
      return;
    }
    expect(key.sk).not.toBeNull();
    const hit = spec.rows.find((r) => r.skPattern?.test(key.sk ?? "") === true);
    expect(hit?.name).toBe(name);
  });

  it("空を許す列を持った行も通る", () => {
    const full = {
      ...ROW_CASES["delegation"]?.sample,
      last_used_at: AT,
      revoked_at: AT,
    };
    expect(ROW_CASES["delegation"]?.schema.safeParse(full).success).toBe(true);
    const team = { ...ROW_CASES["team"]?.sample, monthly_cap: { amount_minor: 10000, currency: "JPY" } };
    expect(ROW_CASES["team"]?.schema.safeParse(team).success).toBe(true);
    const question = {
      ...ROW_CASES["question"]?.sample,
      options: [{ key: "done", label: "済んだ", description: "" }],
      recommended: "done",
      answer_id: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
      delivery: "pending",
      waiting_since: AT,
    };
    expect(ROW_CASES["question"]?.schema.safeParse(question).success).toBe(true);
  });

  it.each([
    ["user", "created_at"],
    ["sprint", "started_at"],
    ["notice", "occurred_at"],
    ["audit", "at"],
  ])("%s の %s: 時刻帯の無い日時が落ちる", (name, column) => {
    const c = ROW_CASES[name];
    expect(c?.schema.safeParse({ ...c.sample, [column]: "2026-11-17T03:04:05" }).success).toBe(false);
    expect(c?.schema.safeParse({ ...c.sample, [column]: "2026-11-17T12:04:05+09:00" }).success).toBe(false);
  });

  it("通貨の無い金額が落ちる（I15）", () => {
    const cost = ROW_CASES["cost_record"];
    expect(cost?.schema.safeParse({ ...cost.sample, amount: { amount_minor: 100 } }).success).toBe(false);
    const team = ROW_CASES["team"];
    expect(team?.schema.safeParse({ ...team.sample, monthly_cap: { amount_minor: 100 } }).success).toBe(false);
    // 月の使った量は 2 列で持ち、どちらかが欠けると落ちる
    const usage = ROW_CASES["usage_month"];
    expect(usage?.schema.safeParse(without(usage.sample, "used_currency")).success).toBe(false);
    expect(usage?.schema.safeParse(without(usage.sample, "used_amount_minor")).success).toBe(false);
    expect(usage?.schema.safeParse({ ...usage.sample, used_amount_minor: 1.5 }).success).toBe(false);
  });

  it("Cognito の主体の対応の行は状態を持たず、結んだ利用者と結んだ時のサインインの時刻を必須にする", () => {
    const c = ROW_CASES["cognito_subject"];
    if (c === undefined) throw new Error("cognito_subject が無い");
    const validate = ajv.compile(z.toJSONSchema(c.schema));
    expect(c.schema.safeParse(c.sample).success).toBe(true);
    expect(validate(c.sample)).toBe(true);
    const rejected = ["cognito_sub", "cognito_username", "idp", "subject", "user_id", "bound_auth_time", "version"].map((column) => without(c.sample, column));
    rejected.push({ ...c.sample, bound_auth_time: "2026-11-21T12:04:05+09:00" }, { ...c.sample, idp: "okta" });
    for (const row of rejected) {
      expect(c.schema.safeParse(row).success).toBe(false);
      expect(validate(row)).toBe(false);
    }
  });

  it("形の版が整数の 1 でない行が落ちる", () => {
    const c = ROW_CASES["user"];
    for (const v of [0, 2, "1", 1.5]) expect(c?.schema.safeParse({ ...c.sample, schema_version: v }).success).toBe(false);
  });

  it("状態と種類の値は英小文字の識別子で持つ（決定 15）", () => {
    expect(sprintState.options).toEqual(["running", "finished", "stopped", "canceled"]);
    expect(decisionState.options).toEqual(["waiting", "answered", "canceled"]);
    expect(deliveryState.options).toEqual(["pending", "delivering", "delivered", "failed"]);
    expect(segmentResult.options).toEqual(["done", "needs_decision", "failed"]);
    expect(seatRole.options).toEqual(["owner", "member"]);
    expect(idp.options).toEqual(["google", "github"]);
    expect(destinationKind.options).toEqual(["web_push", "slack"]);
    expect(usageKind.options).toEqual(["compute", "inference", "byok_inference", "machine_time"]);
    expect(noticeKind.options).toEqual(["approval", "question", "sprint_finished", "sprint_stopped", "cap_reached"]);
    const lane = ROW_CASES["lane"];
    expect(lane?.schema.safeParse({ ...lane.sample, state: "動いている" }).success).toBe(false);
  });

  it("鍵は行の列から組む", () => {
    expect(keyOf("seat", ROW_CASES["seat"]?.sample)).toEqual({ pk: `TEAM#${id("team", 2)}`, sk: `SEAT#${USR}` });
    expect(keyOf("progress_event", { ...ROW_CASES["progress_event"]?.sample, seq: 12 })).toEqual({ pk: `PROJECT#${PRJ}#LANE#${LANE}`, sk: `SEQ#${"12".padStart(SEQ_DIGITS, "0")}` });
    expect(keyOf("answer", { ...ROW_CASES["answer"]?.sample, parent_id: id("qst", 11) }).sk).toMatch(/^QUESTION#qst_.+#ANSWER#/);
    expect(keyOf("idempotency", ROW_CASES["idempotency"]?.sample).sk).toBeNull();
    expect(keyOf("audit", { ...ROW_CASES["audit"]?.sample, actor: { kind: null } }).pk).toBe("ANON#2026-11-17");
    expect(keyOf("audit", { ...ROW_CASES["audit"]?.sample, project_id: PRJ }).pk).toBe(`PROJECT#${PRJ}`);
  });

  it("並びの鍵の連番は 0 で埋め、文字の並びが数の並びと同じになる", () => {
    expect(seqKey(9) < seqKey(10)).toBe(true);
    expect(() => seqKey(-1)).toThrow(RangeError);
    expect(() => seqKey(1.5)).toThrow(RangeError);
    expect(() => seqKey(10 ** SEQ_DIGITS)).toThrow(RangeError);
  });
});

describe("TABLES", () => {
  it("10 の表の名前の末尾・鍵・TTL の列が詳細設計と一致する", () => {
    expect(Object.keys(TABLES)).toEqual([...TABLE_PURPOSES]);
    for (const spec of Object.values(TABLES)) {
      expect(spec.suffix).toBe(`db-${spec.purpose}`);
      expect(spec.partitionKey).toBe("pk");
      expect(spec.sortKey).toBe(spec.purpose === "idempotency" ? null : "sk");
    }
    const ttl = Object.values(TABLES).filter((t) => t.ttlAttribute === "expire_at").map((t) => t.purpose);
    expect(ttl.sort()).toEqual(["audit", "idempotency", "projects"]);
  });

  it("3 つの索引の鍵と写す列が詳細設計と一致する", () => {
    const indexes = Object.values(TABLES).flatMap((t) => t.indexes.map((i) => ({ table: t.purpose, ...i })));
    expect(indexes).toEqual([
      { table: "teams", name: "user-seats", partitionKey: "user_id", sortKey: "team_id", projection: ["role"] },
      { table: "projects", name: "team-projects", partitionKey: "current_team_id", sortKey: "project_id", projection: ["name", "current_assign_id"] },
      { table: "decisions", name: "waiting", partitionKey: "project_id", sortKey: "waiting_since", projection: ["sprint_id", "lane_id", "gate", "category"] },
    ]);
  });

  it("索引の鍵と写す列は、その表の行の列にある", () => {
    for (const spec of Object.values(TABLES)) {
      for (const index of spec.indexes) {
        const columns = spec.rows.flatMap((r) => Object.keys((ROW_CASES[r.name]?.schema as z.ZodObject).shape));
        for (const column of [index.partitionKey, index.sortKey, ...index.projection]) expect(columns).toContain(column);
      }
    }
  });

  it("db-teams で user_id の列を持つのは席の行だけ", () => {
    const holders = TABLES.teams.rows.filter((r) => "user_id" in (ROW_CASES[r.name]?.schema as z.ZodObject).shape).map((r) => r.name);
    expect(holders).toEqual(["seat"]);
  });

  it("TTL の列を持つ表の、TTL の列を持つ行が詳細設計と一致する", () => {
    const holders = Object.values(TABLES).flatMap((t) => t.rows.filter((r) => "expire_at" in (ROW_CASES[r.name]?.schema as z.ZodObject).shape).map((r) => r.name));
    expect(holders.sort()).toEqual(["audit", "github_token", "idempotency"]);
  });

  const base = Object.values(TABLES);

  it("同じ索引の名前の重なりで投げる", () => {
    const dup = base.map((t) => (t.purpose === "usage" ? { ...t, indexes: [{ name: "waiting", partitionKey: "project_id", sortKey: "occurred_at", projection: [] }] } : t));
    expect(() => defineTables(dup)).toThrow(TableSpecError);
  });

  it("名前の末尾・行の種類の名前の重なり・表の欠けで投げる", () => {
    expect(() => defineTables(base.map((t) => (t.purpose === "usage" ? { ...t, suffix: "db-audit" } : t)))).toThrow(TableSpecError);
    expect(() => defineTables(base.map((t) => (t.purpose === "usage" ? { ...t, rows: [{ name: "audit", skPattern: /^COST#/, writes: "append" as const }] } : t)))).toThrow(TableSpecError);
    expect(() => defineTables(base.filter((t) => t.purpose !== "usage"))).toThrow(TableSpecError);
  });

  it("並びの鍵の有無と行の種類の skPattern が合わないと投げる", () => {
    expect(() => defineTables(base.map((t) => (t.purpose === "idempotency" ? { ...t, rows: [{ name: "idempotency", skPattern: /.*/, writes: "settle_once" as const }] } : t)))).toThrow(TableSpecError);
    expect(() => defineTables(base.map((t) => (t.purpose === "usage" ? { ...t, rows: [{ name: "cost_record", skPattern: null, writes: "append" as const }] } : t)))).toThrow(TableSpecError);
  });
});
