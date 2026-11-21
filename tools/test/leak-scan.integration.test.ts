import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// gitleaks の設定（.gitleaks.toml と tools/checks/gitleaks-default.toml）と、除外を効かなくするスクリプト
// tools/checks/leak-scan.sh が漏れを落とすことを確かめる（#1 の決定 3、受け入れ条件 1・2・3）。
// gitleaks の実行ファイルを PATH から起こす。`leak-check` のジョブが固定の版を置いてから打つ。
// 当てる値はすべて実行の時に生成した架空の値で、ソースには組み立ての手順だけを書く
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "tools", "checks", "leak-scan.sh");
const ND_CONFIG = join(ROOT, ".gitleaks.toml");
const DEFAULT_CONFIG = join(ROOT, "tools", "checks", "gitleaks-default.toml");
const TIMEOUT = 60_000;

/** 許可に書いた作り物の値と印。生成した値がこれらを含まないことを確かめてから木に置く */
const ALLOWED_MARKS = ["123456789012", "210987654321", "EXAMPLE", "acme", "example.com", "00000000-0000-7000-8000-"];

type Finding = { RuleID: string; File: string; StartLine: number; EndLine: number; Commit: string };

/** スクリプトが報告に残す項目。当たった行・伏せた値・コミットの本文と作者を残さない */
const REPORT_KEYS = ["Commit", "EndLine", "File", "RuleID", "StartLine"];
type ScanResult = { status: number | null; output: string; reportText: string | null; findings: Finding[] };

const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => {
  const version = spawnSync("gitleaks", ["version"], { encoding: "utf8" });
  if (version.status !== 0) throw new Error("gitleaks が PATH に無い。leak-check のジョブと同じ固定の版を置いて打つ");
});

function pick(chars: string, length: number): string {
  return Array.from({ length }, () => chars[randomInt(chars.length)]).join("");
}

/** 生成した値が許可の印を含まず、形が合うことを確かめて返す */
function fake(make: () => string, shape: RegExp): string {
  for (;;) {
    const value = make();
    if (!ALLOWED_MARKS.some((mark) => value.includes(mark))) {
      expect(value).toMatch(shape);
      return value;
    }
  }
}

const digits = (length: number) => pick("0123456789", length);
const lower = (length: number) => pick("abcdefghijklmnopqrstuvwxyz", length);
const hex = (length: number) => pick("0123456789abcdef", length);
const alnum = (length: number) => pick("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", length);

/** 架空の AWS のアカウント ID（許可の値に合わない 12 桁） */
const fakeAccount = () => fake(() => digits(12), /^[0-9]{12}$/);
/** 架空の token（gitleaks の既定の規則 `github-pat` の形だけ合わせたもの） */
const fakeToken = () => fake(() => `${"ghp"}_${alnum(36)}`, /^ghp_[0-9A-Za-z]{36}$/);

