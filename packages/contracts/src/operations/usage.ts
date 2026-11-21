import { OWNER_ONLY, ownedBy } from "./marks.ts";

// F19: 使った量・費用の記録・月の上限額（受け持つ子 #29）
const { read, human } = ownedBy("#29");

export const USAGE_OPERATIONS = [
  read("usage.get", ["F19"]),
  read("usage_records.list", ["F9", "F19"]),
  human("spend_caps.update", ["F19"], "usage.get", OWNER_ONLY),
] as const;
