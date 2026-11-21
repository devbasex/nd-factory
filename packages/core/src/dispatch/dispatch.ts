import { isPending, resultSchemaOf, type OperationDef } from "@nd-factory/contracts/operation";
import { cognitoSubjectKey, sessionRevocationKey, type CognitoSubjectRow, type SessionRevocationRow } from "@nd-factory/contracts/rows/users";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { actorOfCreatedUser, appendAudit, auditItem, type AuditActor, type AuditEntry, type AuditResult } from "../audit.ts";
import { authenticate, idempotencyPrincipalKey, SESSIONS_DELETE, type Principal } from "../auth/authenticate.ts";
import { authorize, type ItemAuthz, type ProjectId } from "../authorize.ts";
import { AuditAppendOnlyError, cond, TRANSACT_MAX_ITEMS, WriteSpecError, WriteUnavailableError, writeAtomically, type ConflictRule, type TransactItem, type WriteOutcome } from "../conditional-write.ts";
import { claimIdempotency, settleIdempotency, type IdempotencyClaimInput, type ItemResult } from "../idempotency.ts";
import { newId, type Id } from "../ids.ts";
import type { Logger } from "../log.ts";
import { bodyFaultOf, canonicalJson, problem } from "./http.ts";
import type { AllowedAuthz, DispatchDeps, DispatchResult, Handler, HandlerOutput, OperationCall, Problem } from "./types.ts";

export { readHttpCall, writeHttpResponse } from "./http.ts";
export type * from "./types.ts";

// 操作の振り分け（docs/design/detail.md の「処理の手順」の dispatch）。受けた方法 → 認証 → 本文の形 → 人だけ・委任の種類 →
// 要素ごとの 形 → 見えない → 人だけの要素 → 役割 → 冪等の鍵 → ハンドラー → 確定 を、どの受け口でも同じ順で通す。
// 書く要素ごとに、状態の書き込み・要素の記録の行・冪等の鍵の済みの行（と、主体が人なら要求元の照らし）を 1 つの writeAtomically で確定し（I9）、
// 要求ごとに要約の記録の行を appendAudit で書く。記録を書けなければ 503 で値を返さない

// 要約の記録と応答に残す時間（ミリ秒）。要素の前の残り時間がこれを下回れば、残りの要素を処理しない
export const DISPATCH_RESERVE_MS = 1500;

// 認可の対象を要素の指す行でなく主体の利用者自身にする操作（外したログインの行の有無は、冪等の鍵の照合の後にハンドラーが照らす）
const LOGINS_DELETE = "logins.delete";

// 残りの要素を処理せずに要求全体の誤りで返す
class Halt extends Error {
  override name = "Halt";
  readonly problem: Problem;
  constructor(result: Problem) {
    super(`要求を止める（${result.status}）`);
    this.problem = result;
  }
}

const halt = (status: number, reason: string): Halt => new Halt(problem(status, reason));

// 要約の行に書く、要求の中で決まったこと
type Seen = { principal: Principal | null; createdUserId: Id<"usr"> | null; items: readonly unknown[]; authz: readonly ItemAuthz[] };

type Request = {
  readonly call: OperationCall;
  readonly deps: DispatchDeps;
  readonly op: OperationDef | null;
  readonly at: string;
  readonly auditId: Id<"aud">;
  readonly log: Logger;
  readonly seen: Seen;
};

const operationTables = new WeakMap<readonly OperationDef[], Map<string, OperationDef>>();

function operationOf(operations: readonly OperationDef[], name: string): OperationDef | null {
  let table = operationTables.get(operations);
  if (table === undefined) {
    table = new Map(operations.map((op) => [op.name, op]));
    operationTables.set(operations, table);
  }
  return table.get(name) ?? null;
}

const failure = (status: number, reason: string, fields?: readonly string[]): ItemResult => (fields === undefined ? { ok: false, status, reason } : { ok: false, status, reason, fields });

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function fingerprintOf(item: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(item))));
}

// 記録

function actorOf(req: Request, principal: Principal | null, createdUserId: Id<"usr"> | null): AuditActor {
  const actor: AuditActor = { principal, mcpClientName: req.call.mcpClientName ?? null };
  return createdUserId === null ? actor : actorOfCreatedUser(actor, createdUserId);
}

