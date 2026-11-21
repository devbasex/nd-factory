import { IDEMPOTENT, ownedBy } from "./marks.ts";

// F1・F2: サインイン・利用者・IdP のログインの組（受け持つ子 #4）
const { read, write, human } = ownedBy("#4");

export const USER_OPERATIONS = [
  human("sessions.create", ["F1"], "users.get", IDEMPOTENT),
  human("sessions.delete", ["F1"], "users.get"),
  read("users.get", ["F1", "F2"]),
  write("users.update", ["F2"], "manage"),
  human("logins.create", ["F1"], "users.get", IDEMPOTENT),
  human("logins.delete", ["F1"], "users.get"),
] as const;
