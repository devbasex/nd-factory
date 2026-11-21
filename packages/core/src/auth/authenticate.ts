import type { DelegationKind } from "@nd-factory/contracts/operation";
import type { KeyObject } from "node:crypto";
import type { Clock } from "../clock.ts";
import { parseId, type Id } from "../ids.ts";
import type { Logger } from "../log.ts";
import {
  DB_PREP_AUDIENCE,
  dbPrepClaimsOf,
  isJwtShape,
  parseDelegationToken,
  parseMachineToken,
  RUNNER_AUDIENCE,
  runnerClaimsOf,
  secretMatches,
  unauthorized,
  verifySignedJwt,
  webhookSignatureMatches,
  type CheckResult,
  type CognitoCheck,
  type CognitoClaims,
  type SignedClaims,
  type TokenFault,
} from "./tokens.ts";

export { createCognitoCheck, DB_PREP_AUDIENCE, RUNNER_AUDIENCE, type CognitoCheck, type CognitoCheckOptions, type CognitoClaims, type CognitoConfig } from "./tokens.ts";

// 要求の主体を 1 つに決める（docs/design/api.md の「認証と主体」）。受け口の種類と token の種類だけで決め、外から届く頭書きで変えない。
// 認可の判定（authorize）と操作の記録（audit）が主体を読む

// 検証した Cognito の主体と、それに当たる IdP の主体。IdP の主体は要求の本文から採らず、検証した token の username で
// 利用者プールを引いてサーバーの側で得る（AuthReaders.cognitoIdentity）。authTime は IdP でサインインした時刻（エポックの秒）
export type CognitoLogin = {
  readonly cognitoSub: string;
  readonly idp: "google" | "github";
  readonly subject: string;
  readonly authTime: number;
};

export type Principal =
  // cognitoSub は sessions.create の冪等の鍵を結ぶ前後で同じにするために持つ（idempotencyPrincipalKey）
  | { readonly kind: "human"; readonly userId: Id<"usr">; readonly cognitoSub: string }
  // Cognito の token は正しいが、まだ利用者へ結んでいない主体（初めてのサインイン）。sessions.create だけに渡し、そのハンドラーが
  // login の値（検証した主体とサーバーの側で得た IdP の主体）で利用者・ログインの組・IdP の主体の一意の行・Cognito の主体の対応の行を作る
  | { readonly kind: "newcomer"; readonly login: CognitoLogin }
  | {
      readonly kind: "delegation";
      readonly userId: Id<"usr">;
      readonly delegationId: Id<"dlg">;
      readonly scope: { readonly projectIds: readonly Id<"prj">[]; readonly operations: DelegationKind };
      readonly clientName: string;
    }
  | { readonly kind: "runner"; readonly laneId: Id<"lane">; readonly projectId: Id<"prj">; readonly generation: number }
  | { readonly kind: "machine"; readonly teamId: Id<"team">; readonly machineId: Id<"mch"> }
  | { readonly kind: "github" }
  | { readonly kind: "db_prep"; readonly projectId: Id<"prj">; readonly prepId: string }
  | { readonly kind: "patrol" };

export type AuthResult = { readonly ok: true; readonly principal: Principal } | { readonly ok: false; readonly reason: "unauthorized" | "unavailable" };

// 受け口（受けた HTTP の経路の頭で決まる）。見回りは HTTP の経路を持たず、認証を通らない
export type AuthEndpoint = "user" | "mcp" | "runner" | "machine" | "github" | "db_prep";

export type InboundRequest = {
  readonly endpoint: AuthEndpoint;
  // 操作の名前（経路ごとの token の用途を照らす。GitHub の Webhook は空）
  readonly operation: string;
  // Authorization の Bearer の値。無ければ null
  readonly token: string | null;
  // GitHub の Webhook だけ: 受けたままの本文のバイト列と X-Hub-Signature-256 の値。
  // 受け口は本文を文字列に直さずに渡す（API Gateway の isBase64Encoded なら base64 から、そうでなければ UTF-8 でバイト列に戻す）
  readonly rawBody?: Uint8Array;
  readonly signature?: string | null;
};

// 最後に使った時刻を、前の値からこの時間がたったときだけ書く
export const DELEGATION_TOUCH_MS = 3_600_000;

