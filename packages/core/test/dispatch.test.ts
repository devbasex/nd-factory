import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthSetup, DelegationRecord, Principal } from "../src/auth/authenticate.ts";
import type { ScopeReader } from "../src/authorize.ts";
import { createClock } from "../src/clock.ts";
import { cond, putIfAbsent, replaceIfVersion, type TransactItem } from "../src/conditional-write.ts";
import type { StoredRow } from "../src/db.ts";
import { DISPATCH_REBUILD_LIMIT, DISPATCH_RESERVE_MS, DISPATCH_SUMMARY_MS, dispatch, readHttpCall, type DispatchDeps, type DispatchResult, type Handler, type HttpEvent, type OperationCall } from "../src/dispatch/dispatch.ts";
import { createLogger } from "../src/log.ts";
import { DISPATCH_OPERATIONS, NOTE_INCARNATION, NOTE_KEY, noteHandlers } from "./fixtures/dispatch.ts";
import { projectsGet } from "./fixtures/operations.ts";
import { leakedSecrets, SECRET_SAMPLES } from "./fixtures/secrets.ts";
import { fakeScope, seedWorld } from "./fakes/scope.ts";
import { fakeTable, type FakeTable } from "./fakes/table.ts";

// DynamoDB と IdP には触れない。表は偽の表、主体は偽の読み手で決める（人は偽の Cognito の照らしと偽の表の対応の行、委任は偽の委任の行）か、渡した主体

const NOW = Date.parse("2026-11-21T03:04:05.000Z");

const id = <K extends string>(kind: K, n: number) => `${kind}_01890a5d-ac96-774b-bcce-${n.toString(16).padStart(12, "0")}` as `${K}_${string}`;

const OWNER = id("usr", 1);
const CREATED = id("usr", 2);
const TEAM_A = id("team", 10);
const TEAM_B = id("team", 11);
const P_A = id("prj", 20);
const P_B = id("prj", 21);
const DELEGATION = id("dlg", 30);
const IDEM_1 = "0193a1b2-0000-7000-8000-000000000001";
const IDEM_2 = "0193a1b2-0000-7000-8000-000000000002";

// 要求元のサインイン
const SUB = "acme-sub-1";
const OTHER_SUB = "acme-sub-2";
const SESSION = "acme-jti-1";
const BOUND_AT = "2026-11-21T03:00:00.000Z";
const AUTH_TIME = Date.parse(BOUND_AT) / 1000;
const HUMAN_TOKEN = "eyJhbGciOiJSUzI1NiJ9.e30.c2ln";
const BINDING_KEY = { pk: `COGNITO#${SUB}`, sk: "COGNITO" };
const REVOKED_KEY = { pk: `COGNITO#${SUB}`, sk: `REVOKED#${SESSION}` };

const human: Principal = { kind: "human", userId: OWNER, cognitoSub: SUB, sessionId: SESSION, boundAuthTime: BOUND_AT, authTime: AUTH_TIME };
const delegate = (operations: "read" | "run" | "manage", projectIds = [P_A]): Principal => ({ kind: "delegation", userId: OWNER, delegationId: DELEGATION, scope: { projectIds, operations }, clientName: "acme-agent" });

const SECRET = randomBytes(32).toString("base64url");
const DELEGATION_TOKEN = `ndfd_${OWNER}.${DELEGATION}.${SECRET}`;
// 委任の行の世代（作り物の値）。偽の表の委任の行と、読み手が返す保存の値で同じにする
const DELEGATION_INCARNATION = "3f6c1a2b-4d5e-4f70-8a9b-0c1d2e3f4a5b";
const delegationRecord = (operations: "read" | "run" | "manage" = "read"): DelegationRecord => ({
  secretSha256: createHash("sha256").update(SECRET).digest("hex"),
  expiresAt: new Date(NOW + 86_400_000).toISOString(),
  revokedAt: null,
  scope: { projectIds: [P_A], operations },
  clientName: "acme-agent",
  stored: { version: { kind: "value", value: 1 }, incarnation: { kind: "value", value: DELEGATION_INCARNATION } },
});

type Setup = { table: FakeTable; deps: DispatchDeps; lines: string[]; readerCalls: string[]; authzItems: unknown[] };

const bindingRow = (sub: string, userId = OWNER, boundAt = BOUND_AT) => ({ pk: `COGNITO#${sub}`, sk: "COGNITO", schema_version: 1, version: 1, cognito_sub: sub, user_id: userId, bound_auth_time: boundAt });

function setup(opts: { handlers?: Record<string, Handler>; delegation?: DelegationRecord | null; readerFail?: Error } = {}): Setup {
  const table = fakeTable();
  seedWorld(table, {
    seats: [{ teamId: TEAM_A, userId: OWNER, role: "owner" }],
    projects: [
      { projectId: P_A, teamId: TEAM_A },
      { projectId: P_B, teamId: TEAM_B },
    ],
  });
  table.seed("users", bindingRow(SUB));
  table.seed("users", bindingRow(OTHER_SUB));
  table.seed("users", { pk: `USER#${OWNER}`, sk: `DELEGATION#${DELEGATION}`, schema_version: 1, version: 1, incarnation: DELEGATION_INCARNATION });
  const lines: string[] = [];
  const readerCalls: string[] = [];
  const authzItems: unknown[] = [];
  const clock = createClock(() => NOW);
  const record = opts.delegation === undefined ? delegationRecord() : opts.delegation;
  const auth: AuthSetup = {
    // 偽の Cognito の照らし: 署名と claim を通した token として、要求元のサインインの claim を返す
    cognito: async () => ({ ok: true, value: { sub: SUB, username: "acme-user", authTime: AUTH_TIME, originJti: SESSION } }),
    signingKey: null,
    webhookSecret: null,
    clock,
    readers: {
      async userOfSubject(sub) {
        const row = await table.db.get("users", { pk: `COGNITO#${sub}`, sk: "COGNITO" }, true);
        return row === null ? null : { userId: row["user_id"] as typeof OWNER, boundAuthTime: String(row["bound_auth_time"]) };
      },
      async sessionRevocation(sub, sessionId) {
        const row = await table.db.get("users", { pk: `COGNITO#${sub}`, sk: `REVOKED#${sessionId}` }, true);
        return row === null ? null : { revokedAt: String(row["revoked_at"]) };
      },
      async cognitoIdentity() {
        return null;
      },
      async delegation() {
        readerCalls.push("delegation");
        if (opts.readerFail !== undefined) throw opts.readerFail;
        return record;
      },
      async machine() {
        return null;
      },
      async lane() {
        return null;
      },
      async dbPrep() {
        return null;
      },
    },
  };
  const scope = fakeScope(table);
  const recording: ScopeReader = {
    ...scope,
    async projectOfTarget(op, item) {
      authzItems.push(item);
      return scope.projectOfTarget(op, item);
    },
  };
  const deps: DispatchDeps = {
    operations: [...DISPATCH_OPERATIONS, projectsGet],
    handlers: opts.handlers ?? noteHandlers,
    scope: recording,
    auth,
    db: table.db,
    clock,
    log: createLogger({ request_id: "req-1", fn: "test", endpoint: "user" }, (line) => lines.push(line)),
  };
  return { table, deps, lines, readerCalls, authzItems };
}

const call = (operation: string, items: readonly unknown[], over: Partial<OperationCall> = {}): OperationCall => ({
  endpoint: "user",
  channel: "screen",
  operation,
  token: null,
  principal: human,
  items,
  requestId: "req-1",
  remainingMs: () => 10_000,
  ...over,
});

// 認証を通す呼び出し（人の token）
const viaToken = (token: string, channel: "screen" | "api" = "screen"): Partial<OperationCall> => ({ principal: undefined, token, channel });

const problem = (status: number, reason: string | null): DispatchResult => ({ kind: "problem", status, reason });
const itemsOf = (result: DispatchResult) => (result.kind === "items" ? result.items : []);

const auditRows = (table: FakeTable) => table.rows("audit");
const summaryRows = (table: FakeTable) => auditRows(table).filter((row) => row["item_index"] === undefined);
const elementRows = (table: FakeTable) => auditRows(table).filter((row) => row["item_index"] !== undefined);
const stateWrites = (table: FakeTable, name = "sprints") => table.transactions.filter((t) => t.some((i) => i.table === name));
const shapeOf = (t: readonly TransactItem[]) => t.map((i) => `${i.table}:${i.op}`);
const guardsOf = (t: readonly TransactItem[]) => t.filter((i) => i.table === "users" && i.op === "check");

