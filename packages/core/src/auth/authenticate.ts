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
// 利用者プールを引いてサーバーの側で得る（AuthReaders.cognitoIdentity）。authTime は IdP でサインインした時刻（token の auth_time、エポックの秒）で、
// 結ぶハンドラーが対応の行の bound_auth_time に書く。username は検証した token の username（Cognito の利用者の名前）で、
// 結ぶハンドラーが対応の行の cognito_username に書く（ログインを外すときの Cognito の呼び出しの対象）。
// sessionId は検証した token の origin_jti で、利用者を作った要素の記録を作った利用者の人の主体で書くときに使う（audit の actorOfCreatedUser）。
// 結ぶハンドラーは対応の行を無いときだけ書く（認証の読みの後に別の要求が結んだ行へ重ねて結ばない）
export type CognitoLogin = {
  readonly cognitoSub: string;
  readonly username: string;
  readonly sessionId: string;
  readonly idp: "google" | "github";
  readonly subject: string;
  readonly authTime: number;
};

export type Principal =
  // sessionId は検証した token の origin_jti（そのサインインのセッションの識別子）、boundAuthTime は対応の行の bound_auth_time
  // （結んだ時のサインインの時刻。UTC の ISO 8601）、authTime は要求の token の auth_time（エポックの秒。既にある利用者がサインインし直した
  // token では boundAuthTime より後）。dispatch は人の書き込みの要求元の照らしに cognitoSub・sessionId・boundAuthTime を使い、
  // 冪等の鍵の主体の部分（idempotencyPrincipalKey）は sessions.create で authTime、logins.create で sessionId と boundAuthTime を使う
  | {
      readonly kind: "human";
      readonly userId: Id<"usr">;
      readonly cognitoSub: string;
      readonly sessionId: string;
      readonly boundAuthTime: string;
      readonly authTime: number;
    }
  // Cognito の token は正しいが、まだ利用者へ結んでいない主体（初めてのサインインとログインの付け替え）。sessions.create だけに渡し、そのハンドラーが
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

// sessionRevokedAt は、operation が sessions.delete で要求のセッションの取り消しの行があったときだけその revoked_at、ほかは null。
// session_ended は、署名・claim・期限を通した人の token のセッションが既に断たれているときだけ（取り消しの行がある（sessions.delete を除く）・
// 対応の行が無い（sessions.create を除く）・auth_time が対応の行の bound_auth_time より前。docs/design/api.md の「誤りの形」の 401 の本文）
export type AuthResult =
  | { readonly ok: true; readonly principal: Principal; readonly sessionRevokedAt: string | null }
  | { readonly ok: false; readonly reason: "unauthorized" | "session_ended" | "unavailable" };

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
// Cognito の主体の対応の行の読んだ値（docs/design/data.md の「Cognito の主体の対応の行」）。行は状態を持たず、行があることが結んでいることである。
// boundAuthTime は結んだときに使った token の auth_time（UTC の ISO 8601）で、これより前にサインインした token を断つ
export type CognitoBinding = { readonly userId: Id<"usr">; readonly boundAuthTime: string };

// セッションの取り消しの行の読んだ値（docs/design/data.md の「セッションの取り消しの行」）。revokedAt は UTC の ISO 8601
export type SessionRevocation = { readonly revokedAt: string };

