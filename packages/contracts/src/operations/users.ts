import { IDEMPOTENT, ownedBy } from "./marks.ts";

// F1・F2: サインイン・利用者・IdP のログインの組（受け持つ子 #4）
const { read, write, human } = ownedBy("#4");

// logins.create の要素の理由（docs/design/detail.md の verifyLoginToLink）。画面は link_invalid で流れを始め直し、
// already_linked で IdP の別のアカウントを選び直す案内を出す
const LOGIN_LINK_REASONS = [
  { code: "link_invalid", status: 409, when: "always" },
  { code: "already_linked", status: 409, when: "always" },
] as const;

export const USER_OPERATIONS = [
  human("sessions.create", ["F1"], "users.get", IDEMPOTENT),
  human("sessions.delete", ["F1"], "users.get"),
  read("users.get", ["F1", "F2"]),
  write("users.update", ["F2"], "manage"),
  human("login_links.create", ["F1"], "users.get", IDEMPOTENT),
  human("logins.create", ["F1"], "users.get", { ...IDEMPOTENT, reasons: LOGIN_LINK_REASONS }),
  human("logins.delete", ["F1"], "users.get"),
] as const;
