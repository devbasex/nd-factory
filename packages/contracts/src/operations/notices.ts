import { IDEMPOTENT, ownedBy } from "./marks.ts";

// F14・F15: 知らせ・通知先（受け持つ子 #8）
const { read, write, human } = ownedBy("#8");

export const NOTICE_OPERATIONS = [
  read("notices.list", ["F14"]),
  write("notices.mark_read", ["F14"], "run"),
  read("notification_targets.list", ["F15"]),
  // Slack の登録を始め、認可の取引を人のサインインセッションに結ぶ（docs/design/execution.md#slack-の登録）
  human("notification_targets.authorize", ["F15"], "notification_targets.list"),
  human("notification_targets.create", ["F15"], "notification_targets.list", IDEMPOTENT),
  // 試しの知らせを外へ送る
  write("notification_targets.test", ["F15"], "manage", IDEMPOTENT),
  // 外すと bot token の秘密も消すため human_only（C1）
  human("notification_targets.delete", ["F15"], "notification_targets.list"),
] as const;