/** 一時の木を作り、ファイルを置く */
function makeTree(files: Record<string, string>): string {
  const root = tempDir("leak-scan-");
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "acme",
      GIT_AUTHOR_EMAIL: "ops@example.com",
      GIT_COMMITTER_NAME: "acme",
      GIT_COMMITTER_EMAIL: "ops@example.com",
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} が失敗した: ${result.stderr}`);
  return result.stdout.trim();
}

function initRepo(root: string): void {
  git(root, "init", "-q", "-b", "main");
}

function commitAll(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function write(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

/**
 * `leak-check` のジョブが組むのと同じ重ねた設定（`.gitleaks.toml` を `[extend] path` で読み、規則 `nd-real-value` を足す）を
 * 一時のディレクトリに書く
 */
function overlayConfig(pattern: string): string {
  const path = join(tempDir("leak-overlay-"), "gitleaks.toml");
  writeFileSync(
    path,
    `[extend]\npath = "${ND_CONFIG}"\n\n[[rules]]\nid = "nd-real-value"\ndescription = "CI の秘密 LEAK_CHECK_PATTERN の実際の値"\nregex = '''${pattern}'''\n`,
  );
  return path;
}

/**
 * スクリプトを子のプロセスで打ち、報告を木の外の一時のファイルに受ける。
 * 規則とファイルの組を照らすため既定で `--paths` を渡す（CI のジョブは渡さない。伏せる側は `paths: false` で確かめる）
 */
function scan(cwd: string, args: string[], { paths = true }: { paths?: boolean } = {}): ScanResult {
  const reportPath = join(tempDir("leak-report-"), "report.json");
  const extra = paths ? ["--paths"] : [];
  const result = spawnSync("bash", [SCRIPT, ...args, ...extra, "--report", reportPath], { cwd, encoding: "utf8" });
  const reportText = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : null;
  const findings = reportText === null ? [] : (JSON.parse(reportText) as Finding[]);
  return { status: result.status, output: `${result.stdout}${result.stderr}`, reportText, findings };
}

/** ファイルごとの当てた規則の id */
function rulesByFile(findings: Finding[]): Record<string, string[]> {
  const byFile: Record<string, string[]> = {};
  for (const finding of findings) (byFile[finding.File] ??= []).push(finding.RuleID);
  for (const rules of Object.values(byFile)) rules.sort();
  return byFile;
}

/**
 * 架空の端点の資源の部分の作り方とサービスの部分。実行の時に繋ぐ（ソースに端点の形を書かず、今の木の探しに当たらない）
 */
const ENDPOINTS: [() => string, string][] = [
  [() => lower(10), "execute-api.us-west-2.amazonaws.com"],
  [() => lower(26), "lambda-url.us-west-2.on.aws"],
  [() => `d${lower(13)}`, "cloudfront.net"],
  [() => `${lower(8)}-login`, "auth.us-west-2.amazoncognito.com"],
  [() => `${lower(8)}.${lower(12)}.us-west-2`, "rds.amazonaws.com"],
  [() => lower(12), "s3.amazonaws.com"],
  [() => `nd-${lower(10)}`, "s3.us-west-2.amazonaws.com"],
  [() => `nd-${lower(10)}`, "s3-us-west-2.amazonaws.com"],
  [() => `nd-${lower(10)}`, "s3.dualstack.us-west-2.amazonaws.com"],
  [() => `nd-${lower(10)}`, "s3-website-us-west-2.amazonaws.com"],
];

/** 架空の値（許可に合わず、nd-factory の規則に合う）を規則ごとに `docs/` の下のファイルへ置いた木 */
function leakTree(realWord: string) {
  const account = fakeAccount();
  const arnAccount = fakeAccount();
  const role = fake(() => `nd${lower(10)}`, /^nd[a-z]{10}$/);
  const bucket = fake(() => `nd-${lower(12)}`, /^[a-z0-9-]+$/);
  const resources = [fake(() => `vpc-${hex(17)}`, /^vpc-[0-9a-f]{17}$/), fake(() => `sg-${hex(8)}`, /^sg-[0-9a-f]{8}$/)];
  const endpoints = ENDPOINTS.map(([resource, service]) =>
    fake(() => `${resource()}.${service}`, /^[a-z0-9.-]+\.(?:amazonaws\.com|on\.aws|cloudfront\.net|amazoncognito\.com)$/),
  );
  const files = {
    "docs/account.md": `作り物でないアカウント ${account} の行\n`,
    "docs/arn.md": `役割 arn:aws:iam::${arnAccount}:role/${role}\n`,
    "docs/s3.md": `置き場 arn:aws:s3:::${bucket}/key\n`,
    "docs/resource.md": resources.map((id) => `資源 ${id}\n`).join(""),
    "docs/endpoint.md": endpoints.map((host) => `端点 https://${host}/path\n`).join(""),
    "docs/real.md": `環境の名前 ${realWord} の行\n`,
  };
  return { files, values: [account, arnAccount, role, bucket, ...resources, ...endpoints, realWord] };
}

const ND_RULES_BY_FILE = {
  "docs/account.md": ["nd-aws-account-id"],
  "docs/arn.md": ["nd-aws-account-id", "nd-aws-arn"],
  "docs/s3.md": ["nd-aws-arn-s3"],
  "docs/resource.md": ["nd-aws-resource-id", "nd-aws-resource-id"],
  "docs/endpoint.md": Array.from({ length: ENDPOINTS.length }, () => "nd-aws-endpoint"),
};

