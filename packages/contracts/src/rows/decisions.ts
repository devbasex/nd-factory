import { z } from "zod";
import { rowCodec } from "../row-codec.ts";
import { idOf } from "../ids.ts";
import { utcDateTime } from "../values.ts";
import { identifier, overwriteRow, type RowKey, sha256Hex, uuid, versionlessRow } from "./common.ts";

// db-decisions の行（承認の依頼・問い・答え）。承認の依頼と答えの ndf_event_seqs は全体の設計（docs/design/data.md の「テーブル定義」）の列

export const decisionState = z.enum(["waiting", "answered", "canceled"]);
export const deliveryState = z.enum(["pending", "delivering", "delivered", "failed"]);

// 承認の依頼（PROJECT#<プロジェクト> / APPROVAL#<依頼>）。上書き。
// project_id は表と鍵の決まりで持ち、waiting の索引の区切りの鍵にもなる。答えるか取り消すと waiting_since を消す
export const approvalRow = overwriteRow(1, {
  approval_id: idOf("apr"),
  project_id: idOf("prj"),
  sprint_id: idOf("spr"),
  lane_id: idOf("lane"),
  // 承認ゲートの種類（全体の設計の 設計・リリース・レッドライン）。識別子の対応は承認を書く子が決める
  gate: identifier,
  material_digest: sha256Hex,
  state: decisionState,
  // 答えの ID は答えの要素の冪等の鍵（UUID）
  answer_id: uuid.optional(),
  delivery: deliveryState.optional(),
  waiting_since: utcDateTime.optional(),
});
export type ApprovalRow = z.infer<typeof approvalRow>;
export const approvalKey = (row: ApprovalRow): RowKey => ({ pk: `PROJECT#${row.project_id}`, sk: `APPROVAL#${row.approval_id}` });

// 問いの選択肢
export const questionOption = z.strictObject({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
});

// 問い（PROJECT#<プロジェクト> / QUESTION#<問い>）。上書き
export const questionRow = overwriteRow(1, {
  question_id: idOf("qst"),
  project_id: idOf("prj"),
  sprint_id: idOf("spr"),
  lane_id: idOf("lane"),
  // 区間の報告の区分の文字列（NDF の値のまま）
  category: z.string().min(1),
  human_only: z.boolean(),
  state: decisionState,
  body: z.string().min(1),
  options: z.array(questionOption).optional(),
  // 選択肢の鍵
  recommended: z.string().min(1).optional(),
  // どちらも契約の fields の答えを待つ（#6）
  ndf_gate_id: z.string().min(1).optional(),
  machine_id: idOf("mch").optional(),
  answer_id: uuid.optional(),
  delivery: deliveryState.optional(),
  waiting_since: utcDateTime.optional(),
});
export type QuestionRow = z.infer<typeof questionRow>;
export const questionKey = (row: QuestionRow): RowKey => ({ pk: `PROJECT#${row.project_id}`, sk: `QUESTION#${row.question_id}` });

// 答えた主体。委任なら委任の ID も持つ
export const answeredBy = z.strictObject({
  kind: z.enum(["human", "delegation"]),
  user_id: idOf("usr"),
  delegation_id: idOf("dlg").optional(),
});

// 答え（PROJECT#<プロジェクト> / APPROVAL#<依頼>#ANSWER#<答え>・QUESTION#<問い>#ANSWER#<答え>）。追記だけ。
// claimed_generation と ndf_event_seqs は空のときに 1 回だけ書く（I5）
export const answerRow = versionlessRow(1, {
  answer_id: uuid,
  project_id: idOf("prj"),
  // 依頼か問いの ID。頭で並びの鍵の APPROVAL# か QUESTION# を決める
  parent_id: z.union([idOf("apr"), idOf("qst")]),
  // 承認は ndfAnswerWord、問いは選択肢の鍵
  word: z.string().min(1),
  reason: z.string().max(2000).optional(),
  // 差し戻しの指摘
  notes: z.string().max(10000).optional(),
  drop_issues: z.array(z.int().min(1)).optional(),
  material_digest: sha256Hex.optional(),
  head_sha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  answered_by: answeredBy,
  answered_at: utcDateTime,
  claimed_generation: z.int().min(0).optional(),
  ndf_event_seqs: z.array(z.int().min(0)).optional(),
});
export type AnswerRow = z.infer<typeof answerRow>;
export const answerKey = (row: AnswerRow): RowKey => ({
  pk: `PROJECT#${row.project_id}`,
  sk: `${row.parent_id.startsWith("apr_") ? "APPROVAL" : "QUESTION"}#${row.parent_id}#ANSWER#${row.answer_id}`,
});

// 行の版の読み手と書き手。今の行はどれも版 1 で、前の版を持たない
export const approvalCodec = rowCodec({ latest: { version: 1, schema: approvalRow }, writeVersion: 1, keyOf: approvalKey });
export const questionCodec = rowCodec({ latest: { version: 1, schema: questionRow }, writeVersion: 1, keyOf: questionKey });
export const answerCodec = rowCodec({ latest: { version: 1, schema: answerRow }, writeVersion: 1, keyOf: answerKey });
