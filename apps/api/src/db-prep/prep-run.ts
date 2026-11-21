import { ADMIN_DATABASE, type SqlExecutor } from "./sql-executor.ts";

// 受け取りの行を残す日数。待ち行列の最大の年齢（60 秒）より十分長い
export const PREP_RUN_RETENTION_DAYS = 7;

// 表の有無を見る前に排他の鎖を取る。鎖の後に見るので、別の配信が作り終えた表を必ず見て、作る文どうしが重ならない
// （鎖より前に見ると、見た後に作られた表に CREATE … IF NOT EXISTS が重なり、カタログの一意の制約で落ちうる）
// 関数を FROM に置き、void の列を行に載せない
const SCHEMA_LOCK = "SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtext('nd-prep:schema'))";
const TABLE_PRESENT = "SELECT to_regclass('nd_prep.prep_runs') IS NOT NULL AS present";
const CREATE_SCHEMA = "CREATE SCHEMA IF NOT EXISTS nd_prep";
const REVOKE_SCHEMA = "REVOKE ALL ON SCHEMA nd_prep FROM PUBLIC";
const CREATE_TABLE =
  "CREATE TABLE IF NOT EXISTS nd_prep.prep_runs (prep_id text PRIMARY KEY, claimed_at timestamptz NOT NULL DEFAULT now())";
const REVOKE_TABLE = "REVOKE ALL ON nd_prep.prep_runs FROM PUBLIC";
// Data API は整数を longValue（bigint）で渡し、make_interval の days は int なので、SQL の側で int に決める
const DELETE_OLD = "DELETE FROM nd_prep.prep_runs WHERE claimed_at < now() - make_interval(days => CAST(:retention_days AS int))";
// 同じ ID の 2 つの挿入は主キーの一意の索引で直列になり、後の方は前の確定を待って何も足さない
const INSERT_RUN = "INSERT INTO nd_prep.prep_runs (prep_id) VALUES (:prep_id) ON CONFLICT (prep_id) DO NOTHING RETURNING prep_id";

// 同じ用意の ID の重複の配信のうち、1 つだけに SQL と終わりの記録を許す
export async function claimPrepRun(sql: SqlExecutor, prepId: string): Promise<"first" | "duplicate"> {
  if (prepId.length === 0) throw new Error("用意の ID が空");
  const tx = await sql.begin({ database: ADMIN_DATABASE });
  const opts = { database: ADMIN_DATABASE, transactionId: tx };
  let inserted: boolean;
  try {
    // 鎖は確定か巻き戻しまで持つ。受け取りどうしは短いトランザクションで直列になる
    await sql.execute(SCHEMA_LOCK, undefined, opts);
    const [presence] = await sql.execute(TABLE_PRESENT, undefined, opts);
    if (presence?.present !== true) {
      for (const stmt of [CREATE_SCHEMA, REVOKE_SCHEMA, CREATE_TABLE, REVOKE_TABLE]) {
        await sql.execute(stmt, undefined, opts);
      }
    }
    await sql.execute(DELETE_OLD, [{ name: "retention_days", value: PREP_RUN_RETENTION_DAYS }], opts);
    const rows = await sql.execute(INSERT_RUN, [{ name: "prep_id", value: prepId }], opts);
    inserted = rows.length === 1;
  } catch (e) {
    // 巻き戻しの失敗は元の失敗より後の出来事で、呼ぶ側は元の失敗で扱う。Data API のトランザクションは無通信で巻き戻る
    await sql.rollback(tx).catch(() => undefined);
    throw e;
  }
  // 確定が投げたら、記せたかが分からないまま投げる（呼ぶ側は終わりを記さない）
  await sql.commit(tx);
  return inserted ? "first" : "duplicate";
}
