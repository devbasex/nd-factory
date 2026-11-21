import { IDEMPOTENT, ownedBy } from "./marks.ts";

// F7〜F10: 待ちの数・課題の候補・スプリント・レーン・進捗の事象（受け持つ子 #6）
const { read, write } = ownedBy("#6");

export const SPRINT_OPERATIONS = [
  read("waiting_counts.get", ["F7", "F14"]),
  read("issue_candidates.list", ["F8"]),
  write("sprints.create", ["F8"], "run", IDEMPOTENT),
  read("sprints.list", ["F7", "F9"]),
  read("sprints.get", ["F9"]),
  read("lanes.list", ["F9"]),
  read("progress_events.list", ["F9"]),
  write("sprints.cancel", ["F10"], "run", IDEMPOTENT),
] as const;
