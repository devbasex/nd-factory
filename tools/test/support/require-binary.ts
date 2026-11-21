import { spawnSync } from "node:child_process";

/** 実行ファイル `name` を `args` で起こし、0 で終えなければ `message` で失敗する（PATH に固定の版を置いたかの確認） */
export function requireBinary(name: string, args: string[], message: string): void {
  const version = spawnSync(name, args, { encoding: "utf8" });
  if (version.status !== 0) throw new Error(message);
}
