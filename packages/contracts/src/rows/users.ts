import { z } from "zod";
import { idOf } from "../ids.ts";
import { languageTag, timeZone, utcDateTime } from "../values.ts";
import { overwriteRow, type RowKey, sha256Hex, uuid, versionlessRow } from "./common.ts";

// db-users の行（利用者・ログインの組・IdP の主体の一意の行・Cognito の主体の対応の行・委任）

export const idp = z.enum(["google", "github"]);

// 利用者（USER#<利用者> / USER）。上書き
export const userRow = overwriteRow(1, {
  user_id: idOf("usr"),
  display_name: z.string().max(32),
  language: languageTag.optional(),
  time_zone: timeZone.optional(),
  created_at: utcDateTime,
});
export type UserRow = z.infer<typeof userRow>;
export const userKey = (row: UserRow): RowKey => ({ pk: `USER#${row.user_id}`, sk: "USER" });

// ログインの組（USER#<利用者> / LOGIN#<IdP>#<主体>）。作ると消すだけ
export const loginRow = versionlessRow(1, {
  user_id: idOf("usr"),
  idp,
  subject: z.string().min(1),
  linked_at: utcDateTime,
});
export type LoginRow = z.infer<typeof loginRow>;
export const loginKey = (row: LoginRow): RowKey => ({ pk: `USER#${row.user_id}`, sk: `LOGIN#${row.idp}#${row.subject}` });

// IdP の主体の一意の行（LOGIN#<IdP>#<主体> / LOGIN、I16）。作ると消すだけ。
// 全体の設計の列は user_id だけで、鍵を列から組むために idp と subject を持つ（全体の設計からの読み替え）
export const loginSubjectRow = versionlessRow(1, {
  user_id: idOf("usr"),
  idp,
  subject: z.string().min(1),
});
export type LoginSubjectRow = z.infer<typeof loginSubjectRow>;
export const loginSubjectKey = (row: LoginSubjectRow): RowKey => ({ pk: `LOGIN#${row.idp}#${row.subject}`, sk: "LOGIN" });

// Cognito の主体の対応の行（COGNITO#<Cognito の sub> / COGNITO）。上書き（外しても消さず、失効の境を残す）。
// Cognito の access token は IdP の主体でなく Cognito の利用者の sub を持つため、認証（userOfSubject）はこの行を強い整合で読んで利用者を引く。
// Cognito は IdP のアカウントごとに別の利用者（別の sub）を作るため、ログインの組と 1 対 1 に当たる。
// state は bound（結んでいる。user_id と bound_auth_time を持つ）・signing_out（外して、その Cognito の利用者の
// AdminUserGlobalSignOut の済むのを待つ間。結び直せない）・unlinked（外して失効を済ませた。revoked_before を持つ）。
// bound_auth_time は結んだときに使った token の auth_time。認証はこれより前にサインインした token を断つ。
// revoked_before は失効を済ませた時刻。これ以前にサインインした token では結び直せない（外す前のセッションと、失効の済む前のセッション）。
// binding_epoch は外した回数。sessions.create の冪等の鍵に入れ、外す前の結果を外した後に返さない。
// cognito_username は結ぶのに使った token の username で、外した後の AdminUserGlobalSignOut に渡す。
// signout_lease_id と signout_lease_until は signing_out の間だけ持つ、失効の呼び出しの借り。「行う予定」の行（外したときの binding_epoch に固定）の
// 実行が AdminUserGlobalSignOut を呼ぶ前に、同じ世代の signing_out で借りが無いか期限を過ぎたときだけ取り、借りの持ち主だけが unlinked へ進める。
// signout_unsettled_until は、応答を失った呼び出し（打ち切り・期限切れ・失敗。Cognito に届いた実行は取り消せない）の結果の分からない期間の終わり。
// この時刻より前は借りを取らず、この時刻より後に始めた呼び出しの成功だけで unlinked へ進める（後から処理される前の失効が、結び直したセッションへ届かない）
// 状態ごとに持つ列を形で決める（bound は user_id と bound_auth_time、unlinked は revoked_before が必須。失効の借りと
// 結果の分からない期間の列は signing_out の間だけ）。状態に当たらない列を持つ行は断つ（読み手が状態の値を組めない行を書かせない）
export const COGNITO_SUBJECT_STATES = ["bound", "signing_out", "unlinked"] as const;
const cognitoSubjectCommon = {
  cognito_sub: z.string().min(1),
  cognito_username: z.string().min(1),
  idp,
  subject: z.string().min(1),
  binding_epoch: z.int().min(0),
};
// その状態では持たない列
const absent = z.never().optional();
export const cognitoSubjectRow = z.discriminatedUnion("state", [
  overwriteRow(1, {
    ...cognitoSubjectCommon,
    state: z.literal("bound"),
    user_id: idOf("usr"),
    bound_auth_time: utcDateTime,
    revoked_before: absent,
    signout_lease_id: absent,
    signout_lease_until: absent,
    signout_unsettled_until: absent,
  }),
  overwriteRow(1, {
    ...cognitoSubjectCommon,
    state: z.literal("signing_out"),
    user_id: absent,
    bound_auth_time: absent,
    revoked_before: absent,
    signout_lease_id: uuid.optional(),
    signout_lease_until: utcDateTime.optional(),
    signout_unsettled_until: utcDateTime.optional(),
  }),
  overwriteRow(1, {
    ...cognitoSubjectCommon,
    state: z.literal("unlinked"),
    user_id: absent,
    bound_auth_time: absent,
    revoked_before: utcDateTime,
    signout_lease_id: absent,
    signout_lease_until: absent,
    signout_unsettled_until: absent,
  }),
]);
export type CognitoSubjectRow = z.infer<typeof cognitoSubjectRow>;
export const cognitoSubjectKey = (row: CognitoSubjectRow): RowKey => ({ pk: `COGNITO#${row.cognito_sub}`, sk: "COGNITO" });

// 委任（USER#<利用者> / DELEGATION#<委任>）。上書き。状態は expires_at・revoked_at から導き、列に持たない
export const delegationRow = overwriteRow(1, {
  delegation_id: idOf("dlg"),
  user_id: idOf("usr"),
  client_name: z.string().min(1).max(64),
  scope_project_ids: z.array(idOf("prj")).min(1),
  scope_kind: z.enum(["read", "run", "manage"]),
  secret_sha256: sha256Hex,
  expires_at: utcDateTime,
  created_at: utcDateTime,
  last_used_at: utcDateTime.optional(),
  revoked_at: utcDateTime.optional(),
});
export type DelegationRow = z.infer<typeof delegationRow>;
export const delegationKey = (row: DelegationRow): RowKey => ({ pk: `USER#${row.user_id}`, sk: `DELEGATION#${row.delegation_id}` });
