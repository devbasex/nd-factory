import { z } from "zod";
import { repairIdentity, rowCodec } from "../row-codec.ts";
import { idOf } from "../ids.ts";
import { languageTag, timeZone, utcDateTime } from "../values.ts";
import { expireAt, overwriteRow, type RowKey, sha256Hex, uuid, versionlessRow } from "./common.ts";

// db-users の行（利用者・ログインの組・IdP の主体の一意の行・Cognito の主体の対応の行・セッションの取り消しの行・ログインをつなぐ流れの行・委任・委任の使った時刻）

export const idp = z.enum(["google", "github"]);

// 利用者（USER#<利用者> / USER）。上書き。
// login_count は結んだログインの数（1 以上）。初めてのサインインの sessions.create が 1 で書き、logins.create が 1 足し、
// logins.delete が「2 以上」を条件に 1 引く（docs/design/data.md の「Cognito の主体の対応の行」の書き方の表）
export const userRow = overwriteRow(1, {
  user_id: idOf("usr"),
  login_count: z.int().min(1),
  display_name: z.string().max(32),
  language: languageTag.optional(),
  time_zone: timeZone.optional(),
  created_at: utcDateTime,
});
export type UserRow = z.infer<typeof userRow>;
export const userKey = (row: UserRow): RowKey => ({ pk: `USER#${row.user_id}`, sk: "USER" });

// ログインの組（USER#<利用者> / LOGIN#<IdP>#<主体>）。上書き（作ると消すのほかは、ログインの付け替えで cognito_sub と bound_auth_time を書き換えるため、
// issues/issue-2-design-row-writers.md の決定 2 で version を持つ）。
// cognito_sub は外すときに Cognito の主体の対応の行の鍵を組む値、bound_auth_time は対応の行の bound_auth_time を写した値
// （結んだ時のサインインの時刻。users.get がログインごとに返し、logins.delete の要素が読んだ値として持って照らす）
export const loginRow = overwriteRow(1, {
  user_id: idOf("usr"),
  idp,
  subject: z.string().min(1),
  cognito_sub: z.string().min(1),
  bound_auth_time: utcDateTime,
  linked_at: utcDateTime,
});
export type LoginRow = z.infer<typeof loginRow>;
export const loginKey = (row: LoginRow): RowKey => ({ pk: `USER#${row.user_id}`, sk: `LOGIN#${row.idp}#${row.subject}` });

// IdP の主体の一意の行（LOGIN#<IdP>#<主体> / LOGIN、I16）。上書き（ログインの付け替えで書き換えるため、決定 2 で version を持つ）。
// 全体の設計の列は user_id・cognito_sub・bound_auth_time で、鍵を列から組むために idp と subject を持つ（全体の設計からの読み替え）。
// cognito_sub と bound_auth_time はログインの組の行と同じ値を写し、ログインの付け替えのときだけ書き換える
export const loginSubjectRow = overwriteRow(1, {
  user_id: idOf("usr"),
  idp,
  subject: z.string().min(1),
  cognito_sub: z.string().min(1),
  bound_auth_time: utcDateTime,
});
export type LoginSubjectRow = z.infer<typeof loginSubjectRow>;
export const loginSubjectKey = (row: LoginSubjectRow): RowKey => ({ pk: `LOGIN#${row.idp}#${row.subject}`, sk: "LOGIN" });

// Cognito の主体の対応の行（COGNITO#<Cognito の sub> / COGNITO。docs/design/data.md の「Cognito の主体の対応の行」）。
// Cognito の access token は IdP の主体でなく Cognito の利用者の sub を持つため、認証（userOfSubject）はこの行を強い整合で読んで利用者を引く。
// Cognito は IdP のアカウントごとに別の利用者（別の sub）を作るため、ログインの組と 1 対 1 に当たる。
// 行は状態を持たず、行があることがその sub を利用者へ結んでいることである。結ぶときに無いときだけ書き、外すときに消す（書き換えない）。
// cognito_username は結ぶのに使った token の username（外すときの Cognito の呼び出しに渡す）、
// bound_auth_time は結ぶのに使った token の auth_time（認証はこれより前にサインインした token を断つ）
export const cognitoSubjectRow = overwriteRow(1, {
  cognito_sub: z.string().min(1),
  cognito_username: z.string().min(1),
  idp,
  subject: z.string().min(1),
  user_id: idOf("usr"),
  bound_auth_time: utcDateTime,
});
export type CognitoSubjectRow = z.infer<typeof cognitoSubjectRow>;
export const cognitoSubjectKey = (row: CognitoSubjectRow): RowKey => ({ pk: `COGNITO#${row.cognito_sub}`, sk: "COGNITO" });

// セッションの取り消しの行（COGNITO#<Cognito の sub> / REVOKED#<origin_jti>。docs/design/data.md の「セッションの取り消しの行」）。
// sessions.delete が無いときだけ書き、TTL で消える（version を持たない）。session_id は取り消したセッションの origin_jti。
// expire_at は revoked_at に SESSION_REVOKED_KEEP_MS を足した時刻を expireAtSeconds で秒にした値。認証は行があれば expire_at によらず断つ
export const sessionRevocationRow = versionlessRow(1, {
  cognito_sub: z.string().min(1),
  session_id: z.string().min(1),
  revoked_at: utcDateTime,
  expire_at: expireAt,
});
export type SessionRevocationRow = z.infer<typeof sessionRevocationRow>;
export const sessionRevocationKey = (row: SessionRevocationRow): RowKey => ({ pk: `COGNITO#${row.cognito_sub}`, sk: `REVOKED#${row.session_id}` });

// ログインをつなぐ流れの状態。open: 交換の前・verified: 交換して照らし、利用者の確かめを待つ・used: 結んだ
export const loginLinkState = z.enum(["open", "verified", "used"]);

