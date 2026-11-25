import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomInt } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { requireBinary } from "./support/require-binary.ts";
import { useTempTree, write } from "./support/temp-tree.ts";

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

const { tempDir, makeTree } = useTempTree("leak-scan-");

beforeAll(() => {
  requireBinary(spawnSync("gitleaks", ["version"], { encoding: "utf8" }), "gitleaks が PATH に無い。leak-check のジョブと同じ固定の版を置いて打つ");
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
/** 架空の語（`nd` と小文字 10 字） */
const fakeWord = () => fake(() => `nd${lower(10)}`, /^nd[a-z]{10}$/);
/** 架空の token（gitleaks の既定の規則 `github-pat` の形だけ合わせたもの） */
const fakeToken = () => fake(() => `${"ghp"}_${alnum(36)}`, /^ghp_[0-9A-Za-z]{36}$/);

// CI のランナーは git の利用者の設定を持たないので、作り物の名前とメールを環境変数で渡す
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "acme",
  GIT_AUTHOR_EMAIL: "ops@example.com",
  GIT_COMMITTER_NAME: "acme",
  GIT_COMMITTER_EMAIL: "ops@example.com",
};

/** git を打ち、失敗しても投げずに結果を返す */
function gitResult(cwd: string, ...args: string[]): SpawnSyncReturns<string> {
  return spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_IDENTITY },
  });
}

