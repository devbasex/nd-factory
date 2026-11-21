import { z } from "zod";
import { rowCodec } from "../row-codec.ts";
import { idOf } from "../ids.ts";
import { currencyCode, money, utcDateTime } from "../values.ts";
import { inference, overwriteRow, place, type RowKey, sha256Hex } from "./common.ts";

// db-teams の行（チーム・席・招待・手元のマシン・月の使った量）。
// 利用者の ID を user_id の列に持つのは席の行だけにする（user-seats の索引に席の行だけが載る）

export const seatRole = z.enum(["owner", "member"]);

// チーム（TEAM#<チーム> / TEAM）。上書き
export const teamRow = overwriteRow(1, {
  team_id: idOf("team"),
  name: z.string().min(1).max(100),
  // 料金プランの行の名前（data/plans.json の name と同じ形）
  plan: z.string().regex(/^[a-z][a-z0-9_]*$/),
  currency: currencyCode,
  monthly_cap: money.optional(),
  default_place: place,
  default_inference: inference,
  created_at: utcDateTime,
});
export type TeamRow = z.infer<typeof teamRow>;
export const teamKey = (row: TeamRow): RowKey => ({ pk: `TEAM#${row.team_id}`, sk: "TEAM" });

// 席（TEAM#<チーム> / SEAT#<利用者>）。上書き
export const seatRow = overwriteRow(1, {
  team_id: idOf("team"),
  user_id: idOf("usr"),
  role: seatRole,
  added_at: utcDateTime,
});
export type SeatRow = z.infer<typeof seatRow>;
export const seatKey = (row: SeatRow): RowKey => ({ pk: `TEAM#${row.team_id}`, sk: `SEAT#${row.user_id}` });

// 招待（TEAM#<チーム> / INVITE#<招待>）。上書き。状態は accepted_at・withdrawn_at・expires_at から導く
export const invitationRow = overwriteRow(1, {
  invitation_id: idOf("inv"),
  team_id: idOf("team"),
  role: seatRole,
  created_by: idOf("usr"),
  created_at: utcDateTime,
  expires_at: utcDateTime,
  accepted_by: idOf("usr").optional(),
  accepted_at: utcDateTime.optional(),
  withdrawn_at: utcDateTime.optional(),
});
export type InvitationRow = z.infer<typeof invitationRow>;
export const invitationKey = (row: InvitationRow): RowKey => ({ pk: `TEAM#${row.team_id}`, sk: `INVITE#${row.invitation_id}` });

// 手元のマシン（TEAM#<チーム> / MACHINE#<マシン>）。上書き。状態は last_heartbeat_at から導く
export const machineRow = overwriteRow(1, {
  machine_id: idOf("mch"),
  team_id: idOf("team"),
  name: z.string().min(1).max(64),
  token_sha256: sha256Hex,
  token_expires_at: utcDateTime,
  last_heartbeat_at: utcDateTime.optional(),
  lane_capacity: z.int().min(1).max(16).optional(),
  created_at: utcDateTime,
  revoked_at: utcDateTime.optional(),
});
export type MachineRow = z.infer<typeof machineRow>;
export const machineKey = (row: MachineRow): RowKey => ({ pk: `TEAM#${row.team_id}`, sk: `MACHINE#${row.machine_id}` });

// 月の使った量（TEAM#<チーム> / USAGE#<UTC の年月>）。上書き（usageAddItem が加算）。
// 使った額は金額の地図でなく used_amount_minor と used_currency の 2 列で持ち、どちらも必ず持たせて I15 を守る
export const usageMonthRow = overwriteRow(1, {
  team_id: idOf("team"),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  used_amount_minor: z.int().min(0),
  used_currency: currencyCode,
});
export type UsageMonthRow = z.infer<typeof usageMonthRow>;
export const usageMonthKey = (row: UsageMonthRow): RowKey => ({ pk: `TEAM#${row.team_id}`, sk: `USAGE#${row.month}` });

// 行の版の読み手と書き手。今の行はどれも版 1 で、前の版を持たない
export const teamCodec = rowCodec({ latest: { version: 1, schema: teamRow }, writeVersion: 1, keyOf: teamKey });
export const seatCodec = rowCodec({ latest: { version: 1, schema: seatRow }, writeVersion: 1, keyOf: seatKey });
export const invitationCodec = rowCodec({ latest: { version: 1, schema: invitationRow }, writeVersion: 1, keyOf: invitationKey });
export const machineCodec = rowCodec({ latest: { version: 1, schema: machineRow }, writeVersion: 1, keyOf: machineKey });
export const usageMonthCodec = rowCodec({ latest: { version: 1, schema: usageMonthRow }, writeVersion: 1, keyOf: usageMonthKey });
