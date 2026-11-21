import { describe, expect, it } from "vitest";
import { AUDIT_RETENTION_DAYS, AuditUnavailableError, appendAudit, auditItem, auditPartitionOf, type AuditEntry } from "../src/audit.ts";
import type { Principal } from "../src/auth/authenticate.ts";
import { createClock } from "../src/clock.ts";
import { putIfAbsent, WriteUnavailableError, writeAtomically } from "../src/conditional-write.ts";
import { leakedSecrets, SECRET_SAMPLES } from "./fixtures/secrets.ts";
import { projectsGet, projectsRename, sprintsCreate } from "./fixtures/operations.ts";
import { fakeTable } from "./fakes/table.ts";

// DynamoDB は呼ばない。記録の行は偽の表へ書き、行の中身を照らす

const AT = "2026-11-21T03:04:05.678Z";
const clock = createClock(() => Date.parse(AT));

const USER = "usr_01890a5d-ac96-774b-bcce-b302099a8057";
const PROJECT = "prj_01890a5d-ac96-774b-bcce-b302099a8058";
const TEAM = "team_01890a5d-ac96-774b-bcce-b302099a8059";
const AUDIT = "aud_01890a5d-ac96-774b-bcce-b302099a805a";

const human: Principal = { kind: "human", userId: USER };

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  auditId: AUDIT,
  requestId: "req-1",
  at: AT,
  actor: { principal: human, mcpClientName: null },
  channel: "screen",
  operation: "projects.rename",
  targetIds: { project_id: PROJECT },
  projectId: PROJECT,
  result: { outcome: "ok", status: 200, reasons: [] },
  itemIndex: 0,
  ...over,
});

