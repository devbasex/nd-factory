import { z } from "zod";
import { rowCodec } from "../row-codec.ts";
import { idOf } from "../ids.ts";
import { utcDateTime } from "../values.ts";
import { expireAt, identifier, reasonCode, type RowKey, versionlessRow } from "./common.ts";

// db-audit の行（操作の記録）。追記だけ（I9）。列は全体の設計（docs/design/data.md の「テーブル定義」）のとおりで、
// 鍵を列から組むための audit_id・project_id・item_index と、要求の ID（request_id）は横断の部品の audit の書き手の列に合わせた

// 主体。人・委任・ランナー・手元のマシン・GitHub・見回り・DB の用意のタスクで項目が違うため、知らない項目を落とさない。
// 主体の決まらない 401 は kind が null
export const auditActor = z.looseObject({
  kind: identifier.nullable(),
  user_id: idOf("usr").optional(),
  team_id: idOf("team").optional(),
  project_id: idOf("prj").optional(),
});

export const auditResult = z.strictObject({
  outcome: z.enum(["ok", "partial", "rejected"]),
  status: z.int().min(100).max(599),
  reasons: z.array(reasonCode),
});

// 操作の記録（PROJECT#・USER#・TEAM#・ANON#<UTC の年月日> / <時刻>#<ID>）。記録を残す日数で TTL
export const auditRow = versionlessRow(1, {
  audit_id: idOf("aud"),
  request_id: z.string().min(1),
  at: utcDateTime,
  actor: auditActor,
  channel: identifier,
  // 操作の表の名前。表に無い HTTP の経路は空の文字列
  operation: z.string(),
  target_ids: z.array(z.string()),
  // 主体がそのプロジェクトを見られたときだけ
  project_id: idOf("prj").optional(),
  // 要素の番号。要約の行は持たない
  item_index: z.int().min(0).optional(),
  result: auditResult,
  expire_at: expireAt,
});
export type AuditRow = z.infer<typeof auditRow>;

// 区切りの鍵: 見られたプロジェクト → 主体の利用者 → 主体のチーム・結んだプロジェクト → 主体の決まらない日ごとの区切り
function auditPartition(row: AuditRow): string {
  if (row.project_id !== undefined) return `PROJECT#${row.project_id}`;
  const { actor } = row;
  if ((actor.kind === "human" || actor.kind === "delegation") && actor.user_id !== undefined) return `USER#${actor.user_id}`;
  if (actor.kind === "machine" && actor.team_id !== undefined) return `TEAM#${actor.team_id}`;
  if ((actor.kind === "runner" || actor.kind === "db_prep") && actor.project_id !== undefined) return `PROJECT#${actor.project_id}`;
  return `ANON#${row.at.slice(0, 10)}`;
}

// 要約の行と要素の行は同じ記録の ID を持つため、要素の行は並びの鍵の末尾に要素の番号を足して分ける
export const auditKey = (row: AuditRow): RowKey => ({
  pk: auditPartition(row),
  sk: row.item_index === undefined ? `${row.at}#${row.audit_id}` : `${row.at}#${row.audit_id}#${String(row.item_index).padStart(3, "0")}`,
});

// 行の版の読み手と書き手。今の行はどれも版 1 で、前の版を持たない
export const auditCodec = rowCodec({ latest: { version: 1, schema: auditRow }, writeVersion: 1, keyOf: auditKey });
