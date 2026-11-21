import { IDEMPOTENT, ownedBy } from "./marks.ts";

// F16・F20: 委任・操作の記録（受け持つ子 #11）
const { read, human } = ownedBy("#11");

export const DELEGATION_OPERATIONS = [
  read("delegations.list", ["F16"]),
  human("delegations.create", ["F16"], "delegations.list", IDEMPOTENT),
  human("delegations.revoke", ["F16"], "delegations.list"),
] as const;

// 操作の一覧の最後の行（F20）。表の順に並べるため委任と分けて出す
export const AUDIT_OPERATIONS = [read("audit_records.list", ["F20"])] as const;
