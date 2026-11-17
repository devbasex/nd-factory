import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "ci.yml");
const DECLARATION = join(ROOT, ".ndf", "project.json");

/** ワークフローの `jobs:` の直下（2 つの空白で字下げした行）のキーを集める */
export function jobNames(yaml: string): string[] {
  const names: string[] = [];
  let inJobs = false;
  for (const line of yaml.split("\n")) {
    if (/^\S/.test(line)) {
      inJobs = /^jobs:\s*$/.test(line);
      continue;
    }
    const match = inJobs ? /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line) : null;
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

/** AWS の資格情報を CI へ渡す書き方。1 つでもあれば CI が資格情報を持つ */
export const CREDENTIAL_WORDS = [
  "configure-aws-credentials",
  "role-to-assume",
  "id-token: write",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "aws-access-key-id",
  "aws-secret-access-key",
  "AWS_PROFILE",
];

export function credentialWords(yaml: string): string[] {
  return CREDENTIAL_WORDS.filter((word) => yaml.includes(word));
}

describe("CI の定義", () => {
  const yaml = readFileSync(WORKFLOW, "utf8");

  it("ジョブの名前の集合が NDF の宣言の必須のチェックと等しい", () => {
    const declared = JSON.parse(readFileSync(DECLARATION, "utf8")) as { ci: { required_checks: string[] } };
    expect(new Set(jobNames(yaml))).toEqual(new Set(declared.ci.required_checks));
    expect(jobNames(yaml)).toHaveLength(declared.ci.required_checks.length);
  });

  it("4 つのジョブを持つ", () => {
    expect(new Set(jobNames(yaml))).toEqual(new Set(["check", "synth", "e2e", "ref-check"]));
  });

  it("AWS の資格情報の語を持たない", () => {
    expect(credentialWords(yaml)).toEqual([]);
  });

  it("ジョブを片方にだけ足すと食い違いが見える", () => {
    const added = yaml.replace("jobs:\n", "jobs:\n  extra:\n    runs-on: ubuntu-24.04\n");
    expect(jobNames(added)).toContain("extra");
    expect(jobNames(added)).toHaveLength(jobNames(yaml).length + 1);
  });

  it("資格情報の語を足すと当たる", () => {
    expect(credentialWords(`${yaml}\n    permissions:\n      id-token: write\n`)).toEqual(["id-token: write"]);
    expect(credentialWords(`${yaml}\n      - uses: aws-actions/configure-aws-credentials@v4\n`)).toContain(
      "configure-aws-credentials",
    );
  });
});
