import { RETRY_POLICIES } from "@nd-factory/contracts/data";
import {
  DB_PREP_AUDIENCE,
  dbPrepTokenClaims,
  delegationToken,
  machineToken,
  RUNNER_AUDIENCE,
  runnerTokenClaims,
  type DbPrepTokenClaims,
  type RunnerTokenClaims,
} from "@nd-factory/contracts/tokens";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import {
  CognitoJwtInvalidClientIdError,
  CognitoJwtInvalidTokenUseError,
  FetchError,
  JwksNotAvailableInCacheError,
  JwksValidationError,
  JwkValidationError,
  JwtBaseError,
  JwtExpiredError,
  JwtInvalidIssuerError,
  JwtInvalidSignatureError,
  JwtNotBeforeError,
  KidNotFoundInJwksError,
  ParameterValidationError,
  WaitPeriodNotYetEndedJwkError,
} from "aws-jwt-verify/error";
import { SimpleFetcher, type Fetcher } from "aws-jwt-verify/https";
import { SimpleJwksCache } from "aws-jwt-verify/jwk";
import { createHash, createHmac, timingSafeEqual, verify, type KeyObject } from "node:crypto";

// token の照らしの部品。authenticate だけが使う。token とその要約値・秘密の部分を戻り値の外へ運ばない（ログにも出さない）

// 照らしに外れた内訳。ログにだけ出し、応答は理由によらず同じ 401 にする
export type TokenFault = "shape" | "signature" | "expired" | "revoked" | "endpoint" | "unknown_principal" | "state";

export type CheckResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: "unauthorized"; readonly fault: TokenFault } | { readonly ok: false; readonly reason: "unavailable"; readonly cause: string };

export function unauthorized(fault: TokenFault): { readonly ok: false; readonly reason: "unauthorized"; readonly fault: TokenFault } {
  return { ok: false, reason: "unauthorized", fault };
}

// 3 つの部分の JWT の形（base64url の 3 つを . で区切る）
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function isJwtShape(token: string): boolean {
  return JWT_SHAPE.test(token);
}

// 不透明な token（委任・登録）。形の正本の形に合えば、頭の後の 2 つの ID と秘密の部分を返す
export type OpaqueToken = { readonly first: string; readonly second: string; readonly secret: string };

function splitOpaque(token: string, head: string): OpaqueToken | null {
  const [first, second, secret] = token.slice(head.length).split(".");
  if (first === undefined || second === undefined || secret === undefined) return null;
  return { first, second, secret };
}

export function parseDelegationToken(token: string): OpaqueToken | null {
  return delegationToken.safeParse(token).success ? splitOpaque(token, "ndfd_") : null;
}

export function parseMachineToken(token: string): OpaqueToken | null {
  return machineToken.safeParse(token).success ? splitOpaque(token, "ndfm_") : null;
}

// SHA-256 の 16 進（64 字）の形
const SHA256_HEX = /^[0-9a-f]{64}$/;

// 秘密の部分の SHA-256 を、控えた要約と一定時間で比べる。控えの形が違えば合わないとする
export function secretMatches(secret: string, expectedSha256Hex: string): boolean {
  if (!SHA256_HEX.test(expectedSha256Hex)) return false;
  const actual = createHash("sha256").update(secret, "utf8").digest();
  return timingSafeEqual(actual, Buffer.from(expectedSha256Hex, "hex"));
}

// GitHub の Webhook の署名（X-Hub-Signature-256: sha256=<16 進>）を、本文の HMAC-SHA256 と一定時間で比べる
const GITHUB_SIGNATURE = /^sha256=([0-9a-f]{64})$/;

// 本文はバイト列のまま受ける。文字列に直すと不正な UTF-8 が置換文字に化け、正当な署名でも合わなくなる
export function webhookSignatureMatches(rawBody: Uint8Array, secret: string, signature: string | null): boolean {
  const matched = signature === null ? null : GITHUB_SIGNATURE.exec(signature);
  const hex = matched?.[1];
  if (hex === undefined) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(hex, "hex"));
}

