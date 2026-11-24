import type { SpawnSyncReturns } from "node:child_process";

/**
 * 実行ファイルを起こした結果 `version` が 0 で終えていなければ `message` で失敗する（PATH に固定の版を置いたかの確認）。
 * 起こす `spawnSync("<実行ファイル>", ...)` は呼び出し側に文字どおり書く。knip が実行ファイルの使用を拾い、
 * knip.jsonc の tools の ignoreBinaries（gitleaks・zizmor）を当たる除外として数えるため
 */
export function requireBinary(version: SpawnSyncReturns<string>, message: string): void {
  if (version.status !== 0) throw new Error(message);
}
