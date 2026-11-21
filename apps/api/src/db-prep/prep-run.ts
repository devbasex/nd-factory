import { ADMIN_DATABASE, type SqlExecutor } from "./sql-executor.ts";

// 受け取りの行を残す日数。待ち行列の最大の年齢（60 秒）より十分長い
export const PREP_RUN_RETENTION_DAYS = 7;

// 表を作るときだけ取る排他の鎖。表の有無は 2 回見る: 鎖なしで見て、有れば鎖を取らない（ふだんの受け取りは鎖で直列に
// ならず、鎖の待ちが Data API の 45 秒の取り消しに数えられない）。無ければ鎖を取ってから見直す。トランザクションは
// READ COMMITTED（PostgreSQL と Data API の既定）で文ごとに新しい写しを読むため、見直しは鎖の前に別の配信が作り終えた
// 表を必ず見て、作る文どうしが重ならない（見直さずに作ると、CREATE … IF NOT EXISTS が重なり、カタログの一意の制約で落ちうる）。
// 見直しは to_regclass でなく、カタログの表をその文の写しで読む。to_regclass は表の鎖を取らずに名前を引くため、同じトランザクション
// の 1 回目で残った「無い」の控え（syscache の負の項目）を、他の配信の確定の知らせを受け取らないまま使い、作られた表を見落とす
// 作る配信は表と権限の外しを 1 つのトランザクションで確定するため、鎖なしで「有る」と見えた表は権限を外し終えている
// 関数を FROM に置き、void の列を行に載せない
const SCHEMA_LOCK = "SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtext('nd-prep:schema'))";
const TABLE_PRESENT = "SELECT to_regclass('nd_prep.prep_runs') IS NOT NULL AS present";
const TABLE_PRESENT_FRESH =
  "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace" +
  " WHERE n.nspname = 'nd_prep' AND c.relname = 'prep_runs') AS present";
const CREATE_SCHEMA = "CREATE SCHEMA IF NOT EXISTS nd_prep";
const REVOKE_SCHEMA = "REVOKE ALL ON SCHEMA nd_prep FROM PUBLIC";
const CREATE_TABLE =
  "CREATE TABLE IF NOT EXISTS nd_prep.prep_runs (prep_id text PRIMARY KEY, claimed_at timestamptz NOT NULL DEFAULT now())";
const REVOKE_TABLE = "REVOKE ALL ON nd_prep.prep_runs FROM PUBLIC";
// Data API は整数を longValue（bigint）で渡し、make_interval の days は int なので、SQL の側で int に決める
const DELETE_OLD = "DELETE FROM nd_prep.prep_runs WHERE claimed_at < now() - make_interval(days => CAST(:retention_days AS int))";
// 同じ ID の 2 つの挿入は主キーの一意の索引で直列になり、後の方は前の確定を待って何も足さない
const INSERT_RUN = "INSERT INTO nd_prep.prep_runs (prep_id) VALUES (:prep_id) ON CONFLICT (prep_id) DO NOTHING RETURNING prep_id";

async function tablePresent(sql: SqlExecutor, stmt: string, opts: { database: string; transactionId: string }): Promise<boolean> {
  const [row] = await sql.execute(stmt, undefined, opts);
  return row?.present === true;
}

// 同じ用意の ID の重複の配信のうち、1 つだけに SQL と終わりの記録を許す
export async function claimPrepRun(sql: SqlExecutor, prepId: string): Promise<"first" | "duplicate"> {
  if (prepId.length === 0) throw new Error("用意の ID が空");
  const tx = await sql.begin({ database: ADMIN_DATABASE });
  const opts = { database: ADMIN_DATABASE, transactionId: tx };
  let inserted: boolean;
  try {
    if (!(await tablePresent(sql, TABLE_PRESENT, opts))) {
      // 鎖は確定か巻き戻しまで持つ。表の無い間の受け取りどうしだけが直列になる
      await sql.execute(SCHEMA_LOCK, undefined, opts);
      if (!(await tablePresent(sql, TABLE_PRESENT_FRESH, opts))) {
        for (const stmt of [CREATE_SCHEMA, REVOKE_SCHEMA, CREATE_TABLE, REVOKE_TABLE]) {
          await sql.execute(stmt, undefined, opts);
        }
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