function entryOf(req: Request, actor: AuditActor, fields: Pick<AuditEntry, "targetIds" | "projectId" | "result" | "itemIndex">): AuditEntry {
  return { auditId: req.auditId, requestId: req.call.requestId, at: req.at, actor, channel: req.call.channel, operation: req.op?.name ?? null, ...fields };
}

function itemAuditResult(result: ItemResult): AuditResult {
  if (result.ok) return { outcome: "ok", status: 200, reasons: [] };
  return { outcome: "rejected", status: typeof result["status"] === "number" ? result["status"] : 0, reasons: typeof result["reason"] === "string" ? [result["reason"]] : [] };
}

function summaryResult(result: DispatchResult): AuditResult {
  if (result.kind === "problem") return { outcome: "rejected", status: result.status, reasons: result.reason === null ? [] : [result.reason] };
  const reasons = [...new Set(result.items.flatMap((r) => (!r.ok && typeof r["reason"] === "string" ? [r["reason"]] : [])))];
  return { outcome: result.items.every((r) => r.ok) ? "ok" : "partial", status: 200, reasons };
}

// 要約の行の対象の ID の元。許した鍵（op.auditKeys）ごとに要素の値を集める（行へは ID の形の値だけを auditItem が写す）
function summaryTargets(op: OperationDef | null, items: readonly unknown[]): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const key of op?.auditKeys ?? []) {
    const values = items.flatMap((item) => {
      const value = record(item)[key];
      return Array.isArray(value) ? value : value === undefined ? [] : [value];
    });
    if (values.length > 0) out[key] = values;
  }
  return out;
}

// 見られたプロジェクトが 1 つに決まるときだけ、その区切りに置く
function soleProject(authz: readonly ItemAuthz[]): ProjectId | null {
  const ids = new Set(authz.flatMap((a) => (a.decision === "allow" && a.projectId !== null ? [a.projectId] : [])));
  return ids.size === 1 ? ([...ids][0] ?? null) : null;
}

// 要約の行を書いてから返す。書けなければ 503 audit_unavailable で値を返さない。既に 503 の結果は書けなくてもそのまま
async function finish(req: Request, result: DispatchResult): Promise<DispatchResult> {
  const { seen } = req;
  const fields = { targetIds: summaryTargets(req.op, seen.items), projectId: soleProject(seen.authz), result: summaryResult(result), itemIndex: null };
  try {
    await appendAudit(req.deps.db, entryOf(req, actorOf(req, seen.principal, seen.createdUserId), fields), req.op, req.deps.clock);
    return result;
  } catch (error) {
    req.log.error("要約の記録の行を書けない", { error: errorName(error) });
    return result.kind === "problem" && result.status === 503 ? result : problem(503, "audit_unavailable");
  }
}

// 人の書き込みの要求元の照らし（docs/design/data.md の「人の書き込みの要求元の照らし」）。主体が人の書く操作で、sessions.delete を除く。
// 要求元の対応の行が今も主体の利用者と結んだ時刻のままであることと、要求元のセッションの取り消しの行が無いことを、書かない条件で照らす
function requesterGuards(op: OperationDef, principal: Principal): TransactItem[] {
  if (op.access !== "write" || principal.kind !== "human" || op.name === SESSIONS_DELETE) return [];
  const binding = cognitoSubjectKey({ cognito_sub: principal.cognitoSub } as CognitoSubjectRow);
  const revocation = sessionRevocationKey({ cognito_sub: principal.cognitoSub, session_id: principal.sessionId } as SessionRevocationRow);
  return [
    {
      table: "users",
      op: "check",
      key: binding,
      condition: cond.and(cond.exists("pk"), cond.eq("user_id", principal.userId), cond.eq("bound_auth_time", principal.boundAuthTime)),
      onConflict: "state_mismatch",
    },
    { table: "users", op: "check", key: revocation, condition: cond.notExists("pk"), onConflict: "state_mismatch" },
  ];
}

// 確定の組み立て。件ごとに、どの要素のどの役の件かを持つ（外れた件を要素の結果へ戻すため）

type Handled = { readonly result: ItemResult; readonly writes: readonly TransactItem[]; readonly claim: IdempotencyClaimInput | null; readonly authz: AllowedAuthz; readonly item: unknown; readonly createdUserId: Id<"usr"> | null };

