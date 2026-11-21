import { PROGRESS_DB_IDENT_SHAPE } from "@nd-factory/contracts/db-prep";
import { escapeLiteral } from "pg";
import { scramVerifier } from "./scram.ts";
import type { SqlExecutor } from "./sql-executor.ts";

// 役割のパスワードを書く道。CREATE ROLE と ALTER ROLE の PASSWORD は引数の束縛を受けないため、値を文に書くと、
// 文が失敗したときに PostgreSQL が既定（log_min_error_statement が ERROR）で文ごとサーバーのログへ書く。
// 検証子（SCRAM-SHA-256 の StoredKey と ServerKey）も認証に使う秘密のため、どの文の本文にも載せない:
// 0. 引数の値を記録しない設定を確かめる。通常の文のログ（log_statement と log_min_duration_statement）は
//    log_parameter_max_length（既定 -1 で値を全部書く）に、失敗のログは log_parameter_max_length_on_error に従う。
//    前者は SUSET で、Aurora の管理の役割（superuser でない）はセッションで変えられないため、スタックがクラスタの
//    パラメータで 0 に置き、関数は読んで 0 であることを照らす。後者は USERSET のため、トランザクションの中だけで 0 に置く。
//    続けて実行計画のログを確かめる。PostgreSQL はカスタムプランで束縛値を定数に置き換えるため、計画を書く設定では
//    set_config の引数の値が計画とともにログに残る。debug_print_plan は USERSET のため、トランザクションの中だけで off に置く。
//    auto_explain（読み込めば計画と Query Parameters を書く）の auto_explain.log_min_duration は SUSET で変えられないため、
//    -1（書かない）でなければ止める。
//    最後に pgAudit の設定を読み、引数の値を書く設定（pgaudit.log_parameter）か、役割の文を書く分類（role・all）が
//    効いていれば止める（役割の文は EXECUTE で打つ入れ子の文で、pgAudit はその本文を書く）。照らしが通らなければ検証子を送らない
// 1. 検証子を引数で渡し、トランザクションの中だけの設定（set_config の is_local）に置く
// 2. DO の中で設定から読み、format で組んだ文を EXECUTE で打つ。EXECUTE の文が失敗すると、PL/pgSQL は失敗の
//    文脈に打った文の本文を載せるため、同じ所で受けて、決まった文の誤りに替えて投げ直す（SQLSTATE は残す）。
//    受けた誤りはログに書かれない。OTHERS は文の取り消し（query_canceled）を含まないため、名を挙げて受ける
// 3. 打ち終えたら設定を空へ戻す。設定はトランザクションの終わりにも消える
// 呼ぶ側はトランザクションの中で打つ（Data API はトランザクションの外の文ごとに接続を変えうるため、設定が次の文に届かない）

const VERIFIER_SETTING = "nd_prep.role_verifier";

// 0 の確かめ。どの設定も権限を要さずに読める。pgAudit・auto_explain を読み込んでいないクラスタでは pgaudit.*・auto_explain.* が NULL になる
const CHECK_PARAM_LOG = [
  "SELECT current_setting('log_parameter_max_length') AS normal,",
  " set_config('log_parameter_max_length_on_error', '0', true) AS on_error,",
  " set_config('debug_print_plan', 'off', true) AS print_plan,",
  " current_setting('auto_explain.log_min_duration', true) AS explain_min_duration,",
  " current_setting('pgaudit.log', true) AS audit_log,",
  " current_setting('pgaudit.log_parameter', true) AS audit_parameter",
].join("");

const AUDIT_CLASSES = ["read", "write", "function", "role", "ddl", "misc", "misc_set"];

// pgAudit 16 の check_pgaudit_log と同じ読み。並びは SplitIdentifierString（区切りは ,）で切り、引用符の無い名前は小文字にし、
// 引用符の付いた名前（"role"・"" は 1 つの "）はそのまま取る。各名前は先頭の - で引き算になり、残りを大小を問わずに分類と照らす。
// none はビットを足しも引きもしない（それまでに効いた分類を消さない）。all はすべての分類。
// 左から順に足し引きした結果を返す。pgAudit が受けない並び（形の誤り・知らない分類）は undefined を返す
export function auditClasses(list: string): Set<string> | undefined {
  const names = splitIdentifierList(list);
  if (names === undefined) return undefined;
  const classes = new Set<string>();
  for (const raw of names) {
    const minus = raw.startsWith("-");
    const name = (minus ? raw.slice(1) : raw).toLowerCase();
    let targets: string[];
    if (name === "none") targets = [];
    else if (name === "all") targets = AUDIT_CLASSES;
    else if (AUDIT_CLASSES.includes(name)) targets = [name];
    else return undefined;
    for (const t of targets) {
      if (minus) classes.delete(t);
      else classes.add(t);
    }
  }
  return classes;
}

const isSpace = (c: string | undefined): boolean => c !== undefined && /^[ \t\n\r\f\v]$/.test(c);

