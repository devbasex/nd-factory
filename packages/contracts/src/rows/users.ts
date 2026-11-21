import { z } from "zod";
import { rowCodec } from "../row-codec.ts";
import { idOf } from "../ids.ts";
import { languageTag, timeZone, utcDateTime } from "../values.ts";
import { overwriteRow, type RowKey, sha256Hex, versionlessRow } from "./common.ts";

// db-users の行（利用者・ログインの組・IdP の主体の一意の行・委任）

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

// 行の版の読み手と書き手。今の行はどれも版 1 で、前の版を持たない
export const userCodec = rowCodec({ latest: { version: 1, schema: userRow }, writeVersion: 1, keyOf: userKey });
export const loginCodec = rowCodec({ latest: { version: 1, schema: loginRow }, writeVersion: 1, keyOf: loginKey });
export const loginSubjectCodec = rowCodec({ latest: { version: 1, schema: loginSubjectRow }, writeVersion: 1, keyOf: loginSubjectKey });
export const delegationCodec = rowCodec({ latest: { version: 1, schema: delegationRow }, writeVersion: 1, keyOf: delegationKey });
