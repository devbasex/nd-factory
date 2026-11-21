import { z } from "zod";
import { idOf } from "../ids.ts";
import { utcDateTime } from "../values.ts";
import { identifier, type RowKey, seqKey, versionlessRow } from "./common.ts";

// db-events の行（進捗の事象）。追記だけ（I13）

// 進捗の事象（PROJECT#<プロジェクト>#LANE#<レーン> / SEQ#<連番>）
export const progressEventRow = versionlessRow(1, {
  project_id: idOf("prj"),
  lane_id: idOf("lane"),
  seq: z.int().min(1),
  generation: z.int().min(0),
  // 事象の種類。値の集合は #6
  kind: identifier,
  occurred_at: utcDateTime,
  // 種類ごとの形（redact を通した値）。形は #6 が種類ごとに決めるため、知らない項目を落とさない
  body: z.looseObject({}),
});
export type ProgressEventRow = z.infer<typeof progressEventRow>;
export const progressEventKey = (row: ProgressEventRow): RowKey => ({ pk: `PROJECT#${row.project_id}#LANE#${row.lane_id}`, sk: `SEQ#${seqKey(row.seq)}` });