const revoke = (table: FakeTable) => table.seed("users", { ...REVOKED_KEY, schema_version: 1, cognito_sub: SUB, session_id: SESSION, revoked_at: "2026-11-21T03:04:00.000Z", expire_at: 1 });

function httpEvent(path: string, body: string | undefined, token: string | null = null, method = "POST"): HttpEvent {
  return {
    rawPath: path,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    body,
    isBase64Encoded: false,
    requestContext: { requestId: "req-1", http: { method } },
  };
}

describe("dispatch: 書く要素と記録（I9・受け入れ条件 4）", () => {
  it("書く要素ごとに、状態・要素の記録の行・冪等の鍵の済みの行・要求元の照らしを 1 つのトランザクションで確定する", async () => {
    const { table, deps } = setup();
    const items = [
      { project_id: P_A, title: "one", idempotency_key: IDEM_1 },
      { project_id: P_A, title: "two", idempotency_key: IDEM_2 },
    ];
    const result = await dispatch(call("notes.create", items, viaToken(HUMAN_TOKEN)), deps);
    expect(itemsOf(result)).toEqual([
      { ok: true, item: { title: "one" } },
      { ok: true, item: { title: "two" } },
    ]);
    expect(stateWrites(table)).toHaveLength(2);
    for (const transaction of stateWrites(table)) {
      expect(shapeOf(transaction)).toEqual(["sprints:put", "audit:put", "idempotency:put", "users:check", "users:check"]);
    }
    expect(table.rows("sprints")).toHaveLength(2);
    expect(table.rows("idempotency").map((r) => r["state"])).toEqual(["settled", "settled"]);
    expect(elementRows(table)).toHaveLength(2);
    expect(summaryRows(table)).toHaveLength(1);
    expect(summaryRows(table)[0]).toMatchObject({ operation: "notes.create", result: { outcome: "ok", status: 200 }, pk: `PROJECT#${P_A}` });
  });

  it("要素の記録を書けないと 503 audit_unavailable を返し、状態も書かれず、残りの要素を処理しない", async () => {
    const { table, deps } = setup();
    table.seed("sprints", { ...NOTE_KEY(P_A), schema_version: 1, version: 1, title: "before" });
    table.failNext("unavailable");
    const result = await dispatch(
      call("notes.rename", [
        { project_id: P_A, title: "after", version: 1 },
        { project_id: P_A, title: "later", version: 1 },
      ]),
      deps,
    );
    expect(result).toEqual(problem(503, "audit_unavailable"));
    expect(table.row("sprints", NOTE_KEY(P_A))).toMatchObject({ title: "before", version: 1 });
    // 失敗した要素の確定と要約の行だけ
    expect(table.transactions).toHaveLength(2);
    expect(summaryRows(table)[0]).toMatchObject({ result: { outcome: "rejected", status: 503, reasons: ["audit_unavailable"] } });
  });

  it("ハンドラーが記録の表の書き換えを返すと 503 で確定しない", async () => {
    const tamper: Handler = async () => ({
      result: { ok: true, item: { title: "x" } },
      // 既にある記録の行の上書き（replaceIfVersion は組む時点で記録の表を拒むため、件を手で組む）
      writes: [{ table: "audit", op: "put", key: { pk: `PROJECT#${P_A}`, sk: "x" }, item: { pk: `PROJECT#${P_A}`, sk: "x", schema_version: 1, result: "ok" }, condition: cond.exists("pk"), onConflict: "fail" }],
    });
    const { table, deps } = setup({ handlers: { ...noteHandlers, "notes.rename": tamper } });
    const result = await dispatch(call("notes.rename", [{ project_id: P_A, title: "x", version: 1 }]), deps);
    expect(result).toEqual(problem(503, "unavailable"));
    expect(table.transactions.every((t) => t.every((i) => i.table === "audit" && i.op === "put"))).toBe(true);
  });

  it("本文の秘密の形の値は、記録の行とログに残らない", async () => {
    const { table, deps, lines } = setup();
    const secret = SECRET_SAMPLES["github_app_token"] ?? "";
    await dispatch(call("notes.create", [{ project_id: P_A, title: secret, idempotency_key: IDEM_1 }]), deps);
    expect(leakedSecrets(JSON.stringify(auditRows(table)))).toEqual([]);
    expect(leakedSecrets(lines.join("\n"))).toEqual([]);
    // 許した鍵の値のうち ID の形のものだけを写す
    expect(elementRows(table)[0]?.["target_ids"]).toEqual([P_A]);
  });

  it("版が合わない要素は 409 version_mismatch で、要素の記録の行も書かない", async () => {
    const { table, deps } = setup();
    table.seed("sprints", { ...NOTE_KEY(P_A), schema_version: 1, version: 2, title: "before" });
    const result = await dispatch(call("notes.rename", [{ project_id: P_A, title: "after", version: 1 }]), deps);
    expect(itemsOf(result)).toEqual([{ ok: false, status: 409, reason: "version_mismatch" }]);
    expect(elementRows(table)).toHaveLength(0);
  });

  it("ハンドラーの結果が操作の結果の形に合わなければ 503 unavailable で確定しない", async () => {
    const wrong: Handler = async () => ({ result: { ok: true, item: { title: 1 } }, writes: [] });
    const { table, deps } = setup({ handlers: { ...noteHandlers, "notes.create": wrong } });
    await expect(dispatch(call("notes.create", [{ project_id: P_A, title: "x", idempotency_key: IDEM_1 }]), deps)).resolves.toEqual(problem(503, "unavailable"));
    expect(elementRows(table)).toHaveLength(0);
  });
});