type Part = { readonly element: number; readonly writes: readonly TransactItem[]; readonly audit: TransactItem; readonly settle: TransactItem | null };

// guarded は要求元の照らしの件か、要求元の条件を足した件
type Slot = { readonly element: number | null; readonly role: "write" | "audit" | "settle" | "guard"; readonly writeIndex: number; readonly guarded: boolean };

const sameRow = (a: TransactItem, b: TransactItem): boolean => a.table === b.table && a.key.pk === b.key.pk && a.key.sk === b.key.sk;

function partOf(req: Request, principal: Principal, op: OperationDef, element: number, h: Handled, writes: readonly TransactItem[]): Part {
  const entry = entryOf(req, actorOf(req, principal, h.createdUserId), { targetIds: record(h.item), projectId: h.authz.projectId, result: itemAuditResult(h.result), itemIndex: element });
  return { element, writes, audit: auditItem(entry, op, req.deps.clock), settle: h.claim === null ? null : settleIdempotency(h.claim, h.result, op, req.deps.clock) };
}

// ハンドラーの書き込みが要求元の照らしと同じ行を指すときは件を足さず、その書き込みの条件に要求元の条件を AND で足す（同じ行を 2 回指せない）
function compose(parts: readonly Part[], guards: readonly TransactItem[]): { items: TransactItem[]; slots: Slot[] } {
  const items: TransactItem[] = [];
  const slots: Slot[] = [];
  const rest = [...guards];
  for (const part of parts) {
    part.writes.forEach((write, writeIndex) => {
      const at = rest.findIndex((guard) => sameRow(guard, write));
      const guard = at < 0 ? undefined : rest.splice(at, 1)[0];
      items.push(guard === undefined ? write : { ...write, condition: cond.and(write.condition, guard.condition) });
      slots.push({ element: part.element, role: "write", writeIndex, guarded: guard !== undefined });
    });
    items.push(part.audit);
    slots.push({ element: part.element, role: "audit", writeIndex: -1, guarded: false });
    if (part.settle !== null) {
      items.push(part.settle);
      slots.push({ element: part.element, role: "settle", writeIndex: -1, guarded: false });
    }
  }
  for (const guard of rest) {
    items.push(guard);
    slots.push({ element: null, role: "guard", writeIndex: -1, guarded: true });
  }
  return { items, slots };
}

// 確定。届かないときは記録の行を含むため 503 audit_unavailable。組み方の誤り（記録の表の書き換え・件の数の越え）と表が断った失敗は 503 unavailable
async function commit(req: Request, items: readonly TransactItem[]): Promise<WriteOutcome> {
  try {
    return await writeAtomically(req.deps.db, items, req.log);
  } catch (error) {
    if (error instanceof WriteUnavailableError) throw halt(503, error.includesAudit ? "audit_unavailable" : "unavailable");
    if (error instanceof AuditAppendOnlyError || error instanceof WriteSpecError) req.log.error("ハンドラーが組んだ書き込みを確定しない", { error: error.name });
    throw halt(503, "unavailable");
  }
}

type Failed = { readonly slot: Slot; readonly onConflict: ConflictRule };

function failedOf(outcome: Extract<WriteOutcome, { ok: false }>, slots: readonly Slot[]): Failed[] {
  return outcome.failed.flatMap((f) => {
    const slot = slots[f.index];
    return slot === undefined ? [] : [{ slot, onConflict: f.onConflict }];
  });
}

// 1 つの要素の外れた件を結果へ訳す。要求元の照らし（足した条件を含む）を先に当て、残りはハンドラーが並べた件の順の最初の理由。
// 記録の行が外れたら 503 audit_unavailable、済みの行だけが外れたら（借りを失った）409 in_progress。
// どの外れた書き込みも return_existing なら、それを外して確定し直す（retry）
function verdictOf(req: Request, failed: readonly Failed[]): ItemResult | "retry" {
  if (failed.some((f) => f.slot.guarded)) return failure(409, "state_mismatch");
  if (failed.some((f) => f.slot.role === "audit")) throw halt(503, "audit_unavailable");
  const own = failed.filter((f) => f.slot.role === "write").sort((a, b) => a.slot.writeIndex - b.slot.writeIndex);
  if (own.length === 0) return failure(409, "in_progress");
  const decisive = own.find((f) => f.onConflict !== "return_existing");
  if (decisive === undefined) return "retry";
  if (decisive.onConflict === "version_mismatch" || decisive.onConflict === "state_mismatch") return failure(409, decisive.onConflict);
  req.log.error("ハンドラーの書き込みの条件が外れた", { failed: own.map((f) => f.onConflict) });
  throw halt(503, "unavailable");
}