describe("nd-factory の規則（.gitleaks.toml）", () => {
  it("架空の値を docs/ に置いた木で、.gitleaks.toml の規則がそれぞれ当たる", () => {
    const realWord = fake(() => `nd${lower(10)}`, /^nd[a-z]{10}$/);
    const root = makeTree(leakTree(realWord).files);
    const result = scan(root, ["dir", ND_CONFIG]);
    expect(result.status).toBe(1);
    expect(rulesByFile(result.findings)).toEqual(ND_RULES_BY_FILE);
  }, TIMEOUT);

  it("重ねた設定では .gitleaks.toml の規則に加えて、重ねた規則の語が当たる", () => {
    const realWord = fake(() => `nd${lower(10)}`, /^nd[a-z]{10}$/);
    const root = makeTree(leakTree(realWord).files);
    const result = scan(root, ["dir", overlayConfig(realWord)]);
    expect(result.status).toBe(1);
    expect(rulesByFile(result.findings)).toEqual({ ...ND_RULES_BY_FILE, "docs/real.md": ["nd-real-value"] });
  }, TIMEOUT);

  it("報告と標準出力・標準エラーに当てた値が現れない", () => {
    const realWord = fake(() => `nd${lower(10)}`, /^nd[a-z]{10}$/);
    const { files, values } = leakTree(realWord);
    const root = makeTree(files);
    const result = scan(root, ["dir", overlayConfig(realWord)]);
    expect(result.findings.length).toBeGreaterThan(0);
    const shown = `${result.output}${result.reportText ?? ""}`;
    expect(values.filter((value) => shown.includes(value))).toEqual([]);
    expect(result.output).toContain("leak-scan: 当たり nd-aws-arn docs/arn.md:1");
    expect([...new Set(result.findings.flatMap((f) => Object.keys(f)))].sort()).toEqual(REPORT_KEYS);
  }, TIMEOUT);

  it("--paths を渡さなければ、ファイルの名前に入った秘密の値を記録と報告に出さず、名前の順の番号に替える", () => {
    const realWord = fake(() => `nd${lower(10)}`, /^nd[a-z]{10}$/);
    const root = makeTree({
      [`docs/${realWord}.md`]: `環境の名前 ${realWord} の行\n`,
      "docs/account.md": `アカウント ${fakeAccount()}\n`,
    });
    const result = scan(root, ["dir", overlayConfig(realWord)], { paths: false });
    expect(result.status).toBe(1);
    const shown = `${result.output}${result.reportText ?? ""}`;
    expect(shown).not.toContain(realWord);
    expect(shown).not.toContain("docs/");
    expect(result.findings.map((f) => [f.RuleID, f.File, f.StartLine]).sort()).toEqual([
      ["nd-aws-account-id", "file-1", 1],
      ["nd-real-value", "file-2", 1],
    ]);
    expect(result.output).toContain("leak-scan: 当たり nd-real-value file-2:1");
    expect(result.output).toContain("--paths");
    expect([...new Set(result.findings.flatMap((f) => Object.keys(f)))].sort()).toEqual(REPORT_KEYS);
  }, TIMEOUT);

  it("1 つの行に別の規則の値が並んでも、どの当たりの出力にも行の残りが現れない", () => {
    const realWord = fake(() => `nd${lower(10)}`, /^nd[a-z]{10}$/);
    const account = fakeAccount();
    const role = fake(() => `nd${lower(10)}`, /^nd[a-z]{10}$/);
    const vpc = fake(() => `vpc-${hex(17)}`, /^vpc-[0-9a-f]{17}$/);
    const values = [account, role, vpc, realWord];
    const root = makeTree({ "docs/line.md": `役割 arn:aws:iam::${account}:role/${role} 資源 ${vpc} 名前 ${realWord}\n` });
    const result = scan(root, ["dir", overlayConfig(realWord)]);
    expect(result.status).toBe(1);
    expect(result.findings.map((f) => [f.RuleID, f.File, f.StartLine]).sort()).toEqual([
      ["nd-aws-account-id", "docs/line.md", 1],
      ["nd-aws-arn", "docs/line.md", 1],
      ["nd-aws-resource-id", "docs/line.md", 1],
      ["nd-real-value", "docs/line.md", 1],
    ]);
    const shown = `${result.output}${result.reportText ?? ""}`;
    expect(values.filter((value) => shown.includes(value))).toEqual([]);
    expect(shown).not.toContain("role/");
  }, TIMEOUT);

  it("隣り合う 12 桁を 1 文字の区切りでそれぞれ当て、英数字に接した数と作り物の値は当てない", () => {
    const lines = [
      ...[",", ";", " ", "\t", "|", ":", "/", "-", "_"].map((sep) => [fakeAccount(), fakeAccount(), fakeAccount()].join(sep)),
      `123456789012,${fakeAccount()}`,
      `${fakeAccount()},123456789012,210987654321`,
      `00000000-0000-7000-8000-${digits(12)},${fakeAccount()}`,
      `spr_00000000-0000-7000-8000-${digits(12)}`,
      `x${fakeAccount()} ${fakeAccount()}x ${digits(13)}`,
      `prod_${fakeAccount()} ${fakeAccount()}_role`,
    ];
    const root = makeTree({ "docs/list.md": `${lines.join("\n")}\n` });
    const result = scan(root, ["dir", ND_CONFIG]);
    const perLine: Record<number, number> = {};
    for (const f of result.findings) perLine[f.StartLine] = (perLine[f.StartLine] ?? 0) + 1;
    // 区切りごとに 3 件。作り物の値と UUID の最後の組は数えず、英数字に接した数と 13 桁は当てない
    expect(perLine).toEqual({ 1: 3, 2: 3, 3: 3, 4: 3, 5: 3, 6: 3, 7: 3, 8: 3, 9: 3, 10: 1, 11: 1, 12: 1, 15: 2 });
    expect(result.findings.filter((f) => f.StartLine === 9).map((f) => f.RuleID).sort()).toEqual([
      "nd-aws-account-id",
      "nd-aws-account-id",
      "nd-aws-account-id-joined",
    ]);
  }, TIMEOUT);

  it("文書の区切り（<…> の自動のリンク・波括弧）に接した実際の名前を、置き場所の記号として許さない", () => {
    const host = fake(() => `d${lower(13)}`, /^d[a-z]{13}$/);
    const bucket = fake(() => `nd-${lower(10)}`, /^nd-[a-z]{10}$/);
    const regional = fake(() => `nd-${lower(10)}`, /^nd-[a-z]{10}$/);
    const root = makeTree({
      "docs/autolink.md": `端点 <${host}.${"cloudfront.net"}>\n`,
      "docs/brace.md": `置き場 {arn:aws:s3:::${bucket}}\n`,
      "docs/s3-autolink.md": `端点 <https://${regional}.${"s3.us-west-2.amazonaws.com"}/key>\n`,
      "docs/arn-autolink.md": `役割 <arn:aws:iam::${fakeAccount()}:role/${lower(8)}>\n`,
    });
    const result = scan(root, ["dir", ND_CONFIG]);
    expect(result.status).toBe(1);
    expect(rulesByFile(result.findings)).toEqual({
      "docs/autolink.md": ["nd-aws-endpoint"],
      "docs/brace.md": ["nd-aws-arn-s3"],
      "docs/s3-autolink.md": ["nd-aws-endpoint"],
      "docs/arn-autolink.md": ["nd-aws-account-id", "nd-aws-arn"],
    });
  }, TIMEOUT);

  it.each([
    ["(.gitleaks.toml)", () => ND_CONFIG],
    ["(重ねた設定)", () => overlayConfig(`nd${lower(10)}`)],
  ])("作り物の値だけの木では当たらない %s", (_label, config) => {
    const uuidTail = digits(12);
    const root = makeTree({
      "docs/fake.md": [
        "アカウント 123456789012 と別のアカウント 210987654321",
        "役割 arn:aws:iam::123456789012:role/acme-deploy",
        `作り物の UUID spr_00000000-0000-7000-8000-${uuidTail}`,
        `13 桁の数 ${digits(13)}`,
        "置き場 arn:aws:s3:::<bucket> と arn:aws:s3:::${AssetsBucket} と arn:aws:s3:::acme-assets",
        "置き場 arn:aws:s3:::assets.example.com と arn:aws:s3:::nd-EXAMPLE-logs",
        "端点 https://<api-id>.execute-api.<region>.amazonaws.com と https://${ApiId}.execute-api.${AWS::Region}.amazonaws.com",
        "端点 https://acme-test-login.auth.us-west-2.amazoncognito.com と https://EXAMPLE1234.cloudfront.net",
        "端点 https://<bucket>.s3.<region>.amazonaws.com と ${AssetsBucket}.s3.${AWS::Region}.amazonaws.com と <bucket>.s3-us-west-2.amazonaws.com",
        "端点 https://s3.us-west-2.amazonaws.com/acme-assets と 置き場 arn:aws:s3:::<bucket>/key と 役割 arn:aws:iam::123456789012:role/${RoleName}",
        "",
      ].join("\n"),
    });
    const result = scan(root, ["dir", config()]);
    expect(result.findings).toEqual([]);
    expect(result.status).toBe(0);
  }, TIMEOUT);

  it("package-lock.json の名前のファイルに置いた 12 桁も当たる（既定の全体の許可を読まない）", () => {
    const root = makeTree({ "package-lock.json": `{ "account": "${fakeAccount()}" }\n` });
    const result = scan(root, ["dir", ND_CONFIG]);
    expect(rulesByFile(result.findings)).toEqual({ "package-lock.json": ["nd-aws-account-id"] });
  }, TIMEOUT);
});

