import { OWNER_ONLY, OWNER_ONLY_IDEMPOTENT, ownedBy } from "./marks.ts";

// F18: 手元のマシン（受け持つ子 #7）
const { read, human } = ownedBy("#7");

export const MACHINE_OPERATIONS = [
  read("machines.list", ["F18"]),
  human("machines.create", ["F18"], "machines.list", OWNER_ONLY_IDEMPOTENT),
  human("machines.delete", ["F18"], "machines.list", OWNER_ONLY),
] as const;
