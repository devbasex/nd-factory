import { readFileSync } from "node:fs";
import { type Settings, parseSettings } from "@nd-factory/contracts/settings";

// 設定のファイルを読んで形の正本に照らす。誤りは人が直せるよう 1 件 1 行の一覧で返す

export class SettingsFileError extends Error {
  readonly issues: string[];

  constructor(path: string, issues: string[]) {
    super(`設定のファイル ${path} を使えない:\n${issues.join("\n")}`);
    this.name = "SettingsFileError";
    this.issues = issues;
  }
}

export function loadSettingsFile(path: string): Settings {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "unknown";
    throw new SettingsFileError(path, [`(ファイル): 読めない（${code}）`]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SettingsFileError(path, ["(ファイル): JSON として読めない"]);
  }
  const parsed = parseSettings(raw);
  if (!parsed.ok) throw new SettingsFileError(path, parsed.issues);
  return parsed.value;
}