// 要素ごと

type ParsedItem = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly fields: string[] };

function parseItems(op: OperationDef, items: readonly unknown[]): ParsedItem[] {
  const schema = op.item;
  if (isPending(schema)) return items.map(() => ({ ok: false, fields: [] }));
  return items.map((item, index) => {
    const parsed = schema.safeParse(item);
    if (parsed.success) return { ok: true, value: parsed.data };
    return { ok: false, fields: [...new Set(parsed.error.issues.map((issue) => [`/${index}`, ...issue.path.map(String)].join("/")))] };
  });
}

function checkTime(req: Request): void {
  if (req.call.remainingMs() < DISPATCH_RESERVE_MS) {
    req.log.warn("関数の残り時間が足りないため残りの要素を処理しない", { reserve_ms: DISPATCH_RESERVE_MS });
    throw halt(503, "unavailable");
  }
}

type Ctx = { readonly req: Request; readonly principal: Principal; readonly sessionRevokedAt: string | null; readonly op: OperationDef; readonly handler: Handler };

function checkOutput(c: Ctx, output: HandlerOutput | undefined): HandlerOutput {
  const valid = output !== null && typeof output === "object" && Array.isArray(output.writes) && resultSchemaOf(c.op).safeParse(output.result).success;
  if (!valid || output === undefined) {
    c.req.log.error("ハンドラーの戻り値が操作の形に合わない", {});
    throw halt(503, "unavailable");
  }
  if (c.op.access === "read" && output.writes.length > 0) {
    c.req.log.error("読む操作のハンドラーが書き込みを返した", {});
    throw halt(503, "unavailable");
  }
  return output;
}

// 1 つの要素の、形 → 見えない・人だけの要素・役割（authorize が決めた）→ 冪等の鍵 → ハンドラー
async function prepare(c: Ctx, index: number, parsed: ParsedItem, authz: ItemAuthz | undefined): Promise<ItemResult | Handled> {
  const { req, principal, op } = c;
  if (!parsed.ok) return failure(400, "item_invalid", parsed.fields);
  if (authz === undefined || authz.decision === "deny") return failure(authz?.status ?? 404, authz?.reason ?? "not_found");

  let claim: IdempotencyClaimInput | null = null;
  if (op.idempotencyKey) {
    const key = record(parsed.value)["idempotency_key"];
    if (typeof key !== "string" || key.length === 0) return failure(400, "item_invalid", [`/${index}/idempotency_key`]);
    claim = { principalKey: idempotencyPrincipalKey(principal, op.name), operation: op.name, key, fingerprint: fingerprintOf(parsed.value), requestId: req.call.requestId };
    let claimed;
    try {
      claimed = await claimIdempotency(req.deps.db, claim, req.deps.clock, req.log);
    } catch (error) {
      req.log.error("冪等の鍵の表に届かない", { error: errorName(error) });
      throw halt(503, "unavailable");
    }
    if (claimed.kind === "replay") return claimed.result;
    if (claimed.kind === "in_progress") return failure(409, "in_progress");
    if (claimed.kind === "reused") return failure(422, "idempotency_key_reused");
  }

  let output: HandlerOutput | undefined;
  try {
    output = await c.handler(parsed.value, { principal, authz, clock: req.deps.clock, db: req.deps.db, sessionRevokedAt: c.sessionRevokedAt });
  } catch (error) {
    req.log.error("ハンドラーが想定しない例外を投げた", { error: errorName(error) });
    throw halt(503, "unavailable");
  }
  const checked = checkOutput(c, output);
  const createdUserId = principal.kind === "newcomer" ? (checked.createdUserId ?? null) : null;
  return { result: checked.result, writes: checked.writes, claim, authz, item: parsed.value, createdUserId };
}