describe("dispatch: 人の書き込みの要求元の照らし", () => {
  it("照らしの 2 件は対応の行（利用者と結んだ時刻）と取り消しの行が無いことを照らす", async () => {
    const { table, deps } = setup();
    await dispatch(call("notes.rename", [{ project_id: P_A, title: "x", version: 1 }]), deps);
    const [binding, revoked] = guardsOf(table.transactions[0] ?? []);
    expect(binding).toMatchObject({ key: BINDING_KEY, onConflict: "state_mismatch", condition: { kind: "and", of: [{ kind: "exists", path: "pk" }, { kind: "cmp", path: "user_id", value: OWNER }, { kind: "cmp", path: "bound_auth_time", value: BOUND_AT }] } });
    expect(revoked).toMatchObject({ key: REVOKED_KEY, onConflict: "state_mismatch", condition: { kind: "not_exists", path: "pk" } });
  });

  it("委任の書き込み・読む操作・sessions.delete・まだ結んでいない人の sessions.create には足さない", async () => {
    const { table, deps } = setup();
    await dispatch(call("notes.create", [{ project_id: P_A, title: "d", idempotency_key: IDEM_1 }], { principal: delegate("run") }), deps);
    await dispatch(call("sessions.delete", [{}]), deps);
    await dispatch(call("sessions.create", [{ idempotency_key: IDEM_2 }], { principal: { kind: "newcomer", login: { cognitoSub: "acme-new", username: "acme-new", sessionId: "jti-new", idp: "google", subject: "s", authTime: AUTH_TIME } } }), deps);
    await dispatch(call("notes.get", [{ project_id: P_A }]), deps);
    expect(table.transactions.flatMap(guardsOf)).toEqual([]);
  });

  it("既にある利用者の sessions.create は、記録と冪等の鍵の済みの行だけの書き込みにも足す", async () => {
    const { table, deps } = setup();
    await dispatch(call("sessions.create", [{ idempotency_key: IDEM_1 }]), deps);
    expect(shapeOf(table.transactions.find((t) => t.some((i) => i.table === "idempotency" && i.op === "put" && i.condition.kind === "and")) ?? [])).toEqual(["audit:put", "idempotency:put", "users:check", "users:check"]);
  });

  it("認証の後に要求元のセッションが取り消されたら、要素を書かずに 409 state_mismatch（ハンドラーの理由より先）", async () => {
    const { table, deps } = setup();
    table.seed("sprints", { ...NOTE_KEY(P_A), schema_version: 1, version: 2, title: "before" });
    const racing: Handler = async (item, ctx) => {
      revoke(table);
      return noteHandlers["notes.rename"]!(item, ctx);
    };
    const result = await dispatch(call("notes.rename", [{ project_id: P_A, title: "after", version: 1 }], viaToken(HUMAN_TOKEN)), { ...deps, handlers: { ...noteHandlers, "notes.rename": racing } });
    expect(itemsOf(result)).toEqual([{ ok: false, status: 409, reason: "state_mismatch" }]);
    expect(table.row("sprints", NOTE_KEY(P_A))).toMatchObject({ title: "before" });
  });

  it("要求元のログインを結び直した（bound_auth_time が違う）後の書き込みは 409 state_mismatch", async () => {
    const { table, deps } = setup();
    table.seed("users", bindingRow(SUB, OWNER, "2026-11-21T03:04:00.000Z"));
    const result = await dispatch(call("notes.create", [{ project_id: P_A, title: "x", idempotency_key: IDEM_1 }]), deps);
    expect(itemsOf(result)).toEqual([{ ok: false, status: 409, reason: "state_mismatch" }]);
    expect(table.rows("sprints")).toHaveLength(0);
  });

  it("要素ごとの操作は要素ごとに照らし、照らしの前に確定した要素は確定のまま残る", async () => {
    const { table, deps } = setup();
    let n = 0;
    const second: Handler = async (item, ctx) => {
      n += 1;
      if (n === 2) revoke(table);
      return noteHandlers["notes.create"]!(item, ctx);
    };
    const result = await dispatch(
      call("notes.create", [
        { project_id: P_A, title: "one", idempotency_key: IDEM_1 },
        { project_id: P_A, title: "two", idempotency_key: IDEM_2 },
      ]),
      { ...deps, handlers: { ...noteHandlers, "notes.create": second } },
    );
    expect(itemsOf(result)).toEqual([
      { ok: true, item: { title: "one" } },
      { ok: false, status: 409, reason: "state_mismatch" },
    ]);
    expect(table.rows("sprints")).toHaveLength(1);
  });

  it("要求元のログインそのものを外す書き込みは、件を足さずにその条件へ要求元の条件を AND で足す", async () => {
    const { table, deps } = setup();
    const result = await dispatch(call("logins.delete", [{ cognito_sub: SUB, idempotency_key: IDEM_1 }]), deps);
    expect(itemsOf(result)).toEqual([{ ok: true, item: { cognito_sub: SUB } }]);
    const transaction = stateWrites(table, "users")[0] ?? [];
    expect(shapeOf(transaction)).toEqual(["users:delete", "audit:put", "idempotency:put", "users:check"]);
    expect(transaction[0]?.condition).toEqual({
      kind: "and",
      of: [
        { kind: "exists", path: "pk" },
        { kind: "and", of: [{ kind: "exists", path: "pk" }, { kind: "cmp", path: "user_id", op: "=", value: OWNER }, { kind: "cmp", path: "bound_auth_time", op: "=", value: BOUND_AT }] },
      ],
    });
    expect(guardsOf(transaction)[0]?.key).toEqual(REVOKED_KEY);
    expect(table.row("users", BINDING_KEY)).toBeUndefined();
  });

  it("全部か無かの操作は 1 つのトランザクションに 1 回だけ足し、外れたらどの要素も 409 state_mismatch", async () => {
    const ok = setup();
    await dispatch(call("notes.import", [{ project_id: P_A, title: "one" }, { project_id: P_A, title: "two" }]), ok.deps);
    expect(shapeOf(stateWrites(ok.table)[0] ?? [])).toEqual(["sprints:put", "audit:put", "sprints:put", "audit:put", "users:check", "users:check"]);

    const ng = setup();
    revoke(ng.table);
    const result = await dispatch(call("notes.import", [{ project_id: P_A, title: "one" }, { project_id: P_A, title: "two" }]), ng.deps);
    expect(itemsOf(result)).toEqual([
      { ok: false, status: 409, reason: "state_mismatch" },
      { ok: false, status: 409, reason: "state_mismatch" },
    ]);
    expect(ng.table.rows("sprints")).toHaveLength(0);
  });
});

describe("dispatch: 本文は配列（I12・受け入れ条件 5）", () => {
  it('HTTP の {"a": 1} の本文は 400 body_not_array で、記録の行を 1 件書く', async () => {
    const { table, deps } = setup({ delegation: delegationRecord() });
    const read = readHttpCall(httpEvent("/v1/notes/get", '{"a": 1}', DELEGATION_TOKEN), () => 10_000);
    // 経路は形の正本の表で引くため、作り物の操作の経路は 404。呼び出しを作り物の操作の名前へ置き替える
    expect(read).toMatchObject({ operation: "", fault: { status: 404, reason: null } });
    const real = readHttpCall(httpEvent("/v1/projects/get", '{"a": 1}', DELEGATION_TOKEN), () => 10_000);
    if ("kind" in real) throw new Error("呼び出しに読めない");
    const result = await dispatch({ ...real, operation: "notes.get" }, deps);
    expect(result).toEqual(problem(400, "body_not_array"));
    expect(summaryRows(table)).toHaveLength(1);
    expect(summaryRows(table)[0]).toMatchObject({ result: { outcome: "rejected", status: 400, reasons: ["body_not_array"] } });
  });

  it("MCP の入口から配列でない要素を渡しても 400 body_not_array", async () => {
    const { deps } = setup();
    const result = await dispatch(call("notes.get", { a: 1 } as unknown as unknown[], { endpoint: "mcp", channel: "mcp", principal: delegate("read") }), deps);
    expect(result).toEqual(problem(400, "body_not_array"));
  });

  it("MCP の入口の空・重なり・数の越えも HTTP と同じ順で照らす", async () => {
    const { deps } = setup();
    const mcp = { endpoint: "mcp", channel: "mcp", principal: delegate("run") } as const;
    await expect(dispatch(call("notes.get", [], mcp), deps)).resolves.toEqual(problem(400, "body_empty"));
    await expect(dispatch(call("notes.get", [{ project_id: P_A }, { project_id: P_A }], mcp), deps)).resolves.toEqual(problem(400, "duplicate_item"));
    const four = [1, 2, 3, 4].map((n) => ({ project_id: P_A, title: `t${n}` }));
    await expect(dispatch(call("notes.import", four, mcp), deps)).resolves.toEqual(problem(400, "too_many_items"));
  });
});

