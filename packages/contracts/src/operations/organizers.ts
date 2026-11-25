import { IDEMPOTENT, ownedBy } from "./marks.ts";

// F24・F25: オーガナイザーと会話、オーガナイザーのランナー・手元のマシン向けの HTTP のルート（受け持つ子 #10。
// docs/design-process/issue-24/plan.md の L2）。専用の委任だけが呼べる issue_requests.create の制限（I24）の印は、
// #10 が操作を中身ごと作るときに足す（docs/specifications/contracts-and-core.md の「対象範囲」）
const { read, write, human, self } = ownedBy("#10");

export const ORGANIZER_OPERATIONS = [
  read("organizers.list", ["F24"]),
  read("organizers.get", ["F24"]),
  human("organizers.create", ["F24"], "organizers.list", IDEMPOTENT),
  human("organizers.close", ["F24"], "organizers.get"),
  human("organizers.resume", ["F24"], "organizers.get"),
  read("organizer_messages.list", ["F25"]),
  write("organizer_messages.create", ["F25"], "run", IDEMPOTENT),
  write("organizer_messages.withdraw", ["F25"], "run"),
  write("issue_requests.create", ["F25"], "run", IDEMPOTENT),
] as const;

// オーガナイザーのレーンのランナー向けのルート。どれも書き込み（渡した世代・受け取り・キャッシュの確定を記す）
export const ORGANIZER_RUNNER_OPERATIONS = [
  self("runner", "runner.organizer_inputs.list", "write"),
  self("runner", "runner.organizer_replies.create", "write"),
  self("runner", "runner.organizer_receipts.create", "write"),
  self("runner", "runner.organizer_transcripts.create", "write"),
] as const;

// 手元のマシンが作業の場所を消し終えたことを通知するルート
export const ORGANIZER_MACHINE_OPERATIONS = [self("machine", "machine.organizer_wipes.create", "write")] as const;