const isHandled = (p: ItemResult | Handled): p is Handled => "writes" in p && "claim" in p;

// 要素ごとの確定。状態を書かず冪等の鍵も押さえていない要素は、要約の行だけに残す
async function settleElement(c: Ctx, index: number, h: Handled): Promise<ItemResult> {
  const { req, principal, op } = c;
  if (op.access === "read" || (h.writes.length === 0 && h.claim === null)) return h.result;
  if (h.createdUserId !== null) req.seen.createdUserId = h.createdUserId;
  const guards = requesterGuards(op, principal);
  let writes = h.writes;
  // return_existing の外れを外した確定し直しは 1 回だけ
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { items, slots } = compose([partOf(req, principal, op, index, h, writes)], guards);
    const outcome = await commit(req, items);
    if (outcome.ok) return h.result;
    const failed = failedOf(outcome, slots);
    const verdict = verdictOf(req, failed);
    if (verdict !== "retry") return verdict;
    const dropped = new Set(failed.map((f) => f.slot.writeIndex));
    writes = writes.filter((_, i) => !dropped.has(i));
  }
  req.log.error("同じ行の既にある書き込みを外しても確定できない", {});
  throw halt(503, "unavailable");
}

async function eachItem(c: Ctx, parsed: readonly ParsedItem[], authz: readonly (ItemAuthz | undefined)[]): Promise<ItemResult[]> {
  const results: ItemResult[] = [];
  for (const [index, item] of parsed.entries()) {
    checkTime(c.req);
    const p = await prepare(c, index, item, authz[index]);
    results.push(isHandled(p) ? await settleElement(c, index, p) : p);
  }
  return results;
}

// 全部か無か: すべての要素の書き込みを 1 つの writeAtomically に集め（要求元の照らしは 1 回）、要素の失敗が 1 つでもあれば確定しない
async function allOrNothing(c: Ctx, parsed: readonly ParsedItem[], authz: readonly (ItemAuthz | undefined)[]): Promise<ItemResult[]> {
  const { req, principal, op } = c;
  const prepared: (ItemResult | Handled)[] = [];
  for (const [index, item] of parsed.entries()) {
    checkTime(req);
    prepared.push(await prepare(c, index, item, authz[index]));
  }
  const results = prepared.map((p) => (isHandled(p) ? p.result : p));
  const notApplied = failure(409, "not_applied");
  if (results.some((r) => !r.ok)) return results.map((r) => (r.ok ? notApplied : r));

  const parts = prepared.flatMap((p, index) => (isHandled(p) && (p.writes.length > 0 || p.claim !== null) ? [partOf(req, principal, op, index, p, p.writes)] : []));
  if (parts.length === 0) return results;
  const { items, slots } = compose(parts, requesterGuards(op, principal));
  if (items.length > TRANSACT_MAX_ITEMS) {
    req.log.error("全部か無かの書き込みが 1 つのトランザクションに収まらない", { count: items.length });
    throw halt(503, "unavailable");
  }
  const outcome = await commit(req, items);
  if (outcome.ok) return results;
  const failed = failedOf(outcome, slots);
  if (failed.some((f) => f.slot.role === "audit")) throw halt(503, "audit_unavailable");
  // 要求元の照らしの件が外れたら、どの要素も 409 state_mismatch
  if (failed.some((f) => f.slot.element === null)) return results.map(() => failure(409, "state_mismatch"));
  return results.map((_, element) => {
    const mine = failed.filter((f) => f.slot.element === element);
    if (mine.length === 0) return notApplied;
    const verdict = verdictOf(req, mine);
    return verdict === "retry" ? failure(409, "state_mismatch") : verdict;
  });
}

// logins.delete の認可の対象は、要素が指すログインの組の行でなく認証した主体の利用者自身（読み手に外すログインの行を引かせない）
function authzItemOf(op: OperationDef, principal: Principal, item: unknown): unknown {
  return op.name === LOGINS_DELETE && principal.kind === "human" ? { user_id: principal.userId } : item;
}

