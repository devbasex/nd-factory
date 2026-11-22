import { z } from "zod";
import { repairIdentity, rowCodec } from "../row-codec.ts";
import { idOf } from "../ids.ts";
import { utcDateTime } from "../values.ts";
import { overwriteRow, type RowKey, sha256Hex } from "./common.ts";

// db-notices の行（知らせ・通知先）

export const noticeKind = z.enum(["approval", "question", "sprint_finished", "sprint_stopped", "cap_reached"]);
export const destinationKind = z.enum(["web_push", "slack"]);

// 通知先ごとの送達の状態
export const noticeDelivery = z.strictObject({
  state: z.enum(["pending", "sent", "failed", "skipped"]),
  attempts: z.int().min(0),
});

// 知らせ（USER#<利用者> / NOTICE#<時刻>#<ID>）。上書き（既読は画面、送達は送り手が、読んだ行から作った行全体を replaceIfVersion で書く）
export const noticeRow = overwriteRow(1, {
  notice_id: idOf("ntc"),
  user_id: idOf("usr"),
  project_id: idOf("prj"),
  kind: noticeKind,
  // 依頼・問い・スプリントの ID
  target_id: z.union([idOf("apr"), idOf("qst"), idOf("spr")]),
  occurred_at: utcDateTime,
  read_at: utcDateTime.optional(),
  // 通知先の ID から送達の状態への地図
  deliveries: z.record(idOf("dst"), noticeDelivery),
});
export type NoticeRow = z.infer<typeof noticeRow>;
export const noticeKey = (row: NoticeRow): RowKey => ({ pk: `USER#${row.user_id}`, sk: `NOTICE#${row.occurred_at}#${row.notice_id}` });

// 通知先（USER#<利用者> / DEST#<通知先>）。上書き。宛先の値は秘密の器に置き、行は名前と要約値と末尾 4 字だけを持つ
export const destinationRow = overwriteRow(1, {
  destination_id: idOf("dst"),
  user_id: idOf("usr"),
  kind: destinationKind,
  // slack だけ
  team_id: idOf("team").optional(),
  secret_name: z.string().min(1),
  // 宛先の値の SHA-256
  fingerprint: sha256Hex,
  last4: z.string().min(1).max(4),
  state: z.enum(["active", "invalid", "failed"]),
  created_at: utcDateTime,
});
export type DestinationRow = z.infer<typeof destinationRow>;
export const destinationKey = (row: DestinationRow): RowKey => ({ pk: `USER#${row.user_id}`, sk: `DEST#${row.destination_id}` });

// 行の版の読み手と書き手。今の行はどれも版 1 で、前の版を持たない。
// U3b より前の書き手が保存した行（incarnation と、U3b で足した version の無い行）を、旧形式の補い（repairIdentity）で読む
export const noticeCodec = rowCodec({ latest: { version: 1, schema: noticeRow }, writeVersion: 1, repair: repairIdentity({ version: false }), keyOf: noticeKey });
export const destinationCodec = rowCodec({ latest: { version: 1, schema: destinationRow }, writeVersion: 1, repair: repairIdentity({ version: false }), keyOf: destinationKey });
