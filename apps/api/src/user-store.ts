import type { UserRow } from "@nd-factory/contracts/users-api";
import type { Clock } from "@nd-factory/core/clock";
import { putIfAbsent, WriteUnavailableError, writeAtomically } from "@nd-factory/core/conditional-write";
import type { Db, TableName } from "@nd-factory/core/db";

// 行の形の版。行の列を変えるときに上げ、読む側が古い行を見分けられるようにする
export const SCHEMA_VERSION = 1;

export type StoreOperation = "put" | "get";

// 失敗の元の例外の名前。writeAtomically が届かない失敗を包んだときは、包む前の例外の名前を使う
function causeNameOf(cause: unknown): string {
  const inner = cause instanceof WriteUnavailableError ? cause.cause : cause;
  return inner instanceof Error ? inner.name : "Unknown";
}

// 表に届かなかったことを、失敗した操作と例外の名前だけを持って上へ伝える（行の中身は持たない）
export class StoreError extends Error {
  override name = "StoreError";
  readonly operation: StoreOperation;
  readonly causeName: string;

  constructor(operation: StoreOperation, cause: unknown) {
    const causeName = causeNameOf(cause);
    super(`利用者の表の ${operation} が失敗した: ${causeName}`, { cause });
    this.operation = operation;
    this.causeName = causeName;
  }
}

// 利用者の行を無いときだけ作り、今の行を返す。同じ利用者の要求が重なっても created_at は最初の 1 回のまま。
// table は Db の表の用途で、実際の表の名前は Db を組んだ側が持つ
export async function ensureUser(db: Db, table: TableName, sub: string, clock: Clock): Promise<UserRow> {
  if (sub.length === 0) throw new Error("利用者の ID が空");
  const key = { pk: `USER#${sub}`, sk: "PROFILE" };
  const createdAt = clock.iso();
  try {
    const outcome = await writeAtomically(db, [putIfAbsent({ table, item: { ...key, schema_version: SCHEMA_VERSION, created_at: createdAt }, onConflict: "return_existing" })]);
    if (outcome.ok) return { id: sub, created_at: createdAt };
  } catch (e) {
    throw new StoreError("put", e);
  }

  // 行はもうある。書いた直後の行を確実に読むため、強い整合の読みにする
  let item: Readonly<Record<string, unknown>> | null;
  try {
    item = await db.get(table, key, true);
  } catch (e) {
    throw new StoreError("get", e);
  }
  if (!item || typeof item.created_at !== "string") {
    throw new StoreError("get", new Error("行が無いか形が違う"));
  }
  return { id: sub, created_at: item.created_at };
}
