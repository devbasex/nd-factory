import { ownedBy } from "./marks.ts";

// 手元のマシン向けの 2 つの HTTP の経路（受け持つ子 #7）
const { self } = ownedBy("#7");

export const MACHINE_ENDPOINT_OPERATIONS = [
  self("machine", "machine.heartbeats.create", "write"),
  self("machine", "machine.lane_claims.create", "write"),
] as const;
