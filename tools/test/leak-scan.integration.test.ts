import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
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
        "置き場 arn:aws:s3:::<bucket> と arn:aws:s3:::${AssetsBucket} と arn:aws:s3:::amzn-s3-demo-bucket",
        `端点 https://amzn-s3-demo-bucket.${"s3.us-west-2.amazonaws.com"} と amzn-s3-demo-bucket.${"s3.amazonaws.com"}`,
        "端点 https://<api-id>.execute-api.<region>.amazonaws.com と https://${ApiId}.execute-api.${AWS::Region}.amazonaws.com",
        "端点 https://acme-cognito-login.auth.us-west-2.amazoncognito.com と https://EXAMPLE1234.cloudfront.net",
        "端点 https://<prefix>-<environment>-login.auth.<リージョン>.amazoncognito.com",
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

/** PATH から実行ファイルを引く（偽の実行ファイルを PATH の先頭に置く前の本物） */
function which(name: string): string {
  const found = spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" });
  if (found.status !== 0) throw new Error(`${name} が PATH に無い`);
  return found.stdout.trim();
}

/** 偽の実行ファイル `name` を置いた PATH を返す。`extra` は隣に置くファイル（名前と中身） */
function fakePath(name: string, body: string[], extra: Record<string, string> = {}): string {
  const bin = tempDir("leak-fake-bin-");
  writeFileSync(join(bin, name), `${body.join("\n")}\n`, { mode: 0o755 });
  for (const [file, content] of Object.entries(extra)) writeFileSync(join(bin, file), content);
  return `${bin}:${process.env.PATH ?? ""}`;
}

/** gitleaks の隣の既定の設定のファイル（偽の gitleaks を置くときは隣に写す） */
const defaultConfigBeside = () => ({ "gitleaks.default.toml": readFileSync(join(dirname(which("gitleaks")), "gitleaks.default.toml"), "utf8") });

/**
 * 本物の gitleaks を打ち、`after`（bash の行）で報告か記録を加工して、本物の終了コードで終える偽の gitleaks を置いた PATH を返す。
 * `after` では、`$report`（報告のパス）・`$sub`（dir か git）・`$source`・`$tag`（報告の番号。1 回目か 2 回目か）・`$status` を使える
 */
function wrappedGitleaksPath(after: string[]): string {
  return fakePath(
    "gitleaks",
    [
      "#!/usr/bin/env bash",
      'sub="$1"; source="$2"; report=""; args=("$@")',
      'while (($# > 0)); do if [[ "$1" == --report-path ]]; then report="$2"; shift 2; else shift; fi; done',
      'tag="${report##*report-}"; tag="${tag%.json}"',
      "status=0",
      `"${which("gitleaks")}" "\${args[@]}" || status=$?`,
      ...after,
      'exit "$status"',
    ],
    defaultConfigBeside(),
  );
}

/**
 * 診断にファイルの名前を載せる偽の gitleaks を置いた PATH を返す（v8.30.1 の dir は読めないファイルの診断などに名前を載せる。
 * 実物で起こす条件は実行の環境に依るので、出力の扱いだけを偽の実行ファイルで確かめる）。本物を打った後に診断の行を足す
 */
function fakeGitleaksPath(diagnostic: string, stderrLine = `4:08PM INF stderr ${diagnostic}`, trailingLines = 0): string {
  return wrappedGitleaksPath([
    `echo "stdout ${diagnostic}"`,
    `printf '%s\\n' '${stderrLine}' >&2`,
    `for ((i = 0; i < ${trailingLines}; i++)); do echo "filler line $i of the scan log, no level word here" >&2; done`,
  ]);
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
      expect(shown.output).toContain(`INF stderr docs/${realWord}.md`);
    }, TIMEOUT);
  }
});

/** gitleaks v8.30.1 が読めない対象を飛ばすときの標準エラーの 1 行（色の制御の列を含む実物の形） */
function skipLine(path: string): string {
  const esc = "\u001b";
  return `${esc}[90m4:08PM${esc}[0m ${esc}[33mWRN${esc}[0m ${esc}[1mskipping file: permission denied${esc}[0m ${esc}[36mpath=${esc}[0m${path}`;
}

/** gitleaks v8.30.1 が当たりのあるときに標準エラーへ出す件数の 1 行（色の制御の列を含む実物の形） */
function gitleaksCountLine(count: number): string {
  const esc = "\u001b";
  return `${esc}[90m4:08PM${esc}[0m ${esc}[31mWRN${esc}[0m ${esc}[1mleaks found: ${count}${esc}[0m`;
}

const SKIP_MESSAGE = "leak-scan: gitleaks が警告か誤りを出した";
const UNSEARCHED_MESSAGE = "leak-scan: gitleaks が中身を読まずに飛ばしたファイルを探せなかった";
const HISTORY_MESSAGE = "leak-scan: 履歴を最後まで探し終えたことを確かめられなかった";

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

  it("gitleaks が当たりで出す WRN の件数の行（時刻 WRN leaks found: <件数>）だけなら、警告か誤りと見なさない", () => {
    const { root } = makeRepo({ "a.md": "中身\n" }, "first");
    const env = { ...process.env, PATH: fakeGitleaksPath("中身", gitleaksCountLine(2)) };
    const result = scan(root, ["dir", ND_CONFIG], { paths: false, env });
    expect(result.status).toBe(0);
    expect(result.output).not.toContain(SKIP_MESSAGE);
  }, TIMEOUT);

  it("飛ばした対象の警告の末尾がたまたま件数の行と同じ文言でも、当たり無しとして通さない", () => {
    const realWord = fakeWord();
    const { root } = makeRepo({ "a.md": "中身\n" }, "first");
    // 色を外すと「4:08PM WRN skipping file: ... path=docs/<語> WRN leaks found: 2」になり、末尾が件数の行と同じになる
    const env = { ...process.env, PATH: fakeGitleaksPath("中身", skipLine(`docs/${realWord} WRN leaks found: 2`)) };
    const result = scan(root, ["dir", ND_CONFIG], { paths: false, env });
    expect(result.status).toBe(1);
    expect(result.output).toContain(SKIP_MESSAGE);
    expect(result.output).not.toContain(realWord);
  }, TIMEOUT);

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

/** `--paths` を渡さないときに、gitleaks の生の出力を伏せたことを知らせる固定の 1 行 */
const HIDDEN_NOTE = "leak-scan: gitleaks の出力はファイルの名前を含み得るので伏せた。手元で同じ引数に --paths を足して打つと出る";
/** `--paths` を渡さないときに、当たりのファイルの名前を伏せたことを知らせる固定の 1 行 */
const NAMES_NOTE = "leak-scan: ファイルの名前は伏せた。手元で同じ引数に --paths を足して打つと出る";

/**
 * 標準エラーへ `stderrLine` を出し、報告に `report` を書き（`null` なら書かない）、`exitCode` で終える偽の gitleaks を置いた PATH を返す
 */
function fakeGitleaksReportPath(stderrLine: string, report: string | null, exitCode: number): string {
  return fakePath("gitleaks", [
    "#!/usr/bin/env bash",
    'report=""',
    'while (($# > 0)); do if [[ "$1" == --report-path ]]; then report="$2"; shift 2; else shift; fi; done',
    `printf '%s\\n' '${stderrLine}' >&2`,
    ...(report === null ? [] : [`printf '%s' '${report}' >"$report"`]),
    `exit ${exitCode}`,
  ]);
}

/** スクリプトを打ち、終了コードと、標準出力・標準エラーそれぞれの `leak-scan:` で始まる行を返す */
function scanLines(cwd: string, args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string[]; stderr: string[] } {
  const result = spawnSync("bash", [SCRIPT, ...args], { cwd, encoding: "utf8", env });
  const lines = (text: string) => text.split("\n").filter((line) => line.startsWith("leak-scan:"));
  return { status: result.status, stdout: lines(result.stdout), stderr: lines(result.stderr) };
}

