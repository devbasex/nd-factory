import { z } from "zod";
import { repairIdentity, rowCodec } from "../row-codec.ts";
import { idOf, UUID_V7_PATTERN } from "../ids.ts";
import { githubIssueRef, utcDateTime } from "../values.ts";
import { identifier, inference, overwriteRow, place, reasonCode, type RowKey, SEQ_DIGITS, seqKey } from "./common.ts";

// db-sprints の行（スプリント・レーン・区間）。レーンは全体の設計（docs/design/data.md の「テーブル定義」）の列

export const sprintState = z.enum(["running", "finished", "stopped", "canceled"]);
export const segmentResult = z.enum(["done", "needs_decision", "failed"]);
export const segmentFailureReason = z.enum(["result_line_missing", "result_value_unknown", "segment_crashed", "segment_timeout"]);

// 区間の ID（<レーンの ID>#SEG#<連番>）。費用の記録の冪等の鍵と COST# の <ID> に使う
export const segmentId = z.string().regex(new RegExp(`^lane_${UUID_V7_PATTERN}#SEG#\\d{${SEQ_DIGITS}}$`));

export function segmentIdOf(laneId: string, seq: number): string {
  return `${laneId}#SEG#${seqKey(seq)}`;
}

// スプリント（PROJECT#<プロジェクト> / SPRINT#<スプリント>）。上書き
export const sprintRow = overwriteRow(1, {
  sprint_id: idOf("spr"),
  project_id: idOf("prj"),
  title: z.string().min(1).max(200),
  issues: z.array(githubIssueRef).min(1).max(20),
  place,
  inference,
  state: sprintState,
  // 始めた利用者。委任なら委任した人
  started_by: idOf("usr"),
  started_at: utcDateTime,
  ended_at: utcDateTime.optional(),
  end_reason: reasonCode.optional(),
});
export type SprintRow = z.infer<typeof sprintRow>;
export const sprintKey = (row: SprintRow): RowKey => ({ pk: `PROJECT#${row.project_id}`, sk: `SPRINT#${row.sprint_id}` });

// レーン（PROJECT#<プロジェクト> / SPRINT#<スプリント>#LANE#<レーン>）。上書き。
// project_id は表と鍵の決まりで持ち、sprint_id は鍵を列から組むために持つ（全体の設計の列からの読み替え）
export const laneRow = overwriteRow(1, {
  lane_id: idOf("lane"),
  project_id: idOf("prj"),
  sprint_id: idOf("spr"),
  repo_id: idOf("repo"),
  after: z.array(idOf("lane")),
  place,
  inference,
  runner_id: z.string().min(1).optional(),
  generation: z.int().min(0),
  // レーンの状態。識別子の対応は実行を書く子（#6）が決める
  state: identifier,
  last_seq: z.int().min(0),
});
export type LaneRow = z.infer<typeof laneRow>;
export const laneKey = (row: LaneRow): RowKey => ({ pk: `PROJECT#${row.project_id}`, sk: `SPRINT#${row.sprint_id}#LANE#${row.lane_id}` });

// 区間（PROJECT#<プロジェクト> / SPRINT#<スプリント>#LANE#<レーン>#SEG#<連番>）。上書き（閉じるときに結果を書く）
export const segmentRow = overwriteRow(1, {
  project_id: idOf("prj"),
  sprint_id: idOf("spr"),
  lane_id: idOf("lane"),
  // レーンの中で 1 から上げる
  seq: z.int().min(1),
  started_at: utcDateTime,
  ended_at: utcDateTime.optional(),
  result: segmentResult.optional(),
  // 区間の報告の区分の文字列（NDF の値のまま）
  category: z.string().min(1).optional(),
  failure_reason: segmentFailureReason.optional(),
});
export type SegmentRow = z.infer<typeof segmentRow>;
export const segmentKey = (row: SegmentRow): RowKey => ({
  pk: `PROJECT#${row.project_id}`,
  sk: `SPRINT#${row.sprint_id}#LANE#${row.lane_id}#SEG#${seqKey(row.seq)}`,
});

// 行の版の読み手と書き手。今の行はどれも版 1 で、前の版を持たない。
// U3b より前の書き手が保存した行（incarnation と、U3b で足した version の無い行）を、旧形式の補い（repairIdentity）で読む
export const sprintCodec = rowCodec({ latest: { version: 1, schema: sprintRow }, writeVersion: 1, repair: repairIdentity({ version: false }), keyOf: sprintKey });
export const laneCodec = rowCodec({ latest: { version: 1, schema: laneRow }, writeVersion: 1, repair: repairIdentity({ version: false }), keyOf: laneKey });
export const segmentCodec = rowCodec({ latest: { version: 1, schema: segmentRow }, writeVersion: 1, repair: repairIdentity({ version: false }), keyOf: segmentKey });
