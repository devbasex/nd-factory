import { z } from "zod";
import { idOf } from "../ids.ts";
import { languageTag, timeZone, utcDateTime } from "../values.ts";
import { overwriteRow, type RowKey, sha256Hex, versionlessRow } from "./common.ts";

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
