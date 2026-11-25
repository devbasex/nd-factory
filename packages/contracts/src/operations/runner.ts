import { ownedBy } from "./marks.ts";

// ランナー向けの HTTP のルート（受け持つ子 #6）
const { self } = ownedBy("#6");

export const RUNNER_OPERATIONS = [
  self("runner", "runner.exchanges.create", "write"),
  self("runner", "runner.events.create", "write"),
  self("runner", "runner.heartbeats.create", "write"),
  // 状態用 S3 バケットの署名つき URL。URL の期限を記す書き込み（docs/design/data.md#署名つき-url）
  self("runner", "runner.state_urls.create", "write"),
  // 受け取りは送達の状態を「渡し中」にし受け取った世代を記す書き込み（docs/design/execution.md#答えの送達）
  self("runner", "runner.answers.list", "write"),
  self("runner", "runner.answer_deliveries.create", "write"),
] as const;