describe("生の出力を伏せた知らせ", () => {
  for (const mode of ["dir", "git"] as const) {
    it(`${mode} の探しで報告を読めなければ、--paths を渡さないときだけ、読めない行の直後に伏せた知らせを 1 行出して 1 で終える`, () => {
      const realWord = fakeWord();
      const { root } = makeRepo({ "a.md": "中身\n" }, "first");
      const env = { ...process.env, PATH: fakeGitleaksReportPath(`stderr docs/${realWord}.md`, null, 3) };
      const hidden = scanLines(root, [mode, ND_CONFIG], env);
      expect(hidden.status).toBe(1);
      expect(hidden.stdout).toEqual([]);
      const history = mode === "git" ? [HISTORY_MESSAGE] : [];
      expect(hidden.stderr).toEqual([
        "leak-scan: gitleaks の報告を読めない（終了コード 3）",
        HIDDEN_NOTE,
        ...history,
        ...(mode === "git" ? [NAMES_NOTE] : []),
      ]);
      const shown = scanLines(root, [mode, ND_CONFIG, "--paths"], env);
      expect(shown.status).toBe(1);
      expect(shown.stderr).toEqual(["leak-scan: gitleaks の報告を読めない（終了コード 3）", ...history]);
    }, TIMEOUT);
  }

  it("報告が配列でなくても、--paths を渡さなければ読めない行の直後に伏せた知らせを出す", () => {
    const { root } = makeRepo({ "a.md": "中身\n" }, "first");
    const env = { ...process.env, PATH: fakeGitleaksReportPath("stderr 中身", "{}", 0) };
    const result = scanLines(root, ["dir", ND_CONFIG], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toEqual(["leak-scan: gitleaks の報告を読めない（終了コード 0）", HIDDEN_NOTE]);
  }, TIMEOUT);

  it("警告か誤りが出れば、--paths を渡さないときだけ、警告か誤りの行の直後に伏せた知らせを 1 行出して 1 で終える", () => {
    const realWord = fakeWord();
    const { root } = makeRepo({ "a.md": "中身\n" }, "first");
    const env = { ...process.env, PATH: fakeGitleaksReportPath(skipLine(`docs/${realWord}.md`), "[]", 0) };
    const hidden = scanLines(root, ["dir", ND_CONFIG], env);
    expect(hidden.status).toBe(1);
    expect(hidden.stdout).toEqual([]);
    expect(hidden.stderr).toEqual([`${SKIP_MESSAGE}。読めずに飛ばした対象があり得るので、当たり無しとして通さない`, HIDDEN_NOTE]);
    const shown = scanLines(root, ["dir", ND_CONFIG, "--paths"], env);
    expect(shown.status).toBe(1);
    expect(shown.stderr).toEqual([`${SKIP_MESSAGE}。読めずに飛ばした対象があり得るので、当たり無しとして通さない`]);
  }, TIMEOUT);

  it("警告か誤りと当たりが同時なら、--paths を渡さないとき、警告か誤りの行・伏せた知らせ・件数の行・名前を伏せた知らせの順に出す", () => {
    const realWord = fakeWord();
    const { root } = makeRepo({ "a.md": "中身\n" }, "first");
    const report = JSON.stringify([
      { RuleID: "nd-aws-account-id", File: `docs/${realWord}.md`, StartLine: 2, EndLine: 2, Commit: "", Match: "x", Secret: "y" },
    ]);
    const env = { ...process.env, PATH: fakeGitleaksReportPath(skipLine(`docs/${realWord}.md`), report, 1) };
    const hidden = scanLines(root, ["dir", ND_CONFIG], env);
    expect(hidden.status).toBe(1);
    expect(hidden.stdout).toEqual(["leak-scan: 当たり nd-aws-account-id file-1:2"]);
    expect(hidden.stderr).toEqual([
      `${SKIP_MESSAGE}。読めずに飛ばした対象があり得るので、当たり無しとして通さない`,
      HIDDEN_NOTE,
      "leak-scan: 当たり 1 件",
      NAMES_NOTE,
    ]);
    const shown = scanLines(root, ["dir", ND_CONFIG, "--paths"], env);
    expect(shown.status).toBe(1);
    expect(shown.stdout).toEqual([`leak-scan: 当たり nd-aws-account-id docs/${realWord}.md:2`]);
    expect(shown.stderr).toEqual([`${SKIP_MESSAGE}。読めずに飛ばした対象があり得るので、当たり無しとして通さない`, "leak-scan: 当たり 1 件"]);
  }, TIMEOUT);

  it("報告を読めて警告か誤りが無ければ、--paths を渡さなくても伏せた知らせを出さない", () => {
    const { root } = makeRepo({ "a.md": "中身\n" }, "first");
    const env = { ...process.env, PATH: fakeGitleaksReportPath("stderr 中身", "[]", 0) };
    const result = scanLines(root, ["dir", ND_CONFIG], env);
    expect(result.status).toBe(0);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([]);
  }, TIMEOUT);
});

const EXPORT_SCRIPT = join(ROOT, "tools", "checks", "export-tree.sh");

type RunResult = { status: number | null; output: string };

/**
 * `export-tree.sh` を子のプロセスで打ち、標準出力と標準エラーを合わせて返す。
 * 引数は木の取り出し・履歴の取り出し・照らすだけの 2 つ（`--verify`・`--verify-history`）のどれか。
 * `tmp` を渡せば、スクリプトの作業のディレクトリをそこに作らせる（残らないことを確かめるため）。
 * `umask` を渡せば、その umask で打つ（書いたファイルの権限が umask によらないことを確かめるため）
 */
function exportTree(cwd: string, args: string[], { tmp, umask }: { tmp?: string; umask?: string } = {}): RunResult {
  const command = umask === undefined ? [EXPORT_SCRIPT, ...args] : ["-c", `umask ${umask} && exec bash "$0" "$@"`, EXPORT_SCRIPT, ...args];
  const result = spawnSync("bash", command, {
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

/** `input` を `git mktree` に渡して木を作り、その名前を返す（失敗なら投げる） */
function mktree(root: string, input: string, ...options: string[]): string {
  const tree = spawnSync("git", ["mktree", ...options], { cwd: root, input, encoding: "utf8" });
  if (tree.status !== 0) throw new Error("git mktree が失敗した");
  return tree.stdout.trim();
}

/** `git mktree` で 1 つの項目を持つ木を作り、`dir` の下に置いたコミットを作る（git の作業ツリーでは作れないパスのため） */
function commitCraftedTree(root: string, dir: string, name: string, parent?: string): string {
  const blob = git(root, "hash-object", "-w", "--stdin");
  const inner = mktree(root, `100644 blob ${blob}\t${name}\n`);
  const outer = mktree(root, `040000 tree ${inner}\t${dir}\n`);
  return git(root, "commit-tree", outer, ...(parent === undefined ? [] : ["-p", parent]), "-m", "crafted");
}

/** 倉庫に無い blob の名前（`git cat-file blob` が失敗する） */
function missingBlob(): string {
  return hex(40);
}

/**
 * `git mktree --missing` で根に `entries`（名前と blob）だけを置いた木を作り、コミットにする。
 * 倉庫に無い blob も置ける（blob を書く手順の失敗を起こすため）
 */
function commitFlatTree(root: string, entries: [name: string, blob: string, mode?: string][], parent?: string): string {
  const input = entries.map(([name, blob, mode = "100644"]) => `${mode} blob ${blob}\t${name}\n`).join("");
  const tree = mktree(root, input, "--missing");
  return git(root, "commit-tree", tree, ...(parent === undefined ? [] : ["-p", parent]), "-m", "flat");
}

/** 中身を blob として倉庫に書き、名前を返す */
function storeBlob(root: string, body: string): string {
  const result = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: body, encoding: "utf8" });
  if (result.status !== 0) throw new Error("git hash-object が失敗した");
  return result.stdout.trim();
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

  it("実行できるファイル（100755）も、深い階層のファイルも、中身のまま umask によらず 0644 の普通のファイルとして書く", () => {
    const { root } = makeRepo({ "run.sh": "#!/bin/sh\necho 一\n", "a/b/c/d.md": "深い\n" }, "first");
    chmodSync(join(root, "run.sh"), 0o755);
    const head = commitAll(root, "exec");
    expect(git(root, "ls-tree", head, "run.sh")).toContain("100755 blob");
    const out = join(tempDir("export-out-"), "tree");
    expect(exportTree(root, [head, out], { umask: "077" })).toEqual({ status: 0, output: "" });
    expect(listOutput(out)).toEqual({ files: ["a/b/c/d.md", "run.sh"], others: 0 });
    expect(readFileSync(join(out, "run.sh"), "utf8")).toBe("#!/bin/sh\necho 一\n");
    expect(readFileSync(join(out, "a", "b", "c", "d.md"), "utf8")).toBe("深い\n");
    for (const file of ["run.sh", "a/b/c/d.md"]) expect(lstatSync(join(out, file)).mode & 0o777).toBe(0o644);
  }, TIMEOUT);

  it("倉庫に無い blob の項目で、その項目の番号を示す「木を書き出せない」の 1 になり、診断と作業のディレクトリを残さない", () => {
    const realWord = fakeWord();
    const { root } = makeRepo({ "a.md": "中身\n" }, "first");
    const commit = commitFlatTree(root, [
      ["a.md", storeBlob(root, "中身\n")],
      [`${realWord}.md`, missingBlob()],
      ["z.md", storeBlob(root, "後\n")],
    ]);
    const tmp = tempDir("export-tmp-");
    const result = exportTree(root, [commit, join(tempDir("export-out-"), "tree")], { tmp });
    expect(result).toEqual({ status: 1, output: "export-tree: 木を書き出せない（2 番目）\n" });
    expect(readdirSync(tmp)).toEqual([]);
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

  it("実行できるファイル（100755）と深い階層のファイルを、層に中身のまま umask によらず 0644 の普通のファイルとして書く", () => {
    const { root, base } = forkRepo();
    write(root, "run.sh", "#!/bin/sh\necho 一\n");
    chmodSync(join(root, "run.sh"), 0o755);
    write(root, "a/b/c/d.md", "深い\n");
    const head = commitAll(root, "exec");
    expect(git(root, "ls-tree", head, "run.sh")).toContain("100755 blob");
    const out = join(tempDir("history-out-"), "history");
    expect(exportTree(root, ["--history", base, head, out], { umask: "077" })).toEqual({ status: 0, output: "" });
    expect(listOutput(join(out, "layers")).files).toEqual(["1/a/b/c/d.md", "1/run.sh"]);
    expect(readFileSync(join(out, "layers", "1", "run.sh"), "utf8")).toBe("#!/bin/sh\necho 一\n");
    expect(readFileSync(join(out, "layers", "1", "a", "b", "c", "d.md"), "utf8")).toBe("深い\n");
    for (const file of ["run.sh", "a/b/c/d.md"]) expect(lstatSync(join(out, "layers", "1", file)).mode & 0o777).toBe(0o644);
  }, TIMEOUT);

  it("倉庫に無い blob の組で、パスの番号でなく組の番号を示す「履歴の項目を書き出せない」の 1 になり、診断と作業のディレクトリを残さない", () => {
    const { root, base } = forkRepo();
    const missing = missingBlob();
    // 古いコミット: m.md（倉庫に無い blob）と x.md を足す。新しいコミット: ok.md を足し、x.md を消す。
    // 新しい順に読むので、パスは ok.md・x.md（消した）・m.md・x.md、組は ok.md・m.md・x.md の順になり、m.md は組の 2 番目
    const first = commitFlatTree(root, [["m.md", missing], ["x.md", storeBlob(root, "消す\n")]], base);
    const head = commitFlatTree(root, [["m.md", missing], ["ok.md", storeBlob(root, "足す\n")]], first);
    const tmp = tempDir("export-tmp-");
    const result = exportTree(root, ["--history", base, head, join(tempDir("history-out-"), "history")], { tmp });
    expect(result).toEqual({ status: 1, output: "export-tree: 履歴の項目を書き出せない（2 番目）\n" });
    expect(readdirSync(tmp)).toEqual([]);
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
function secretScan(
  cwd: string,
  args: string[],
  { pattern, require, path }: { pattern?: string; require?: boolean; path?: string } = {},
): RunResult {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== "LEAK_CHECK_PATTERN" && name !== "LEAK_CHECK_REQUIRE_PATTERN"),
  );
  if (path !== undefined) env.PATH = path;
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

  describe("--count-only で、nd-real-value の探しの失敗を件数とは別の行で出す", () => {
    const FAILED_LINE = "leak-scan-secret: nd-real-value の探しが失敗した";
    /**
     * nd-real-value だけの設定で打たれたときだけ、当たり 1 件を報告に書いて 1 で終える偽の gitleaks。
     * warn が真なら、そのときに読めない対象を飛ばした警告も出す。ほかの設定では当たり無しで 0 で終える
     */
    const fakePath = (warn: boolean, realWord: string) => {
      const bin = tempDir("secret-fake-bin-");
      const body = [
        "#!/usr/bin/env bash",
        'report=""; config=""',
        'while (($# > 0)); do case "$1" in --report-path) report="$2"; shift 2 ;; --config) config="$2"; shift 2 ;; *) shift ;; esac; done',
        `if grep -qF 'id = "nd-real-value"' "$config" && ! grep -qF '[extend]' "$config"; then`,
        `  ${warn ? `printf '%s\\n' '${skipLine(`docs/${realWord}.md`)}' >&2` : ":"}`,
        `  printf '[{"RuleID":"nd-real-value","File":"docs/a.md","StartLine":1,"EndLine":1,"Commit":""}]' >"$report"`,
        "  exit 1",
        "fi",
        "printf '[]' >\"$report\"",
        "exit 0",
      ].join("\n");
      writeFileSync(join(bin, "gitleaks"), `${body}\n`, { mode: 0o755 });
      return `${bin}:${process.env.PATH ?? ""}`;
    };

    it("当たりと読み飛ばしが同時に起きると、件数の行と失敗の行の両方を出し、飛ばしたファイルの名前を出さない", () => {
      const realWord = fakeWord();
      const root = makeTree({ "docs/a.md": "中身\n" });
      const result = secretScan(root, ["dir", "--count-only"], { pattern: fakeWord(), path: fakePath(true, realWord) });
      expect(result.status).toBe(1);
      expect(result.output).toContain(countLine(1));
      expect(result.output).toContain(FAILED_LINE);
      expect(result.output).not.toContain(realWord);
    }, TIMEOUT);

    it("当たりだけなら、失敗の行を出さない", () => {
      const root = makeTree({ "docs/a.md": "中身\n" });
      const result = secretScan(root, ["dir", "--count-only"], { pattern: fakeWord(), path: fakePath(false, fakeWord()) });
      expect(result.status).toBe(1);
      expect(result.output).toContain(countLine(1));
      expect(result.output).not.toContain(FAILED_LINE);
    }, TIMEOUT);
  });

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
    expect(secretScan(root, ["git", "--range", `${base}..${head}`], { pattern: realWord }).output).toContain(countLine(1));
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

  it("既定の全体の許可がパスで外すファイル（img/logo.png）の値も、名前を変えずに history で当たる", () => {
    const { root, base } = forkRepo();
    write(root, "img/logo.png", `token ${fakeToken()}\n`);
    commitAll(root, "png");
    rmSync(join(root, "img"), { recursive: true });
    const head = commitAll(root, "remove");
    const result = secretScan(root, ["history", exportedHistory(root, base, head), "--details"], { pattern: fakeWord() });
    expect(result.status).toBe(1);
    expect(result.output).toContain("leak-scan: 当たり github-pat img/logo.png:1");
  }, TIMEOUT);

  it("history に export-tree.sh の範囲が空の出力先を渡すと、引数の誤りにならずに 0", () => {
    const { root, base } = forkRepo();
    const result = secretScan(root, ["history", exportedHistory(root, base, base)], { pattern: fakeWord() });
    expect(result).toEqual({ status: 0, output: `leak-scan-secret: 履歴 paths を探す\n${countLine(0)}\n` });
  }, TIMEOUT);
});

// ここから #98: サービスの token、飛ばされるファイル、アーカイブ、読み終えたことの確かめ、絞った許可

const base64url = (length: number) => pick("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_", length);

/** 架空の委任の token（`ndfd_`）か手元のマシンの登録の token（`ndfm_`） */
const serviceToken = (head: "ndfd" | "ndfm") =>
  fake(() => `${head}_usr_${hex(12)}.id_${hex(12)}.${base64url(43)}`, /^ndf[dm]_usr_[0-9a-f]{12}\.id_[0-9a-f]{12}\.[0-9A-Za-z_-]{43}$/);

/** 先頭に NUL を持つバイト列の後ろに本文を置く */
const nul = (text: string) => Buffer.concat([Buffer.from([0, 1, 2, 10]), Buffer.from(text)]);
/** ELF の頭を持つバイト列（gitleaks の dir が中身を読まずに飛ばす）。本文は 2 行目から。種類の判定には 52 バイトより長い頭が要る */
const elf = (text: string) => Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(64), Buffer.from(`\n${text}`)]);
const tokenLine = () => `token ${fakeToken()}\n`;

function writeBytes(root: string, path: string, body: Buffer | string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

function treeOf(files: Record<string, Buffer | string>): string {
  const root = makeTree({});
  for (const [path, body] of Object.entries(files)) writeBytes(root, path, body);
  return root;
}

/** 空のコミットの後に files を足し、次のコミットで消した履歴 */
function addedAndRemoved(files: Record<string, Buffer | string>): { root: string; base: string; added: string } {
  const { root, base } = forkRepo();
  for (const [path, body] of Object.entries(files)) writeBytes(root, path, body);
  git(root, "add", "-A", "-f");
  git(root, "commit", "-q", "-m", "add");
  const added = git(root, "rev-parse", "HEAD");
  for (const path of Object.keys(files)) rmSync(join(root, path));
  commitAll(root, "remove");
  return { root, base, added };
}

/** コミットを 1 つ足す。値が null のファイルは消す */
function step(root: string, files: Record<string, Buffer | string | null>): string {
  for (const [path, body] of Object.entries(files)) {
    if (body === null) rmSync(join(root, path));
    else writeBytes(root, path, body);
  }
  return commitAll(root, "step");
}

const gitScan = (root: string, config: string, base?: string, options?: Parameters<typeof scan>[2]) =>
  scan(root, ["git", config, ...(base === undefined ? [] : ["--range", `${base}..HEAD`])], options);

const hits = (result: ScanResult) => result.findings.map((f) => [f.RuleID, f.File, f.Commit]).sort();
const places = (result: ScanResult) => result.findings.map((f) => [f.RuleID, f.File, f.StartLine]).sort();

/** `[extend] path` で base を読み、extra を足した設定 */
function extendConfig(base: string, extra: string): string {
  const path = join(tempDir("leak-extend-"), "gitleaks.toml");
  writeFileSync(path, `[extend]\npath = "${base}"\n\n${extra}`);
  return path;
}

/** 既定の規則の設定の写しに extra を足した設定（`useDefault` を直に持つ形のまま） */
function defaultWith(extra: string): string {
  const path = join(tempDir("leak-default-"), "gitleaks-default.toml");
  writeFileSync(path, `${readFileSync(DEFAULT_CONFIG, "utf8")}\n${extra}`);
  return path;
}

/** 作業ディレクトリ dir で python3 のコードを打つ（アーカイブを作る） */
function python(dir: string, code: string, input: string): void {
  const result = spawnSync("python3", ["-I", "-c", code], { cwd: dir, input, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

/** 中身を JSON で受けて、形ごとのアーカイブを作るコード */
const MAKE_ARCHIVES = `
import bz2, gzip, io, json, lzma, sys, tarfile, zipfile
spec = json.load(sys.stdin)
secret = spec["secret"].encode()

def zipped(members, method=zipfile.ZIP_DEFLATED):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", method) as z:
        for name, body in members:
            z.writestr(name, body)
    return out.getvalue()

def tarred(members, fmt=tarfile.PAX_FORMAT):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w", format=fmt) as t:
        for name, body in members:
            info = tarfile.TarInfo(name)
            info.size = len(body)
            t.addfile(info, io.BytesIO(body))
    return out.getvalue()

body = secret * 3
inner = zipped([("deep.txt", body)])
prefix = {"sh": b"#!/bin/sh\\nexit 0\\n", "elf": b"\\x7fELF\\x02\\x01\\x01\\x00" + bytes(64)}
files = {}
for kind in spec["kinds"]:
    if kind == "good":
        files["a.zip"] = zipped([("app.env", body), ("a.bin", body), ("lib.so", b"\\x7fELF\\x02\\x01\\x01\\x00\\n" + body)])
        files["conf/app.env.gz"] = gzip.compress(body)
        files["b.tar.gz"] = gzip.compress(tarred([("dir/t.txt", body)]))
        files["nest.zip"] = zipped([("in.zip", inner)])
        files["renamed.dat"] = zipped([("d.txt", body)])
        files["x.bz2"] = bz2.compress(body)
        files["y.xz"] = lzma.compress(body)
        files["sfx-sh.run"] = prefix["sh"] + zipped([("s.txt", body)])
        files["sfx-elf.run"] = prefix["elf"] + zipped([("e.txt", body)])
        v7 = tarred([("old.txt", body)], tarfile.USTAR_FORMAT)
        header = bytearray(v7[:512])
        header[257:265] = bytes(8)
        header[148:156] = b" " * 8
        header[148:156] = ("%06o\\0 " % sum(header)).encode()
        files["v7.tar"] = bytes(header) + v7[512:]
        files["v7.tar.gz"] = gzip.compress(files["v7.tar"])
    elif kind == "clean":
        files["clean.zip"] = zipped([("a.txt", b"hello\\n"), ("empty", b""), ("sub/", b"")])
        out = io.BytesIO()
        with tarfile.open(fileobj=out, mode="w") as t:
            root = tarfile.TarInfo("./")
            root.type = tarfile.DIRTYPE
            t.addfile(root)
        files["clean.tar"] = out.getvalue()
        files["notes.zip"] = b"just text\\n"
        files["notes.br"] = b"just text\\n"
    elif kind.startswith("bad:"):
        name = kind[4:]
        z = zipped([("m.txt", body * 20)])
        if name == "cut.zip": data = z[:len(z) // 2]
        elif name == "cut.gz": data = gzip.compress(body * 20)[:40]
        elif name == "broken.zip":
            data = bytearray(z)
            for i in range(40, 60): data[i] ^= 0xFF
            data = bytes(data)
        elif name == "encrypted.zip":
            data = bytearray(z)
            data[6] |= 1
            data[data.index(b"PK\\x01\\x02") + 8] |= 1
            data = bytes(data)
        elif name == "a.7z": data = b"7z\\xbc\\xaf\\x27\\x1c" + bytes(40)
        elif name in ("method.zip", "method-sfx.run"):
            data = bytearray(z)
            data[8] = 6
            data[data.index(b"PK\\x01\\x02") + 10] = 6
            data = bytes(data)
            if name == "method-sfx.run": data = prefix["sh"] + data[:data.index(b"PK\\x01\\x02")]
        elif name == "sfx-sh-cut.run": data = prefix["sh"] + z[:z.index(b"PK\\x01\\x02")]
        elif name == "sfx-elf-cut.run": data = prefix["elf"] + z[:z.index(b"PK\\x01\\x02")]
        elif name == "sfx-boundary.run": data = b"#" * ((1 << 20) - 10) + z[:z.index(b"PK\\x01\\x02")]
        elif name == "deep.zip":
            data = inner
            for i in range(6): data = zipped([("n%d.zip" % i, data)])
        elif name == "data.br": data = b"\\x0b\\x02\\x80\\x00\\xff"
        elif name == "dotdot.zip": data = zipped([("../m.txt", body)])
        elif name == "v7-cut.tar.gz":
            t = bytearray(tarred([("old.txt", body * 100)], tarfile.USTAR_FORMAT)[:1024])
            t[257:265] = bytes(8)
            t[148:156] = b" " * 8
            t[148:156] = ("%06o\\0 " % sum(t[:512])).encode()
            data = gzip.compress(bytes(t))
        else: raise SystemExit("unknown " + name)
        files[name] = data
    elif kind == "limit-one":
        files["one.zip"] = zipped([("m", b"a" * 5000)])
    elif kind == "limit-sum":
        files["sum.zip"] = zipped([("m1", b"a" * 3000), ("m2", b"b" * 3000)])
    elif kind in ("limit-pax", "limit-gnu"):
        out = io.BytesIO()
        fmt = tarfile.PAX_FORMAT if kind == "limit-pax" else tarfile.GNU_FORMAT
        with tarfile.open(fileobj=out, mode="w", format=fmt) as t:
            info = tarfile.TarInfo("n" * 20000 if kind == "limit-gnu" else "e")
            if kind == "limit-pax": info.pax_headers = {"comment": "c" * 20000}
            t.addfile(info)
        files[kind + ".tar"] = out.getvalue()
import os
for name, data in files.items():
    os.makedirs(os.path.dirname(name) or ".", exist_ok=True)
    open(name, "wb").write(data)
`;

/** python で作ったアーカイブを、名前と中身の組で返す */
function archives(kinds: string[], secret = tokenLine()): Record<string, Buffer> {
  const dir = tempDir("leak-archives-");
  python(dir, MAKE_ARCHIVES, JSON.stringify({ kinds, secret }));
  const { files } = listOutput(dir);
  return Object.fromEntries(files.map((name) => [name, readFileSync(join(dir, name))]));
}

describe("サービスの token（#98 の 1）", () => {
  it("委任の token と登録の token が、今の木と途中のコミットの両方で当たる", () => {
    const files = { "docs/d.md": `${serviceToken("ndfd")}\n`, "docs/m.md": `${serviceToken("ndfm")}\n` };
    const tree = scan(treeOf(files), ["dir", ND_CONFIG]);
    expect(tree.status).toBe(1);
    expect(rulesByFile(tree.findings)).toEqual({ "docs/d.md": ["nd-delegation-token"], "docs/m.md": ["nd-machine-token"] });
    const { root, base, added } = addedAndRemoved(files);
    const history = gitScan(root, ND_CONFIG, base);
    expect(history.status).toBe(1);
    expect(hits(history)).toEqual([
      ["nd-delegation-token", "docs/d.md", added],
      ["nd-machine-token", "docs/m.md", added],
    ]);
  }, TIMEOUT);
});

describe("今の木の探し直し（#98 の 3・4）", () => {
  it("NUL を含むファイル・ELF の頭・RTF の頭・名前に .br を含むファイルの値が、元のパスと行で当たる", () => {
    const root = treeOf({
      nulfile: nul(tokenLine()),
      "bin/elf": elf(tokenLine()),
      "doc.rtf.txt": `{\\rtf1 x}\n${tokenLine()}`,
      "log.browser.test.ts": tokenLine(),
    });
    const result = scan(root, ["dir", DEFAULT_CONFIG]);
    expect(result.status).toBe(1);
    expect(places(result)).toEqual([
      ["github-pat", "bin/elf", 2],
      ["github-pat", "doc.rtf.txt", 2],
      ["github-pat", "log.browser.test.ts", 1],
      ["github-pat", "nulfile", 2],
    ]);
    expect(result.output).not.toContain(UNSEARCHED_MESSAGE);
  }, TIMEOUT);

  it("木の根の 1 という名前のファイルと foo.zip という名前のテキストが、それぞれ当たる", () => {
    const root = treeOf({ "1": elf(tokenLine()), "foo.zip": tokenLine() });
    expect(places(scan(root, ["dir", DEFAULT_CONFIG]))).toEqual([
      ["github-pat", "1", 2],
      ["github-pat", "foo.zip", 1],
    ]);
  }, TIMEOUT);

  it("呼び出し元の GIT_DIR などがあっても、元のリポジトリに書き込まずに探し直す", () => {
    const { root } = makeRepo({ "docs/a.md": "中身\n" }, "first");
    writeBytes(root, "e", elf(tokenLine()));
    writeBytes(root, "a.bin", tokenLine());
    const state = () => [git(root, "rev-parse", "HEAD"), git(root, "for-each-ref"), readFileSync(join(root, ".git", "index")).toString("hex")];
    const before = state();
    const env = {
      ...process.env,
      GIT_DIR: join(root, ".git"),
      GIT_WORK_TREE: root,
      GIT_INDEX_FILE: join(root, ".git", "index"),
    };
    const result = scan(root, ["dir", DEFAULT_CONFIG], { env });
    expect(places(result)).toEqual([
      ["github-pat", "a.bin", 1],
      ["github-pat", "e", 2],
    ]);
    expect(state()).toEqual(before);
  }, TIMEOUT);

  it("パスだけの規則と規則単位のパスの許可が、飛ばされるファイルの元のパスに効く", () => {
    const rule = `[[rules]]\nid = "nd-test-p12"\ndescription = "p12"\npath = '''\\.p12'''\n`;
    const files = { "keys/a.p12": elf("x\n"), "keys/b.p12.gz": "text\n" };
    const result = scan(treeOf(files), ["dir", extendConfig(ND_CONFIG, rule)]);
    expect(places(result)).toEqual([
      ["nd-test-p12", "keys/a.p12", 0],
      ["nd-test-p12", "keys/b.p12.gz", 0],
    ]);
    expect(result.findings.map((f) => f.EndLine)).toEqual([0, 0]);
    const allowed = scan(treeOf(files), ["dir", extendConfig(ND_CONFIG, `${rule}\n[[rules.allowlists]]\npaths = ['''^keys/''']\n`)]);
    expect(allowed.status).toBe(0);
    expect(allowed.output).not.toContain(UNSEARCHED_MESSAGE);
  }, TIMEOUT);

  it("コミットを条件にする許可は今の木には効かず、Commit は空になる", () => {
    const token = fakeToken();
    const config = defaultWith(
      `[[rules]]\nid = "github-pat"\n[[rules.allowlists]]\ncondition = "AND"\ncommits = ["${hex(40)}"]\nregexes = ['''${token}''']\n`,
    );
    const result = scan(treeOf({ e: elf(`token ${token}\n`) }), ["dir", config]);
    expect(hits(result)).toEqual([["github-pat", "e", ""]]);
  }, TIMEOUT);

  it("報告が壊れていても、飛ばしたファイルの当たりを出す", () => {
    const env = { ...process.env, PATH: wrappedGitleaksPath(['[[ "$tag" == 1 ]] && printf "{" >"$report"']) };
    const result = scan(treeOf({ e: elf(tokenLine()) }), ["dir", DEFAULT_CONFIG], { env });
    expect(result.status).toBe(1);
    expect(result.output).toContain("gitleaks の報告を読めない");
    expect(places(result)).toEqual([["github-pat", "e", 2]]);
  }, TIMEOUT);

  it("1 回目と 2 回目の両方に当たりがあっても、失敗の行を出さない", () => {
    const result = scan(treeOf({ "a.md": tokenLine(), e: elf(tokenLine()) }), ["dir", DEFAULT_CONFIG]);
    expect(result.status).toBe(1);
    expect(result.findings).toHaveLength(2);
    expect(result.output).not.toContain(SKIP_MESSAGE);
    expect(result.output).not.toContain(UNSEARCHED_MESSAGE);
  }, TIMEOUT);

  it("--paths を渡しても、当たった値と trace の行を出さない", () => {
    const values = [fakeToken(), fakeToken()];
    const result = scan(treeOf({ "a.md": `token ${values[0]}\n`, e: elf(`token ${values[1]}\n`) }), ["dir", DEFAULT_CONFIG]);
    expect(result.findings).toHaveLength(2);
    expect(values.filter((value) => shownText(result).includes(value))).toEqual([]);
    expect(result.output).not.toMatch(/ (DBG|TRC) /);
    expect(result.output).not.toContain("leaks found");
  }, TIMEOUT);

  /** 偽の gitleaks が 2 回目（か 1 回目の記録）を壊す。当たりの無い飛ばされるファイルだけの木で 1 になる */
  it.each([
    ["2 回目の終了コードが 2", '[[ "$tag" == 2 ]] && status=2'],
    ["2 回目の報告が無い", '[[ "$tag" == 2 ]] && rm -f "$report"'],
    ["2 回目の報告が配列でない", '[[ "$tag" == 2 ]] && echo "{}" >"$report"'],
    ["2 回目の報告が空（目印が無い）", '[[ "$tag" == 2 ]] && { echo "[]" >"$report"; status=0; }'],
    [
      "2 回目の当たりが対象に無いパス",
      `[[ "$tag" == 2 ]] && sed -i 's/"File": "e"/"File": "other"/' "$report"`,
    ],
    ["2 回目が飛ばす", `[[ "$tag" == 2 ]] && echo "4:08PM DBG skipping binary file path=e" >&2`],
    ["2 回目が command aborted", `[[ "$tag" == 2 ]] && echo "4:08PM DBG command aborted: x" >&2`],
    ["1 回目に知らない skipping の行", `[[ "$tag" == 1 ]] && echo "4:08PM DBG skipping file: new reason path=e" >&2`],
    ["1 回目に path を読めない行", `[[ "$tag" == 1 ]] && echo "4:08PM DBG skipping binary file" >&2`],
  ])("探し直しの失敗（%s）は、当たりが無くても固定の行で 1", (_label, line) => {
    const name = fakeWord();
    const root = treeOf({ e: elf("x\n"), [`${name}.md`]: "中身\n" });
    expect(scan(root, ["dir", DEFAULT_CONFIG]).status).toBe(0);
    const result = scan(root, ["dir", DEFAULT_CONFIG], { paths: false, env: { ...process.env, PATH: wrappedGitleaksPath([line]) } });
    expect(result.status).toBe(1);
    expect(result.findings).toEqual([]);
    expect(result.output).toContain(UNSEARCHED_MESSAGE);
    expect(result.output).not.toContain(name);
  }, TIMEOUT);

  it("2 回目の目印だけを除くと失敗する", () => {
    const drop = `[[ "$tag" == 2 ]] && jq 'map(select(.RuleID != "leak-scan-marker"))' "$report" >"$report.t" && mv "$report.t" "$report"`;
    const result = scan(treeOf({ e: elf("x\n") }), ["dir", DEFAULT_CONFIG], { env: { ...process.env, PATH: wrappedGitleaksPath([drop]) } });
    expect(result.status).toBe(1);
    expect(result.output).toContain(UNSEARCHED_MESSAGE);
  }, TIMEOUT);

  /** 2 回目の報告を jq の式で加工する偽の gitleaks の行 */
  const editSecondReport = (filter: string) =>
    `[[ "$tag" == 2 ]] && jq '${filter}' "$report" >"$report.t" && mv "$report.t" "$report"`;

  it.each([
    ["番号を引けないメール", '.Email = "ops@example.com"', "e", /^[0-9a-f]{40}$/],
    ["写しと違うパス", '.File = "other"', "other", /^[0-9a-f]{40}$/],
    ["写しと違うコミット", `.Commit = "${"0".repeat(40)}"`, "e", /^0{40}$/],
  ])("2 回目の当たりが%sなら、目印がそろっていても、報告の値を戻さずに出して固定の行で 1", (_label, change, file, commit) => {
    const env = {
      ...process.env,
      PATH: wrappedGitleaksPath([editSecondReport(`map(if .RuleID == "github-pat" then ${change} else . end)`)]),
    };
    const result = scan(treeOf({ e: elf(tokenLine()) }), ["dir", DEFAULT_CONFIG], { env });
    expect(result.status).toBe(1);
    expect(places(result)).toEqual([["github-pat", file, 2]]);
    expect(result.findings[0]?.Commit).toMatch(commit);
    expect(result.output).toContain(UNSEARCHED_MESSAGE);
  }, TIMEOUT);

  it("2 回目に対象と一致しない目印が余分にあると、その目印は当たりにせず、固定の行で 1", () => {
    const add = editSecondReport('. + [(.[] | select(.RuleID == "leak-scan-marker") | .Email = "ops@example.com")]');
    const result = scan(treeOf({ e: elf(tokenLine()) }), ["dir", DEFAULT_CONFIG], {
      env: { ...process.env, PATH: wrappedGitleaksPath([add]) },
    });
    expect(result.status).toBe(1);
    expect(hits(result)).toEqual([["github-pat", "e", ""]]);
    expect(result.output).toContain(UNSEARCHED_MESSAGE);
  }, TIMEOUT);

  it("2 回目が警告を出すと、当たりは元のパスに戻して出し、警告の行でなく探し直しの固定の行で 1", () => {
    const env = { ...process.env, PATH: wrappedGitleaksPath([`[[ "$tag" == 2 ]] && echo "4:08PM WRN something" >&2`]) };
    const result = scan(treeOf({ e: elf(tokenLine()) }), ["dir", DEFAULT_CONFIG], { env });
    expect(result.status).toBe(1);
    expect(hits(result)).toEqual([["github-pat", "e", ""]]);
    expect(result.output).toContain(UNSEARCHED_MESSAGE);
    expect(result.output).not.toContain(SKIP_MESSAGE);
  }, TIMEOUT);

  it("対象外の行（ディレクトリの許可・設定のファイル・規則の許可・空のファイル・シンボリックリンク・skipping finding）だけなら 0", () => {
    const root = treeOf({ empty: "", "a.md": "中身\n", "keys/e": elf("x\n") });
    symlinkSync("a.md", join(root, "link"));
    writeFileSync(
      join(root, "cfg.toml"),
      `[extend]\npath = "${ND_CONFIG}"\n\n[[rules]]\nid = "nd-test-a"\ndescription = "a"\nregex = '''zz-noth[i]ng'''\n[[rules.allowlists]]\npaths = ['''a\\.md''']\n`,
    );
    const result = scan(root, ["dir", join(root, "cfg.toml")]);
    expect(result.findings).toEqual([]);
    expect(result.status).toBe(0);
  }, TIMEOUT);

  it("既定の全体の許可のパス条件を外せなければ、全体の許可が外すファイルがあると 1", () => {
    const real = wrappedGitleaksPath([]);
    rmSync(join(real.split(":")[0] ?? "", "gitleaks.default.toml"));
    const result = scan(treeOf({ "a.bin": "x\n" }), ["dir", DEFAULT_CONFIG], { env: { ...process.env, PATH: real } });
    expect(result.status).toBe(1);
    expect(result.output).toContain(UNSEARCHED_MESSAGE);
  }, TIMEOUT);

  it("python3 が無ければ、探しの固定の行で 1", () => {
    const bin = tempDir("leak-nopython-");
    for (const name of ["bash", "git", "dirname"]) symlinkSync(which(name), join(bin, name));
    const { root } = makeRepo({ "a.md": "中身\n" }, "first");
    for (const [mode, message] of [["dir", UNSEARCHED_MESSAGE], ["git", HISTORY_MESSAGE]] as const) {
      const result = spawnSync(join(bin, "bash"), [SCRIPT, mode, ND_CONFIG], { cwd: root, encoding: "utf8", env: { PATH: bin } });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
    }
  }, TIMEOUT);
});

describe("道具の版の確かめ", () => {
  /** name の代わりに body を打つ起動スクリプトを PATH の先頭に置いた環境 */
  const shadowed = (name: string, body: string) => {
    const bin = tempDir("leak-oldtool-");
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
    return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
  };

  it("python3 が 3.11 より古ければ、探しの固定の行で 1", () => {
    const { root } = makeRepo({ "a.md": "中身\n" }, "first");
    const env = shadowed("python3", "exit 1");
    for (const [mode, message] of [["dir", UNSEARCHED_MESSAGE], ["git", HISTORY_MESSAGE]] as const) {
      const result = spawnSync("bash", [SCRIPT, mode, ND_CONFIG], { cwd: root, encoding: "utf8", env });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
      expect(result.stderr).toContain("python3 が 3.11 より古い");
    }
  }, TIMEOUT);

  it("git が 2.40 より古ければ、履歴の探しは固定の行で 1", () => {
    const { root } = makeRepo({ "a.md": "中身\n" }, "first");
    const env = shadowed("git", `[[ "$1" == --version ]] && { echo "git version 2.39.5"; exit 0; }\nexec '${which("git")}' "$@"`);
    const result = spawnSync("bash", [SCRIPT, "git", ND_CONFIG], { cwd: root, encoding: "utf8", env });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(HISTORY_MESSAGE);
    expect(result.stderr).toContain("git が 2.40 より古い");
  }, TIMEOUT);
});

describe("名前で外すファイル（#98 の決定 6）", () => {
  it("追跡していない依存のディレクトリは当てず、追跡したもの・vendor・img は木と履歴で当たる", () => {
    const untracked = makeRepo({ "a.md": "中身\n" }, "first").root;
    writeBytes(untracked, "node_modules/p/i.js", tokenLine());
    expect(scan(untracked, ["dir", DEFAULT_CONFIG]).status).toBe(0);

    const files = {
      "node_modules/p/i.js": tokenLine(),
      "bower_components/p/i.js": tokenLine(),
      "vendor/acme/a.bin": tokenLine(),
      "img/logo.png": tokenLine(),
      "docs/gitleaks.toml.md": tokenLine(),
      "gitleaks.toml.d/x": tokenLine(),
      "docs/verification-metadata.xml": tokenLine(),
    };
    const expected = Object.keys(files).sort().map((path) => ["github-pat", path, 1]);
    const tracked = treeOf(files);
    initRepo(tracked);
    git(tracked, "add", "-A", "-f");
    git(tracked, "commit", "-q", "-m", "add");
    expect(places(scan(tracked, ["dir", DEFAULT_CONFIG]))).toEqual(expected);
    const { root, base } = addedAndRemoved(files);
    expect(places(gitScan(root, DEFAULT_CONFIG, base))).toEqual(expected);
    // Git のリポジトリでないディレクトリでは、依存のディレクトリの下も除かない
    expect(places(scan(treeOf({ "node_modules/p/i.js": tokenLine() }), ["dir", DEFAULT_CONFIG]))).toEqual([
      ["github-pat", "node_modules/p/i.js", 1],
    ]);
  }, TIMEOUT);

  it("ファイル名を条件にする規則が、外れたディレクトリと名前でアーカイブと見なす所でも当たる", () => {
    const password = alnum(24);
    const body = `<configuration>\n<packageSourceCredentials>\n<add key="ClearTextPassword" value="${password}" />\n</packageSourceCredentials>\n</configuration>\n`;
    const files = { "gitleaks.toml.d/NuGet.config": body };
    const expected = [["nuget-config-password", "gitleaks.toml.d/NuGet.config", 3]];
    expect(places(scan(treeOf(files), ["dir", DEFAULT_CONFIG]))).toEqual(expected);
    const { root, base } = addedAndRemoved(files);
    expect(places(gitScan(root, DEFAULT_CONFIG, base))).toEqual(expected);
    expect(places(scan(treeOf({ "acme.gem/NuGet.config": body }), ["dir", DEFAULT_CONFIG]))).toEqual([
      ["nuget-config-password", "acme.gem/NuGet.config", 3],
    ]);
  }, TIMEOUT);

  it("pnpm-lock.yaml の Kubernetes の Secret の形が、木と履歴で元のパスで当たる", () => {
    const files = {
      "pnpm-lock.yaml": `apiVersion: v1\nkind: Secret\nmetadata:\n  name: x\ndata:\n  password: ${randomBytes(24).toString("base64")}\n`,
    };
    const secrets = (result: ScanResult) => places(result).filter(([rule]) => rule === "kubernetes-secret-yaml");
    const expected = [["kubernetes-secret-yaml", "pnpm-lock.yaml", 2]];
    expect(secrets(scan(treeOf(files), ["dir", DEFAULT_CONFIG]))).toEqual(expected);
    const { root, base } = addedAndRemoved(files);
    expect(secrets(gitScan(root, DEFAULT_CONFIG, base))).toEqual(expected);
  }, TIMEOUT);

  it("ディレクトリを限った規則単位の許可が、探し直しでも元のパスに効く", () => {
    const line = tokenLine();
    const config = defaultWith(`[[rules]]\nid = "github-pat"\n[[rules.allowlists]]\npaths = ['''^docs/allowed/''']\n`);
    const files = { "docs/allowed/a.bin": line, "docs/other/a.bin": line };
    expect(places(scan(treeOf(files), ["dir", config]))).toEqual([["github-pat", "docs/other/a.bin", 1]]);
    const { root, base } = addedAndRemoved(files);
    expect(places(gitScan(root, config, base))).toEqual([["github-pat", "docs/other/a.bin", 1]]);
  }, TIMEOUT);

  it("外れたディレクトリの空のファイルは通し、読めないファイルは失敗にする", () => {
    const root = treeOf({ "gitleaks.toml.d/empty": "", "gitleaks.toml.d/a": "中身\n" });
    expect(scan(root, ["dir", DEFAULT_CONFIG]).status).toBe(0);
    if (process.getuid?.() === 0) return;
    writeBytes(root, "gitleaks.toml.d/closed", "x\n");
    chmodSync(join(root, "gitleaks.toml.d/closed"), 0o000);
    const result = scan(root, ["dir", DEFAULT_CONFIG]);
    expect(result.status).toBe(1);
    expect(result.output).toContain(UNSEARCHED_MESSAGE);
  }, TIMEOUT);
});

describe("履歴のバイナリと読み終えたことの確かめ（#98 の 2・4）", () => {
  it("NUL を含むファイル・ELF の頭・-diff を付けたファイルの、途中のコミットの値が当たる", () => {
    const { root, base } = forkRepo();
    const added = step(root, { nulfile: nul(tokenLine()), e: elf(tokenLine()), "t.dat": tokenLine(), ".gitattributes": "t.dat -diff\n" });
    step(root, { nulfile: null, e: null, "t.dat": null, ".gitattributes": null });
    const result = gitScan(root, DEFAULT_CONFIG, base);
    expect(result.status).toBe(1);
    expect(hits(result)).toEqual([
      ["github-pat", "e", added],
      ["github-pat", "nulfile", added],
      ["github-pat", "t.dat", added],
    ]);
  }, TIMEOUT);

  it("要求の事象 2 の blob.bin が、履歴と今の木で元のパスで当たる", () => {
    const secret = `aws_secret_access_key = "${alnum(40)}"\n`;
    const files = { "text.txt": secret, "blob.bin": nul(secret) };
    const { root, base, added } = addedAndRemoved(files);
    expect(hits(gitScan(root, DEFAULT_CONFIG, base))).toEqual([
      ["generic-api-key", "blob.bin", added],
      ["generic-api-key", "text.txt", added],
    ]);
    expect(rulesByFile(scan(treeOf(files), ["dir", DEFAULT_CONFIG]).findings)["blob.bin"]).toEqual(["generic-api-key"]);
  }, TIMEOUT);

  it("同じ行の 2 つの秘密は 2 件、バイナリに足した 1 つの秘密は 1 件", () => {
    const { root, base } = forkRepo();
    step(root, { one: nul(tokenLine()), two: nul(`${fakeToken()} ${fakeToken()}\n`) });
    expect(gitScan(root, DEFAULT_CONFIG, base).findings.map((f) => f.File).sort()).toEqual(["one", "two", "two"]);
  }, TIMEOUT);

  it.each(["a.dat", "a.bin"])("旧い値の残る %s の別の行を変えるコミットは当たらず、足したコミットだけが当たる", (name) => {
    const token = fakeToken();
    const { root, base } = forkRepo();
    const added = step(root, { [name]: nul(`token ${token}\nfirst\n`) });
    step(root, { [name]: nul(`token ${token}\nsecond\n`) });
    expect(gitScan(root, DEFAULT_CONFIG, added).status).toBe(0);
    expect(hits(gitScan(root, DEFAULT_CONFIG, base))).toEqual([["github-pat", name, added]]);
    const config = defaultWith(
      `[[rules]]\nid = "github-pat"\n[[rules.allowlists]]\ncondition = "AND"\ncommits = ["${added}"]\nregexes = ['''${token}''']\n`,
    );
    expect(gitScan(root, config).status).toBe(0);
  }, TIMEOUT);

  it.each(["a.dat", "a.bin"])("元のコミットを条件にする許可が、%s の写しの探しにも効く", (name) => {
    const token = fakeToken();
    const { root, base } = forkRepo();
    const x = step(root, { [name]: nul(`token ${token}\n`) });
    step(root, { [name]: null });
    const y = step(root, { [name]: nul(`token ${token}\n`) });
    const config = defaultWith(
      `[[rules]]\nid = "github-pat"\n[[rules.allowlists]]\ncondition = "AND"\ncommits = ["${x}"]\nregexes = ['''${token}''']\n`,
    );
    expect(hits(gitScan(root, config, base))).toEqual([["github-pat", name, y]]);
    expect(scan(root, ["git", config, "--range", `${base}..${x}`]).status).toBe(0);
  }, TIMEOUT);

  const pairRule = `[[rules]]\nid = "nd-test-pair"\ndescription = "隣り合う 2 行"\nregex = '''nd-first-half\\nnd-second-half'''\n`;

  it.each(["a.dat", "a.bin"])("%s で、行を足して成立する秘密と、行の削除だけで成立する秘密が当たる", (name) => {
    const config = defaultWith(pairRule);
    const { root, base } = forkRepo();
    step(root, { [name]: nul("nd-first-half\n") });
    const completed = step(root, { [name]: nul("nd-first-half\nnd-second-half\n") });
    step(root, { [name]: null });
    expect(hits(gitScan(root, config, base))).toEqual([["nd-test-pair", name, completed]]);

    const other = forkRepo();
    step(other.root, { [name]: nul("nd-first-half\nbetween\nnd-second-half\n") });
    const joined = step(other.root, { [name]: nul("nd-first-half\nnd-second-half\n") });
    step(other.root, { [name]: null });
    expect(hits(gitScan(other.root, config, other.base))).toEqual([["nd-test-pair", name, joined]]);

    const old = forkRepo();
    const before = step(old.root, { [name]: nul("nd-first-half\nnd-second-half\nextra\n") });
    step(old.root, { [name]: nul("nd-first-half\nnd-second-half\n") });
    expect(gitScan(old.root, config, before).status).toBe(0);
  }, TIMEOUT);

  it.each(["a.dat", "a.bin"])("%s の真ん中の版にだけある値が当たる", (name) => {
    const { root, base } = forkRepo();
    step(root, { [name]: nul("one\n") });
    const middle = step(root, { [name]: nul(`one\n${tokenLine()}`) });
    step(root, { [name]: nul("one\n") });
    expect(hits(gitScan(root, DEFAULT_CONFIG, base))).toEqual([["github-pat", name, middle]]);
  }, TIMEOUT);

  it("途中のコミットの .gitattributes だけが付ける -diff も、そのコミットの属性で読む", () => {
    const config = defaultWith(pairRule);
    const { root, base } = forkRepo();
    step(root, { "t.txt": "nd-first-half\n" });
    const marked = step(root, { "t.txt": "nd-first-half\nnd-second-half\n", ".gitattributes": "t.txt -diff\n" });
    step(root, { "t.txt": null, ".gitattributes": null });
    expect(hits(gitScan(root, config, base))).toEqual([["nd-test-pair", "t.txt", marked]]);
  }, TIMEOUT);

  it("サブモジュールを同じパスのバイナリに置き換えたコミットを探せる", () => {
    for (const [body, status] of [[nul("x\n"), 0], [nul(tokenLine()), 1]] as const) {
      const { root, head } = makeRepo({ "a.md": "中身\n" }, "first");
      git(root, "update-index", "--add", "--cacheinfo", `160000,${head},sub`);
      git(root, "commit", "-q", "-m", "sub");
      const base = git(root, "rev-parse", "HEAD");
      git(root, "rm", "-q", "--cached", "sub");
      writeBytes(root, "sub", body);
      const replaced = commitAll(root, "replace");
      const result = gitScan(root, DEFAULT_CONFIG, base);
      expect(result.status).toBe(status);
      expect(result.findings.map((f) => f.Commit)).toEqual(status === 0 ? [] : [replaced]);
    }
  }, TIMEOUT);

  /** 空白と日本語の名前・引用が要る名前・名前の変更・マージ・モードだけの変更・空のファイルを持つ秘密の無い範囲 */
  function variedRepo(): { root: string; base: string } {
    const { root, head: base } = makeRepo({ "空白 と 日本語.md": "一\n", "q\"uote.md": "一\n", "old.md": "中身\n", "run.sh": "echo\n" }, "base");
    git(root, "checkout", "-q", "-b", "side");
    step(root, { "side.md": "side\n", "空白 と 日本語.md": "二\n", "q\"uote.md": "二\n", "empty": "" });
    git(root, "checkout", "-q", "main");
    git(root, "mv", "old.md", "new.md");
    chmodSync(join(root, "run.sh"), 0o755);
    step(root, { "main.md": "no newline" });
    git(root, "merge", "-q", "--no-ff", "--no-commit", "side");
    step(root, { "merged.md": "merged\n", "main.md": "changed" });
    return { root, base };
  }

  it("いろいろな形の変更を含む秘密の無い範囲は 0 で、目印は出力にも報告にも出ない", () => {
    const { root, base } = variedRepo();
    for (const config of [ND_CONFIG, DEFAULT_CONFIG]) {
      const result = gitScan(root, config, base);
      expect(result.status).toBe(0);
      expect(result.findings).toEqual([]);
      expect(shownText(result)).not.toContain("leak-scan-marker");
      expect(result.output).not.toContain("leaks found");
    }
    expect(gitScan(root, ND_CONFIG).status).toBe(0);
  }, TIMEOUT);

  it("利用者の Git の設定が色と見出しの形を変えても探せる", () => {
    const { root, base } = variedRepo();
    const globalConfig = join(tempDir("leak-gitconfig-"), "config");
    writeFileSync(globalConfig, "[color]\n\tui = always\n\tdiff = always\n[diff]\n\tnoprefix = true\n");
    const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig };
    expect(gitScan(root, ND_CONFIG, base, { env }).status).toBe(0);
    const added = step(root, { "t.md": `x\n${tokenLine()}`, "t.bin": tokenLine() });
    expect(places(gitScan(root, DEFAULT_CONFIG, base, { env }))).toEqual([
      ["github-pat", "t.bin", 1],
      ["github-pat", "t.md", 2],
    ]);
    expect(gitScan(root, DEFAULT_CONFIG, base, { env }).findings.map((f) => f.Commit)).toEqual([added, added]);
  }, TIMEOUT);

  it("渡した設定のファイルを変えるコミットは、その差分を探さず、失敗にもしない", () => {
    const { root, base } = forkRepo();
    step(root, { ".gitleaks.toml": `${readFileSync(ND_CONFIG, "utf8")}\n# ${"arn:aws:s3"}:::nd-${lower(10)}\n` });
    const result = gitScan(root, join(root, ".gitleaks.toml"), base);
    expect(result.status).toBe(0);
    expect(result.findings).toEqual([]);
  }, TIMEOUT);

  /** `log -p` の出力か終了コードを壊す偽の git */
  const fakeGit = (filter: string, status = "$?") => {
    const real = which("git");
    return fakePath("git", [
      "#!/usr/bin/env bash",
      `if [[ " $* " == *" log "* && " $* " == *" -p "* ]]; then`,
      `  "${real}" "$@" | ${filter}`,
      `  exit ${status}`,
      "fi",
      `exec "${real}" "$@"`,
    ]);
  };

  it.each([
    ["パッチから 1 つのファイルの差分を丸ごと除く", "awk '/^diff --git /{skip = index($0, \"b.md\") > 0} /^commit /{skip = 0} !skip'", "0"],
    ["hunk の行の数を多くする", "sed 's/^@@ -0,0 +1 @@/@@ -0,0 +1,9 @@/'", "0"],
    ["内部の git log が途中で 0 以外", "cat", "3"],
  ])("%s と、当たりが無くても履歴の固定の行で 1", (_label, filter, status) => {
    const { root, base } = forkRepo();
    step(root, { "a.md": "一\n", "b.md": "二\n" });
    expect(gitScan(root, ND_CONFIG, base).status).toBe(0);
    const result = gitScan(root, ND_CONFIG, base, { paths: false, env: { ...process.env, PATH: fakeGit(filter, status) } });
    expect(result.status).toBe(1);
    expect(result.findings).toEqual([]);
    expect(result.output).toContain(HISTORY_MESSAGE);
    expect(result.output).not.toContain("b.md");
  }, TIMEOUT);

  /**
   * `cat-file --batch` が bad の blob で失敗する偽の git。失敗したプロセスはその後の要求にも答えないので、
   * 後の blob を読めるのは、読み手を作り直したときだけになる
   */
  const brokenBlobGit = (bad: string) =>
    fakePath("git", [
      "#!/usr/bin/env python3",
      "import os, subprocess, sys",
      `real = ${JSON.stringify(which("git"))}`,
      'if sys.argv[1:] != ["cat-file", "--batch"]:',
      "    os.execv(real, [real, *sys.argv[1:]])",
      "broken = False",
      "for line in sys.stdin.buffer:",
      `    broken = broken or line.strip() == b"${bad}"`,
      '    answer = line.strip() + b" missing\\n" if broken else subprocess.run([real, *sys.argv[1:]], input=line, capture_output=True, check=True).stdout',
      "    sys.stdout.buffer.write(answer)",
      "    sys.stdout.buffer.flush()",
    ]);

  it("変更後の blob を読めなければ、その対象は中を探さず、読み手を作り直して後の対象を探し、履歴の固定の行で 1", () => {
    const { root, base } = forkRepo();
    const added = step(root, { "a.gz": gzipSync(tokenLine()), "b.gz": gzipSync(tokenLine()) });
    const env = { ...process.env, PATH: brokenBlobGit(git(root, "rev-parse", `${added}:a.gz`)) };
    const result = gitScan(root, DEFAULT_CONFIG, base, { env });
    expect(result.status).toBe(1);
    expect(result.output).toContain(HISTORY_MESSAGE);
    expect(hits(result)).toEqual([["github-pat", "b.gz!b", added]]);
  }, TIMEOUT);

  it("変更前の blob を読めなければ、変更後の blob の当たりを帰属させずに出し、読み手を作り直して後の対象を探し、履歴の固定の行で 1", () => {
    const token = fakeToken();
    const { root } = forkRepo();
    const added = step(root, { "a.dat": nul(`token ${token}\nfirst\n`) });
    const changed = step(root, { "a.dat": nul(`token ${token}\nsecond\n`), "b.gz": gzipSync(tokenLine()) });
    const env = { ...process.env, PATH: brokenBlobGit(git(root, "rev-parse", `${added}:a.dat`)) };
    const result = gitScan(root, DEFAULT_CONFIG, added, { env });
    expect(result.status).toBe(1);
    expect(result.output).toContain(HISTORY_MESSAGE);
    expect(hits(result)).toEqual([
      ["github-pat", "a.dat", changed],
      ["github-pat", "b.gz!b", changed],
    ]);
  }, TIMEOUT);

  const dropMarker = (tag: string, select: string) =>
    `[[ "$tag" == ${tag} ]] && jq '([.[] | select(.RuleID == "leak-scan-marker"${select})] | first) as $one | map(select(. != $one))' "$report" >"$report.t" && mv "$report.t" "$report"`;

  it.each([
    ["1 回目の目印を 1 件除く", dropMarker("1", "")],
    ["写しの目印を 1 件除く", dropMarker("2", "")],
    ["写しが command aborted", `[[ "$tag" == 2 ]] && echo "4:08PM DBG command aborted: x" >&2`],
    ["写しの報告が無い", '[[ "$tag" == 2 ]] && rm -f "$report"'],
  ])("%s と、履歴の固定の行だけを出して 1", (_label, line) => {
    const { root, base } = forkRepo();
    step(root, { "a.md": "一\n", n: nul("x\n"), "z.bin": "y\n" });
    expect(gitScan(root, DEFAULT_CONFIG, base).status).toBe(0);
    const result = gitScan(root, DEFAULT_CONFIG, base, { env: { ...process.env, PATH: wrappedGitleaksPath([line]) } });
    expect(result.status).toBe(1);
    expect(result.findings).toEqual([]);
    expect(result.output).toContain(HISTORY_MESSAGE);
    expect(result.output).not.toContain(UNSEARCHED_MESSAGE);
  }, TIMEOUT);

  it("同じ写しのパスの 2 つの対象で、片方の目印だけを除くと 1", () => {
    const { root, base } = forkRepo();
    step(root, { "a.bin": "一\n" });
    step(root, { "a.bin": "二\n" });
    const result = gitScan(root, DEFAULT_CONFIG, base, { env: { ...process.env, PATH: wrappedGitleaksPath([dropMarker("2", "")]) } });
    expect(result.status).toBe(1);
    expect(result.output).toContain(HISTORY_MESSAGE);
  }, TIMEOUT);

  it("マージのコミットは親ごとに目印を確かめる", () => {
    const { root, head: base } = makeRepo({ "a.md": "一\n二\n三\n四\n五\n" }, "base");
    git(root, "checkout", "-q", "-b", "side");
    const side = step(root, { "a.md": "side\n二\n三\n四\n五\n" });
    git(root, "checkout", "-q", "main");
    step(root, { "a.md": "一\n二\n三\n四\nmain\n" });
    git(root, "merge", "-q", "--no-ff", "-m", "merge", "side");
    expect(gitScan(root, ND_CONFIG, base).status).toBe(0);
    const drop = `[[ "$tag" == 1 ]] && jq 'map(select((.Match | contains("-${side}-")) | not))' "$report" >"$report.t" && mv "$report.t" "$report"`;
    const result = gitScan(root, ND_CONFIG, base, { env: { ...process.env, PATH: wrappedGitleaksPath([drop]) } });
    expect(result.status).toBe(1);
    expect(result.output).toContain(HISTORY_MESSAGE);
  }, TIMEOUT);

  it("別のコミットの全体の許可の行を、除外の根拠にしない", () => {
    const { root, base } = forkRepo();
    const a = step(root, { "a.md": "一\n" });
    const b = step(root, { "a.md": "二\n" });
    for (const line of [`commit=${a} path=a.md`, "path=a.md"]) {
      const after = [
        '[[ "$tag" == 1 ]] && {',
        `  jq 'map(select(.Commit != "${b}"))' "$report" >"$report.t" && mv "$report.t" "$report"`,
        `  echo "4:08PM TRC skipping file: global allowlist ${line}" >&2`,
        "}",
      ];
      const result = gitScan(root, ND_CONFIG, base, { env: { ...process.env, PATH: wrappedGitleaksPath(after) } });
      expect(result.status).toBe(1);
      expect(result.output).toContain(HISTORY_MESSAGE);
    }
  }, TIMEOUT);

  it("非公開の探しの --count-only は、当たりと履歴の失敗が同時なら失敗の行も出す", () => {
    const realWord = fakeWord();
    const { root, base } = forkRepo();
    step(root, { "a.md": `名前 ${realWord}\n`, n: nul("x\n") });
    const path = wrappedGitleaksPath(['[[ "$tag" == 2 ]] && rm -f "$report"']);
    const result = secretScan(root, ["git", "--range", `${base}..HEAD`, "--count-only"], { pattern: realWord, path });
    expect(result.status).toBe(1);
    expect(result.output).toContain(countLine(1));
    expect(result.output).toContain("leak-scan-secret: nd-real-value の探しが失敗した");
  }, TIMEOUT);
});

describe("アーカイブと圧縮ファイル（#98 の 4・決定 8）", () => {
  const goodPaths = [
    "a.zip!a.bin",
    "a.zip!app.env",
    "a.zip!lib.so",
    "b.tar.gz!b.tar!dir/t.txt",
    "conf/app.env.gz!app.env",
    "nest.zip!in.zip!deep.txt",
    "renamed.dat!d.txt",
    "sfx-elf.run!e.txt",
    "sfx-sh.run!s.txt",
    "v7.tar!old.txt",
    "v7.tar.gz!v7.tar!old.txt",
    "x.bz2!x",
    "y.xz!y",
  ];

  it("圧縮した秘密が、木と履歴で <アーカイブ>!<中のパス> で当たる", () => {
    const files = archives(["good"]);
    const inside = (result: ScanResult) => [...new Set(result.findings.map((f) => f.File).filter((f) => f.includes("!")))].sort();
    const tree = scan(treeOf(files), ["dir", DEFAULT_CONFIG]);
    expect(tree.status).toBe(1);
    expect(inside(tree)).toEqual(goodPaths);
    const { root, base } = addedAndRemoved(files);
    const history = gitScan(root, DEFAULT_CONFIG, base);
    expect(history.status).toBe(1);
    expect(history.output).not.toContain(HISTORY_MESSAGE);
    expect(inside(history)).toEqual(goodPaths);
  }, TIMEOUT);

  it("ルート直下のメンバーに、ファイル名を条件にする規則が当たる", () => {
    const secret = tokenLine();
    const config = extendConfig(ND_CONFIG, `[[rules]]\nid = "nd-test-env"\ndescription = "env"\npath = '''(^|/)app\\.env$'''\nregex = '''token'''\n`);
    const files = { "a.zip": archives(["good"], secret)["a.zip"] ?? Buffer.alloc(0) };
    expect(scan(treeOf(files), ["dir", config]).findings.map((f) => f.File)).toContain("a.zip!app.env");
    const { root, base } = addedAndRemoved(files);
    expect(gitScan(root, config, base).findings.map((f) => f.File)).toContain("a.zip!app.env");
  }, TIMEOUT);

  it("秘密の無いアーカイブと、名前だけがアーカイブのテキストは、木と履歴で 0", () => {
    const files = archives(["clean"]);
    expect(scan(treeOf(files), ["dir", DEFAULT_CONFIG]).output).not.toContain("leak-scan:");
    const { root, base } = addedAndRemoved(files);
    const result = gitScan(root, DEFAULT_CONFIG, base);
    expect(result.output).not.toContain("leak-scan:");
    expect(result.status).toBe(0);
    const secret = tokenLine();
    expect(places(scan(treeOf({ "notes.zip": secret, "notes.br": secret }), ["dir", DEFAULT_CONFIG]))).toEqual([
      ["github-pat", "notes.br", 1],
      ["github-pat", "notes.zip", 1],
    ]);
  }, TIMEOUT);

  it.each([
    "cut.zip",
    "cut.gz",
    "broken.zip",
    "encrypted.zip",
    "a.7z",
    "method.zip",
    "method-sfx.run",
    "sfx-sh-cut.run",
    "sfx-elf-cut.run",
    "sfx-boundary.run",
    "deep.zip",
    "data.br",
    "dotdot.zip",
    "v7-cut.tar.gz",
  ])("展開できない %s は、当たりが無くても木と履歴で固定の行で 1", (name) => {
    // 秘密は秘密の形でない値にする（当たりが無くても失敗することを確かめる）
    const files = archives([`bad:${name}`], `plain ${fakeWord()}\n`);
    const tree = scan(treeOf(files), ["dir", ND_CONFIG], { paths: false });
    expect(tree.status).toBe(1);
    expect(tree.findings).toEqual([]);
    expect(tree.output).toContain(UNSEARCHED_MESSAGE);
    expect(tree.output).not.toContain(name);
    const { root, base } = addedAndRemoved(files);
    const history = gitScan(root, ND_CONFIG, base, { paths: false });
    expect(history.status).toBe(1);
    expect(history.findings).toEqual([]);
    expect(history.output).toContain(HISTORY_MESSAGE);
  }, TIMEOUT);

  it.each(["limit-one", "limit-sum", "limit-pax", "limit-gnu"])("展開の上限を超える %s は、木と履歴で 1", (kind) => {
    const files = archives([kind]);
    const env = { ...process.env, LEAK_SCAN_EXPAND_LIMIT: "4000" };
    expect(scan(treeOf(files), ["dir", ND_CONFIG]).status).toBe(0);
    const tree = scan(treeOf(files), ["dir", ND_CONFIG], { env });
    expect(tree.status).toBe(1);
    expect(tree.output).toContain(UNSEARCHED_MESSAGE);
    const { root, base } = addedAndRemoved(files);
    const history = gitScan(root, ND_CONFIG, base, { env });
    expect(history.status).toBe(1);
    expect(history.output).toContain(HISTORY_MESSAGE);
  }, TIMEOUT);
});

describe("絞った許可（#98 の 5・決定 5）", () => {
  const S3 = "s3.amazonaws.com";
  const cognito = "auth.us-west-2.amazoncognito.com";
  const s3Arn = "arn:aws:s3:::";
  const iam = `arn:aws:iam::${"123456789012"}:`;
  const word = () => `nd${lower(10)}`;

  it("main の履歴の旧い値の許可は、並べたコミットの外では効かない", () => {
    const { root, base } = forkRepo();
    step(root, { "e.md": `https://acme-bucket.s3.${"us-west-2.amazonaws.com"}/p\n${s3Arn}acme-assets\n` });
    expect(rulesByFile(gitScan(root, ND_CONFIG, base).findings)).toEqual({ "e.md": ["nd-aws-arn-s3", "nd-aws-endpoint"] });
  }, TIMEOUT);

  it("サービス名と DNS の接尾辞に大文字を混ぜた端点も当たる", () => {
    const endpoints = [
      `${word()}.${"Execute-API.us-west-2.AmazonAWS.com"}`,
      `${word()}.${"Lambda-URL.us-west-2.On.AWS"}`,
      `d${lower(13)}.${"CloudFront.NET"}`,
      `${word()}.${"Auth.us-west-2.AmazonCognito.COM"}`,
      `${word()}.${lower(12)}.us-west-2.${"RDS.AmazonAWS.com"}`,
      `${word()}.${"S3.US-West-2.AMAZONAWS.COM"}`,
    ];
    const root = makeTree({ "e.md": endpoints.map((host) => `https://${host}/p\n`).join("") });
    const result = scan(root, ["dir", ND_CONFIG]);
    expect(result.findings.filter((f) => f.RuleID === "nd-aws-endpoint").map((f) => f.StartLine).sort((a, b) => a - b)).toEqual(endpoints.map((_, i) => i + 1));
    expect(result.status).toBe(1);
  }, TIMEOUT);

  it("実際の名前になり得る端点・置き場・ARN・資源の ID は当たる", () => {
    const endpoints = [
      `data-example.com-logs.${S3}`,
      `real-<env>.${S3}`,
      `${word()}.example.com.${"s3-website-us-west-2.amazonaws.com"}`,
      `${word()}-EXAMPLE-${word()}.${"cloudfront.net"}`,
      `EXAMPLE1234.${"execute-api.us-west-2.amazonaws.com"}`,
      `acme-${word()}.${S3}`,
      `acme-${word()}-login.${cognito}`,
      // infra のテストが組み立てる端点と同じ値
      `${["acme", "test", "login"].join("-")}.${cognito}`,
      `amzn-s3-demo-${word()}-${word()}-s3alias.${S3}`,
    ];
    const buckets = ["data-example.com-logs", `acme-${word()}`, `amzn-s3-demo-${word()}-${word()}-s3alias`, `real-${word()}`];
    const arns = [
      `${iam}role/${word()}`,
      `${iam}role/acme-${word()}`,
      `${iam}role/${word()}-EXAMPLE`,
      `${iam}role/${word()}.example.com`,
      `${iam}role/<name>-${word()}`,
    ];
    const root = makeTree({
      "e.md": endpoints.map((host) => `https://${host}/p\n`).join(""),
      "s.md": buckets.map((name) => `${s3Arn}${name}\n`).join(""),
      "a.md": arns.map((arn) => `${arn}\n`).join(""),
      "r.md": `vpc-${["1234", "5678", "9012"].join("")}${hex(5)}\n`,
    });
    const result = scan(root, ["dir", ND_CONFIG]);
    const lines = (rule: string) => result.findings.filter((f) => f.RuleID === rule).map((f) => f.StartLine).sort((a, b) => a - b);
    expect(lines("nd-aws-endpoint")).toEqual(endpoints.map((_, i) => i + 1));
    expect(lines("nd-aws-arn-s3")).toEqual(buckets.map((_, i) => i + 1));
    expect(lines("nd-aws-arn")).toEqual(arns.map((_, i) => i + 1));
    expect(lines("nd-aws-resource-id")).toEqual([1]);
  }, TIMEOUT);
});
