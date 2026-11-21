import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsFileError, loadSettingsFile } from "../lib/settings-file.ts";

const EXAMPLE = new URL("../settings.example.json", import.meta.url).pathname;
const FIXTURE = new URL("./fixtures/settings.json", import.meta.url).pathname;

function tempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nd-settings-"));
  const path = join(dir, "settings.json");
  writeFileSync(path, content);
  return path;
}

function catchError(fn: () => unknown): SettingsFileError {
  try {
    fn();
  } catch (e) {
    if (e instanceof SettingsFileError) return e;
    throw e;
  }
  throw new Error("投げなかった");
}

describe("loadSettingsFile", () => {
  it("見本を読むと形に合う値を返す", () => {
    expect(loadSettingsFile(EXAMPLE)).toEqual({
      prefix: "acme",
      environment: "test",
      login: { google: {} },
      network: { vpc_cidr: "10.80.0.0/16" },
      progress_db: { max_acu: 2 },
      budget: { monthly_usd: 30, scope: "tags" },
      ops: { notify_emails: ["ops@example.com"] },
    });
  });

  it("試験の作り物の値はパイプラインを持つ", () => {
    expect(loadSettingsFile(FIXTURE).pipeline?.repository).toBe("example-org/example-app");
  });

  it("ファイルが無ければ SettingsFileError", () => {
    const e = catchError(() => loadSettingsFile(join(tmpdir(), "nd-no-such-dir", "settings.json")));
    expect(e.issues).toHaveLength(1);
    expect(e.issues[0]).toMatch(/読めない/);
  });

  it("JSON でなければ SettingsFileError", () => {
    const e = catchError(() => loadSettingsFile(tempFile("{ prefix: ")));
    expect(e.issues[0]).toMatch(/JSON/);
  });

  it("形に合わなければ、誤ったキーを 1 件ずつ持つ SettingsFileError", () => {
    const path = tempFile(JSON.stringify({ prefix: "awsome", environment: "test", login: { google: {} }, extra: 1 }));
    const e = catchError(() => loadSettingsFile(path));
    expect(e.issues.length).toBe(2);
    expect(e.issues.some((i) => i.startsWith("prefix:"))).toBe(true);
    expect(e.issues.some((i) => i.startsWith("extra:"))).toBe(true);
  });
});