describe("dispatch: 認証と要求全体の拒み", () => {
  it("POST でない要求は認証の前に 405 で、主体の無い記録の行を 1 件書く", async () => {
    const { table, deps, readerCalls } = setup();
    const result = await dispatch(call("notes.get", [], { ...viaToken(DELEGATION_TOKEN, "api"), fault: { status: 405, reason: null } }), deps);
    expect(result).toEqual(problem(405, null));
    expect(readerCalls).toEqual([]);
    expect(String(summaryRows(table)[0]?.["pk"])).toBe("ANON#2026-11-21");
  });

  it("受け口と操作の受け口が食い違えば 405", async () => {
    const { deps } = setup();
    await expect(dispatch(call("notes.get", [{ project_id: P_A }], { endpoint: "runner", channel: "runner" }), deps)).resolves.toEqual(problem(405, null));
  });

  it("token の誤りは 401 unauthorized で、主体の無い記録の行を 1 件書く", async () => {
    const { table, deps } = setup({ delegation: null });
    const result = await dispatch(call("notes.get", [{ project_id: P_A }], viaToken(DELEGATION_TOKEN, "api")), deps);
    expect(result).toEqual(problem(401, "unauthorized"));
    expect(summaryRows(table)).toHaveLength(1);
    expect(String(summaryRows(table)[0]?.["pk"])).toBe("ANON#2026-11-21");
  });

  it("断たれたセッションの token は 401 session_ended", async () => {
    const { table, deps } = setup();
    revoke(table);
    await expect(dispatch(call("notes.get", [{ project_id: P_A }], viaToken(HUMAN_TOKEN)), deps)).resolves.toEqual(problem(401, "session_ended"));
  });

  it("sessions.delete は取り消しの行があっても通り、その revoked_at をハンドラーへ渡す", async () => {
    const { table, deps } = setup();
    revoke(table);
    const result = await dispatch(call("sessions.delete", [{}], viaToken(HUMAN_TOKEN)), deps);
    expect(itemsOf(result)).toEqual([{ ok: true, item: { revoked_at: "2026-11-21T03:04:00.000Z" } }]);
  });

  it("認証の依存先に届かないときは 503 unavailable で、記録の行を書けなくても 503 unavailable のまま", async () => {
    const { table, deps } = setup({ readerFail: Object.assign(new Error("down"), { name: "InternalServerError" }) });
    table.failNext("unavailable");
    const result = await dispatch(call("notes.get", [{ project_id: P_A }], viaToken(DELEGATION_TOKEN, "api")), deps);
    expect(result).toEqual(problem(503, "unavailable"));
  });

  it("渡した主体（MCP の tools/call）があれば認証を繰り返さない", async () => {
    const { deps, readerCalls } = setup();
    const result = await dispatch(call("notes.get", [{ project_id: P_A }], { endpoint: "mcp", channel: "mcp", principal: delegate("read"), token: null }), deps);
    expect(result.kind).toBe("items");
    expect(readerCalls).toEqual([]);
  });

  it("画面と MCP から同じ操作を呼ぶと同じ要素の結果になる", async () => {
    const a = setup();
    const b = setup();
    const items = [{ project_id: P_A }, { project_id: P_B }];
    const screen = await dispatch(call("notes.get", items, viaToken(HUMAN_TOKEN)), a.deps);
    const mcp = await dispatch(call("notes.get", items, { endpoint: "mcp", channel: "mcp", principal: delegate("read", [P_A, P_B]) }), b.deps);
    expect(mcp).toEqual(screen);
    expect(itemsOf(screen)).toEqual([
      { ok: true, item: { project_id: P_A, title: "acme" } },
      { ok: false, status: 404, reason: "not_found" },
    ]);
  });

  it("人だけの操作を委任から呼ぶと 403 human_only でハンドラーを呼ばない", async () => {
    let called = false;
    const purge: Handler = async () => {
      called = true;
      return { result: { ok: true, item: {} }, writes: [] };
    };
    const { deps } = setup({ handlers: { ...noteHandlers, "notes.purge": purge } });
    const result = await dispatch(call("notes.purge", [{ project_id: P_A }], viaToken(DELEGATION_TOKEN, "api")), deps);
    expect(result).toEqual(problem(403, "human_only"));
    expect(called).toBe(false);
  });

  it("委任の種類が操作の印より弱いと 403 scope_insufficient", async () => {
    const { deps } = setup({ delegation: delegationRecord("read") });
    const result = await dispatch(call("notes.create", [{ project_id: P_A, title: "x", idempotency_key: IDEM_1 }], viaToken(DELEGATION_TOKEN, "api")), deps);
    expect(result).toEqual(problem(403, "scope_insufficient"));
  });

  it("形の未定の操作は 503 unavailable とログの error（操作の名前だけ）で、要約の行を 1 件書く", async () => {
    const { table, deps, lines } = setup();
    const result = await dispatch(call("projects.get", [{ project_id: P_A }]), deps);
    expect(result).toEqual(problem(503, "unavailable"));
    expect(lines.map((l) => JSON.parse(l))).toContainEqual(expect.objectContaining({ level: "error", msg: "操作の形が未定かハンドラーが無い", operation: "projects.get" }));
    expect(summaryRows(table)).toHaveLength(1);
  });

  it("ハンドラーの表に無い操作は 503 unavailable", async () => {
    const { deps } = setup({ handlers: {} });
    await expect(dispatch(call("notes.get", [{ project_id: P_A }]), deps)).resolves.toEqual(problem(503, "unavailable"));
  });
});

describe("dispatch: 要素ごとの判定", () => {
  it("形の誤り → 見えない の順で要素の結果にし、形の誤りの要素は認可へ渡さない", async () => {
    const { deps, authzItems } = setup();
    const result = await dispatch(call("notes.get", [{ project_id: P_A }, { project_id: P_B }, { project_id: "prj_bad" }]), deps);
    expect(itemsOf(result)).toEqual([
      { ok: true, item: { project_id: P_A, title: "acme" } },
      { ok: false, status: 404, reason: "not_found" },
      { ok: false, status: 400, reason: "item_invalid", fields: ["/2/project_id"] },
    ]);
    expect(authzItems).toEqual([{ project_id: P_A }, { project_id: P_B }]);
  });

  it("同じ冪等の鍵の 2 回目は前の結果を返して状態を変えず、中身が違えば 422", async () => {
    const { table, deps } = setup();
    const item = { project_id: P_A, title: "one", idempotency_key: IDEM_1 };
    const first = await dispatch(call("notes.create", [item]), deps);
    const second = await dispatch(call("notes.create", [item]), deps);
    expect(second).toEqual(first);
    expect(stateWrites(table)).toHaveLength(1);
    const reused = await dispatch(call("notes.create", [{ ...item, title: "other" }]), deps);
    expect(itemsOf(reused)).toEqual([{ ok: false, status: 422, reason: "idempotency_key_reused" }]);
  });

  it("logins.delete の認可の対象は主体の利用者自身で、外したログインの送り直しは 404 でなく 1 回目の成功を返す", async () => {
    const { table, deps, authzItems } = setup();
    const item = { cognito_sub: OTHER_SUB, idempotency_key: IDEM_1 };
    const first = await dispatch(call("logins.delete", [item]), deps);
    expect(itemsOf(first)).toEqual([{ ok: true, item: { cognito_sub: OTHER_SUB } }]);
    expect(authzItems).toEqual([{ user_id: OWNER }]);
    expect(table.row("users", { pk: `COGNITO#${OTHER_SUB}`, sk: "COGNITO" })).toBeUndefined();
    await expect(dispatch(call("logins.delete", [item]), deps)).resolves.toEqual(first);
    // 鍵の違う要求は、ハンドラーが行の無いことを照らして 404
    expect(itemsOf(await dispatch(call("logins.delete", [{ ...item, idempotency_key: IDEM_2 }]), deps))).toEqual([{ ok: false, status: 404, reason: "not_found" }]);
  });

  it("ハンドラーの想定しない例外は 503 unavailable で、前の要素は確定済み", async () => {
    const failing: Handler = async (item, ctx) => {
      if ((item as { title: string }).title === "boom") throw new TypeError("bug");
      return noteHandlers["notes.create"]!(item, ctx);
    };
    const { table, deps, lines } = setup({ handlers: { ...noteHandlers, "notes.create": failing } });
    const result = await dispatch(
      call("notes.create", [
        { project_id: P_A, title: "ok", idempotency_key: IDEM_1 },
        { project_id: P_A, title: "boom", idempotency_key: IDEM_2 },
      ]),
      deps,
    );
    expect(result).toEqual(problem(503, "unavailable"));
    expect(table.rows("sprints")).toHaveLength(1);
    expect(lines.map((l) => JSON.parse(l))).toContainEqual(expect.objectContaining({ level: "error", error: "TypeError", request_id: "req-1" }));
  });

  it("残り時間が予備の時間ちょうどなら処理し、下回れば残りを処理せずに 503", async () => {
    const enough = setup();
    await expect(dispatch(call("notes.get", [{ project_id: P_A }], { remainingMs: () => DISPATCH_RESERVE_MS }), enough.deps)).resolves.toMatchObject({ kind: "items" });
    const short = setup();
    let left = DISPATCH_RESERVE_MS;
    const items = [
      { project_id: P_A, title: "one", idempotency_key: IDEM_1 },
      { project_id: P_A, title: "two", idempotency_key: IDEM_2 },
    ];
    await expect(dispatch(call("notes.create", items, { remainingMs: () => left-- }), short.deps)).resolves.toEqual(problem(503, "unavailable"));
    expect(short.table.rows("sprints")).toHaveLength(1);
  });

  it("読む操作は要約の行を書けないと値を返さず 503 audit_unavailable", async () => {
    const { table, deps } = setup();
    table.failNext("unavailable");
    await expect(dispatch(call("notes.get", [{ project_id: P_A }]), deps)).resolves.toEqual(problem(503, "audit_unavailable"));
  });

  it("まだ結んでいない人が利用者を作った要素と要約は、作った利用者の人の主体で記録する", async () => {
    const create: Handler = async () => ({ result: { ok: true, item: { user_id: CREATED } }, writes: [], createdUserId: CREATED });
    const { table, deps } = setup({ handlers: { ...noteHandlers, "sessions.create": create } });
    const newcomer: Principal = { kind: "newcomer", login: { cognitoSub: "acme-new", username: "acme-new", sessionId: "jti-new", idp: "google", subject: "s", authTime: AUTH_TIME } };
    await dispatch(call("sessions.create", [{ idempotency_key: IDEM_1 }], { principal: newcomer }), deps);
    expect(auditRows(table).map((r) => [r["pk"], (r["actor"] as Record<string, unknown>)["kind"]])).toEqual([
      [`USER#${CREATED}`, "human"],
      [`USER#${CREATED}`, "human"],
    ]);
    expect(JSON.stringify(auditRows(table))).not.toContain("acme-new");
  });
});

