import { z } from "zod";

// 表の行の共通の列と基の形（docs/design/data.md の「共通の列」、issues/issue-2-design-detail.md の「サービスの表」）。
// 行の zod は z.object で、知らない列を落とす（表の移しの読み手が次の版だけの列を捨てる）。
// 鍵の列（pk・sk）は行の zod に持たず、行の種類ごとの keyOf だけが行の列から組む（Value 13）

// 行の鍵。区切りの鍵だけの表（冪等の鍵）は sk が null
export type RowKey = { readonly pk: string; readonly sk: string | null };

// エンティティの版。書き換えるたびに 1 上げ、条件つきの書き込み（replaceIfVersion・deleteIfVersion）で照らす
export const entityVersion = z.int().min(1);

// TTL の列（expire_at）。UNIX の秒の整数で、DynamoDB の TTL の属性。
// 行の形は 10 桁の秒の整数だけを通す（ミリ秒の値は DynamoDB が遠い先の時刻と見て消さないため落とす）
export const TTL_ATTRIBUTE = "expire_at";
export const expireAt = z.int().min(1_000_000_000).max(9_999_999_999);

// 期限の UNIX のミリ秒を、TTL の列に書く秒の整数にする。どの書き手もこれで expire_at を作る
export function expireAtSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

// 閉じた語の集まりのうち、値の集合をほかの子が決めるものの形（決定 15 の英小文字の識別子）
export const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/);

// 理由のコードの形（reasons.ts の REASON_CODE と同じ）
export const reasonCode = z.string().regex(/^[a-z][a-z0-9_]*$/);

// SHA-256 の 16 進の 64 桁
export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

// 冪等の鍵の UUID（答えの ID にそのまま使う）
export const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

// 実行の場所と推論の手段
export const place = z.enum(["hosted", "machine"]);
export const inference = z.enum(["managed", "byok"]);

// 並びの鍵に入れる連番の桁。文字の並びが数の並びと同じになるよう 0 で埋める
export const SEQ_DIGITS = 10;

export function seqKey(n: number): string {
  if (!Number.isInteger(n) || n < 0 || String(n).length > SEQ_DIGITS) throw new RangeError(`連番は 0 以上 ${SEQ_DIGITS} 桁までの整数: ${n}`);
  return String(n).padStart(SEQ_DIGITS, "0");
}

// 行の世代（issues/issue-2-design-row-writers.md の決定 8）。行を作るときに putIfAbsent が UUID v4 を入れ、置き換えと表の移しで変えない。
// 消して同じ鍵で作り直した行を見分ける（version は作り直すと 1 に戻る）。U3b より前の行は repairIdentity が鍵から決まる UUID の形の値で補うため、版の桁を縛らない
const incarnation = uuid;

type Shape = Record<string, z.ZodType>;

// 上書きの行（作った後に書き換える行の種類はどれも。決定 2）。形の版とエンティティの版と行の世代を持つ
export function overwriteRow<const S extends Shape>(schemaVersion: number, shape: S) {
  return z.object({ schema_version: z.literal(schemaVersion), version: entityVersion, incarnation, ...shape });
}

// 作った後に書き換えない行（追記だけの行・作ると消すだけの行・期限で消える行）。形の版と行の世代を持ち、エンティティの版を持たない
export function versionlessRow<const S extends Shape>(schemaVersion: number, shape: S) {
  return z.object({ schema_version: z.literal(schemaVersion), incarnation, ...shape });
}

// 記録の表（db-audit）の行。追記だけで表の移しも書き直さない（決定 9）ため、形の版だけを持ち、行の世代を持たない
export function auditRecordRow<const S extends Shape>(schemaVersion: number, shape: S) {
  return z.object({ schema_version: z.literal(schemaVersion), ...shape });
}
