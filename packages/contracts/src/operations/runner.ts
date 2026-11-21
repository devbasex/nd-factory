import { ownedBy } from "./marks.ts";

// ランナー向けの 5 つの HTTP の経路（受け持つ子 #6）
const { self } = ownedBy("#6");

export const RUNNER_OPERATIONS = [
  self("runner", "runner.exchanges.create", "write"),
  self("runner", "runner.events.create", "write"),
  self("runner", "runner.heartbeats.create", "write"),
  self("runner", "runner.answers.list", "read"),
  self("runner", "runner.answer_deliveries.create", "write"),
] as const;
