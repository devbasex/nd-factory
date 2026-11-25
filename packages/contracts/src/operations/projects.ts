import { OWNER_ONLY, OWNER_ONLY_IDEMPOTENT, ownedBy } from "./marks.ts";

// F4〜F6: プロジェクト・GitHub App の導入・リポジトリ・割り当ての移し（受け持つ子 #5）
const { read, write, human } = ownedBy("#5");

// 全部か無かの上限は要素 1 つの書き込みの件の数から見積もる（詳細設計の「全部か無かの上限」）。
// projects.create はプロジェクト・主リポジトリ・割り当て・記録の行・冪等の済みの行の 5 件、
// repositories.add はリポジトリの行・プロジェクトの行の照らし・記録の行・冪等の済みの行の 4 件。
// 主体が人のときは要求元の対応の行とセッションの取り消しの行の照らしの 2 件が 1 回だけ入るため、
// 上限は 100 件から 2 件を残して決める（データの文書の「人の書き込みの要求元の照らし」）。
// projects.create は 19 × 5 + 2 = 97 件、repositories.add は 24 × 4 + 2 = 98 件
const PROJECTS_CREATE_MAX_ITEMS = 19;
const REPOSITORIES_ADD_MAX_ITEMS = 24;

export const PROJECT_OPERATIONS = [
  read("projects.list", ["F4", "F7"]),
  read("projects.get", ["F4"]),
  human("projects.create", ["F4"], "teams.list", { ...OWNER_ONLY_IDEMPOTENT, allOrNothing: { maxItems: PROJECTS_CREATE_MAX_ITEMS } }),
  write("projects.update", ["F4"], "manage", OWNER_ONLY),
  read("github_installations.list", ["F5"]),
  human("github_installations.link", ["F5"], "github_installations.list"),
  read("repositories.list", ["F5"]),
  write("repositories.add", ["F5"], "manage", { ...OWNER_ONLY_IDEMPOTENT, allOrNothing: { maxItems: REPOSITORIES_ADD_MAX_ITEMS } }),
  write("repositories.remove", ["F5"], "manage", OWNER_ONLY),
  read("project_transfers.list", ["F6"]),
  human("project_transfers.create", ["F6"], "project_transfers.list", OWNER_ONLY_IDEMPOTENT),
  human("project_transfers.accept", ["F6"], "project_transfers.list", OWNER_ONLY),
  human("project_transfers.delete", ["F6"], "project_transfers.list", OWNER_ONLY),
  human("projects.close", ["F6"], "projects.get", OWNER_ONLY),
] as const;
