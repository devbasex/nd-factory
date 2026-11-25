import { z } from "zod";
import { repairIdentity, rowCodec } from "../row-codec.ts";
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

// 行の版の読み手と書き手。今の行はどれも版 1 で、前の版を持たない。
// U3b より前の書き手が保存した行（incarnation と、U3b で足した version の無い行）を、旧形式の補い（repairIdentity）で読む
export const progressEventCodec = rowCodec({ latest: { version: 1, schema: progressEventRow }, writeVersion: 1, repair: repairIdentity({ version: false }), keyOf: progressEventKey });