async function run(req: Request): Promise<DispatchResult> {
  const { call, deps, op } = req;
  // 受けた方法が POST でない・受け口と操作の受け口の食い違い（MCP の受け口は利用者向けの操作を呼ぶ）
  const expected = call.endpoint === "mcp" ? "user" : call.endpoint;
  if (call.fault?.status === 405 || (op !== null && op.endpoint !== expected)) return finish(req, problem(405, null));

  // 認証。MCP の tools/call は serveMcp が決めた主体のまま続ける
  let principal: Principal;
  let sessionRevokedAt: string | null = null;
  if (call.principal !== undefined) principal = call.principal;
  else {
    const auth = await authenticate({ endpoint: call.endpoint, operation: call.operation, token: call.token }, { ...deps.auth, log: req.log });
    if (!auth.ok) return finish(req, auth.reason === "unavailable" ? problem(503, "unavailable") : problem(401, auth.reason));
    principal = auth.principal;
    sessionRevokedAt = auth.sessionRevokedAt;
  }
  req.seen.principal = principal;

  // 本文の形（HTTP は readHttpCall が見つけた誤り、MCP の入口は arguments.items を同じ順で照らす）
  const bodyFault = call.fault?.status === 400 ? call.fault.reason : bodyFaultOf(call.items, op);
  if (bodyFault !== null) return finish(req, problem(400, bodyFault));
  req.seen.items = call.items;

  // 形の未定か、ハンドラーの表に無い操作
  const handler = op === null ? undefined : deps.handlers[op.name];
  if (op === null || isPending(op.item) || isPending(op.result) || handler === undefined) {
    req.log.error("操作の形が未定かハンドラーが無い", {});
    return finish(req, problem(503, "unavailable"));
  }

  // 要素の形を照らし、通った要素だけを認可へ渡す。人だけ・委任の種類は要求全体で、見えない・人だけの要素・役割は要素ごとに決まる
  const parsed = parseItems(op, call.items);
  const valid = parsed.flatMap((p, i) => (p.ok ? [{ index: i, value: p.value }] : []));
  let decision;
  try {
    decision = await authorize(principal, op, valid.map((v) => authzItemOf(op, principal, v.value)), deps.scope, req.log);
  } catch (error) {
    req.log.error("認可の読み手が失敗した", { error: errorName(error) });
    return finish(req, problem(503, "unavailable"));
  }
  if ("reject" in decision) return finish(req, problem(403, decision.reject));
  const authz: (ItemAuthz | undefined)[] = parsed.map(() => undefined);
  valid.forEach((v, i) => (authz[v.index] = decision.items[i]));
  req.seen.authz = decision.items;

  const c: Ctx = { req, principal, sessionRevokedAt, op, handler };
  try {
    const results = op.allOrNothing === null ? await eachItem(c, parsed, authz) : await allOrNothing(c, parsed, authz);
    return await finish(req, { kind: "items", items: results });
  } catch (error) {
    if (error instanceof Halt) return finish(req, error.problem);
    throw error;
  }
}

export async function dispatch(call: OperationCall, deps: DispatchDeps): Promise<DispatchResult> {
  const started = deps.clock.epochMs();
  // 受け口はログの文脈の必須の endpoint が持つ（起点が受け口ごとに渡す）
  const log = deps.log.child({ channel: call.channel, operation: call.operation });
  const req: Request = {
    call,
    deps,
    op: operationOf(deps.operations, call.operation),
    at: deps.clock.iso(),
    auditId: newId("aud", deps.clock),
    log,
    seen: { principal: null, createdUserId: null, items: [], authz: [] },
  };
  let result: DispatchResult;
  try {
    result = await run(req);
  } catch (error) {
    // 想定しない失敗は 503 にし、500 を返さない
    log.error("振り分けで想定しない失敗", { error: errorName(error) });
    result = await finish(req, problem(503, "unavailable"));
  }
  // 要求の終わりに 1 行。要素の中身・token・応答の値は出さない
  const fields = {
    items: Array.isArray(call.items) ? call.items.length : 0,
    principal: req.seen.principal?.kind ?? null,
    outcome: summaryResult(result).outcome,
    status: result.kind === "problem" ? result.status : 200,
    duration_ms: deps.clock.epochMs() - started,
  };
  if (result.kind === "problem" && result.status === 503) log.error("要求を終えた", fields);
  else log.info("要求を終えた", fields);
  return result;
}