describe("auditItem", () => {
  it("許した鍵だけを写した 1 行を、記録の表へ無いときだけ足す 1 件にする", () => {
    const item = auditItem(entry(), projectsRename, clock);
    expect(item).toMatchObject({ table: "audit", op: "put", condition: { kind: "not_exists", path: "pk" }, onConflict: "fail" });
    expect(item.item).toEqual({
      pk: `PROJECT#${PROJECT}`,
      sk: `${AT}#${AUDIT}#000`,
      schema_version: 1,
      audit_id: AUDIT,
      request_id: "req-1",
      at: AT,
      actor: { kind: "human", user_id: USER },
      channel: "screen",
      operation: "projects.rename",
      target_ids: [PROJECT],
      project_id: PROJECT,
      item_index: 0,
      result: { outcome: "ok", status: 200, reasons: [] },
      expire_at: Math.floor(Date.parse(AT) / 1000) + AUDIT_RETENTION_DAYS * 86_400,
    });
  });

  it("要約の行は要素の番号を持たず、並びの鍵が要素の行と重ならない", () => {
    const summary = auditItem(entry({ itemIndex: null }), projectsRename, clock);
    expect(summary.item?.sk).toBe(`${AT}#${AUDIT}`);
    expect(summary.item).not.toHaveProperty("item_index");
    expect(summary.key).not.toEqual(auditItem(entry(), projectsRename, clock).key);
  });

  it("見られたプロジェクトが無ければ主体の区切り、主体の無い 401 は日ごとの区切り", () => {
    expect(auditPartitionOf(entry({ projectId: null }))).toBe(`USER#${USER}`);
    expect(auditPartitionOf(entry({ projectId: null, actor: { principal: null, mcpClientName: null } }))).toBe("ANON#2026-11-21");
    expect(auditPartitionOf(entry({ projectId: null, actor: { principal: { kind: "machine", teamId: TEAM, machineId: "mch_01890a5d-ac96-774b-bcce-b302099a805b" }, mcpClientName: null } }))).toBe(`TEAM#${TEAM}`);
  });

  it("主体の無い 401 の行は主体の種類を空にする", () => {
    const item = auditItem(entry({ projectId: null, itemIndex: null, operation: null, actor: { principal: null, mcpClientName: null }, result: { outcome: "rejected", status: 401, reasons: ["unauthorized"] } }), null, clock);
    expect(item.item).toMatchObject({ pk: "ANON#2026-11-21", actor: { kind: null }, operation: "", target_ids: [], result: { outcome: "rejected", status: 401, reasons: ["unauthorized"] } });
  });

  it("委任の行は委任の ID とクライアントの名前と MCP の名乗りを持ち、委任の範囲を持たない", () => {
    const delegation: Principal = {
      kind: "delegation",
      userId: USER,
      delegationId: "dlg_01890a5d-ac96-774b-bcce-b302099a805c",
      scope: { projectIds: [PROJECT], operations: "run" },
      clientName: "acme-agent",
    };
    const item = auditItem(entry({ channel: "mcp", actor: { principal: delegation, mcpClientName: "acme-mcp" } }), projectsRename, clock);
    expect(item.item?.["actor"]).toEqual({ kind: "delegation", user_id: USER, delegation_id: "dlg_01890a5d-ac96-774b-bcce-b302099a805c", client_name: "acme-agent", mcp_client_name: "acme-mcp" });
  });

  // 受け入れ条件 4（I9）: 秘密の形の値が記録の行に残らない
  it("本文・秘密・メールを渡しても行に残らない", () => {
    const targetIds = {
      project_id: PROJECT,
      name: "acme secret project",
      email: "ops@example.com",
      token: SECRET_SAMPLES["delegation_token"],
      body: { note: SECRET_SAMPLES["github_app_token"] },
    };
    const item = auditItem(entry({ targetIds, result: { outcome: "partial", status: 200, reasons: ["not_found", `bad ${SECRET_SAMPLES["github_app_token"]}`] } }), projectsRename, clock);
    const text = JSON.stringify(item);
    expect(leakedSecrets(text)).toEqual([]);
    expect(text).not.toContain("ops@example.com");
    expect(text).not.toContain("acme secret project");
    expect(item.item?.["target_ids"]).toEqual([PROJECT]);
    expect(item.item?.["result"]).toEqual({ outcome: "partial", status: 200, reasons: ["not_found"] });
  });

  it("許した鍵の欄に秘密の形の値を入れても写さない", () => {
    const item = auditItem(entry({ targetIds: { project_id: SECRET_SAMPLES["github_app_token"] } }), projectsRename, clock);
    expect(leakedSecrets(JSON.stringify(item))).toEqual([]);
    expect(item.item?.["target_ids"]).toEqual([]);
  });

  it.each([
    ["メールアドレス", "ops@example.com"],
    ["呼び名", "Taro Yamada"],
    ["IP アドレス", "203.0.113.7"],
    ["頭の無い UUIDv7", "01890a5d-ac96-774b-bcce-b302099a8058"],
    ["集まりに無い頭", "foo_01890a5d-ac96-774b-bcce-b302099a8058"],
    ["大文字の ID", PROJECT.toUpperCase()],
  ])("許した鍵の欄に ID の形でない値（%s）を入れても写さない", (_label, value) => {
    const item = auditItem(entry({ targetIds: { project_id: value } }), projectsRename, clock);
    expect(JSON.stringify(item.item?.["target_ids"])).not.toContain(value);
    expect(item.item?.["target_ids"]).toEqual([]);
  });

  it("許した鍵の配列は ID の形の要素だけを写す", () => {
    const SPRINT = "spr_01890a5d-ac96-774b-bcce-b302099a805d";
    const item = auditItem(entry({ targetIds: { project_id: PROJECT, sprint_id: [SPRINT, "ops@example.com", 42] } }), sprintsCreate, clock);
    expect(item.item?.["target_ids"]).toEqual([PROJECT, SPRINT]);
  });

  it("委任のクライアントの名前に秘密の形の値を入れても伏せる", () => {
    const delegation: Principal = { kind: "delegation", userId: USER, delegationId: "dlg_01890a5d-ac96-774b-bcce-b302099a805c", scope: { projectIds: [], operations: "read" }, clientName: SECRET_SAMPLES["jwt"] ?? "" };
    const item = auditItem(entry({ actor: { principal: delegation, mcpClientName: SECRET_SAMPLES["machine_token"] ?? "" } }), projectsGet, clock);
    expect(leakedSecrets(JSON.stringify(item))).toEqual([]);
  });

  it("UTC でない時刻と負の要素の番号は投げる", () => {
    expect(() => auditItem(entry({ at: "2026-11-21T12:04:05+09:00" }), projectsGet, clock)).toThrow();
    expect(() => auditItem(entry({ itemIndex: -1 }), projectsGet, clock)).toThrow();
  });
});

