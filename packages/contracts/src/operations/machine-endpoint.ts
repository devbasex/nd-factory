import { ownedBy } from "./marks.ts";

// 手元のマシン向けの 2 つの HTTP のルート（受け持つ子 #7。オーガナイザーのルートは #10 の organizers.ts）
const { self } = ownedBy("#7");

export const MACHINE_ENDPOINT_OPERATIONS = [
  self("machine", "machine.heartbeats.create", "write"),
  self("machine", "machine.lane_claims.create", "write"),
] as const;
