import { PROGRESS_DB_IDENT_SHAPE } from "@nd-factory/contracts/db-prep";
import { escapeLiteral } from "pg";
import { scramVerifier } from "./scram.ts";
import type { SqlExecutor } from "./sql-executor.ts";

// 役割のパスワードを書く道。CREATE ROLE と ALTER ROLE の PASSWORD は引数の束縛を受けないため、値を文に書くと、
// 文が失敗したときに PostgreSQL が既定（log_min_error_statement が ERROR）で文ごとサーバーのログへ書く。
// 検証子（SCRAM-SHA-256 の StoredKey と ServerKey）も認証に使う秘密のため、どの文の本文にも載せない:
// 1. 検証子を引数で渡し、トランザクションの中だけの設定（set_config の is_local）に置く。引数の値は既定
//    （log_parameter_max_length_on_error が 0）で失敗のログに書かれない
// 2. DO の中で設定から読み、format で組んだ文を EXECUTE で打つ。EXECUTE の文が失敗すると、PL/pgSQL は失敗の
//    文脈に打った文の本文を載せるため、同じ所で受けて、決まった文の誤りに替えて投げ直す（SQLSTATE は残す）。
//    受けた誤りはログに書かれない。OTHERS は文の取り消し（query_canceled）を含まないため、名を挙げて受ける
// 3. 打ち終えたら設定を空へ戻す。設定はトランザクションの終わりにも消える
// 呼ぶ側はトランザクションの中で打つ（Data API はトランザクションの外の文ごとに接続を変えうるため、設定が次の文に届かない）

const VERIFIER_SETTING = "nd_prep.role_verifier";

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

// パスワードを SCRAM-SHA-256 の検証子に変え、1〜3 の順で役割へ書く。平文はどの文にも引数にも載せない。
// 印字できない文字のパスワードは、文を打つ前に投げる
export function prepareRolePassword(role: string, password: string, mode: RolePasswordMode) {
  const statement = rolePasswordStatement(role, mode);
  const verifier = scramVerifier(password);
  return async (sql: SqlExecutor, opts: { database: string; transactionId: string }): Promise<void> => {
    await sql.execute(STAGE_VERIFIER, [{ name: "verifier", value: verifier }], opts);
    await sql.execute(statement, undefined, opts);
  };
}