describe("appendAudit", () => {
  it("1 行を追記する", async () => {
    const table = fakeTable();
    await appendAudit(table.db, entry({ itemIndex: null, operation: "projects.get" }), projectsGet, clock);
    expect(table.rows("audit")).toHaveLength(1);
  });

  it("断った要求の行を書く", async () => {
    const table = fakeTable();
    await appendAudit(table.db, entry({ itemIndex: null, result: { outcome: "rejected", status: 403, reasons: ["human_only"] } }), projectsRename, clock);
    expect(table.rows("audit")[0]).toMatchObject({ result: { outcome: "rejected", status: 403, reasons: ["human_only"] } });
  });

  it("書けなければ AuditUnavailableError を投げる", async () => {
    const table = fakeTable();
    table.failNext("unavailable");
    await expect(appendAudit(table.db, entry({ itemIndex: null }), projectsGet, clock)).rejects.toBeInstanceOf(AuditUnavailableError);
  });

  it("同じ記録の行が既にあれば上書きせず AuditUnavailableError を投げる", async () => {
    const table = fakeTable();
    await appendAudit(table.db, entry({ itemIndex: null }), projectsGet, clock);
    await expect(appendAudit(table.db, entry({ itemIndex: null, operation: "x" }), projectsGet, clock)).rejects.toBeInstanceOf(AuditUnavailableError);
    expect(table.rows("audit")[0]).toMatchObject({ operation: "projects.rename" });
  });
});

// 受け入れ条件 4（I9）: 記録の書き込みの失敗で操作が成功を返さない
describe("状態と記録を 1 つのトランザクションで書く", () => {
  const state = () => putIfAbsent({ table: "projects", item: { pk: `PROJECT#${PROJECT}`, sk: "PROJECT", schema_version: 1, version: 1, name: "acme" }, onConflict: "fail" });

  it("状態と記録の行がどちらも書かれる", async () => {
    const table = fakeTable();
    expect(await writeAtomically(table.db, [state(), auditItem(entry(), projectsRename, clock)])).toEqual({ ok: true });
    expect(table.rows("projects")).toHaveLength(1);
    expect(table.rows("audit")).toHaveLength(1);
  });

  it("記録の表に届かなければ投げ、状態も書かれない", async () => {
    const table = fakeTable();
    table.failNext("unavailable");
    const error = await writeAtomically(table.db, [state(), auditItem(entry(), projectsRename, clock)]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WriteUnavailableError);
    // 記録の行を含むため、呼び手は 503 audit_unavailable にする
    expect((error as WriteUnavailableError).includesAudit).toBe(true);
    expect(table.rows("projects")).toEqual([]);
    expect(table.rows("audit")).toEqual([]);
  });

  it("記録の行が書けない（条件の外れ）と ok にならず、状態も書かれない", async () => {
    const table = fakeTable();
    const audit = auditItem(entry(), projectsRename, clock);
    table.seed("audit", { ...audit.item });
    const outcome = await writeAtomically(table.db, [state(), audit]);
    expect(outcome).toEqual({ ok: false, failed: [{ index: 1, onConflict: "fail" }] });
    expect(table.rows("projects")).toEqual([]);
  });
});