// ログインをつなぐ流れの行（USER#<利用者> / LINK#<流れの ID>。docs/design/data.md の「ログインをつなぐ流れの行」）。
// login_links.create が open で無いときだけ書き、logins.create の交換の要素が open を条件に verified へ、確定の要素が結ぶのと同じトランザクションで used へ書き換える。
// 上書き（決定 2 で version を持つ。状態の遷移の条件はハンドラーが読んだ行で照らし、確定の条件は読んだ version にする）。列の有無の決まり（code_verifier は open の間だけ・candidate_* は verified の間だけ・
// exchange_*・account_label は verified と used の間・used_idempotency_key・linked_* は used の間）は書き手（#4）が守る。
// code_verifier はサーバーだけが持ち、画面へ返さずログに出さない。
// expires_at は確定を受け付ける期限（作成から LOGIN_LINK_TTL_MS。書き換えで変えない）、expire_at は TTL（交換と確定がそれぞれ延ばす）
export const loginLinkRow = overwriteRow(1, {
  link_id: uuid,
  state: loginLinkState,
  created_at: utcDateTime,
  user_id: idOf("usr"),
  session_sub: z.string().min(1),
  session_id: z.string().min(1),
  session_bound_auth_time: utcDateTime,
  idp,
  code_verifier: z.string().min(1).optional(),
  exchange_idempotency_key: uuid.optional(),
  exchange_fingerprint: sha256Hex.optional(),
  candidate_sub: z.string().min(1).optional(),
  candidate_username: z.string().min(1).optional(),
  candidate_idp: idp.optional(),
  candidate_subject: z.string().min(1).optional(),
  candidate_auth_time: utcDateTime.optional(),
  account_label: z.string().min(1).optional(),
  used_idempotency_key: uuid.optional(),
  linked_idp: idp.optional(),
  linked_subject: z.string().min(1).optional(),
  expires_at: utcDateTime,
  expire_at: expireAt,
});
export type LoginLinkRow = z.infer<typeof loginLinkRow>;
export const loginLinkKey = (row: LoginLinkRow): RowKey => ({ pk: `USER#${row.user_id}`, sk: `LINK#${row.link_id}` });

// 委任（USER#<利用者> / DELEGATION#<委任>）。上書き。状態は expires_at・revoked_at から導き、列に持たない。
// 最後に使った時刻は委任の使った時刻の行に置き、使うたびにこの行の version を上げない（決定 10）
export const delegationRow = overwriteRow(1, {
  delegation_id: idOf("dlg"),
  user_id: idOf("usr"),
  client_name: z.string().min(1).max(64),
  scope_project_ids: z.array(idOf("prj")).min(1),
  scope_kind: z.enum(["read", "run", "manage"]),
  secret_sha256: sha256Hex,
  expires_at: utcDateTime,
  created_at: utcDateTime,
  revoked_at: utcDateTime.optional(),
});
export type DelegationRow = z.infer<typeof delegationRow>;
export const delegationKey = (row: DelegationRow): RowKey => ({ pk: `USER#${row.user_id}`, sk: `DELEGATION#${row.delegation_id}` });

// 委任の使った時刻（USER#<利用者> / DELEGATION_USED#<委任>。issues/issue-2-design-row-writers.md の決定 10）。上書き。
// authenticate が委任の認証に成功した後だけ、委任の行の version と incarnation の照らしと一緒に書く。委任の行と同じ長さ残り、表の期限を持たない
export const delegationUsedRow = overwriteRow(1, {
  delegation_id: idOf("dlg"),
  user_id: idOf("usr"),
  last_used_at: utcDateTime,
});
export type DelegationUsedRow = z.infer<typeof delegationUsedRow>;
export const delegationUsedKey = (row: DelegationUsedRow): RowKey => ({ pk: `USER#${row.user_id}`, sk: `DELEGATION_USED#${row.delegation_id}` });

// 行の版の読み手と書き手。今の行はどれも版 1 で、前の版を持たない。
// U3b より前の書き手が保存した行（incarnation と、U3b で足した version の無い行）を、旧形式の補い（repairIdentity）で読む
export const userCodec = rowCodec({ latest: { version: 1, schema: userRow }, writeVersion: 1, repair: repairIdentity({ version: false }), keyOf: userKey });
export const loginCodec = rowCodec({ latest: { version: 1, schema: loginRow }, writeVersion: 1, repair: repairIdentity({ version: true }), keyOf: loginKey });
export const loginSubjectCodec = rowCodec({ latest: { version: 1, schema: loginSubjectRow }, writeVersion: 1, repair: repairIdentity({ version: true }), keyOf: loginSubjectKey });
export const cognitoSubjectCodec = rowCodec({ latest: { version: 1, schema: cognitoSubjectRow }, writeVersion: 1, repair: repairIdentity({ version: false }), keyOf: cognitoSubjectKey });
export const sessionRevocationCodec = rowCodec({ latest: { version: 1, schema: sessionRevocationRow }, writeVersion: 1, repair: repairIdentity({ version: false }), keyOf: sessionRevocationKey });
export const loginLinkCodec = rowCodec({ latest: { version: 1, schema: loginLinkRow }, writeVersion: 1, repair: repairIdentity({ version: true }), keyOf: loginLinkKey });
export const delegationCodec = rowCodec({ latest: { version: 1, schema: delegationRow }, writeVersion: 1, repair: repairIdentity({ version: false }), keyOf: delegationKey });
export const delegationUsedCodec = rowCodec({ latest: { version: 1, schema: delegationUsedRow }, writeVersion: 1, repair: repairIdentity({ version: true }), keyOf: delegationUsedKey });