// 委任の行の読んだ値（中身は委任の持ち主の子 #11 が apps/api/src/modules/ で読む）
export type DelegationRecord = {
  readonly secretSha256: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly scope: { readonly projectIds: readonly Id<"prj">[]; readonly operations: DelegationKind };
  readonly clientName: string;
};

// 手元のマシンの行の読んだ値（#7）
export type MachineRecord = { readonly secretSha256: string; readonly expiresAt: string; readonly revokedAt: string | null };

// レーンの行の読んだ値（#6）。終わったレーン・前の世代の token は断つ（I11）。
// exchangedGeneration は引き換えの token を使い終えた世代（まだなら null）。世代ごとに持つため、世代を上げても消し直さない
export type LaneRecord = { readonly projectId: Id<"prj">; readonly generation: number; readonly ended: boolean; readonly exchangedGeneration: number | null };

// プロジェクトの進行表の DB の用意の状態（#13）。consumed は今の用意（prepId）の 1 回だけの token のうち使い終えた用途
export type DbPrepUse = "exchange" | "completion";
export type DbPrepRecord = { readonly prepId: string; readonly inProgress: boolean; readonly consumed: readonly DbPrepUse[] };

// 1 回だけの token（ランナーの引き換え・DB の用意の引き換えと終わりの報告）の使い終えの印:
// authenticate は読んだ印で使い終えた token を断つだけで、印を書かない（読むだけでは同じ時の 2 つの要求を分けられない）。
// 1 回だけを守るのはその経路のハンドラーで、返す値の書き込みと同じ writeAtomically に、印の無いときだけ印を付ける条件つきの書き込みを入れる。
// 認証の読みの後に行が変わり得るため、その条件には authenticate が照らした状態も同じく入れ直す:
// - ランナー: レーンが終わっておらず（終了・取り消し済みでない）、今の世代が token の世代と同じで、exchangedGeneration が token の世代でないときだけ token の世代にする
// - DB の用意: 進行表の DB が作成中か差し替えの途中で、prepId が token の用意と同じで、consumed にその用途が無いときだけ足す
// 条件に外れたら、authenticate の外れと同じ 401 unauthorized を返し、値を返さない

// 行の読み手（ポート）。どれも表の本体を強い整合で読む。中身は行の持ち主の子が書く（core から apps へ依存しない）
// Cognito の主体の対応の行の読んだ値。boundAuthTime は結んだときに使った token の auth_time（UTC の ISO 8601）で、
// これより前にサインインした token（結び直す前のセッション）を断つ
export type CognitoBinding = { readonly userId: Id<"usr">; readonly boundAuthTime: string };

export type AuthReaders = {
  // Cognito の access token の sub から利用者を引く。読むのは db-users の Cognito の主体の対応の行
  // （COGNITO#<sub> / COGNITO の user_id と bound_auth_time。docs/design/data.md の「Cognito の主体の対応の行」）で、LOGIN#<IdP>#<主体> の行は読まない
  // （sub は Cognito の利用者の ID で、IdP の主体ではない）。行が無ければ null
  userOfSubject(cognitoSub: string): Promise<CognitoBinding | null>;
  // 検証した token の username で利用者プールの利用者を読み（AdminGetUser）、属性 sub と identities（IdP の名前と IdP の利用者の ID）を返す。
  // IdP の名前は設定で google か github に当てる。利用者が無い・identities が 1 件でない・当たる IdP が無ければ null
  cognitoIdentity(username: string): Promise<{ readonly cognitoSub: string; readonly idp: "google" | "github"; readonly subject: string } | null>;
  delegation(userId: Id<"usr">, delegationId: Id<"dlg">): Promise<DelegationRecord | null>;
  // 最後に使った時刻を at にする。今の値が ifBefore より前（か無い）ときだけ書く条件つきの更新
  touchDelegation(userId: Id<"usr">, delegationId: Id<"dlg">, at: string, ifBefore: string): Promise<void>;
  machine(teamId: Id<"team">, machineId: Id<"mch">): Promise<MachineRecord | null>;
  lane(laneId: Id<"lane">): Promise<LaneRecord | null>;
  dbPrep(projectId: Id<"prj">): Promise<DbPrepRecord | null>;
};

