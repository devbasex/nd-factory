import { IDEMPOTENT, ownedBy } from "./marks.ts";

// F11〜F13: 承認の依頼・問い（受け持つ子 #8）
const { read, write, human } = ownedBy("#8");

export const DECISION_OPERATIONS = [
  read("approvals.list", ["F7", "F11"]),
  read("approvals.get", ["F11"]),
  human("approvals.answer", ["F12"], "approvals.get", IDEMPOTENT),
  read("questions.list", ["F7", "F13"]),
  read("questions.get", ["F13"]),
  // 「人だけか」が真の問いの要素だけを 403 human_only にする（決定 57）
  write("questions.answer", ["F13"], "run", { ...IDEMPOTENT, humanOnly: "per_item" }),
] as const;