describe("dispatch: 全部か無か", () => {
  it("1 つの要素が失敗すると確定せず、ほかの要素は 409 not_applied", async () => {
    const { table, deps } = setup();
    const result = await dispatch(
      call("notes.import", [
        { project_id: P_A, title: "one" },
        { project_id: P_A, title: "" },
      ]),
      deps,
    );
    expect(itemsOf(result)).toEqual([
      { ok: false, status: 409, reason: "not_applied" },
      { ok: false, status: 400, reason: "item_invalid", fields: ["/1/title"] },
    ]);
    expect(table.rows("sprints")).toHaveLength(0);
  });

  it("確定の条件が外れた要素はその理由、ほかの要素は 409 not_applied", async () => {
    const { table, deps } = setup();
    table.seed("sprints", { pk: `PROJECT#${P_A}`, sk: "NOTE#two", schema_version: 1, version: 1, title: "two" });
    const result = await dispatch(
      call("notes.import", [
        { project_id: P_A, title: "one" },
        { project_id: P_A, title: "two" },
      ]),
      deps,
    );
    expect(itemsOf(result)).toEqual([
      { ok: false, status: 409, reason: "not_applied" },
      { ok: false, status: 409, reason: "state_mismatch" },
    ]);
    expect(table.rows("sprints")).toHaveLength(1);
  });
});