export type AuthDeps = {
  // Cognito の照らし（起点が実行環境ごとに 1 回 createCognitoCheck で作る）。設定が無い環境は null で、人の token を断つ
  readonly cognito: CognitoCheck | null;
  // nd-factory 自身の Ed25519 の検証の鍵（秘密の器から起動のときに 1 回読む）
  readonly signingKey: KeyObject | null;
  // GitHub の Webhook の署名の秘密
  readonly webhookSecret: string | null;
  readonly readers: AuthReaders;
  readonly clock: Clock;
  readonly log?: Logger;
};

// 利用者へ結んでいない人の主体を受ける唯一の経路（初めてのサインインで利用者を作る）
export const SESSIONS_CREATE = "sessions.create";

// ログインを結ぶ（sessions.create の初回と logins.create）token は、この時間の内に IdP でサインインしたものだけを受ける。
// 結ぶ要求をその場のサインインの流れに限り、前に漏れた token や外す前のセッションの token で結べないようにする
export const LOGIN_BIND_FRESH_MS = 300_000;

// 引き換えの token を受ける経路。ほかの経路は用途ごとの token（レーン・終わりの報告）だけを受ける
const RUNNER_EXCHANGE = "runner.exchanges.create";
const DB_PREP_EXCHANGE = "db_prep.exchanges.create";
const DB_PREP_COMPLETION = "db_prep.completions.create";

type Outcome = CheckResult<Principal>;

const ok = (principal: Principal): Outcome => ({ ok: true, value: principal });

function isExpired(iso: string, nowMs: number): boolean {
  const at = Date.parse(iso);
  return !Number.isFinite(at) || at <= nowMs;
}

// 結ぶための新しさの照らしと、IdP の主体のサーバーの側での取得（検証した username で利用者プールを引き、sub が token と同じこと）
async function loginOf(claims: CognitoClaims, deps: AuthDeps): Promise<CheckResult<CognitoLogin>> {
  if (claims.authTime * 1000 < deps.clock.epochMs() - LOGIN_BIND_FRESH_MS) return unauthorized("expired");
  const identity = await deps.readers.cognitoIdentity(claims.username);
  if (identity === null || identity.cognitoSub !== claims.sub) return unauthorized("unknown_principal");
  return { ok: true, value: { cognitoSub: claims.sub, idp: identity.idp, subject: identity.subject, authTime: claims.authTime } };
}

async function human(token: string, operation: string, deps: AuthDeps): Promise<Outcome> {
  if (deps.cognito === null) return unauthorized("endpoint");
  const checked = await deps.cognito(token, deps.clock.epochMs());
  if (!checked.ok) return checked;
  const cognitoSub = checked.value.sub;
  const binding = await deps.readers.userOfSubject(cognitoSub);
  if (binding !== null) {
    // 結んだときの token より前にサインインした token は、外して結び直す前のセッションのものとして断つ
    const bound = Date.parse(binding.boundAuthTime);
    if (!Number.isFinite(bound) || checked.value.authTime * 1000 < bound) return unauthorized("unknown_principal");
    return ok({ kind: "human", userId: binding.userId, cognitoSub });
  }
  // 結んでいない主体は sessions.create へだけ渡す（ほかの操作は利用者を持たないため断る）
  if (operation !== SESSIONS_CREATE) return unauthorized("unknown_principal");
  const login = await loginOf(checked.value, deps);
  return login.ok ? ok({ kind: "newcomer", login: login.value }) : login;
}

