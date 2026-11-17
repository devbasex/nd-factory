import data from "../data/exit-codes.json" with { type: "json" };

// 設置のコマンドの終了コード。正本は data/exit-codes.json で、ここは読んで型を付けるだけにする

export type ExitName = "OK" | "USAGE" | "SETTINGS" | "PROFILE" | "BOOTSTRAP" | "BUILD" | "CONFIRM_MISMATCH" | "DEPLOY_FAILED";

export type ExitCodeEntry = {
  code: number;
  name: ExitName;
  meaning: string;
  aws_write: string;
};

const NAMES: readonly ExitName[] = ["OK", "USAGE", "SETTINGS", "PROFILE", "BOOTSTRAP", "BUILD", "CONFIRM_MISMATCH", "DEPLOY_FAILED"];

function isExitName(name: string): name is ExitName {
  return (NAMES as readonly string[]).includes(name);
}

function load(): { entries: ExitCodeEntry[]; byName: Record<ExitName, number> } {
  const entries: ExitCodeEntry[] = [];
  const byName: Partial<Record<ExitName, number>> = {};
  for (const row of data.codes) {
    if (!isExitName(row.name)) throw new Error(`終了コードの名前が型に無い: ${row.name}`);
    if (byName[row.name] !== undefined) throw new Error(`終了コードの名前が重なる: ${row.name}`);
    byName[row.name] = row.code;
    entries.push({ code: row.code, name: row.name, meaning: row.meaning, aws_write: row.aws_write });
  }
  const missing = NAMES.filter((n) => byName[n] === undefined);
  if (missing.length > 0) throw new Error(`終了コードの正本に無い名前: ${missing.join(", ")}`);
  return { entries, byName: byName as Record<ExitName, number> };
}

const loaded = load();

export const EXIT_CODES: readonly ExitCodeEntry[] = loaded.entries;
export const EXIT: Readonly<Record<ExitName, number>> = loaded.byName;
