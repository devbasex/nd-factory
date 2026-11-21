import { ownedBy } from "./marks.ts";

// DB の用意のタスク向けの 2 つの HTTP の経路（受け持つ子 #13）。
// 形は #13 の db-prep-api.ts が持つ。まだ無いため形の未定で置き、#13 がつなぐ
const { self } = ownedBy("#13");

export const DB_PREP_OPERATIONS = [
  self("db_prep", "db_prep.exchanges.create", "write"),
  self("db_prep", "db_prep.completions.create", "write"),
] as const;