// nd-factory 自身が Ed25519 で署名する JWT（ランナーと DB の用意のタスク）。aws-jwt-verify を通さず node:crypto の verify で照らす。
// 主張の形（宛先・期限・用途・sub・project_id、ランナーだけ generation）の正本は形の正本の tokens.ts で、発行する子（#6・#13）も同じ形を読む
export { DB_PREP_AUDIENCE, RUNNER_AUDIENCE };
export type { DbPrepTokenClaims, RunnerTokenClaims };

export type SignedClaims = Readonly<Record<string, unknown>>;

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 署名・宛先・期限を照らし、通れば主張を返す。期限は exp の秒が今より後のときだけ通す。
// verify(null, …) は渡された鍵の種別で方式を選ぶため、鍵が Ed25519 でなければ照らさない（ヘッダーの alg だけでは方式を固定できない）。
// 鍵の種別の誤りは設定の誤りのため、token の外れ（401）でなく依存先の失敗（503）にする
export function verifySignedJwt(token: string, key: KeyObject, audience: string, nowMs: number): CheckResult<SignedClaims> {
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") return { ok: false, reason: "unavailable", cause: "signing_key_not_ed25519" };
  if (!isJwtShape(token)) return unauthorized("shape");
  const [headerB64 = "", payloadB64 = "", signatureB64 = ""] = token.split(".");
  const header = decodeSegment(headerB64);
  const payload = decodeSegment(payloadB64);
  if (!isRecord(header) || !isRecord(payload) || header["alg"] !== "EdDSA") return unauthorized("shape");
  let valid: boolean;
  try {
    valid = verify(null, Buffer.from(`${headerB64}.${payloadB64}`, "utf8"), key, Buffer.from(signatureB64, "base64url"));
  } catch {
    valid = false;
  }
  if (!valid) return unauthorized("signature");
  if (payload["aud"] !== audience) return unauthorized("endpoint");
  const exp = payload["exp"];
  if (typeof exp !== "number" || !Number.isFinite(exp)) return unauthorized("shape");
  if (exp * 1000 <= nowMs) return unauthorized("expired");
  return { ok: true, value: payload };
}

// 署名と宛先と期限を照らした主張を、形の正本の主張の形で読む。形に外れれば null
export function runnerClaimsOf(claims: SignedClaims): RunnerTokenClaims | null {
  const parsed = runnerTokenClaims.safeParse(claims);
  return parsed.success ? parsed.data : null;
}

export function dbPrepClaimsOf(claims: SignedClaims): DbPrepTokenClaims | null {
  const parsed = dbPrepTokenClaims.safeParse(claims);
  return parsed.success ? parsed.data : null;
}

// Cognito の access token の照らし。aws-jwt-verify の Cognito の検証で、署名（kid の公開鍵）・発行元・client_id・token_use を照らす。
// 期限（exp。必須）と nbf は、ほかの token と同じく authenticate の注入した時計（nowMs）だけで照らす。aws-jwt-verify は exp・nbf を
// 実時刻（Date.now）で照らし、時計を受けないため、その照らしは graceSeconds を無限にして止める（ほかの照らしには graceSeconds が効かない）。
// 公開鍵の控えは組み込みの SimpleJwksCache と SimplePenaltyBox を既定のまま使い、取り手 SimpleFetcher には方針 http-idp-keys の
// responseTimeout だけを渡す（決定 17。全体の設計の決定 48）。控えは実行環境ごとに 1 つで、起点が 1 回だけ作る
export type CognitoConfig = { readonly userPoolId: string; readonly clientId: string };

// sub は Cognito の利用者の ID、username は Cognito の利用者の名前（IdP の主体を引く AdminGetUser に渡す）、
// authTime は利用者が IdP でサインインした時刻（auth_time。refresh token で取り直しても変わらない）のエポックの秒
export type CognitoClaims = { readonly sub: string; readonly username: string; readonly authTime: number };

export type CognitoCheck = (token: string, nowMs: number) => Promise<CheckResult<CognitoClaims>>;

export type CognitoCheckOptions = {
  // テストだけが差し替える（本番は SimpleFetcher のまま）
  readonly fetcher?: Fetcher;
};