export type AuthReaders = {
  // Cognito の access token の sub から利用者を引く。読むのは db-users の Cognito の主体の対応の行
  // （COGNITO#<sub> / COGNITO。docs/design/data.md の「Cognito の主体の対応の行」）で、LOGIN#<IdP>#<主体> の行は読まない
  // （sub は Cognito の利用者の ID で、IdP の主体ではない）。行が無ければ null（一度も結んでいない）
  userOfSubject(cognitoSub: string): Promise<CognitoBinding | null>;
  // セッションの取り消しの行（COGNITO#<sub> / REVOKED#<origin_jti>）を読む。無ければ null。TTL の削除は遅れるため、行があれば expire_at によらず返す
  sessionRevocation(cognitoSub: string, sessionId: string): Promise<SessionRevocation | null>;
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

// 取り消しの行があっても断たず、期限を過ぎた access token も猶予の内なら受ける唯一の経路（サインアウト）
export const SESSIONS_DELETE = "sessions.delete";

// 冪等の鍵の主体の部分を要求のセッションで区切る経路（ログインをつなぐ）
const LOGINS_CREATE = "logins.create";

// sessions.delete だけが、exp を過ぎた Cognito の access token を受ける長さ（exp から数える）。refresh token の寿命（30 日）と同じ
export const SESSION_DELETE_EXPIRED_GRACE_MS = 2_592_000_000;

// ログインを結ぶ（sessions.create の初回と logins.create）token は、この時間の内に IdP でサインインしたものだけを受ける。
// 結ぶ要求をその場のサインインの流れに限り、前に漏れた token や外す前のセッションの token で結べないようにする
export const LOGIN_BIND_FRESH_MS = 300_000;

// 引き換えの token を受ける経路。ほかの経路は用途ごとの token（レーン・終わりの報告）だけを受ける
const RUNNER_EXCHANGE = "runner.exchanges.create";
const DB_PREP_EXCHANGE = "db_prep.exchanges.create";
const DB_PREP_COMPLETION = "db_prep.completions.create";

// session_ended の内訳（ログにだけ出す）: 取り消しの行がある・結んだ時より前のサインイン・対応の行が無い
type SessionEndedFault = "revoked" | "before_bound" | "unbound";

type Decided = { readonly principal: Principal; readonly sessionRevokedAt: string | null };

type Outcome = CheckResult<Decided> | { readonly ok: false; readonly reason: "session_ended"; readonly fault: SessionEndedFault };

const ok = (principal: Principal, sessionRevokedAt: string | null = null): Outcome => ({ ok: true, value: { principal, sessionRevokedAt } });

const sessionEnded = (fault: SessionEndedFault): Outcome => ({ ok: false, reason: "session_ended", fault });

function isExpired(iso: string, nowMs: number): boolean {
  const at = Date.parse(iso);
  return !Number.isFinite(at) || at <= nowMs;
}

// 結ぶための照らし: 新しいサインインであることと、IdP の主体のサーバーの側での取得（検証した username で利用者プールを引き、
// 利用者があり sub が token と同じこと）。外れは unauthorized（利用者が無いか別の sub が返るのは、外したログインの古い token に当たる）
async function loginOf(claims: CognitoClaims, deps: AuthDeps): Promise<CheckResult<CognitoLogin>> {
  if (claims.authTime * 1000 < deps.clock.epochMs() - LOGIN_BIND_FRESH_MS) return unauthorized("expired");
  const identity = await deps.readers.cognitoIdentity(claims.username);
  if (identity === null || identity.cognitoSub !== claims.sub) return unauthorized("unknown_principal");
  return { ok: true, value: { cognitoSub: claims.sub, username: claims.username, sessionId: claims.originJti, idp: identity.idp, subject: identity.subject, authTime: claims.authTime } };
}

async function human(token: string, operation: string, deps: AuthDeps): Promise<Outcome> {
  if (deps.cognito === null) return unauthorized("endpoint");
  // sessions.delete だけは exp から猶予の内の期限切れも通す（期限切れの token しか持たない端末が取り消しの行を確定できるように）
  const graceMs = operation === SESSIONS_DELETE ? SESSION_DELETE_EXPIRED_GRACE_MS : 0;
  const checked = await deps.cognito(token, deps.clock.epochMs(), graceMs);
  if (!checked.ok) return checked;
  const claims = checked.value;
  // 対応の行と取り消しの行を強い整合で並べて読む
  const [binding, revocation] = await Promise.all([deps.readers.userOfSubject(claims.sub), deps.readers.sessionRevocation(claims.sub, claims.originJti)]);
  // サインアウトしたセッションは断つ。sessions.delete だけは断たず、取り消し済みとその revoked_at を返す（ハンドラーが行を書かずに成功で返す）
  if (revocation !== null && operation !== SESSIONS_DELETE) return sessionEnded("revoked");
  const sessionRevokedAt = operation === SESSIONS_DELETE ? (revocation?.revokedAt ?? null) : null;
  if (binding !== null) {
    // 結んだときの token より前にサインインした token は、結ぶ前のサインインのセッションのものとして断つ（refresh token で取り直しても auth_time は変わらない）
    const bound = Date.parse(binding.boundAuthTime);
    if (!Number.isFinite(bound) || claims.authTime * 1000 < bound) return sessionEnded("before_bound");
    return ok({ kind: "human", userId: binding.userId, cognitoSub: claims.sub, sessionId: claims.originJti, boundAuthTime: binding.boundAuthTime, authTime: claims.authTime }, sessionRevokedAt);
  }
  // 結んでいない主体は sessions.create へだけ渡す。ほかの操作は、外したログインのセッションの token として断つ（取り直しても通らない）
  if (operation !== SESSIONS_CREATE) return sessionEnded("unbound");
  const login = await loginOf(claims, deps);
  return login.ok ? ok({ kind: "newcomer", login: login.value }) : login;
}

// 冪等の鍵の主体の部分（docs/design/detail.md の idempotencyPrincipalKey。docs/design/api.md の「冪等の鍵」）。
// 主体の種類ごとに頭を変え、種類の違う主体の鍵が重ならないようにする（利用者の ID は usr_ の頭を持つ）
export function idempotencyPrincipalKey(principal: Principal, operation: string): string {
  // sessions.create だけは、対応の行を作る前（newcomer）と後（human）で同じ鍵になるよう、検証した Cognito の sub と要求の token の auth_time の組で区切る。
  // human の boundAuthTime はサインインし直した要求では token の auth_time と違うため使わない。外した後にサインインし直すと auth_time が変わるため、
  // 外す前の結果を外した後の要求へ返さない
  if (operation === SESSIONS_CREATE) {
    if (principal.kind === "newcomer") return `COGNITO#${principal.login.cognitoSub}#${principal.login.authTime}`;
    if (principal.kind === "human") return `COGNITO#${principal.cognitoSub}#${principal.authTime}`;
  }
  switch (principal.kind) {
    case "human":
      // logins.create だけは要求のセッションと結んだ時のサインインの時刻で区切り、同じ利用者の別のセッションの再送へ保存した結果を返さない
      return operation === LOGINS_CREATE ? `${principal.userId}#LINK#${principal.cognitoSub}#${principal.sessionId}#${principal.boundAuthTime}` : principal.userId;
    case "newcomer":
      // 認可が sessions.create の外を先に拒むため、ここへ届くのは実装の誤り
      throw new Error(`まだ結んでいない人の冪等の鍵は sessions.create だけ: ${operation}`);
    case "delegation":
      return principal.userId;
    case "runner":
      return `LANE#${principal.laneId}#${principal.generation}`;
    case "machine":
      return `MACHINE#${principal.teamId}#${principal.machineId}`;
    case "db_prep":
      return `DBPREP#${principal.projectId}#${principal.prepId}`;
    case "github":
      return "GITHUB";
    case "patrol":
      return "PATROL";
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
    deps.log?.info("主体を決めた", { principal: outcome.value.principal.kind, result: "ok" });
    return { ok: true, principal: outcome.value.principal, sessionRevokedAt: outcome.value.sessionRevokedAt };
  }
  if (outcome.reason === "unavailable") {
    deps.log?.warn("認証の依存先に届かない", { result: "unavailable", error: outcome.cause });
    return { ok: false, reason: "unavailable" };
  }
  if (outcome.reason === "session_ended") {
    deps.log?.info("セッションが断たれている", { principal: "human", result: "session_ended", fault: outcome.fault });
    return { ok: false, reason: "session_ended" };
  }
  const fault: TokenFault = outcome.fault;
  deps.log?.info("主体を決められない", { result: "unauthorized", fault });
  return { ok: false, reason: "unauthorized" };
}
