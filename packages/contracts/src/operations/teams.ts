import { IDEMPOTENT, OWNER_ONLY, OWNER_ONLY_IDEMPOTENT, ownedBy } from "./marks.ts";

// F3: チーム・席・招待（受け持つ子 #4）
const { read, write, human } = ownedBy("#4");

export const TEAM_OPERATIONS = [
  read("teams.list", ["F3"]),
  read("teams.get", ["F3"]),
  human("teams.create", ["F3"], "teams.list", IDEMPOTENT),
  write("teams.update", ["F3"], "manage", OWNER_ONLY),
  read("seats.list", ["F3"]),
  human("seats.update", ["F3"], "seats.list", OWNER_ONLY),
  human("seats.delete", ["F3"], "seats.list", OWNER_ONLY),
  read("invitations.list", ["F3"]),
  human("invitations.create", ["F3"], "invitations.list", OWNER_ONLY_IDEMPOTENT),
  human("invitations.accept", ["F3"], "invitations.list"),
  human("invitations.delete", ["F3"], "invitations.list", OWNER_ONLY),
] as const;
