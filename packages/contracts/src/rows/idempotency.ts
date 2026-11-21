import { z } from "zod";
import { rowCodec } from "../row-codec.ts";
import { utcDateTime } from "../values.ts";
import { expireAt, type RowKey, versionlessRow } from "./common.ts";

// db-idempotency の行（冪等の鍵）。区切りの鍵だけの表で、作成から 24 時間で TTL。
// 借りから済みへ 1 回だけ書き換え、エンティティの版を持たない

// 冪等の鍵（<主体>#<操作の名前>#<鍵> / なし）
export const idempotencyRow = versionlessRow(1, {
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

// 行の版の読み手と書き手。今の行はどれも版 1 で、前の版を持たない
export const idempotencyCodec = rowCodec({ latest: { version: 1, schema: idempotencyRow }, writeVersion: 1, keyOf: idempotencyKey });