describe("dispatch: ハンドラーの外へ働きかける前の照らし・外れたときの結果・既にある行", () => {
  it("外へ働きかける直前の要求元の照らしが外れたら、働きかけずに 409 state_mismatch で何も確定しない", async () => {
    const { table, deps } = setup();
    const called: string[] = [];
    const external: Handler = async (item, ctx) => {
      if (!(await ctx.checkRequester())) return { result: { ok: false, status: 409, reason: "state_mismatch" }, writes: [] };
      called.push("cognito");
      return noteHandlers["logins.delete"]!(item, ctx);
    };
    const handlers = { ...noteHandlers, "logins.delete": external };
    const ok = await dispatch(call("logins.delete", [{ cognito_sub: OTHER_SUB, idempotency_key: IDEM_1 }]), { ...deps, handlers });
    expect(itemsOf(ok)).toEqual([{ ok: true, item: { cognito_sub: OTHER_SUB } }]);
    expect(called).toEqual(["cognito"]);
    expect(shapeOf(table.transactions.find((t) => t.every((i) => i.op === "check")) ?? [])).toEqual(["users:check", "users:check"]);

    revoke(table);
    // 照らしの後に外へ働きかけたつもりでも、照らしが外れた要素はハンドラーの戻り値によらず確定しない
    const ignoring: Handler = async (item, ctx) => {
      await ctx.checkRequester();
      return noteHandlers["logins.delete"]!(item, ctx);
    };
    table.seed("users", bindingRow(OTHER_SUB));
    const before = table.transactions.length;
    const ng = await dispatch(call("logins.delete", [{ cognito_sub: OTHER_SUB, idempotency_key: IDEM_2 }]), { ...deps, handlers: { ...noteHandlers, "logins.delete": ignoring } });
    expect(itemsOf(ng)).toEqual([{ ok: false, status: 409, reason: "state_mismatch" }]);
    expect(table.row("users", { pk: `COGNITO#${OTHER_SUB}`, sk: "COGNITO" })).toBeDefined();
    expect(table.transactions.slice(before).filter((t) => t.some((i) => i.table === "users" && i.op !== "check"))).toEqual([]);
  });

  it("書き込みが外れたら、ハンドラーが置いた操作の契約の失敗の結果を返し、要求元の照らしの外れを先に当てる", async () => {
    const userKey = { pk: `USER#${OWNER}`, sk: "USER" };
    const lastLogin: Handler = async (item) => ({
      result: { ok: true, item: { cognito_sub: (item as { cognito_sub: string }).cognito_sub } },
      writes: [{ table: "users", op: "update", key: userKey, update: [{ kind: "increment", path: "login_count", by: -1 }], condition: cond.ge("login_count", 2), onConflict: "fail" }],
      conflicts: [{ result: { ok: false, status: 409, reason: "last_login" } }],
    });
    const a = setup();
    a.table.seed("users", { ...userKey, schema_version: 1, version: 1, login_count: 1 });
    const handlers = { ...noteHandlers, "logins.delete": lastLogin };
    const one = await dispatch(call("logins.delete", [{ cognito_sub: OTHER_SUB, idempotency_key: IDEM_1 }]), { ...a.deps, handlers });
    expect(one).toEqual({ kind: "items", items: [{ ok: false, status: 409, reason: "last_login" }] });

    const b = setup();
    b.table.seed("users", { ...userKey, schema_version: 1, version: 1, login_count: 1 });
    revoke(b.table);
    const two = await dispatch(call("logins.delete", [{ cognito_sub: OTHER_SUB, idempotency_key: IDEM_1 }]), { ...b.deps, handlers });
    expect(itemsOf(two)).toEqual([{ ok: false, status: 409, reason: "state_mismatch" }]);
  });

  it("操作の契約に無い外れたときの結果は 503 unavailable", async () => {
    const wrong: Handler = async (item, ctx) => ({ ...(await noteHandlers["notes.create"]!(item, ctx)), conflicts: [{ result: { ok: false, status: 409, reason: "last_login" } }] });
    const { deps } = setup({ handlers: { ...noteHandlers, "notes.create": wrong } });
    await expect(dispatch(call("notes.create", [{ project_id: P_A, title: "x", idempotency_key: IDEM_1 }]), deps)).resolves.toEqual(problem(503, "unavailable"));
  });

  it("全部か無かで要素ごとに同じ行を照らす件は 1 件にまとめ、外れたらその行を照らした要素のすべてへ戻す", async () => {
    const projectRow = { pk: `PROJECT#${P_A}`, sk: "PROJECT" };
    const withProject: Handler = async (item, ctx) => {
      const out = await noteHandlers["notes.import"]!(item, ctx);
      return { ...out, writes: [{ table: "projects", op: "check", key: projectRow, condition: cond.eq("state", "active"), onConflict: "state_mismatch" }, ...out.writes] };
    };
    const handlers = { ...noteHandlers, "notes.import": withProject };
    const items = [
      { project_id: P_A, title: "one" },
      { project_id: P_A, title: "two" },
    ];
    const ok = setup({ handlers });
    ok.table.seed("projects", { ...(ok.table.row("projects", projectRow) ?? projectRow), state: "active" });
    expect(itemsOf(await dispatch(call("notes.import", items), ok.deps))).toEqual([
      { ok: true, item: { title: "one" } },
      { ok: true, item: { title: "two" } },
    ]);
    expect(shapeOf(stateWrites(ok.table)[0] ?? []).filter((s) => s === "projects:check")).toHaveLength(1);

    const ng = setup({ handlers });
    ng.table.seed("projects", { ...(ng.table.row("projects", projectRow) ?? projectRow), state: "archived" });
    expect(itemsOf(await dispatch(call("notes.import", items), ng.deps))).toEqual([
      { ok: false, status: 409, reason: "state_mismatch" },
      { ok: false, status: 409, reason: "state_mismatch" },
    ]);
    expect(ng.table.rows("sprints")).toHaveLength(0);
  });

  it("全部か無かで確定しなければ、借りた冪等の鍵を手放し、直した送り直しの要素は in_progress にも 422 にもならない", async () => {
    const { table, deps } = setup();
    const items = [
      { project_id: P_A, title: "one", idempotency_key: IDEM_1 },
      { project_id: P_A, title: "two", idempotency_key: IDEM_2 },
    ];
    table.seed("sprints", { pk: `PROJECT#${P_A}`, sk: "NOTE#two", schema_version: 1, version: 1, title: "two" });
    const first = await dispatch(call("notes.bulk", items), deps);
    expect(itemsOf(first)).toEqual([
      { ok: false, status: 409, reason: "not_applied" },
      { ok: false, status: 409, reason: "state_mismatch" },
    ]);
    expect(table.rows("idempotency")).toHaveLength(0);
    const fixed = [items[0], { ...items[1], title: "three" }];
    const second = await dispatch(call("notes.bulk", fixed, { requestId: "req-2" }), deps);
    expect(itemsOf(second)).toEqual([
      { ok: true, item: { title: "one" } },
      { ok: true, item: { title: "three" } },
    ]);
  });

  it("全部か無かで前の要求で確定した要素の送り直しは、ほかの要素が失敗しても確定した結果のまま返す", async () => {
    const { table, deps } = setup();
    const done = { project_id: P_A, title: "one", idempotency_key: IDEM_1 };
    const first = await dispatch(call("notes.bulk", [done]), deps);
    expect(itemsOf(first)).toEqual([{ ok: true, item: { title: "one" } }]);
    table.seed("sprints", { pk: `PROJECT#${P_A}`, sk: "NOTE#two", schema_version: 1, version: 1, title: "two" });
    const second = await dispatch(call("notes.bulk", [done, { project_id: P_A, title: "two", idempotency_key: IDEM_2 }], { requestId: "req-2" }), deps);
    expect(itemsOf(second)).toEqual([
      { ok: true, item: { title: "one" } },
      { ok: false, status: 409, reason: "state_mismatch" },
    ]);
  });

  it("return_existing の件が外れたら既にある行の結果を返し、付随する状態の書き込みを確定しない", async () => {
    const eventKey = { pk: `PROJECT#${P_A}`, sk: "EVENT#1" };
    const event: Handler = async (item) => {
      const note = item as { project_id: string; title: string };
      return {
        result: { ok: true, item: { title: note.title } },
        writes: [
          putIfAbsent({ table: "sprints", item: { ...eventKey, schema_version: 1, version: 1, title: note.title }, onConflict: "return_existing" }),
          replaceIfVersion({
            table: "sprints",
            item: { ...NOTE_KEY(P_A), schema_version: 1, title: note.title },
            version: 1,
            incarnation: NOTE_INCARNATION,
            expect: { version: { kind: "value", value: 1 }, incarnation: { kind: "absent" } },
            onConflict: "version_mismatch",
          }),
        ],
        conflicts: [{ existing: (row) => ({ ok: true, item: { title: String(row?.["title"]) } }) }],
      };
    };
    const { table, deps } = setup({ handlers: { ...noteHandlers, "notes.create": event } });
    table.seed("sprints", { ...eventKey, schema_version: 1, version: 1, title: "stored" });
    table.seed("sprints", { ...NOTE_KEY(P_A), schema_version: 1, version: 1, title: "before" });
    const result = await dispatch(call("notes.create", [{ project_id: P_A, title: "again", idempotency_key: IDEM_1 }]), deps);
    expect(itemsOf(result)).toEqual([{ ok: true, item: { title: "stored" } }]);
    expect(table.row("sprints", NOTE_KEY(P_A))).toMatchObject({ title: "before", version: 1 });
    expect(table.rows("idempotency")[0]).toMatchObject({ state: "settled", result: { ok: true, item: { title: "stored" } } });
  });

  it("同じ連番の並行の再送で付随する書き込みの版も外れたら、版の違いでなく既にある行の結果を返す", async () => {
    const eventKey = { pk: `PROJECT#${P_A}`, sk: "EVENT#1" };
    const event: Handler = async (item) => {
      const note = item as { project_id: string; title: string };
      return {
        result: { ok: true, item: { title: note.title } },
        writes: [
          putIfAbsent({ table: "sprints", item: { ...eventKey, schema_version: 1, version: 1, title: note.title }, onConflict: "return_existing" }),
          replaceIfVersion({
            table: "sprints",
            item: { ...NOTE_KEY(P_A), schema_version: 1, title: note.title },
            version: 1,
            incarnation: NOTE_INCARNATION,
            expect: { version: { kind: "value", value: 1 }, incarnation: { kind: "absent" } },
            onConflict: "version_mismatch",
          }),
        ],
        conflicts: [{ existing: (row) => ({ ok: true, item: { title: String(row?.["title"]) } }) }],
      };
    };
    const { table, deps } = setup({ handlers: { ...noteHandlers, "notes.create": event } });
    // 先に確定した要求が事象を足し、付随する行の版も進めた
    table.seed("sprints", { ...eventKey, schema_version: 1, version: 1, title: "stored" });
    table.seed("sprints", { ...NOTE_KEY(P_A), schema_version: 1, version: 2, title: "stored" });
    const result = await dispatch(call("notes.create", [{ project_id: P_A, title: "again", idempotency_key: IDEM_1 }]), deps);
    expect(itemsOf(result)).toEqual([{ ok: true, item: { title: "stored" } }]);
    expect(table.row("sprints", NOTE_KEY(P_A))).toMatchObject({ title: "stored", version: 2 });
  });

  it("同じ連番の再送でも、要求元の照らしが外れたら既にある行の結果より先に 409 state_mismatch", async () => {
    const eventKey = { pk: `PROJECT#${P_A}`, sk: "EVENT#1" };
    const event: Handler = async (item) => ({
      result: { ok: true, item: { title: (item as { title: string }).title } },
      writes: [putIfAbsent({ table: "sprints", item: { ...eventKey, schema_version: 1, version: 1, title: "x" }, onConflict: "return_existing" })],
      conflicts: [{ existing: (row) => ({ ok: true, item: { title: String(row?.["title"]) } }) }],
    });
    const { table, deps } = setup({ handlers: { ...noteHandlers, "notes.create": event } });
    table.seed("sprints", { ...eventKey, schema_version: 1, version: 1, title: "stored" });
    revoke(table);
    const result = await dispatch(call("notes.create", [{ project_id: P_A, title: "again", idempotency_key: IDEM_1 }]), deps);
    expect(itemsOf(result)).toEqual([{ ok: false, status: 409, reason: "state_mismatch" }]);
  });

  it("全部か無かの後始末は要約の記録と応答の時間を食わず、残り時間が足りなければ借りを手放さずに要約を書いて返す", async () => {
    const { table, deps } = setup();
    const items = [
      { project_id: P_A, title: "one", idempotency_key: IDEM_1 },
      { project_id: P_A, title: "two", idempotency_key: IDEM_2 },
    ];
    table.seed("sprints", { pk: `PROJECT#${P_A}`, sk: "NOTE#two", schema_version: 1, version: 1, title: "two" });
    const result = await dispatch(call("notes.bulk", items, { remainingMs: () => DISPATCH_SUMMARY_MS + (table.rows("idempotency").length < 2 ? DISPATCH_RESERVE_MS : 0) }), deps);
    expect(itemsOf(result)).toHaveLength(2);
    expect(table.rows("idempotency").map((r) => r["state"])).toEqual(["leased", "leased"]);
    expect(table.transactions.filter((t) => t.some((i) => i.table === "idempotency" && i.op === "delete"))).toHaveLength(0);
    expect(summaryRows(table)).toHaveLength(1);
  });

  it("全部か無かの後始末が残り時間の内に終わらなければ、待たずに要約を書いて返す", async () => {
    const { table, deps } = setup();
    const items = [
      { project_id: P_A, title: "one", idempotency_key: IDEM_1 },
      { project_id: P_A, title: "two", idempotency_key: IDEM_2 },
    ];
    table.seed("sprints", { pk: `PROJECT#${P_A}`, sk: "NOTE#two", schema_version: 1, version: 1, title: "two" });
    const hanging: DispatchDeps = {
      ...deps,
      db: {
        ...deps.db,
        transactWrite: (writes) => (writes.some((i) => i.table === "idempotency" && i.op === "delete") ? new Promise<void>(() => {}) : deps.db.transactWrite(writes)),
      },
    };
    const started = Date.now();
    const result = await dispatch(call("notes.bulk", items, { remainingMs: () => DISPATCH_SUMMARY_MS + (table.rows("idempotency").length < 2 ? DISPATCH_RESERVE_MS : 50) }), hanging);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(itemsOf(result)).toHaveLength(2);
    expect(summaryRows(table)).toHaveLength(1);
  });

  it("結果の形に無い鍵は応答に残さない", async () => {
    const { deps } = setup();
    expect(itemsOf(await dispatch(call("notes.peek", [{ project_id: P_A }]), deps))).toEqual([{ ok: true, item: { title: "acme" } }]);
  });
});