// PostgreSQL の SplitIdentifierString（区切りは ,）。形の誤りは undefined。名前の長さの切り詰めは分類の名前に掛からないため行わない
function splitIdentifierList(raw: string): string[] | undefined {
  const out: string[] = [];
  let i = 0;
  while (isSpace(raw[i])) i++;
  if (i === raw.length) return out;
  for (;;) {
    let name: string;
    if (raw[i] === '"') {
      name = "";
      i++;
      for (;;) {
        const close = raw.indexOf('"', i);
        if (close === -1) return undefined;
        name += raw.slice(i, close);
        i = close + 1;
        if (raw[i] !== '"') break;
        name += '"';
        i++;
      }
      if (name === "") return undefined;
    } else {
      const start = i;
      while (i < raw.length && raw[i] !== "," && !isSpace(raw[i])) i++;
      if (i === start) return undefined;
      name = raw.slice(start, i).toLowerCase();
    }
    out.push(name);
    while (isSpace(raw[i])) i++;
    if (raw[i] === ",") {
      i++;
      while (isSpace(raw[i])) i++;
    } else if (i === raw.length) {
      return out;
    } else {
      return undefined;
    }
  }
}

// pgAudit を読み込めば真偽は on か off に揃う。読み込まずに置いた値は、偽と読める綴り以外を有効とみなす
const OFF = new Set(["off", "false", "no", "0"]);

// 検証子を送ってよい設定か。返す文は誤りの文に載せ、値（設定の名前と分類）だけを持つ
export function paramLogProblem(row: Record<string, unknown> | undefined): string | undefined {
  if (row?.normal !== "0") return "log_parameter_max_length が 0 でない（クラスタのパラメータで 0 に置く）";
  if (row?.on_error !== "0") return "log_parameter_max_length_on_error を 0 に置けなかった";
  if (row?.print_plan !== "off") return "debug_print_plan を off に置けなかった";
  const explain = row?.explain_min_duration;
  if (explain !== null && explain !== undefined && (typeof explain !== "string" || explain.trim() !== "-1")) {
    return "auto_explain.log_min_duration が -1 でない（実行計画と引数の値がログに残る）";
  }
  const param = row?.audit_parameter;
  if (param !== null && param !== undefined && typeof param !== "string") return "pgaudit.log_parameter を読めない";
  if (typeof param === "string" && param.trim() !== "" && !OFF.has(param.trim().toLowerCase())) {
    return "pgaudit.log_parameter が有効（引数の値が監査のログに残る）";
  }
  const log = row?.audit_log;
  if (log !== null && log !== undefined && typeof log !== "string") return "pgaudit.log を読めない";
  const classes = typeof log === "string" ? auditClasses(log) : new Set<string>();
  if (classes === undefined) return "pgaudit.log を読めない";
  if (classes.has("role")) return "pgaudit.log が role の文を書く（役割の文の本文が監査のログに残る）";
  return undefined;
}

// 返す列は真偽だけにし、検証子を応答に載せない
const STAGE_VERIFIER = `SELECT (set_config('${VERIFIER_SETTING}', CAST(:verifier AS text), true) IS NOT NULL) AS staged`;

export type RolePasswordMode = "create_login" | "alter_login" | "alter";

const STATEMENT_FORMAT: Record<RolePasswordMode, string> = {
  create_login: "CREATE ROLE %I WITH LOGIN PASSWORD %L",
  alter_login: "ALTER ROLE %I WITH LOGIN PASSWORD %L",
  alter: "ALTER ROLE %I WITH PASSWORD %L",
};

// 本文に載るのは役割の名前と決まった文だけ。Data API と pg の実装の引数の読みに掛からないよう、: を本文に置かない
export function rolePasswordStatement(role: string, mode: RolePasswordMode): string {
  if (!PROGRESS_DB_IDENT_SHAPE.test(role)) throw new Error("役割の名前が形に合わない");
  const setting = escapeLiteral(VERIFIER_SETTING);
  return [
    "DO $nd_role_password$ BEGIN",
    ` EXECUTE format(${escapeLiteral(STATEMENT_FORMAT[mode])}, ${escapeLiteral(role)}, current_setting(${setting}));`,
    ` PERFORM set_config(${setting}, '', true);`,
    " EXCEPTION WHEN query_canceled OR others THEN",
    "  RAISE EXCEPTION USING ERRCODE = SQLSTATE, MESSAGE = 'nd-prep could not write the role password';",
    " END $nd_role_password$",
  ].join("\n");
}

// パスワードを SCRAM-SHA-256 の検証子に変え、0〜3 の順で役割へ書く。平文はどの文にも引数にも載せない。
// 印字できない文字のパスワードは、文を打つ前に投げる
export function prepareRolePassword(role: string, password: string, mode: RolePasswordMode) {
  const statement = rolePasswordStatement(role, mode);
  const verifier = scramVerifier(password);
  return async (sql: SqlExecutor, opts: { database: string; transactionId: string }): Promise<void> => {
    const [row] = await sql.execute(CHECK_PARAM_LOG, undefined, opts);
    const problem = paramLogProblem(row);
    if (problem !== undefined) throw new Error(`検証子を送らずに止めた: ${problem}`);
    await sql.execute(STAGE_VERIFIER, [{ name: "verifier", value: verifier }], opts);
    await sql.execute(statement, undefined, opts);
  };
}
