import { z } from "zod";
import { repairIdentity, rowCodec } from "../row-codec.ts";
import { utcDateTime } from "../values.ts";
import { expireAt, overwriteRow, type RowKey } from "./common.ts";

// db-idempotency の行（冪等の鍵）。区切りの鍵だけの表で、作成から 24 時間で TTL。
// 上書き（借りから済みへの書き換えと借りの取り直しを、読んだ version と incarnation を条件にした行全体の置き換えで書くため、
// docs/specifications/contracts-and-core.md の行の書き手の決定 2・7 で version を持つ）

// 冪等の鍵（<主体>#<操作の名前>#<鍵> / なし）
export const idempotencyRow = overwriteRow(1, {
  principal_key: z.string().min(1),
  operation: z.string().min(1),
  key: z.string().min(1),
  fingerprint: z.string().min(1),
  state: z.enum(["leased", "settled"]),
  owner_request_id: z.string().min(1),
  lease_until: utcDateTime,
  // 要素の結果。済みのときだけ持ち、形は操作ごとの要素の結果
  result: z.looseObject({}).optional(),
  expire_at: expireAt,
});
export type IdempotencyRow = z.infer<typeof idempotencyRow>;
export const idempotencyKey = (row: IdempotencyRow): RowKey => ({ pk: `${row.principal_key}#${row.operation}#${row.key}`, sk: null });

// 行の版の読み手と書き手。今の行はどれも版 1 で、前の版を持たない。
// U3b より前の書き手が保存した行（incarnation と、U3b で足した version の無い行）を、旧形式の補い（repairIdentity）で読む
export const idempotencyCodec = rowCodec({ latest: { version: 1, schema: idempotencyRow }, writeVersion: 1, repair: repairIdentity({ version: true }), keyOf: idempotencyKey });