// 組み直しの作り物: 数の行を強い整合で読み、1 足した行全体を読んだ version と incarnation を条件に rebuild で置き換えるハンドラー。
// raceOn(n) が真の呼び出し（1 から数える）では、読んだ後に並んだ書き手が同じ行へ 1 足して確定したことにする
const counterKey = (name: string) => ({ pk: `PROJECT#${P_A}`, sk: `COUNTER#${name}` });
const counterRow = (name: string, count: number, version: number) => ({ ...counterKey(name), schema_version: 1, version, incarnation: NOTE_INCARNATION, count });

function counting(table: FakeTable, raceOn: (call: number, name: string) => boolean, extra: (name: string) => TransactItem[] = () => []) {
  const calls: string[] = [];
  const handler: Handler = async (item, ctx) => {
    const name = (item as { title: string }).title;
    calls.push(name);
    const raw: StoredRow | null = await ctx.db.get("sprints", counterKey(name), true);
    const count = Number(raw?.["count"]);
    const version = Number(raw?.["version"]);
    if (raceOn(calls.filter((n) => n === name).length, name)) table.seed("sprints", counterRow(name, count + 1, version + 1));
    return {
      result: { ok: true, item: { title: name } },
      writes: [
        replaceIfVersion({
          table: "sprints",
          item: { ...counterKey(name), schema_version: 1, count: count + 1 },
          version,
          incarnation: NOTE_INCARNATION,
          expect: { version: { kind: "value", value: version }, incarnation: { kind: "value", value: NOTE_INCARNATION } },
          onConflict: "rebuild",
        }),
        ...extra(name),
      ],
    };
  };
  return { calls, handler };
}

describe("dispatch: 組み直し（rebuild）", () => {
  it("外れた件がどれも rebuild の件なら、ハンドラーを借りた冪等の鍵のまま呼び直し（行を読み直す）、組み直したトランザクションが確定する", async () => {
    const { table, deps } = setup();
    table.seed("sprints", counterRow("a", 5, 1));
    const { calls, handler } = counting(table, (n) => n === 1);
    const result = await dispatch(call("notes.create", [{ project_id: P_A, title: "a", idempotency_key: IDEM_1 }]), { ...deps, handlers: { ...noteHandlers, "notes.create": handler } });
    expect(itemsOf(result)).toEqual([{ ok: true, item: { title: "a" } }]);
    expect(calls).toEqual(["a", "a"]);
    // 並んだ書き手の 1 と、読み直した行に足した 1
    expect(table.row("sprints", counterKey("a"))).toMatchObject({ count: 7, version: 3 });
    // 借りは 1 回だけ（借りの version 1 を済みで 2 にした）で、取り直していない
    const [leased] = table.rows("idempotency");
    expect(leased).toMatchObject({ state: "settled", version: 2, owner_request_id: "req-1" });
    expect(table.transactions.filter((t) => t.length === 1 && t[0]?.table === "idempotency")).toHaveLength(1);
    expect(elementRows(table)).toHaveLength(1);
  });

  it(`${DISPATCH_REBUILD_LIMIT} 回目の組み直しで確定し、${DISPATCH_REBUILD_LIMIT + 1} 回目は打たずに要求全体の 503 unavailable で warn を残す`, async () => {
    const ok = setup();
    ok.table.seed("sprints", counterRow("a", 0, 1));
    const last = counting(ok.table, (n) => n <= DISPATCH_REBUILD_LIMIT);
    const done = await dispatch(call("notes.create", [{ project_id: P_A, title: "a", idempotency_key: IDEM_1 }]), { ...ok.deps, handlers: { ...noteHandlers, "notes.create": last.handler } });
    expect(itemsOf(done)).toEqual([{ ok: true, item: { title: "a" } }]);
    expect(last.calls).toHaveLength(DISPATCH_REBUILD_LIMIT + 1);

    const ng = setup();
    ng.table.seed("sprints", counterRow("a", 0, 1));
    const always = counting(ng.table, () => true);
    const result = await dispatch(call("notes.create", [{ project_id: P_A, title: "a", idempotency_key: IDEM_1 }]), { ...ng.deps, handlers: { ...noteHandlers, "notes.create": always.handler } });
    expect(result).toEqual(problem(503, "unavailable"));
    expect(always.calls).toHaveLength(DISPATCH_REBUILD_LIMIT + 1);
    expect(elementRows(ng.table)).toHaveLength(0);
    expect(ng.lines.map((l) => JSON.parse(l))).toContainEqual(expect.objectContaining({ level: "warn", rebuilds: DISPATCH_REBUILD_LIMIT }));
  });

  it("組み直しの前に残り時間を照らし、予備の時間を下回れば組み直さずに 503 unavailable", async () => {
    const { table, deps } = setup();
    table.seed("sprints", counterRow("a", 0, 1));
    const { calls, handler } = counting(table, () => true);
    const result = await dispatch(call("notes.create", [{ project_id: P_A, title: "a", idempotency_key: IDEM_1 }], { remainingMs: () => (calls.length === 0 ? DISPATCH_RESERVE_MS : DISPATCH_RESERVE_MS - 1) }), {
      ...deps,
      handlers: { ...noteHandlers, "notes.create": handler },
    });
    expect(result).toEqual(problem(503, "unavailable"));
    expect(calls).toEqual(["a"]);
  });

  it("version_mismatch の件と一緒に外れると組み直さず、409 version_mismatch", async () => {
    const { table, deps } = setup();
    table.seed("sprints", counterRow("a", 0, 1));
    table.seed("sprints", { ...NOTE_KEY(P_A), schema_version: 1, version: 2, title: "before" });
    const stale = (): TransactItem[] => [
      replaceIfVersion({
        table: "sprints",
        item: { ...NOTE_KEY(P_A), schema_version: 1, title: "after" },
        version: 1,
        incarnation: NOTE_INCARNATION,
        expect: { version: { kind: "value", value: 1 }, incarnation: { kind: "absent" } },
        onConflict: "version_mismatch",
      }),
    ];
    const { calls, handler } = counting(table, () => true, stale);
    const result = await dispatch(call("notes.create", [{ project_id: P_A, title: "a", idempotency_key: IDEM_1 }]), { ...deps, handlers: { ...noteHandlers, "notes.create": handler } });
    expect(itemsOf(result)).toEqual([{ ok: false, status: 409, reason: "version_mismatch" }]);
    expect(calls).toEqual(["a"]);
  });

  it("要求元の照らしと一緒に外れると組み直さず、409 state_mismatch", async () => {
    const { table, deps } = setup();
    table.seed("sprints", counterRow("a", 0, 1));
    const { calls, handler } = counting(table, () => {
      revoke(table);
      return true;
    });
    const result = await dispatch(call("notes.create", [{ project_id: P_A, title: "a", idempotency_key: IDEM_1 }]), { ...deps, handlers: { ...noteHandlers, "notes.create": handler } });
    expect(itemsOf(result)).toEqual([{ ok: false, status: 409, reason: "state_mismatch" }]);
    expect(calls).toEqual(["a"]);
  });

  it("冪等の鍵の済みの行と一緒に外れる（借りを取り直された）と組み直さず、409 in_progress", async () => {
    const { table, deps } = setup();
    table.seed("sprints", counterRow("a", 0, 1));
    const { calls, handler } = counting(table, () => {
      // 借りの行を別の要求が取り直した（version が進んだ）
      const [leased] = table.rows("idempotency");
      if (leased !== undefined) table.seed("idempotency", { ...leased, version: Number(leased["version"]) + 1, owner_request_id: "req-other" });
      return true;
    });
    const result = await dispatch(call("notes.create", [{ project_id: P_A, title: "a", idempotency_key: IDEM_1 }]), { ...deps, handlers: { ...noteHandlers, "notes.create": handler } });
    expect(itemsOf(result)).toEqual([{ ok: false, status: 409, reason: "in_progress" }]);
    expect(calls).toEqual(["a"]);
  });

  it("表が断った理由（ValidationError）と条件の外れが同じ取り消しに並ぶと、組み直さずに 503 unavailable", async () => {
    const { table, deps } = setup();
    table.seed("sprints", counterRow("a", 0, 1));
    const { calls, handler } = counting(table, () => {
      table.failNext("invalid_with_conflict");
      return true;
    });
    const result = await dispatch(call("notes.create", [{ project_id: P_A, title: "a", idempotency_key: IDEM_1 }]), { ...deps, handlers: { ...noteHandlers, "notes.create": handler } });
    expect(result).toEqual(problem(503, "unavailable"));
    expect(calls).toEqual(["a"]);
    expect(table.row("sprints", counterKey("a"))).toMatchObject({ count: 1, version: 2 });
  });

  it("全部か無かでは外れた件を返した要素のハンドラーだけを呼び直し、外れていない要素の書き込みはそのまま使う", async () => {
    const { table, deps } = setup();
    table.seed("sprints", counterRow("a", 0, 1));
    table.seed("sprints", counterRow("b", 0, 1));
    const { calls, handler } = counting(table, (n, name) => name === "b" && n === 1);
    const result = await dispatch(call("notes.import", [{ project_id: P_A, title: "a" }, { project_id: P_A, title: "b" }]), { ...deps, handlers: { ...noteHandlers, "notes.import": handler } });
    expect(itemsOf(result)).toEqual([
      { ok: true, item: { title: "a" } },
      { ok: true, item: { title: "b" } },
    ]);
    expect(calls).toEqual(["a", "b", "b"]);
    expect(table.row("sprints", counterKey("a"))).toMatchObject({ count: 1, version: 2 });
    expect(table.row("sprints", counterKey("b"))).toMatchObject({ count: 2, version: 3 });
  });
});

