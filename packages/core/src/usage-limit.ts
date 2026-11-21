import type { PlanRow } from "@nd-factory/contracts/data";
import type { Clock } from "./clock.ts";
import { cond, type TransactItem } from "./conditional-write.ts";
import type { Id } from "./ids.ts";

// 使える量の判定（docs/design/execution.md の「料金プランと月の上限額」、I8・I15）。プランの名前で分けず、プランの行の値だけで決める。
// 金額は通貨つきの最小単位の整数で、違う通貨の値どうしを比べない（換算しない）

export type Money = NonNullable<PlanRow["monthly_cap"]>;
export type Place = PlanRow["places"][number];
export type Inference = PlanRow["inference"][number];

// 判定の時点。始める（スプリントを始める）・割り当てる（レーンを動かす場所へ割り当てる）・区間の境（次の区間を起こす）
export type UsageMoment = "start" | "assign" | "segment_boundary";

export type UsageInput = {
  readonly moment: UsageMoment;
  readonly place: Place;
  readonly inference: Inference;
  // チームの今月の使った額
  readonly used: Money;
  // チームの持ち主が決めた月の上限額。決めていなければ null（プランの行の既定を使う）
  readonly cap: Money | null;
  // 同時に動くレーンの数
  readonly runningLanes: number;
};

export type UsageReason = "monthly_cap_reached" | "place_not_allowed" | "inference_not_allowed" | "concurrency_full" | "currency_mismatch";

// waitable は待てば解けるか（上限額を変えるか月が替わる・動いているレーンが終わる）
export type UsageVerdict = { readonly allowed: true } | { readonly allowed: false; readonly reason: UsageReason; readonly waitable: boolean };

const ALLOWED: UsageVerdict = Object.freeze({ allowed: true });

function deny(reason: UsageReason, waitable: boolean): UsageVerdict {
  return { allowed: false, reason, waitable };
}

// 上限額に当たるか。上限額はチームが決めた値、無ければプランの行の既定。どちらも無ければ照らさない
function capVerdict(input: UsageInput, plan: PlanRow, waitable: boolean): UsageVerdict {
  const cap = input.cap ?? plan.monthly_cap;
  if (cap === null) return ALLOWED;
  if (cap.currency !== input.used.currency) return deny("currency_mismatch", false);
  return input.used.amount_minor >= cap.amount_minor ? deny("monthly_cap_reached", waitable) : ALLOWED;
}

export function judgeUsage(input: UsageInput, plan: PlanRow): UsageVerdict {
  switch (input.moment) {
    case "start":
      if (!plan.places.includes(input.place)) return deny("place_not_allowed", false);
      if (!plan.inference.includes(input.inference)) return deny("inference_not_allowed", false);
      // 始める時点では、待っても解けない（持ち主が上限額を変えるまで始めない）
      return capVerdict(input, plan, false);
    case "assign":
      // 上限なしの行（concurrency が null）は照らさない
      if (plan.concurrency !== null && input.runningLanes >= plan.concurrency) return deny("concurrency_full", true);
      return ALLOWED;
    case "segment_boundary":
      return capVerdict(input, plan, true);
  }
}

// 月の使った量の行の形の版
const USAGE_SCHEMA_VERSION = 1;

// チームの月の使った量の行（db-teams の TEAM#<チーム> / USAGE#<UTC の年月>）へ費用を足す。行が無ければ作る。
// 通貨が同じことを条件にし、違えば外れる（換算しない）。
// 使った額は used_amount_minor と used_currency の 2 列で持つ。DynamoDB の更新の式は、親の地図の無い入れ子の道（used.amount_minor）へ
// 書けず、行の無いときの作成と加算を 1 つの式にできないため（設計の「行ごとの列」の used（money）からの読み替え）
export function usageAddItem(team: Id<"team">, cost: Money, clock: Clock): TransactItem {
  if (!Number.isInteger(cost.amount_minor) || cost.amount_minor < 0) throw new RangeError("費用は 0 以上の整数の最小単位");
  const month = clock.iso().slice(0, 7);
  return {
    table: "teams",
    op: "update",
    key: { pk: `TEAM#${team}`, sk: `USAGE#${month}` },
    update: [
      { kind: "set", path: "team_id", value: team },
      { kind: "set", path: "month", value: month },
      { kind: "set", path: "used_currency", value: cost.currency },
      { kind: "increment", path: "used_amount_minor", by: cost.amount_minor, from: 0 },
      { kind: "set", path: "schema_version", value: USAGE_SCHEMA_VERSION },
      { kind: "increment", path: "version", by: 1, from: 0 },
    ],
    condition: cond.or(cond.notExists("pk"), cond.eq("used_currency", cost.currency)),
    onConflict: "state_mismatch",
  };
}