// logins.create のハンドラーが、要素の login_token（つなぐログインで今サインインした Cognito の access token）を照らす。
// 要求の Authorization（今の利用者）とは別に、人の token と同じ検証・新しさの照らし・サーバーの側での IdP の主体の取得を通し、
// まだ結んでいない主体だけを返す。外れたら要素の 401 unauthorized（理由は分けない）、依存先に届かなければ unavailable
export async function verifyLoginToLink(loginToken: string, deps: AuthDeps): Promise<{ readonly ok: true; readonly login: CognitoLogin } | { readonly ok: false; readonly reason: "unauthorized" | "unavailable" }> {
  try {
    if (deps.cognito === null || !isJwtShape(loginToken)) return { ok: false, reason: "unauthorized" };
    const checked = await deps.cognito(loginToken, deps.clock.epochMs());
    if (!checked.ok) return { ok: false, reason: checked.reason };
    if ((await deps.readers.userOfSubject(checked.value.sub)) !== null) return { ok: false, reason: "unauthorized" };
    const login = await loginOf(checked.value, deps);
    return login.ok ? { ok: true, login: login.value } : { ok: false, reason: login.reason };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

// 冪等の鍵の主体の部分（docs/design/api.md の「冪等の鍵」）。人と委任は主体の利用者。
// sessions.create だけは、対応の行を作る前（newcomer）と後（human）で同じ鍵になるよう、検証した Cognito の sub で区切る
export function idempotencyPrincipalKey(principal: Principal, operation: string): string {
  switch (principal.kind) {
    case "human":
      return operation === SESSIONS_CREATE ? `COGNITO#${principal.cognitoSub}` : principal.userId;
    case "newcomer":
      return `COGNITO#${principal.login.cognitoSub}`;
    case "delegation":
      return principal.userId;
    case "runner":
      return principal.laneId;
    case "machine":
      return principal.machineId;
    case "db_prep":
      return `${principal.projectId}#${principal.prepId}`;
    case "github":
    case "patrol":
      return principal.kind;
  }
}

async function delegation(token: string, deps: AuthDeps): Promise<Outcome> {
  const parsed = parseDelegationToken(token);
  const userId = parsed === null ? null : parseId("usr", parsed.first);
  const delegationId = parsed === null ? null : parseId("dlg", parsed.second);
  if (parsed === null || userId === null || delegationId === null) return unauthorized("shape");
  const row = await deps.readers.delegation(userId, delegationId);
  if (row === null || !secretMatches(parsed.secret, row.secretSha256)) return unauthorized("signature");
  const now = deps.clock.epochMs();
  if (row.revokedAt !== null) return unauthorized("revoked");
  if (isExpired(row.expiresAt, now)) return unauthorized("expired");
  await touch(userId, delegationId, row, deps);
  return ok({ kind: "delegation", userId, delegationId, scope: row.scope, clientName: row.clientName });
}

// 書けなくても主体は決めたまま続ける（次の要求で書き直す）
async function touch(userId: Id<"usr">, delegationId: Id<"dlg">, row: DelegationRecord, deps: AuthDeps): Promise<void> {
  const now = deps.clock.epochMs();
  const last = row.lastUsedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(row.lastUsedAt);
  if (Number.isFinite(last) && now - last < DELEGATION_TOUCH_MS) return;
  try {
    await deps.readers.touchDelegation(userId, delegationId, deps.clock.iso(), new Date(now - DELEGATION_TOUCH_MS).toISOString());
  } catch (error) {
    deps.log?.warn("委任の最後に使った時刻を書けない", { principal: "delegation", error: error instanceof Error ? error.name : "unknown" });
  }
}

async function machine(token: string, deps: AuthDeps): Promise<Outcome> {
  const parsed = parseMachineToken(token);
  const teamId = parsed === null ? null : parseId("team", parsed.first);
  const machineId = parsed === null ? null : parseId("mch", parsed.second);
  if (parsed === null || teamId === null || machineId === null) return unauthorized("shape");
  const row = await deps.readers.machine(teamId, machineId);
  if (row === null || !secretMatches(parsed.secret, row.secretSha256)) return unauthorized("signature");
  if (row.revokedAt !== null) return unauthorized("revoked");
  if (isExpired(row.expiresAt, deps.clock.epochMs())) return unauthorized("expired");
  return ok({ kind: "machine", teamId, machineId });
}

function signedClaims(token: string, audience: string, deps: AuthDeps): CheckResult<SignedClaims> {
  if (deps.signingKey === null) return unauthorized("endpoint");
  return verifySignedJwt(token, deps.signingKey, audience, deps.clock.epochMs());
}

async function runner(token: string, operation: string, deps: AuthDeps): Promise<Outcome> {
  const checked = signedClaims(token, RUNNER_AUDIENCE, deps);
  if (!checked.ok) return checked;
  const claims = checked.value;
  // 引き換えの経路だけ引き換えの token、ほかはレーンの token
  if (claims["token_use"] !== (operation === RUNNER_EXCHANGE ? "exchange" : "lane")) return unauthorized("endpoint");
  const runnerClaims = runnerClaimsOf(claims);
  const laneId = runnerClaims === null ? null : parseId("lane", runnerClaims.sub);
  const projectId = runnerClaims === null ? null : parseId("prj", runnerClaims.project_id);
  if (runnerClaims === null || laneId === null || projectId === null) return unauthorized("shape");
  const generation = runnerClaims.generation;
  const lane = await deps.readers.lane(laneId);
  if (lane === null || lane.ended || lane.generation !== generation || lane.projectId !== projectId) return unauthorized("state");
  // 引き換えの token は引き換えた時点で断つ（印を付けるのは引き換えのハンドラー。上の「使い終えの印」）
  if (claims["token_use"] === "exchange" && lane.exchangedGeneration === generation) return unauthorized("state");
  return ok({ kind: "runner", laneId, projectId, generation });
}

function dbPrepUseOf(operation: string): DbPrepUse | null {
  if (operation === DB_PREP_EXCHANGE) return "exchange";
  if (operation === DB_PREP_COMPLETION) return "completion";
  return null;
}

async function dbPrep(token: string, operation: string, deps: AuthDeps): Promise<Outcome> {
  const checked = signedClaims(token, DB_PREP_AUDIENCE, deps);
  if (!checked.ok) return checked;
  const claims = checked.value;
  // 引き換えの経路だけ引き換えの token、終わりの報告の経路だけ終わりの報告の token
  const use = dbPrepUseOf(operation);
  if (use === null || claims["token_use"] !== use) return unauthorized("endpoint");
  const prepClaims = dbPrepClaimsOf(claims);
  const projectId = prepClaims === null ? null : parseId("prj", prepClaims.project_id);
  if (prepClaims === null || projectId === null) return unauthorized("shape");
  const prepId = prepClaims.sub;
  const prep = await deps.readers.dbPrep(projectId);
  // 進行表の DB が作成中か差し替えの途中で、token の用意が今の用意と合い、その用途をまだ使っていない（1 回だけ。印を付けるのはハンドラー。上の「使い終えの印」）
  if (prep === null || !prep.inProgress || prep.prepId !== prepId || prep.consumed.includes(use)) return unauthorized("state");
  return ok({ kind: "db_prep", projectId, prepId });
}

function github(req: InboundRequest, deps: AuthDeps): Outcome {
  if (deps.webhookSecret === null || req.rawBody === undefined) return unauthorized("endpoint");
  return webhookSignatureMatches(req.rawBody, deps.webhookSecret, req.signature ?? null) ? ok({ kind: "github" }) : unauthorized("signature");
}

async function decide(req: InboundRequest, deps: AuthDeps): Promise<Outcome> {
  // GitHub は Authorization を読まない
  if (req.endpoint === "github") return github(req, deps);
  const token = req.token;
  if (token === null || token.length === 0) return unauthorized("shape");
  switch (req.endpoint) {
    case "user":
      if (token.startsWith("ndfd_")) return delegation(token, deps);
      return isJwtShape(token) ? human(token, req.operation, deps) : unauthorized("shape");
    case "mcp":
      // MCP は委任の token だけ。人の JWT は断る
      return token.startsWith("ndfd_") ? delegation(token, deps) : unauthorized("endpoint");
    case "runner":
      return runner(token, req.operation, deps);
    case "machine":
      return token.startsWith("ndfm_") ? machine(token, deps) : unauthorized("endpoint");
    case "db_prep":
      return dbPrep(token, req.operation, deps);
  }
}

export async function authenticate(req: InboundRequest, deps: AuthDeps): Promise<AuthResult> {
  let outcome: Outcome;
  try {
    outcome = await decide(req, deps);
  } catch (error) {
    // 読み手が表に届かない
    outcome = { ok: false, reason: "unavailable", cause: error instanceof Error ? error.name : "unknown" };
  }
  // token・要約値・秘密の部分・JWT の項目は出さない。unauthorized の内訳はログにだけ出す
  // 受け口はログの文脈の必須の endpoint が持つ（項目に重ねて書くと field.endpoint に避けられる）
  if (outcome.ok) {
    deps.log?.info("主体を決めた", { principal: outcome.value.kind, result: "ok" });
    return { ok: true, principal: outcome.value };
  }
  if (outcome.reason === "unavailable") {
    deps.log?.warn("認証の依存先に届かない", { result: "unavailable", error: outcome.cause });
    return { ok: false, reason: "unavailable" };
  }
  const fault: TokenFault = outcome.fault;
  deps.log?.info("主体を決められない", { result: "unauthorized", fault });
  return { ok: false, reason: "unauthorized" };
}
