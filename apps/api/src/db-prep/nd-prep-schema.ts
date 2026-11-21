// nd_prep のスキーマの SQL。表を作る側（claimPrepRun・claimBinding・rotateRole）が共にする鎖と、スキーマと表の有無の読み

// スキーマを作る文どうしを重ねない鎖。表を作る側はどれも、表が無いと見たときにこの鎖を取ってから読み直す
export const SCHEMA_LOCK = "SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtext('nd-prep:schema'))";
export const SCHEMA_PRESENT = "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'nd_prep') AS present";
export const CREATE_SCHEMA = "CREATE SCHEMA nd_prep";
export const REVOKE_SCHEMA = "REVOKE ALL ON SCHEMA nd_prep FROM PUBLIC";

// 表の名前は SQL の本文に載せるため、決まった形のものだけを受ける
function assertTable(table: string): void {
  if (!/^[a-z_]+$/.test(table)) throw new Error("nd_prep の表の名前が形に合わない");
}

// 鎖なしで見る表の有無（控えを通す）
export function tablePresent(table: string): string {
  assertTable(table);
  return `SELECT to_regclass('nd_prep.${table}') IS NOT NULL AS present`;
}

// 鎖の後に、控え（syscache）を通さずカタログの表をその文の写しで読む表の有無
export function tablePresentFresh(table: string): string {
  assertTable(table);
  return (
    "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace" +
    ` WHERE n.nspname = 'nd_prep' AND c.relname = '${table}') AS present`
  );
}
