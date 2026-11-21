import { OWNER_ONLY, OWNER_ONLY_IDEMPOTENT, ownedBy } from "./marks.ts";

// F17: 実行の場所と推論の手段・持ち込みのキー（受け持つ子 #6）
const { read, write, human } = ownedBy("#6");

export const EXECUTION_OPERATIONS = [
  read("execution_settings.get", ["F17"]),
  human("execution_settings.update", ["F17"], "execution_settings.get", OWNER_ONLY),
  read("model_keys.list", ["F17"]),
  human("model_keys.create", ["F17"], "model_keys.list", OWNER_ONLY_IDEMPOTENT),
  write("model_keys.delete", ["F17"], "manage", OWNER_ONLY),
] as const;