const IDP_KEYS_POLICY = RETRY_POLICIES["http-idp-keys"];

// 公開鍵を取れない・取った鍵の集まりが読めない・設定の誤りは依存先の失敗（503）。ほかの照らしの外れは 401
function isUnavailable(error: unknown): boolean {
  if (!(error instanceof JwtBaseError)) return true;
  return error instanceof FetchError || error instanceof JwksValidationError || error instanceof JwkValidationError || error instanceof JwksNotAvailableInCacheError || error instanceof ParameterValidationError;
}

// aws-jwt-verify の誤りの型は name を持たないため、型で分ける
function faultOf(error: unknown): TokenFault {
  if (error instanceof JwtExpiredError || error instanceof JwtNotBeforeError) return "expired";
  if (error instanceof JwtInvalidSignatureError || error instanceof KidNotFoundInJwksError || error instanceof WaitPeriodNotYetEndedJwkError) return "signature";
  if (error instanceof CognitoJwtInvalidTokenUseError || error instanceof CognitoJwtInvalidClientIdError || error instanceof JwtInvalidIssuerError) return "endpoint";
  return "shape";
}

function causeOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "unknown";
}

// 利用者のプールの発行元（地域の形と全体の形。aws-jwt-verify が両方を受ける）。
// aws-jwt-verify は設定に無い発行元の token を設定の誤り（ParameterValidationError）として投げるため、渡す前に照らして 401 にする
function issuersOf(userPoolId: string): readonly string[] {
  const region = userPoolId.split("_")[0] ?? "";
  return [`https://cognito-idp.${region}.amazonaws.com/${userPoolId}`, `https://issuer-cognito-idp.${region}.amazonaws.com/${userPoolId}`];
}

function issuerOf(token: string): unknown {
  if (!isJwtShape(token)) return undefined;
  const payload = decodeSegment(token.split(".")[1] ?? "");
  return isRecord(payload) ? payload["iss"] : undefined;
}

export function createCognitoCheck(config: CognitoConfig, options: CognitoCheckOptions = {}): CognitoCheck {
  const issuers = issuersOf(config.userPoolId);
  const fetcher = options.fetcher ?? new SimpleFetcher({ defaultRequestOptions: { responseTimeout: IDP_KEYS_POLICY.response_timeout_ms } });
  const verifier = CognitoJwtVerifier.create(
    { userPoolId: config.userPoolId, tokenUse: "access", clientId: config.clientId, graceSeconds: Number.POSITIVE_INFINITY },
    { jwksCache: new SimpleJwksCache({ fetcher }) },
  );
  return async (token, nowMs) => {
    const iss = issuerOf(token);
    if (typeof iss !== "string") return unauthorized("shape");
    if (!issuers.includes(iss)) return unauthorized("endpoint");
    try {
      const payload = await verifier.verify(token);
      const sub = payload.sub;
      if (typeof sub !== "string" || sub.length === 0) return unauthorized("shape");
      // aws-jwt-verify は exp が無ければ期限を照らさないため、有限の数の exp を必須にする
      const exp: unknown = payload.exp;
      if (typeof exp !== "number" || !Number.isFinite(exp)) return unauthorized("shape");
      if (exp * 1000 <= nowMs) return unauthorized("expired");
      const nbf: unknown = payload.nbf;
      if (nbf !== undefined && (typeof nbf !== "number" || !Number.isFinite(nbf))) return unauthorized("shape");
      if (typeof nbf === "number" && nbf * 1000 > nowMs) return unauthorized("expired");
      // 結び直す前の token を断つ照らし（authenticate）と、結ぶときの新しさの照らしに使うため、username と有限の数の auth_time を必須にする
      const username: unknown = payload.username;
      if (typeof username !== "string" || username.length === 0) return unauthorized("shape");
      const authTime: unknown = payload.auth_time;
      if (typeof authTime !== "number" || !Number.isFinite(authTime)) return unauthorized("shape");
      return { ok: true, value: { sub, username, authTime } };
    } catch (error) {
      if (isUnavailable(error)) return { ok: false, reason: "unavailable", cause: causeOf(error) };
      return unauthorized(faultOf(error));
    }
  };
}
