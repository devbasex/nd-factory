// 設定の値と宣言の記録から、人の確定の段階と、承認を待たない反映を拒むかを決める。
// 規則の文章の正本は docs/design/api.md の「段階の保存先」で、機械が読む正本は
// packages/contracts/test/fixtures/confirmation-stage-cases.json の表。反映の直前の検査に束ねるので、依存を持たない

export type Stage = "ai" | "human";

// 宣言の記録（SSM のパラメーター）の状態
export type RecordState = "present" | "absent" | "unreadable";

type Keys = { launch_declared?: unknown; environment_kind?: unknown };

function keysOf(settings: unknown): Keys {
  return settings !== null && typeof settings === "object" ? (settings as Keys) : {};
}

function declaredProduction(settings: unknown): boolean {
  const k = keysOf(settings);
  return k.launch_declared === true && k.environment_kind === "production";
}

// 2 つのキーのどちらかが無いか形が違うときは human にする
export function confirmationStage(settings: unknown): Stage {
  if (declaredProduction(settings)) return "human";
  const k = keysOf(settings);
  const valid = typeof k.launch_declared === "boolean" && (k.environment_kind === "development" || k.environment_kind === "production");
  return valid ? "ai" : "human";
}

// 反映を拒む理由。拒まなければ null。settings が undefined なのは、パラメーターを読めないとき
export function refusalReason(settings: unknown, record: RecordState): string | null {
  if (settings === undefined) return "設定のパラメーターを読めない";
  if (declaredProduction(settings)) return "商用利用を宣言した本番の設定は、承認を待たないパイプラインでは反映できない";
  if (record === "present") return "商用利用の宣言の記録がある";
  if (record === "unreadable") return "宣言の記録の有無を読めない";
  return null;
}