describe("既定の規則（tools/checks/gitleaks-default.toml）", () => {
  it("根に nd-factory の規則だけの .gitleaks.toml がある木でも、dir の探しで架空の token が既定の規則で当たる", () => {
    const root = makeTree({ ".gitleaks.toml": readFileSync(ND_CONFIG, "utf8"), "docs/token.md": `token ${fakeToken()}\n` });
    const result = scan(root, ["dir", DEFAULT_CONFIG]);
    expect(result.status).toBe(1);
    expect(rulesByFile(result.findings)).toEqual({ "docs/token.md": ["github-pat"] });
  }, TIMEOUT);

  it("根に nd-factory の規則だけの .gitleaks.toml がある木でも、git の探しで架空の token が既定の規則で当たる", () => {
    const root = makeTree({ ".gitleaks.toml": readFileSync(ND_CONFIG, "utf8"), "docs/token.md": `token ${fakeToken()}\n` });
    initRepo(root);
    commitAll(root, "token");
    const result = scan(root, ["git", DEFAULT_CONFIG]);
    expect(result.status).toBe(1);
    expect(rulesByFile(result.findings)).toEqual({ "docs/token.md": ["github-pat"] });
  }, TIMEOUT);

  it("設定を渡さずにスクリプトを打つと、探さずに失敗する", () => {
    const root = makeTree({ "docs/token.md": `token ${fakeToken()}\n` });
    const result = spawnSync("bash", [SCRIPT, "dir"], { cwd: root, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("設定");
    expect(result.stdout).not.toContain("leaks found");
    expect(result.stderr).not.toContain("leaks found");
  }, TIMEOUT);
});

describe("履歴の探し", () => {
  it("途中のコミットで足して後で消した値が、分岐点からの git の探しで当たる", () => {
    const root = makeTree({ "docs/a.md": "はじめ\n" });
    initRepo(root);
    const base = commitAll(root, "base");
    write(root, "docs/a.md", `はじめ\nアカウント ${fakeAccount()}\n`);
    const added = commitAll(root, "add");
    write(root, "docs/a.md", "はじめ\n");
    commitAll(root, "remove");
    expect(scan(root, ["dir", ND_CONFIG]).findings).toEqual([]);
    const result = scan(root, ["git", ND_CONFIG, "--range", `${base}..HEAD`]);
    expect(result.status).toBe(1);
    expect(result.findings.map((f) => [f.RuleID, f.File, f.Commit])).toEqual([["nd-aws-account-id", "docs/a.md", added]]);
    expect(result.output).toContain(`leak-scan: 当たり nd-aws-account-id docs/a.md:2 ${added}`);
  }, TIMEOUT);

  it("git の探しの出力と報告に、当たったコミットの本文が現れない", () => {
    const root = makeTree({ "docs/a.md": "はじめ\n" });
    initRepo(root);
    const subject = fake(() => `nd${lower(10)}`, /^nd[a-z]{10}$/);
    write(root, "docs/a.md", `はじめ\nアカウント ${fakeAccount()}\n`);
    commitAll(root, `add ${subject}`);
    const result = scan(root, ["git", ND_CONFIG]);
    expect(result.status).toBe(1);
    expect(result.findings.map((f) => f.RuleID)).toEqual(["nd-aws-account-id"]);
    expect(`${result.output}${result.reportText ?? ""}`).not.toContain(subject);
  }, TIMEOUT);

  it("マージのコミットの競合の解消でだけ足して後で消した値が、マージのコミットの当たりとして報告される", () => {
    const root = makeTree({ "docs/a.md": "はじめ\n" });
    initRepo(root);
    const base = commitAll(root, "base");
    git(root, "checkout", "-q", "-b", "side");
    write(root, "docs/a.md", "枝の側\n");
    commitAll(root, "side");
    git(root, "checkout", "-q", "main");
    write(root, "docs/a.md", "主の側\n");
    commitAll(root, "main");
    // 競合させ、解消の中でだけ値を足す
    const merge = spawnSync("git", ["-c", "commit.gpgsign=false", "merge", "-q", "side"], { cwd: root, encoding: "utf8" });
    expect(merge.status).not.toBe(0);
    write(root, "docs/a.md", `主の側\n枝の側\nアカウント ${fakeAccount()}\n`);
    git(root, "add", "-A");
    git(root, "commit", "-q", "--no-edit");
    const mergeCommit = git(root, "rev-parse", "HEAD");
    write(root, "docs/a.md", "主の側\n枝の側\n");
    commitAll(root, "remove");
    expect(scan(root, ["dir", ND_CONFIG]).findings).toEqual([]);
    const result = scan(root, ["git", ND_CONFIG, "--range", `${base}..HEAD`]);
    expect(result.status).toBe(1);
    expect(result.findings.map((f) => [f.RuleID, f.File, f.Commit])).toContainEqual([
      "nd-aws-account-id",
      "docs/a.md",
      mergeCommit,
    ]);
  }, TIMEOUT);

  it("git で読めない範囲を渡すと、当たり無しで通さずに失敗する", () => {
    const root = makeTree({ "docs/a.md": `アカウント ${fakeAccount()}\n` });
    initRepo(root);
    commitAll(root, "base");
    const result = scan(root, ["git", ND_CONFIG, "--range", `${"0".repeat(40)}..HEAD`]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("範囲");
    expect(result.reportText).toBeNull();
  }, TIMEOUT);
});

describe("除外の拒み", () => {
  const allowLine = () => `アカウント ${fakeAccount()} # gitleaks:allow\n`;

  it("dir の探しで、値の行に gitleaks:allow だけを付けた値が対象の規則の当たりとして報告される", () => {
    const root = makeTree({ "docs/allow.md": allowLine() });
    const result = scan(root, ["dir", ND_CONFIG]);
    expect(result.status).toBe(1);
    expect(rulesByFile(result.findings)).toEqual({ "docs/allow.md": ["nd-aws-account-id"] });
  }, TIMEOUT);

  it("git の探しで、値の行に gitleaks:allow だけを付けた値が対象の規則の当たりとして報告される", () => {
    const root = makeTree({ "docs/allow.md": allowLine() });
    initRepo(root);
    commitAll(root, "allow");
    const result = scan(root, ["git", ND_CONFIG]);
    expect(result.status).toBe(1);
    expect(rulesByFile(result.findings)).toEqual({ "docs/allow.md": ["nd-aws-account-id"] });
  }, TIMEOUT);

  it("dir の探しで、根に追跡していない .gitleaksignore を置くと、名前を示して探さずに失敗する", () => {
    const root = makeTree({ "docs/a.md": `アカウント ${fakeAccount()}\n`, ".gitleaksignore": "docs/a.md:nd-aws-account-id:1\n" });
    const result = scan(root, ["dir", ND_CONFIG]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(".gitleaksignore");
    expect(result.reportText).toBeNull();
  }, TIMEOUT);

  it("git の探しで、根に追跡している .gitleaksignore を置くと、名前を示して探さずに失敗する", () => {
    const root = makeTree({ "docs/a.md": `アカウント ${fakeAccount()}\n`, ".gitleaksignore": "docs/a.md:nd-aws-account-id:1\n" });
    initRepo(root);
    commitAll(root, "ignore");
    const result = scan(root, ["git", ND_CONFIG]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(".gitleaksignore");
    expect(result.reportText).toBeNull();
  }, TIMEOUT);
});