describe("dispatch: 冪等の鍵の借りの行", () => {
  it("済みの行は借りの行の version と incarnation を条件に置き換え、全部か無かの手放しも同じ条件で消す", async () => {
    const ok = setup();
    await dispatch(call("notes.create", [{ project_id: P_A, title: "one", idempotency_key: IDEM_1 }]), ok.deps);
    const claimed = ok.table.transactions[0]?.[0]?.item;
    const settle = stateWrites(ok.table)[0]?.find((i) => i.table === "idempotency");
    expect(settle).toMatchObject({
      op: "put",
      item: { state: "settled", version: 2, incarnation: claimed?.["incarnation"] },
      condition: { kind: "and", of: [{ kind: "exists", path: "pk" }, { kind: "cmp", path: "version", value: 1 }, { kind: "cmp", path: "incarnation", value: claimed?.["incarnation"] }] },
    });

    const ng = setup();
    ng.table.seed("sprints", { pk: `PROJECT#${P_A}`, sk: "NOTE#two", schema_version: 1, version: 1, title: "two" });
    await dispatch(
      call("notes.bulk", [
        { project_id: P_A, title: "one", idempotency_key: IDEM_1 },
        { project_id: P_A, title: "two", idempotency_key: IDEM_2 },
      ]),
      ng.deps,
    );
    // 借りの行の鍵ごとの incarnation
    const leases = new Map(ng.table.transactions.filter((t) => t.length === 1 && t[0]?.table === "idempotency" && t[0].op === "put").map((t) => [t[0]?.key.pk, t[0]?.item?.["incarnation"]]));
    const releases = ng.table.transactions.filter((t) => t.some((i) => i.table === "idempotency" && i.op === "delete")).map((t) => t[0]);
    expect(leases.size).toBe(2);
    expect(releases).toHaveLength(2);
    for (const release of releases) {
      expect(release?.condition).toMatchObject({ kind: "and", of: [{ kind: "exists", path: "pk" }, { kind: "cmp", path: "version", value: 1 }, { kind: "cmp", path: "incarnation", value: leases.get(release?.key.pk) }] });
    }
    expect(ng.table.rows("idempotency")).toHaveLength(0);
  });

  it("手放しは同じ鍵で借り直した行（incarnation の違う行）を消さない", async () => {
    const { table, deps } = setup();
    table.seed("sprints", { pk: `PROJECT#${P_A}`, sk: "NOTE#two", schema_version: 1, version: 1, title: "two" });
    // 手放しの前に、借りが表の期限で消えて別の要求が同じ鍵で version 1 から借り直した
    const racing: Handler = async (item, ctx) => {
      const out = await noteHandlers["notes.bulk"]!(item, ctx);
      if ((item as { title: string }).title === "two") {
        for (const row of table.rows("idempotency")) table.seed("idempotency", { ...row, incarnation: "0f1e2d3c-4b5a-4968-8776-655443322110", owner_request_id: "req-other" });
      }
      return out;
    };
    await dispatch(
      call("notes.bulk", [
        { project_id: P_A, title: "one", idempotency_key: IDEM_1 },
        { project_id: P_A, title: "two", idempotency_key: IDEM_2 },
      ]),
      { ...deps, handlers: { ...noteHandlers, "notes.bulk": racing } },
    );
    expect(table.rows("idempotency").map((r) => r["owner_request_id"])).toEqual(["req-other", "req-other"]);
  });
});

describe("dispatch: 要約の行", () => {
  it("プロジェクトの区切りに置く要約は、そのプロジェクトで許された要素の対象と結果だけを持つ", async () => {
    const { table, deps } = setup();
    const result = await dispatch(call("notes.get", [{ project_id: P_A }, { project_id: P_B }]), deps);
    expect(itemsOf(result)[1]).toEqual({ ok: false, status: 404, reason: "not_found" });
    const summary = summaryRows(table)[0];
    expect(String(summary?.["pk"])).toContain(P_A);
    expect(JSON.stringify(summary)).not.toContain(P_B);
    expect(summary).toMatchObject({ result: { outcome: "ok", status: 200, reasons: [] } });
  });

  it("利用者を作るトランザクションが外れたら、要約は作られなかった利用者の区切りに置かない", async () => {
    const userKey = { pk: `USER#${CREATED}`, sk: "USER" };
    const create: Handler = async () => ({
      result: { ok: true, item: { user_id: CREATED } },
      writes: [putIfAbsent({ table: "users", item: { ...userKey, schema_version: 1, version: 1 }, onConflict: "state_mismatch" })],
      createdUserId: CREATED,
    });
    const { table, deps } = setup({ handlers: { ...noteHandlers, "sessions.create": create } });
    table.seed("users", { ...userKey, schema_version: 1, version: 1 });
    const newcomer: Principal = { kind: "newcomer", login: { cognitoSub: "acme-new", username: "acme-new", sessionId: "jti-new", idp: "google", subject: "s", authTime: AUTH_TIME } };
    const result = await dispatch(call("sessions.create", [{ idempotency_key: IDEM_1 }], { principal: newcomer }), deps);
    expect(itemsOf(result)).toEqual([{ ok: false, status: 409, reason: "state_mismatch" }]);
    expect(summaryRows(table).map((r) => (r["actor"] as Record<string, unknown>)["kind"])).toEqual(["newcomer"]);
    expect(JSON.stringify(summaryRows(table))).not.toContain(CREATED);
  });

  it("表に無い HTTP の経路は 404 を返す前に、操作の無い要約の行を 1 件書く", async () => {
    const { table, deps } = setup();
    const read = readHttpCall(httpEvent("/v1/nothing", "[]", HUMAN_TOKEN), () => 10_000);
    if ("kind" in read) throw new Error("呼び出しに読めない");
    expect(await dispatch(read, deps)).toEqual(problem(404, null));
    expect(summaryRows(table)).toHaveLength(1);
    expect(summaryRows(table)[0]).toMatchObject({ operation: "", result: { outcome: "rejected", status: 404 } });
  });
});

describe("dispatch: ログ", () => {
  it("要求の終わりに 1 行を出し、要素の中身と token を出さない", async () => {
    const { deps, lines } = setup();
    await dispatch(call("notes.get", [{ project_id: P_A }], viaToken(DELEGATION_TOKEN, "api")), deps);
    const last = JSON.parse(lines.at(-1) ?? "{}");
    expect(last).toMatchObject({ level: "info", msg: "要求を終えた", endpoint: "user", channel: "api", operation: "notes.get", items: 1, principal: "delegation", outcome: "ok", status: 200 });
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain(P_A);
  });

  it("想定しない失敗の要求の終わりは error で、例外の名前と要求の ID を出す", async () => {
    const boom: Handler = async () => {
      throw new RangeError("bug");
    };
    const { deps, lines } = setup({ handlers: { ...noteHandlers, "notes.get": boom } });
    await dispatch(call("notes.get", [{ project_id: P_A }]), deps);
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({ level: "error", msg: "要求を終えた", status: 503, request_id: "req-1" });
  });
});