function git(cwd: string, ...args: string[]): string {
  const result = gitResult(cwd, ...args);
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

/** 木を作って git の倉庫にし、全部を 1 つ目のコミットにする。木の根とそのコミットを返す */
function makeRepo(files: Record<string, string>, message: string): { root: string; head: string } {
  const root = makeTree(files);
  initRepo(root);
  return { root, head: commitAll(root, message) };
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
function scan(
  cwd: string,
  args: string[],
  { paths = true, env }: { paths?: boolean; env?: NodeJS.ProcessEnv } = {},
): ScanResult {
  const reportPath = join(tempDir("leak-report-"), "report.json");
  const extra = paths ? ["--paths"] : [];
  const result = spawnSync("bash", [SCRIPT, ...args, ...extra, "--report", reportPath], {
    cwd,
    encoding: "utf8",
    ...(env === undefined ? {} : { env }),
  });
  const reportText = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : null;
  const findings = reportText === null ? [] : (JSON.parse(reportText) as Finding[]);
  return { status: result.status, output: `${result.stdout}${result.stderr}`, reportText, findings };
}

/** 利用者に見える全部（出力と報告を繋いだもの） */
function shownText(result: ScanResult): string {
  return `${result.output}${result.reportText ?? ""}`;
}

/** 報告の当たりが持つ項目の名前（重ねず並べたもの） */
function reportKeys(result: ScanResult): string[] {
  return [...new Set(result.findings.flatMap((f) => Object.keys(f)))].sort();
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
  const role = fakeWord();
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
    const realWord = fakeWord();
    const root = makeTree(leakTree(realWord).files);
    const result = scan(root, ["dir", ND_CONFIG]);
    expect(result.status).toBe(1);
    expect(rulesByFile(result.findings)).toEqual(ND_RULES_BY_FILE);
  }, TIMEOUT);

  it("重ねた設定では .gitleaks.toml の規則に加えて、重ねた規則の語が当たる", () => {
    const realWord = fakeWord();
    const root = makeTree(leakTree(realWord).files);
    const result = scan(root, ["dir", overlayConfig(realWord)]);
    expect(result.status).toBe(1);
    expect(rulesByFile(result.findings)).toEqual({ ...ND_RULES_BY_FILE, "docs/real.md": ["nd-real-value"] });
  }, TIMEOUT);

  it("報告と標準出力・標準エラーに当てた値が現れない", () => {
    const realWord = fakeWord();
    const { files, values } = leakTree(realWord);
    const root = makeTree(files);
    const result = scan(root, ["dir", overlayConfig(realWord)]);
    expect(result.findings.length).toBeGreaterThan(0);
    const shown = shownText(result);
    expect(values.filter((value) => shown.includes(value))).toEqual([]);
    expect(result.output).toContain("leak-scan: 当たり nd-aws-arn docs/arn.md:1");
    expect(reportKeys(result)).toEqual(REPORT_KEYS);
  }, TIMEOUT);

  it("--paths を渡さなければ、ファイルの名前に入った秘密の値を記録と報告に出さず、名前の順の番号に替える", () => {
    const realWord = fakeWord();
    const root = makeTree({
      [`docs/${realWord}.md`]: `環境の名前 ${realWord} の行\n`,
      "docs/account.md": `アカウント ${fakeAccount()}\n`,
    });
    const result = scan(root, ["dir", overlayConfig(realWord)], { paths: false });
    expect(result.status).toBe(1);
    const shown = shownText(result);
    expect(shown).not.toContain(realWord);
    expect(shown).not.toContain("docs/");
    expect(result.findings.map((f) => [f.RuleID, f.File, f.StartLine]).sort()).toEqual([
      ["nd-aws-account-id", "file-1", 1],
      ["nd-real-value", "file-2", 1],
    ]);
    expect(result.output).toContain("leak-scan: 当たり nd-real-value file-2:1");
    expect(result.output).toContain("--paths");
    expect(reportKeys(result)).toEqual(REPORT_KEYS);
  }, TIMEOUT);

  it("1 つの行に別の規則の値が並んでも、どの当たりの出力にも行の残りが現れない", () => {
    const realWord = fakeWord();
    const account = fakeAccount();
    const role = fakeWord();
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
    const shown = shownText(result);
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
    const { root } = makeRepo({ ".gitleaks.toml": readFileSync(ND_CONFIG, "utf8"), "docs/token.md": `token ${fakeToken()}\n` }, "token");
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
    const { root, head: base } = makeRepo({ "docs/a.md": "はじめ\n" }, "base");
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
    const subject = fakeWord();
    write(root, "docs/a.md", `はじめ\nアカウント ${fakeAccount()}\n`);
    commitAll(root, `add ${subject}`);
    const result = scan(root, ["git", ND_CONFIG]);
    expect(result.status).toBe(1);
    expect(result.findings.map((f) => f.RuleID)).toEqual(["nd-aws-account-id"]);
    expect(shownText(result)).not.toContain(subject);
  }, TIMEOUT);

  it("マージのコミットの競合の解消でだけ足して後で消した値が、マージのコミットの当たりとして報告される", () => {
    const { root, head: base } = makeRepo({ "docs/a.md": "はじめ\n" }, "base");
    git(root, "checkout", "-q", "-b", "side");
    write(root, "docs/a.md", "枝の側\n");
    commitAll(root, "side");
    git(root, "checkout", "-q", "main");
    write(root, "docs/a.md", "主の側\n");
    commitAll(root, "main");
    // 競合させ、解消の中でだけ値を足す
    const merge = gitResult(root, "merge", "-q", "side");
    expect(merge.status).not.toBe(0);
    write(root, "docs/a.md", `主の側\n枝の側\nアカウント ${fakeAccount()}\n`);
    git(root, "add", "-A");
    // CI の git は競合のマージのメッセージを空にし得るので、メッセージを明示する
    git(root, "commit", "-q", "-m", "merge the side branch");
    const mergeCommit = git(root, "rev-parse", "HEAD");
    // 競合を解いたコミットがマージのコミット（親が 2 つ）であること
    expect(git(root, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
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

  it("途中のコミットで足して後で消した token が、分岐点からの git の探しで既定の規則に当たる", () => {
    const { root, head: base } = makeRepo({ "docs/a.md": "はじめ\n" }, "base");
    write(root, "docs/a.md", `はじめ\ntoken ${fakeToken()}\n`);
    const added = commitAll(root, "add");
    write(root, "docs/a.md", "はじめ\n");
    commitAll(root, "remove");
    expect(scan(root, ["dir", DEFAULT_CONFIG]).findings).toEqual([]);
    const result = scan(root, ["git", DEFAULT_CONFIG, "--range", `${base}..HEAD`]);
    expect(result.status).toBe(1);
    expect(result.findings.map((f) => [f.RuleID, f.File, f.Commit])).toEqual([["github-pat", "docs/a.md", added]]);
  }, TIMEOUT);

  it("git で読めない範囲を渡すと、当たり無しで通さずに失敗する", () => {
    const { root } = makeRepo({ "docs/a.md": `アカウント ${fakeAccount()}\n` }, "base");
    const result = scan(root, ["git", ND_CONFIG, "--range", `${"0".repeat(40)}..HEAD`]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("範囲");
    expect(result.reportText).toBeNull();
  }, TIMEOUT);
});

/**
 * 診断にファイルの名前を載せる偽の gitleaks を置いた PATH を返す（v8.30.1 の dir は読めないファイルの診断などに名前を載せる。
 * 実物で起こす条件は実行の環境に依るので、出力の扱いだけを偽の実行ファイルで確かめる）
 */
function fakeGitleaksPath(diagnostic: string, stderrLine = `stderr ${diagnostic}`, trailingLines = 0): string {
  const bin = tempDir("leak-fake-bin-");
  const body = [
    "#!/usr/bin/env bash",
    'report=""',
    'while (($# > 0)); do if [[ "$1" == --report-path ]]; then report="$2"; shift 2; else shift; fi; done',
    `echo "stdout ${diagnostic}"`,
    `printf '%s\\n' '${stderrLine}' >&2`,
    `for ((i = 0; i < ${trailingLines}; i++)); do echo "filler line $i of the scan log, no level word here" >&2; done`,
    "printf '[]' >\"$report\"",
    "exit 0",
  ].join("\n");
  writeFileSync(join(bin, "gitleaks"), `${body}\n`, { mode: 0o755 });
  return `${bin}:${process.env.PATH ?? ""}`;
}

describe("gitleaks の生の出力", () => {
  for (const mode of ["dir", "git"] as const) {
    it(`${mode} の探しで、--paths を渡さなければ gitleaks の標準出力と標準エラーに載ったファイルの名前を出さない`, () => {
      const realWord = fakeWord();
      const { root } = makeRepo({ "a.md": "中身\n" }, "first");
      const env = { ...process.env, PATH: fakeGitleaksPath(`docs/${realWord}.md`) };
      const hidden = scan(root, [mode, ND_CONFIG], { paths: false, env });
      expect(hidden.status).toBe(0);
      expect(hidden.output).not.toContain(realWord);
      const shown = scan(root, [mode, ND_CONFIG], { env });
      expect(shown.status).toBe(0);
      expect(shown.output).toContain(`stderr docs/${realWord}.md`);
    }, TIMEOUT);
  }
});

/** gitleaks v8.30.1 が読めない対象を飛ばすときの標準エラーの 1 行（色の制御の列を含む実物の形） */
function skipLine(path: string): string {
  const esc = "\u001b";
  return `${esc}[90m4:08PM${esc}[0m ${esc}[33mWRN${esc}[0m ${esc}[1mskipping file: permission denied${esc}[0m ${esc}[36mpath=${esc}[0m${path}`;
}

const SKIP_MESSAGE = "leak-scan: gitleaks が警告か誤りを出した";

describe("読めずに飛ばした対象", () => {
  for (const mode of ["dir", "git"] as const) {
    it(`${mode} の探しで、gitleaks が警告を出して 0 で終えても、当たり無しとして通さず、ファイルの名前を出さない`, () => {
      const realWord = fakeWord();
      const { root } = makeRepo({ "a.md": "中身\n" }, "first");
      const env = { ...process.env, PATH: fakeGitleaksPath("中身", skipLine(`docs/${realWord}.md`)) };
      const hidden = scan(root, [mode, ND_CONFIG], { paths: false, env });
      expect(hidden.status).toBe(1);
      expect(hidden.output).toContain(SKIP_MESSAGE);
      expect(hidden.output).not.toContain(realWord);
      const shown = scan(root, [mode, ND_CONFIG], { env });
      expect(shown.status).toBe(1);
      expect(shown.output).toContain(SKIP_MESSAGE);
    }, TIMEOUT);
  }

  it("警告の後にパイプの容量を超える出力が続いても、当たり無しとして通さない", () => {
    const realWord = fakeWord();
    const { root } = makeRepo({ "a.md": "中身\n" }, "first");
    // 1 行が約 50 バイトで 1 万行（約 500KB）。パイプの容量（Linux の既定は 64KiB）を超える
    const env = { ...process.env, PATH: fakeGitleaksPath("中身", skipLine(`docs/${realWord}.md`), 10000) };
    const result = scan(root, ["dir", ND_CONFIG], { paths: false, env });
    expect(result.status).toBe(1);
    expect(result.output).toContain(SKIP_MESSAGE);
    expect(result.output).not.toContain(realWord);
  }, TIMEOUT);

  // root は権限によらず読めるので、実物の gitleaks で飛ばさせられない
  it.skipIf(process.getuid?.() === 0)("dir の探しで、読めないファイルとディレクトリがあれば実物の gitleaks でも失敗する", () => {
    const root = makeTree({ "a.md": "中身\n", "c.md": "中身\n", "sec/b.md": "中身\n" });
    chmodSync(join(root, "c.md"), 0o000);
    chmodSync(join(root, "sec"), 0o000);
    try {
      const result = scan(root, ["dir", DEFAULT_CONFIG], { paths: false });
      expect(result.status).toBe(1);
      expect(result.output).toContain(SKIP_MESSAGE);
      expect(result.output).not.toContain("c.md");
    } finally {
      chmodSync(join(root, "sec"), 0o755);
      chmodSync(join(root, "c.md"), 0o644);
    }
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
    const { root } = makeRepo({ "docs/allow.md": allowLine() }, "allow");
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
    const { root } = makeRepo({ "docs/a.md": `アカウント ${fakeAccount()}\n`, ".gitleaksignore": "docs/a.md:nd-aws-account-id:1\n" }, "ignore");
    const result = scan(root, ["git", ND_CONFIG]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(".gitleaksignore");
    expect(result.reportText).toBeNull();
  }, TIMEOUT);
});

const EXPORT_SCRIPT = join(ROOT, "tools", "checks", "export-tree.sh");

type RunResult = { status: number | null; output: string };

/**
 * `export-tree.sh` を子のプロセスで打ち、標準出力と標準エラーを合わせて返す。
 * 引数は木の取り出し・履歴の取り出し・照らすだけの 2 つ（`--verify`・`--verify-history`）のどれか。
 * `tmp` を渡せば、スクリプトの作業のディレクトリをそこに作らせる（残らないことを確かめるため）
 */
function exportTree(cwd: string, args: string[], { tmp }: { tmp?: string } = {}): RunResult {
  const result = spawnSync("bash", [EXPORT_SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: tmp === undefined ? process.env : { ...process.env, TMPDIR: tmp },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** blob のバイト列（属性による加工なし） */
function blobOf(root: string, object: string): Buffer {
  const result = spawnSync("git", ["cat-file", "blob", object], { cwd: root });
  if (result.status !== 0) throw new Error(`git cat-file blob ${object} が失敗した`);
  return result.stdout;
}

/** 木のファイルの項目（モード 100644・100755・120000）のパスと blob */
function fileEntries(root: string, commit: string): { path: string; sha: string }[] {
  return git(root, "ls-tree", "-r", "-z", "--full-tree", commit)
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => {
      const [meta = "", path = ""] = line.split("\t");
      const [mode = "", , sha = ""] = meta.split(" ");
      return { mode, path, sha };
    })
    .filter((entry) => ["100644", "100755", "120000"].includes(entry.mode))
    .map(({ path, sha }) => ({ path, sha }));
}

/** 出力先の普通のファイルの相対パス（並べたもの）と、普通のファイルでもディレクトリでもない物の数 */
function listOutput(dir: string): { files: string[]; others: number } {
  const files: string[] = [];
  let others = 0;
  for (const name of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const stat = lstatSync(join(dir, name));
    if (stat.isFile()) files.push(name);
    else if (!stat.isDirectory()) others += 1;
  }
  return { files: files.sort(), others };
}

/** 木を作って git の倉庫にし、空のコミットを分岐点にしてから、渡したファイルを置いたコミットを足す */
function forkRepo(): { root: string; base: string } {
  const root = makeTree({});
  initRepo(root);
  return { root, base: commitAll(root, "base") };
}

/** `git mktree` で 1 つの項目を持つ木を作り、`dir` の下に置いたコミットを作る（git の作業ツリーでは作れないパスのため） */
function commitCraftedTree(root: string, dir: string, name: string, parent?: string): string {
  const blob = git(root, "hash-object", "-w", "--stdin");
  const inner = spawnSync("git", ["mktree"], { cwd: root, input: `100644 blob ${blob}\t${name}\n`, encoding: "utf8" });
  if (inner.status !== 0) throw new Error("git mktree が失敗した");
  const outer = spawnSync("git", ["mktree"], { cwd: root, input: `040000 tree ${inner.stdout.trim()}\t${dir}\n`, encoding: "utf8" });
  if (outer.status !== 0) throw new Error("git mktree が失敗した");
  return git(root, "commit-tree", outer.stdout.trim(), ...(parent === undefined ? [] : ["-p", parent]), "-m", "crafted");
}

describe("木の取り出し（export-tree.sh）", () => {
  it("属性で中身を変える .gitattributes を持つコミットを、ファイルの数と blob のバイト列のまま取り出す", () => {
    const { root, head } = makeRepo(
      {
        ".gitattributes": "* export-ignore\nsubst.txt export-subst\ncrlf.txt text eol=crlf\nident.txt ident\n",
        "subst.txt": "版 $Format:%H$\n",
        "crlf.txt": "一\n二\n",
        "ident.txt": "$Id$\n",
        "docs/a.md": "中身\n",
      },
      "attributes",
    );
    const out = join(tempDir("export-out-"), "tree");
    const result = exportTree(root, [head, out]);
    expect(result).toEqual({ status: 0, output: "" });
    const entries = fileEntries(root, head);
    expect(listOutput(out)).toEqual({ files: entries.map((entry) => entry.path).sort(), others: 0 });
    for (const entry of entries) expect(readFileSync(join(out, entry.path))).toEqual(blobOf(root, entry.sha));
  }, TIMEOUT);

  it("出力先が無ければ作り、空のディレクトリを渡しても取り出す", () => {
    const { root, head } = makeRepo({ "a.md": "中身\n" }, "first");
    expect(exportTree(root, [head, join(tempDir("export-out-"), "new", "tree")]).status).toBe(0);
    expect(exportTree(root, [head, tempDir("export-empty-")]).status).toBe(0);
  }, TIMEOUT);

  it("空でない出力先・ファイルの出力先・読めないコミットで 2", () => {
    const { root, head } = makeRepo({ "a.md": "中身\n" }, "first");
    const full = makeTree({ "x.md": "x\n" });
    expect(exportTree(root, [head, full])).toEqual({ status: 2, output: "export-tree: 出力先が空のディレクトリでない\n" });
    expect(exportTree(root, [head, join(full, "x.md")]).status).toBe(2);
    expect(exportTree(root, ["0".repeat(40), join(tempDir("export-out-"), "tree")])).toEqual({
      status: 2,
      output: "export-tree: コミットを読めない\n",
    });
    expect(exportTree(root, [head]).output).toContain("使い方");
  }, TIMEOUT);

  it("export-ignore を付けたファイルにだけ置いた作り物の値が、取り出した木の探しで当たる", () => {
    const realWord = fakeWord();
    const { root, head } = makeRepo(
      { ".gitattributes": "docs/hidden.md export-ignore\n", "docs/hidden.md": `名前 ${realWord}\n`, "docs/a.md": "中身\n" },
      "hidden",
    );
    const out = join(tempDir("export-out-"), "tree");
    expect(exportTree(root, [head, out]).status).toBe(0);
    const result = scan(out, ["dir", overlayConfig(realWord)]);
    expect(result.status).toBe(1);
    expect(rulesByFile(result.findings)).toEqual({ "docs/hidden.md": ["nd-real-value"] });
  }, TIMEOUT);

  it("シンボリックリンクはリンク先の文字列を中身とする普通のファイルになり、サブモジュールは書かない", () => {
    const { root } = makeRepo({ "a.md": "中身\n" }, "first");
    symlinkSync("../../outside", join(root, "link"));
    git(root, "add", "link");
    git(root, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},sub`);
    // 作業ツリーにサブモジュールが無いので、git add -A を打たずに索引のままコミットする
    git(root, "commit", "-q", "-m", "link and submodule");
    const head = git(root, "rev-parse", "HEAD");
    expect(git(root, "ls-tree", head, "sub")).toContain("160000 commit");
    const out = join(tempDir("export-out-"), "tree");
    expect(exportTree(root, [head, out]).status).toBe(0);
    expect(listOutput(out)).toEqual({ files: ["a.md", "link"], others: 0 });
    expect(readFileSync(join(out, "link"), "utf8")).toBe("../../outside");
    expect(lstatSync(join(out, "link")).mode & 0o777).toBe(0o644);
  }, TIMEOUT);

  it.each([[".."], [".git"], [".GIT"]])("%s の部分を持つ項目の木で 1 になり、項目のパスを出さない", (name) => {
    const realWord = fakeWord();
    const { root } = makeRepo({ "a.md": "中身\n" }, "first");
    const commit = commitCraftedTree(root, realWord, name);
    const result = exportTree(root, [commit, join(tempDir("export-out-"), "tree")]);
    expect(result).toEqual({ status: 1, output: "export-tree: 木に取り出せない項目がある（1 番目）\n" });
  }, TIMEOUT);

  // root は権限によらず書けるので、mkdir -p を失敗させられない
  it.skipIf(process.getuid?.() === 0)("書けない出力先で 1 になり、作り物の値と診断を出さず、作業のディレクトリを残さない", () => {
    const realWord = fakeWord();
    const { root, head } = makeRepo({ [`${realWord}/a.md`]: "中身\n" }, "first");
    const out = tempDir("export-ro-");
    const tmp = tempDir("export-tmp-");
    chmodSync(out, 0o555);
    try {
      const result = exportTree(root, [head, out], { tmp });
      expect(result).toEqual({ status: 1, output: "export-tree: 木を書き出せない（1 番目）\n" });
      expect(readdirSync(tmp)).toEqual([]);
    } finally {
      chmodSync(out, 0o755);
    }
  }, TIMEOUT);

  describe("--verify", () => {
    const exported = () => {
      const { root, head } = makeRepo({ "a.md": "中身\n", "docs/b.md": "別の中身\n" }, "first");
      const out = join(tempDir("export-out-"), "tree");
      expect(exportTree(root, [head, out]).status).toBe(0);
      return { root, head, out };
    };

    it("取り出したままの出力先で 0", () => {
      const { root, head, out } = exported();
      expect(exportTree(root, ["--verify", head, out])).toEqual({ status: 0, output: "" });
    }, TIMEOUT);

    it.each<[string, (out: string) => void]>([
      ["ファイルを 1 つ消す", (out) => rmSync(join(out, "docs", "b.md"))],
      ["中身を 1 バイト替える", (out) => writeFileSync(join(out, "a.md"), "中身!")],
      ["ファイルを 1 つ足す", (out) => writeFileSync(join(out, "c.md"), "足した\n")],
      ["シンボリックリンクを足す", (out) => symlinkSync("a.md", join(out, "link"))],
    ])("%s と 1", (_label, breakOutput) => {
      const { root, head, out } = exported();
      breakOutput(out);
      expect(exportTree(root, ["--verify", head, out])).toEqual({
        status: 1,
        output: "export-tree: 取り出した木が元の木と一致しない\n",
      });
    }, TIMEOUT);
  });
});

/** NUL を含み、作り物の値を中に持つバイト列 */
function binaryWith(word: string): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x00, 0x01, 0x02]), Buffer.from(`name=${word}`), Buffer.from([0x00, 0xff, 0x0a])]);
}

describe("履歴の取り出し（export-tree.sh --history）", () => {
  it("途中のコミットで足して後で消したパスの名前と、NUL を含むファイルの中身を書く", () => {
    const realWord = fakeWord();
    const { root, base } = forkRepo();
    write(root, `docs/${realWord}.md`, "中身\n");
    write(root, `${realWord}-dir/a.md`, "中身\n");
    writeFileSync(join(root, "bin.dat"), binaryWith(realWord));
    commitAll(root, "add");
    rmSync(join(root, "docs"), { recursive: true });
    rmSync(join(root, `${realWord}-dir`), { recursive: true });
    rmSync(join(root, "bin.dat"));
    write(root, "keep.md", "残す\n");
    const head = commitAll(root, "remove");
    const out = join(tempDir("history-out-"), "history");
    const result = exportTree(root, ["--history", base, head, out]);
    expect(result).toEqual({ status: 0, output: "" });
    const { files, others } = listOutput(out);
    expect(others).toBe(0);
    const paths = files.filter((file) => file.startsWith("paths/")).map((file) => readFileSync(join(out, file), "utf8"));
    expect(paths.sort()).toEqual(["keep.md", "bin.dat", `${realWord}-dir/a.md`, `docs/${realWord}.md`, "bin.dat", `${realWord}-dir/a.md`, `docs/${realWord}.md`].sort());
    expect(readFileSync(join(out, "layers", "1", "bin.dat"))).toEqual(binaryWith(realWord));
    expect(readFileSync(join(out, "binary-text", "1", "bin.dat"), "latin1")).toBe(`\x89\n\n\nname=${realWord}\n\xff\n`);
    expect(files.filter((file) => file.startsWith("binary-text/"))).toEqual(["binary-text/1/bin.dat"]);
  }, TIMEOUT);

  it("範囲の中のマージのコミットの差も読む", () => {
    const { root, base } = forkRepo();
    git(root, "checkout", "-q", "-b", "side");
    write(root, "side.md", "枝\n");
    commitAll(root, "side");
    git(root, "checkout", "-q", "main");
    write(root, "main.md", "主\n");
    commitAll(root, "main");
    git(root, "merge", "-q", "--no-ff", "--no-commit", "side");
    write(root, "merge-only.md", "マージでだけ足した\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "merge");
    const head = git(root, "rev-parse", "HEAD");
    write(root, "x.md", "x\n");
    rmSync(join(root, "merge-only.md"));
    const tip = commitAll(root, "remove");
    const out = join(tempDir("history-out-"), "history");
    expect(exportTree(root, ["--history", base, tip, out]).status).toBe(0);
    expect(readFileSync(join(out, "layers", "1", "merge-only.md"), "utf8")).toBe("マージでだけ足した\n");
    expect(head).not.toBe(tip);
  }, TIMEOUT);

  it("範囲が空なら 3 つの空のディレクトリを書いて 0", () => {
    const { root, base } = forkRepo();
    const out = join(tempDir("history-out-"), "history");
    expect(exportTree(root, ["--history", base, base, out])).toEqual({ status: 0, output: "" });
    expect(readdirSync(out).sort()).toEqual(["binary-text", "layers", "paths"]);
    expect(listOutput(out)).toEqual({ files: [], others: 0 });
    expect(exportTree(root, ["--verify-history", base, base, out]).status).toBe(0);
  }, TIMEOUT);

  it("同じパスを 3 つのコミットで変えると層 1〜3 に 1 つずつ入り、同じ組は 1 回だけ書く", () => {
    const { root, base } = forkRepo();
    for (const body of ["一\n", "二\n", "三\n", "一\n"]) {
      write(root, "a.md", body);
      commitAll(root, body);
    }
    const head = git(root, "rev-parse", "HEAD");
    const out = join(tempDir("history-out-"), "history");
    expect(exportTree(root, ["--history", base, head, out]).status).toBe(0);
    const layers = listOutput(join(out, "layers")).files;
    expect(layers).toEqual(["1/a.md", "2/a.md", "3/a.md"]);
    expect(layers.map((file) => readFileSync(join(out, "layers", file), "utf8")).sort()).toEqual(["一\n", "三\n", "二\n"]);
  }, TIMEOUT);

  it("途中のコミットで a をファイルからディレクトリに変えると、a と a/b が別の層に入る", () => {
    const { root, base } = forkRepo();
    write(root, "a", "ファイル\n");
    commitAll(root, "file");
    rmSync(join(root, "a"));
    write(root, "a/b", "ディレクトリの中\n");
    const head = commitAll(root, "dir");
    const out = join(tempDir("history-out-"), "history");
    expect(exportTree(root, ["--history", base, head, out]).status).toBe(0);
    expect(listOutput(join(out, "layers")).files).toEqual(["1/a/b", "2/a"].sort());
  }, TIMEOUT);

  it("サブモジュールの項目はパスの名前だけを書く", () => {
    const { root, base } = forkRepo();
    git(root, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},sub`);
    git(root, "commit", "-q", "-m", "submodule");
    const head = git(root, "rev-parse", "HEAD");
    const out = join(tempDir("history-out-"), "history");
    expect(exportTree(root, ["--history", base, head, out]).status).toBe(0);
    expect(listOutput(out).files).toEqual(["paths/1"]);
    expect(readFileSync(join(out, "paths", "1"), "utf8")).toBe("sub");
  }, TIMEOUT);

  it("読めない範囲で 2", () => {
    const { root, base } = forkRepo();
    const out = join(tempDir("history-out-"), "history");
    expect(exportTree(root, ["--history", base, "0".repeat(40), out])).toEqual({
      status: 2,
      output: "export-tree: 履歴の範囲を読めない\n",
    });
  }, TIMEOUT);

  it.each([[".."], [".git"]])("%s の部分を持つパスを途中のコミットで足すと 1 になり、パスを出さない", (name) => {
    const realWord = fakeWord();
    const { root, base } = forkRepo();
    const crafted = commitCraftedTree(root, realWord, name, base);
    const out = join(tempDir("history-out-"), "history");
    expect(exportTree(root, ["--history", base, crafted, out])).toEqual({
      status: 1,
      output: "export-tree: 履歴の項目を書き出せない（1 番目）\n",
    });
  }, TIMEOUT);

  describe("--verify-history", () => {
    const written = () => {
      const realWord = fakeWord();
      const { root, base } = forkRepo();
      write(root, `docs/${realWord}.md`, "中身\n");
      writeFileSync(join(root, "bin.dat"), binaryWith(realWord));
      commitAll(root, "add");
      write(root, `docs/${realWord}.md`, "変えた中身\n");
      const head = commitAll(root, "change");
      const out = join(tempDir("history-out-"), "history");
      expect(exportTree(root, ["--history", base, head, out]).status).toBe(0);
      return { root, base, head, out, realWord };
    };
    const MISMATCH = { status: 1, output: "export-tree: 取り出した履歴が元の履歴と一致しない\n" };

    it("書いたままの出力先で 0", () => {
      const { root, base, head, out } = written();
      expect(exportTree(root, ["--verify-history", base, head, out])).toEqual({ status: 0, output: "" });
    }, TIMEOUT);

    it.each<[string, (out: string, word: string) => void]>([
      ["paths/ のファイルの中身を替える", (out) => writeFileSync(join(out, "paths", "1"), "別のパス")],
      ["paths/ のファイルを 1 つ消す", (out) => rmSync(join(out, "paths", "3"))],
      ["layers/ のファイルの中身を替える", (out, word) => writeFileSync(join(out, "layers", "1", "docs", `${word}.md`), "替えた\n")],
      ["layers/ のファイルを 1 つ消す", (out, word) => rmSync(join(out, "layers", "2", "docs", `${word}.md`))],
      ["binary-text/ のファイルを 1 つ消す", (out) => rmSync(join(out, "binary-text", "1", "bin.dat"))],
      ["binary-text/ のファイルの中身を替える", (out) => writeFileSync(join(out, "binary-text", "1", "bin.dat"), "替えた\n")],
      ["3 つのディレクトリのほかにファイルを足す", (out) => writeFileSync(join(out, "extra"), "足した\n")],
    ])("%s と 1", (_label, breakOutput) => {
      const { root, base, head, out, realWord } = written();
      breakOutput(out, realWord);
      expect(exportTree(root, ["--verify-history", base, head, out])).toEqual(MISMATCH);
    }, TIMEOUT);

    it("作り物の値を名前に含む layers/ のファイルを消すと、固定の知らせだけを出し、作業のディレクトリを残さない", () => {
      const { root, base, head, out, realWord } = written();
      rmSync(join(out, "layers", "1", "docs", `${realWord}.md`));
      const tmp = tempDir("export-tmp-");
      const result = exportTree(root, ["--verify-history", base, head, out], { tmp });
      expect(result).toEqual(MISMATCH);
      expect(result.output).not.toContain(realWord);
      expect(readdirSync(tmp)).toEqual([]);
    }, TIMEOUT);
  });
});

const SECRET_SCRIPT = join(ROOT, "tools", "checks", "leak-scan-secret.sh");
const EMPTY_SECRET_LINE = "leak-scan-secret: 秘密 LEAK_CHECK_PATTERN が空なので .gitleaks.toml だけで探す";
const countLine = (count: number) => `leak-scan-secret: nd-real-value: ${count} 件`;

/**
 * `leak-scan-secret.sh` を子のプロセスで打ち、標準出力と標準エラーを合わせて返す。
 * 秘密と必須の指定は引数からだけ渡し、テストを打つ人の環境の値を引き継がない
 */
function secretScan(cwd: string, args: string[], { pattern, require }: { pattern?: string; require?: boolean } = {}): RunResult {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== "LEAK_CHECK_PATTERN" && name !== "LEAK_CHECK_REQUIRE_PATTERN"),
  );
  if (pattern !== undefined) env.LEAK_CHECK_PATTERN = pattern;
  if (require === true) env.LEAK_CHECK_REQUIRE_PATTERN = "1";
  const result = spawnSync("bash", [SECRET_SCRIPT, ...args], { cwd, encoding: "utf8", env });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/**
 * 共通のコミットから base と head を分け、base の側で `git merge --no-ff` して 2 つの親のマージコミットを作る。
 * `common` は共通のコミットのファイル、`base` と `head` はそれぞれの枝で置き換えるファイル
 */
function mergeRepo(
  base: Record<string, string>,
  head: Record<string, string>,
  common: Record<string, string> = {},
): { root: string; baseSha: string; headSha: string; mergeSha: string } {
  const { root } = makeRepo(common, "common");
  git(root, "checkout", "-q", "-b", "head");
  for (const [path, body] of Object.entries(head)) write(root, path, body);
  const headSha = commitAll(root, "head");
  git(root, "checkout", "-q", "main");
  for (const [path, body] of Object.entries(base)) write(root, path, body);
  const baseSha = commitAll(root, "base");
  git(root, "merge", "-q", "--no-ff", "-m", "merge", "head");
  const mergeSha = git(root, "rev-parse", "HEAD");
  return { root, baseSha, headSha, mergeSha };
}

/** コミットの木を取り出した出力先 */
function exportedTree(root: string, commit: string): string {
  const out = join(tempDir("secret-tree-"), "tree");
  expect(exportTree(root, [commit, out]).status).toBe(0);
  return out;
}

/** 範囲の履歴を取り出した出力先 */
function exportedHistory(root: string, base: string, head: string): string {
  const out = join(tempDir("secret-history-"), "history");
  expect(exportTree(root, ["--history", base, head, out]).status).toBe(0);
  return out;
}

describe("秘密を使う探し（leak-scan-secret.sh）", () => {
  it("途中のコミットで足して後で消した値を git --range が当て、件数の行を出し、正規表現と値を出さない", () => {
    const realWord = fakeWord();
    const { root, head: base } = makeRepo({ "docs/a.md": "はじめ\n" }, "base");
    write(root, "docs/a.md", `はじめ\n名前 ${realWord}\n`);
    commitAll(root, "add");
    write(root, "docs/a.md", "はじめ\n");
    commitAll(root, "remove");
    const result = secretScan(root, ["git", "--range", `${base}..HEAD`], { pattern: realWord, require: true });
    expect(result.status).toBe(1);
    expect(result.output).toContain("leak-scan: 当たり nd-real-value file-1:2");
    expect(result.output).toContain(countLine(1));
    expect(result.output).not.toContain(realWord);
  }, TIMEOUT);

  it("分岐点より前から在るファイルの、範囲で変えていない行の値を dir <木> が当てる", () => {
    const realWord = fakeWord();
    const { root } = makeRepo({ "docs/old.md": `名前 ${realWord}\n` }, "base");
    write(root, "docs/new.md", "足した\n");
    commitAll(root, "add");
    const result = secretScan(tempDir("secret-cwd-"), ["dir", root], { pattern: realWord });
    expect(result.status).toBe(1);
    expect(result.output).toContain(countLine(1));
    expect(result.output).not.toContain(realWord);
  }, TIMEOUT);

  it("当たりが 0 件なら 0 で終え、0 件の行を出す。木を省くと今のディレクトリを探す", () => {
    const root = makeTree({ "docs/a.md": "中身\n" });
    expect(secretScan(root, ["dir"], { pattern: fakeWord() })).toEqual({ status: 0, output: `${countLine(0)}\n` });
  }, TIMEOUT);

  it("既定の規則だけに当たる値で 1 回目が 1 を返しても、2 回目も打ち、件数の行を出す", () => {
    const root = makeTree({ "docs/token.md": `token ${fakeToken()}\n`, "docs/a.md": `名前 ${fakeWord()}\n` });
    const realWord = fakeWord();
    write(root, "docs/b.md", `名前 ${realWord}\n`);
    const result = secretScan(root, ["dir"], { pattern: realWord });
    expect(result.status).toBe(1);
    expect(result.output).toContain("leak-scan: 当たり github-pat");
    expect(result.output).toContain("leak-scan: 当たり nd-real-value");
    expect(result.output).toContain(countLine(1));
  }, TIMEOUT);

  it("範囲を読めないと 0 以外で終える", () => {
    const { root } = makeRepo({ "docs/a.md": "中身\n" }, "base");
    const result = secretScan(root, ["git", "--range", `${"0".repeat(40)}..HEAD`], { pattern: fakeWord() });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("leak-scan-secret: nd-real-value の件数を読めない");
  }, TIMEOUT);

  it.each([
    ["知らない対象", ["tree"]],
    ["git に木", ["git", "."]],
    ["history で木を省く", ["history"]],
    ["dir に --range", ["dir", ".", "--range", "a..b"]],
    ["history に --range", ["history", ".", "--range", "a..b"]],
    ["--count-only と --details", ["dir", ".", "--count-only", "--details"]],
    ["知らない引数", ["dir", ".", "--paths"]],
  ])("引数の誤り（%s）で 2", (_label, args) => {
    const root = makeTree({ "a.md": "中身\n" });
    const result = secretScan(root, args, { pattern: fakeWord() });
    expect(result.status).toBe(2);
    expect(result.output).toContain("leak-scan-secret: 使い方");
  });

  it("無い木はパスを出さずに 2", () => {
    const realWord = fakeWord();
    const root = makeTree({});
    const result = secretScan(root, ["dir", join(root, realWord)], { pattern: fakeWord() });
    expect(result).toEqual({ status: 2, output: "leak-scan-secret: 探す木のディレクトリが無い\n" });
  });

  it("秘密が空で必須でなければ、空のときの行を出して .gitleaks.toml だけで探し、件数の行を出さない", () => {
    const root = makeTree({ "docs/a.md": "中身\n" });
    expect(secretScan(root, ["dir"])).toEqual({ status: 0, output: `${EMPTY_SECRET_LINE}\n` });
    expect(secretScan(root, ["dir", "--count-only"])).toEqual({ status: 0, output: `${EMPTY_SECRET_LINE}\n` });
  }, TIMEOUT);

  it("秘密が空で必須なら探さずに 1", () => {
    const root = makeTree({ "docs/a.md": `アカウント ${fakeAccount()}\n` });
    expect(secretScan(root, ["dir"], { require: true })).toEqual({
      status: 1,
      output: "leak-scan-secret: 秘密 LEAK_CHECK_PATTERN が無い（必須にしている）\n",
    });
  });

  it.each([
    ["'''", (word: string) => `${word}'''`],
    ["改行", (word: string) => `${word}\n${word}`],
  ])("%s を含む秘密で 1 になり、秘密の値を出さない", (_label, make) => {
    const realWord = fakeWord();
    const root = makeTree({ "docs/a.md": "中身\n" });
    const result = secretScan(root, ["dir"], { pattern: make(realWord) });
    expect(result).toEqual({ status: 1, output: "leak-scan-secret: 秘密 LEAK_CHECK_PATTERN に ''' と改行を含めない\n" });
  });

  it("--count-only では、nd-real-value の当たりは件数だけを出し、既定の規則の当たりは今の形で出す", () => {
    const realWord = fakeWord();
    const { root, head } = makeRepo({ "docs/token.md": `token ${fakeToken()}\n`, [`docs/${realWord}.md`]: `名前 ${realWord}\n` }, "first");
    // dir は取り出した木を探す（.gitleaks.toml は既定の全体の許可を読まないので、作り物のリポジトリの .git/ の索引も探す）
    for (const args of [["dir", exportedTree(root, head), "--count-only"], ["git", "--count-only"]]) {
      const result = secretScan(root, args, { pattern: realWord, require: true });
      expect(result.status).toBe(1);
      expect(result.output).toContain("leak-scan: 当たり github-pat file-1:1");
      expect(result.output).not.toContain("nd-real-value file-");
      expect(result.output).toContain(countLine(1));
      expect(result.output).not.toContain(realWord);
    }
  }, TIMEOUT);

  it("探す木の中の .gitleaks.toml を読まず、チェックアウトの設定で探す", () => {
    // 探す木の .gitleaks.toml は規則を 1 つも持たない。読まれれば nd-factory の規則の当たりが消える
    const root = makeTree({ ".gitleaks.toml": 'title = "empty"\n', "docs/a.md": `アカウント ${fakeAccount()}\n` });
    const result = secretScan(root, ["dir"], { pattern: fakeWord() });
    expect(result.status).toBe(1);
    expect(result.output).toContain("leak-scan: 当たり nd-aws-account-id file-");
  }, TIMEOUT);

  it("木の根に .gitleaksignore があると 2 で、件数を読めない行を出す", () => {
    const root = makeTree({ "docs/a.md": "中身\n", ".gitleaksignore": "x\n" });
    const result = secretScan(root, ["dir"], { pattern: fakeWord() });
    expect(result.status).toBe(2);
    expect(result.output).toContain("leak-scan-secret: nd-real-value の件数を読めない");
  }, TIMEOUT);

  it("当たり 2 件で 2 件の行を出す", () => {
    const realWord = fakeWord();
    const root = makeTree({ "docs/a.md": `名前 ${realWord}\n`, "docs/b.md": `名前 ${realWord}\n` });
    const result = secretScan(root, ["dir", "--count-only"], { pattern: realWord });
    expect(result.status).toBe(1);
    expect(result.output).toContain(countLine(2));
  }, TIMEOUT);

  it("--details では実際のファイルの名前を出し、無ければ file-<番号> に替える", () => {
    const realWord = fakeWord();
    const root = makeTree({ [`docs/${realWord}.md`]: "中身 nd-detail-marker\n" });
    const pattern = "nd-detail-marker";
    expect(secretScan(root, ["dir", "--details"], { pattern }).output).toContain(`docs/${realWord}.md`);
    const hidden = secretScan(root, ["dir"], { pattern });
    expect(hidden.status).toBe(1);
    expect(hidden.output).toContain("leak-scan: 当たり nd-real-value file-1:1");
    expect(hidden.output).not.toContain(realWord);
  }, TIMEOUT);

  describe("--count-only の出力が当たった場所によって変わらない", () => {
    // 既定の規則に当たる行を 1 つ置き、その行と、別のファイルの行に当たる作り物の正規表現で探す
    const repo = () => {
      const marks = { same: fakeWord(), other: fakeWord(), second: fakeWord() };
      const { root, head } = makeRepo(
        {
          "docs/token.md": `token ${fakeToken()} ${marks.same}\n`,
          "docs/other.md": `名前 ${marks.other}\n名前 ${marks.second}\n`,
        },
        "first",
      );
      return { root, head, marks };
    };
    // dir は取り出した木を探す（作り物のリポジトリの .git/ を探さない）
    const argsOf = (mode: "dir" | "git", root: string, head: string) =>
      mode === "dir" ? ["dir", exportedTree(root, head), "--count-only"] : ["git", "--count-only"];

    for (const mode of ["dir", "git"] as const) {
      it(`${mode} で、同じ行に当たる正規表現と別のファイルに当たる正規表現の出力が同じで、当たらなければ件数の行だけが違う`, () => {
        const { root, head, marks } = repo();
        const args = argsOf(mode, root, head);
        const a = secretScan(root, args, { pattern: marks.same });
        const b = secretScan(root, args, { pattern: marks.other });
        const c = secretScan(root, args, { pattern: fakeWord() });
        expect(a.status).toBe(1);
        expect(a).toEqual(b);
        expect(c.status).toBe(1);
        expect(c.output.replace(countLine(0), countLine(1))).toBe(a.output);
        expect(c.output).not.toBe(a.output);
      }, TIMEOUT);

      it(`${mode} で、2 件が同じ行に在っても別のファイルに在っても出力が同じ`, () => {
        const { root, head, marks } = repo();
        const args = argsOf(mode, root, head);
        const sameLine = secretScan(root, args, { pattern: `${marks.same}|ghp_` });
        const otherFile = secretScan(root, args, { pattern: `${marks.other}|${marks.second}` });
        expect(sameLine.output).toContain(countLine(2));
        expect(sameLine).toEqual(otherFile);
      }, TIMEOUT);
    }
  });
});

describe("取り出した木と履歴の探し（export-tree.sh と leak-scan-secret.sh）", () => {
  it("base と head を合わせた後の木でだけ当たる値が、マージコミットの木の探しで当たる", () => {
    const first = fakeWord();
    const second = fakeWord();
    const pattern = `(?s)${first}.{0,40}${second}`;
    const common = { "docs/a.md": "一\n二\n三\n四\n五\n" };
    const { root, baseSha, headSha, mergeSha } = mergeRepo(
      { "docs/a.md": `${first}\n二\n三\n四\n五\n` },
      { "docs/a.md": `一\n二\n${second}\n四\n五\n` },
      common,
    );
    expect(git(root, "rev-list", "--parents", "-n", "1", mergeSha).split(" ")).toEqual([mergeSha, baseSha, headSha]);
    expect(secretScan(root, ["dir", exportedTree(root, baseSha)], { pattern }).output).toContain(countLine(0));
    expect(secretScan(root, ["dir", exportedTree(root, headSha)], { pattern }).output).toContain(countLine(0));
    const merged = secretScan(root, ["dir", exportedTree(root, mergeSha)], { pattern });
    expect(merged.status).toBe(1);
    expect(merged.output).toContain(countLine(1));
  }, TIMEOUT);

  it("途中のコミットで足して後で消した、作り物の値を名前に含むファイルとディレクトリのパスが history で当たる", () => {
    const realWord = fakeWord();
    const { root, base } = forkRepo();
    write(root, `docs/${realWord}.md`, "中身\n");
    write(root, `${realWord}-dir/a.md`, "中身\n");
    commitAll(root, "add");
    rmSync(join(root, "docs"), { recursive: true });
    rmSync(join(root, `${realWord}-dir`), { recursive: true });
    write(root, "keep.md", "残す\n");
    const head = commitAll(root, "remove");
    const out = exportedHistory(root, base, head);
    expect(secretScan(root, ["dir", exportedTree(root, head)], { pattern: realWord }).status).toBe(0);
    const result = secretScan(root, ["history", out], { pattern: realWord });
    expect(result.status).toBe(1);
    expect(result.output).toContain("leak-scan-secret: 履歴 paths を探す");
    expect(result.output).toContain("leak-scan-secret: 履歴 layers/1 を探す");
    expect(result.output).toContain(countLine(4));
    expect(result.output).not.toContain(realWord);
  }, TIMEOUT);

  it("途中のコミットで足して後で消した、NUL を含み作り物の値を中に持つファイルが binary-text で当たる", () => {
    const realWord = fakeWord();
    const { root, base } = forkRepo();
    writeFileSync(join(root, "bin.dat"), binaryWith(realWord));
    commitAll(root, "add");
    rmSync(join(root, "bin.dat"));
    const head = commitAll(root, "remove");
    const out = exportedHistory(root, base, head);
    expect(secretScan(root, ["git", "--range", `${base}..${head}`], { pattern: realWord }).output).toContain(countLine(0));
    const result = secretScan(root, ["history", out], { pattern: realWord, require: true });
    expect(result.status).toBe(1);
    // layers/ の元のファイル（gitleaks がそのまま読める分）と binary-text/ の両方で当たる
    expect(result.output).toContain("leak-scan-secret: 履歴 binary-text/1 を探す\nleak-scan: 当たり nd-real-value file-1:");
    expect(result.output).toContain(countLine(2));
  }, TIMEOUT);

  it("既定の規則がファイルの名前だけで当てるファイルを途中で足して消すと、history で当たる", () => {
    const { root, base } = forkRepo();
    write(root, "keys/client.p12", "中身\n");
    commitAll(root, "add");
    rmSync(join(root, "keys"), { recursive: true });
    const head = commitAll(root, "remove");
    const result = secretScan(root, ["history", exportedHistory(root, base, head), "--details"], { pattern: fakeWord() });
    expect(result.status).toBe(1);
    expect(result.output).toContain("keys/client.p12");
  }, TIMEOUT);

  it("既定の全体の許可がパスで外すファイルの値は当てず、同じ中身を外さないパスに置けばそちらだけ当たる", () => {
    const token = `token ${fakeToken()}\n`;
    const { root, base } = forkRepo();
    write(root, "img/logo.png", token);
    commitAll(root, "png");
    const pngOnly = commitAll(root, "noop");
    expect(secretScan(root, ["history", exportedHistory(root, base, pngOnly)], { pattern: fakeWord() }).status).toBe(0);
    write(root, "docs/a.md", token);
    commitAll(root, "md");
    rmSync(join(root, "img"), { recursive: true });
    rmSync(join(root, "docs"), { recursive: true });
    const head = commitAll(root, "remove");
    const result = secretScan(root, ["history", exportedHistory(root, base, head), "--details"], { pattern: fakeWord() });
    expect(result.status).toBe(1);
    expect(result.output).toContain("leak-scan: 当たり github-pat docs/a.md:1");
    expect(result.output).not.toContain("logo.png:");
  }, TIMEOUT);

  it("history に export-tree.sh の範囲が空の出力先を渡すと、引数の誤りにならずに 0", () => {
    const { root, base } = forkRepo();
    const result = secretScan(root, ["history", exportedHistory(root, base, base)], { pattern: fakeWord() });
    expect(result).toEqual({ status: 0, output: `leak-scan-secret: 履歴 paths を探す\n${countLine(0)}\n` });
  }, TIMEOUT);
});
