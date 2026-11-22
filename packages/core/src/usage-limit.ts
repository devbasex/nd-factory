import type { PlanRow } from "@nd-factory/contracts/data";
import { readRow, rowReplaceOf, type Stored } from "@nd-factory/contracts/row-codec";
import { usageMonthCodec, type UsageMonthRow } from "@nd-factory/contracts/rows/teams";
import type { Clock } from "./clock.ts";
import { putIfAbsent, replaceIfVersion, rowToCreate, type TransactItem } from "./conditional-write.ts";
import type { Row, StoredRow } from "./db.ts";
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

// 読んだ行に保存してあった列の値（readRow の stored と同じ。列が無ければ absent）
function storedColumn(raw: StoredRow, column: string): Stored {
  return Object.hasOwn(raw, column) && raw[column] !== undefined ? { kind: "value", value: raw[column] } : { kind: "absent" };
}

// 書いた行（putIfAbsent・replaceIfVersion の item）を読み手の見る形にする。書き手の誤りでなければ通る
function usageRowOf(written: Row | undefined): UsageMonthRow {
  const read = readRow(usageMonthCodec, written);
  if (!read.ok) throw new RangeError(`組んだ月の使った量の行を読めない（${read.reason}）`);
  return read.row;
}

export type UsageAddResult = { readonly ok: true; readonly item: TransactItem; readonly row: UsageMonthRow } | { readonly ok: false; readonly onConflict: "state_mismatch" };

// チームの月の使った量の行（db-teams の TEAM#<チーム> / USAGE#<UTC の年月>）へ費用を足した行全体を組む（issues/issue-2-design-row-writers.md の決定 5）。
// current はハンドラーがその月の行を強い整合で読み、行の版の読み手で今の形にした値（無ければ null）。
// 行が無ければ足した行の putIfAbsent、あれば読んだ行に保存してあった version と incarnation を条件にした replaceIfVersion で、どちらも onConflict: "rebuild"
// （並んだ加算に外れたら dispatch がハンドラーを呼び直し、読み直して足し直す）。通貨が違えば書き込みを組まずに state_mismatch（換算しない）。
// row は足した後の行で、使える量の判定に使う（確定した値と同じ）
export function usageAddItem(current: { readonly raw: StoredRow; readonly row: UsageMonthRow } | null, team: Id<"team">, cost: Money, clock: Clock): UsageAddResult {
  if (!Number.isInteger(cost.amount_minor) || cost.amount_minor < 0) throw new RangeError("費用は 0 以上の整数の最小単位");
  const month = clock.iso().slice(0, 7);
  if (current === null) {
    const item = putIfAbsent({
      table: "teams",
      item: rowToCreate(usageMonthCodec, { team_id: team, month, used_amount_minor: cost.amount_minor, used_currency: cost.currency, version: 1 }),
      onConflict: "rebuild",
    });
    return { ok: true, item, row: usageRowOf(item.item) };
  }
  const read = current.row;
  if (read.team_id !== team || read.month !== month) throw new RangeError("読んだ行がこのチームのこの月の行でない");
  if (read.used_currency !== cost.currency) return { ok: false, onConflict: "state_mismatch" };
  const next: UsageMonthRow = { ...read, used_amount_minor: read.used_amount_minor + cost.amount_minor };
  const item = replaceIfVersion({
    table: "teams",
    item: rowReplaceOf(usageMonthCodec, current.raw, next) as Row,
    version: read.version,
    incarnation: read.incarnation,
    expect: { version: storedColumn(current.raw, "version"), incarnation: storedColumn(current.raw, "incarnation") },
    onConflict: "rebuild",
  });
  return { ok: true, item, row: usageRowOf(item.item) };
}
