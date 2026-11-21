import { z } from "zod";
import { rowCodec } from "../row-codec.ts";
import { idOf } from "../ids.ts";
import { money, utcDateTime } from "../values.ts";
import { type RowKey, versionlessRow } from "./common.ts";
import { segmentId } from "./sprints.ts";

// db-usage の行（費用の記録）。追記だけ

export const usageKind = z.enum(["compute", "inference", "byok_inference", "machine_time"]);

export const usageQuantity = z.strictObject({
  unit: z.enum(["seconds", "tokens_in", "tokens_out", "tokens_cache"]),
  value: z.int().min(0),
});

// 費用の記録（PROJECT#<プロジェクト> / COST#<区間の終わりの時刻>#<区間の ID>）。
// 同じ区間の送り直しで同じ並びの鍵になり、putIfAbsent が 2 回目を足さない
export const costRecordRow = versionlessRow(1, {
  project_id: idOf("prj"),
  sprint_id: idOf("spr"),
  lane_id: idOf("lane"),
  segment_id: segmentId,
  kind: usageKind,
  quantity: z.array(usageQuantity),
  // 量だけのものは 0
  amount: money,
  // 区間の終わりの事象の時刻（ランナーが付ける）
  occurred_at: utcDateTime,
});
export type CostRecordRow = z.infer<typeof costRecordRow>;
export const costRecordKey = (row: CostRecordRow): RowKey => ({ pk: `PROJECT#${row.project_id}`, sk: `COST#${row.occurred_at}#${row.segment_id}` });

// 行の版の読み手と書き手。今の行はどれも版 1 で、前の版を持たない
export const costRecordCodec = rowCodec({ latest: { version: 1, schema: costRecordRow }, writeVersion: 1, keyOf: costRecordKey });
