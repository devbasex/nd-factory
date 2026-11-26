import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type BootstrapDeps, mainAppBootstrap, parseArgs, repositoryRoots } from "../bin/app-bootstrap.ts";
import { type BootstrapReader, type BootstrapStack, checkQualifier } from "../lib/bootstrap-collision.ts";
import { appQualifier } from "../lib/naming.ts";
import { standardBootstrapTemplate } from "./support.ts";

// 漏れの検査が ARN の直書きを当てるので、作り物のアカウントは定数から組み立てる
const FAKE_ACCOUNT = "123456789012";

// 値はすべて作り物。AWS は呼ばず、読み取りを偽の reader に差し替える

const FIRST = { prefix: "acme-58885", environment: "dev" };
const SECOND = { prefix: "acme-91474", environment: "dev" };

function target(s: { prefix: string; environment: string }) {
  return {
    qualifier: appQualifier(s),
    stackName: `${s.prefix}-${s.environment}-bootstrap`,
    tags: { "app-prefix": s.prefix, "app-env": s.environment },
  };
}

function stackOf(s: { prefix: string; environment: string }, over: Partial<BootstrapStack> = {}): BootstrapStack {
  const t = target(s);
  return { status: "CREATE_COMPLETE", qualifier: t.qualifier, tags: t.tags, ...over };
}

function reader(version: boolean, stacks: Record<string, BootstrapStack> = {}): BootstrapReader {
  return {
    versionExists: async () => version,
    describeStack: async (name) => stacks[name] ?? null,
  };
}

describe("checkQualifier", () => {
  const mine = target(FIRST);

  it("版のパラメーターもこの名前のスタックも無ければ、新しく作る", async () => {
    expect(await checkQualifier(mine, reader(false))).toEqual({ ok: true, mode: "create" });
  });

  it.each(["CREATE_COMPLETE", "UPDATE_COMPLETE"])("この設置のスタックが %s なら更新する（版の有無を問わない）", async (status) => {
    const stacks = { [mine.stackName]: stackOf(FIRST, { status }) };
    expect(await checkQualifier(mine, reader(true, stacks))).toEqual({ ok: true, mode: "update" });
    expect(await checkQualifier(mine, reader(false, stacks))).toEqual({ ok: true, mode: "update" });
  });

  it("先の設置が使う qualifier を、後の設置の確認は拒む", async () => {
    const used = reader(true, { [target(FIRST).stackName]: stackOf(FIRST) });
    expect(target(SECOND).qualifier).toBe("nd09bda190");
    const result = await checkQualifier(target(SECOND), used);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toContain("nd09bda190");
  });

  it.each([
    ["タグが違う", stackOf(FIRST, { tags: { "app-prefix": "acme-91474", "app-env": "dev" } })],
    ["タグが欠ける", stackOf(FIRST, { tags: {} })],
    ["qualifier が違う", stackOf(FIRST, { qualifier: "ndffffffff" })],
    ["作成の途中", stackOf(FIRST, { status: "CREATE_IN_PROGRESS" })],
    ["巻き戻した", stackOf(FIRST, { status: "UPDATE_ROLLBACK_COMPLETE" })],
  ])("この名前のスタックの%sと拒む", async (_name, stack) => {
    const result = await checkQualifier(mine, reader(true, { [mine.stackName]: stack }));
    expect(result).toMatchObject({ ok: false });
  });

  it.each([
    ["版の読み取り", { versionExists: async () => Promise.reject(new Error("AccessDenied")), describeStack: async () => null }],
    ["スタックの読み取り", { versionExists: async () => false, describeStack: async () => Promise.reject(new Error("AccessDenied")) }],
  ] as Array<[string, BootstrapReader]>)("%sに失敗すると拒む", async (_name, failing) => {
    const result = await checkQualifier(mine, failing);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toContain("AccessDenied");
  });
});

describe("parseArgs", () => {
  const COMMON = ["--profile", "example", "--settings", "settings.json"];

  it("check と template を解く", () => {
    expect(parseArgs(["check", ...COMMON])).toEqual({ kind: "check", profile: "example", settings: "settings.json" });
    expect(parseArgs(["template", ...COMMON, "--out", "t.json"])).toEqual({
      kind: "template",
      profile: "example",
      settings: "settings.json",
      out: "t.json",
      directRoles: [],
    });
  });

  it("--direct-role を重ねて受ける", () => {
    const roles = [`arn:aws:iam::${FAKE_ACCOUNT}:role/acme-a`, `arn:aws:iam::${FAKE_ACCOUNT}:role/acme-b`];
    const args = parseArgs(["template", ...COMMON, "--out", "t.json", "--direct-role", roles[0]!, "--direct-role", roles[1]!]);
    expect(args).toMatchObject({ directRoles: roles });
  });

  it.each([
    [[]],
    [["deploy"]],
    [["check", "--profile", "example"]],
    [["check", ...COMMON, "--out", "t.json"]],
    [["template", ...COMMON]],
    [["template", ...COMMON, "--out", "t.json", "--direct-role", "*"]],
    [["check", ...COMMON, "--unknown"]],
  ])("引数の誤りは使い方にする（%j）", (argv) => {
    expect(parseArgs(argv)).toMatchObject({ kind: "usage" });
  });
});

describe("mainAppBootstrap", () => {
  const FIXTURE = fileURLToPath(new URL("./fixtures/settings.json", import.meta.url));
  const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
  const STANDARD = standardBootstrapTemplate();
  const OUT_DIR = realpathSync(mkdtempSync(join(tmpdir(), "nd-app-bootstrap-")));

  function run(argv: string[], over: Partial<BootstrapDeps> = {}) {
    const written = new Map<string, string>();
    const out: string[] = [];
    const err: string[] = [];
    const deps: BootstrapDeps = {
      repoRoots: () => [REPO_ROOT],
      cwd: OUT_DIR,
      resolveProfile: async (profile) => ({ profile, account: "123456789012", region: "us-west-2" }),
      reader: () => reader(false),
      readTemplate: () => STANDARD,
      writeText: (path, text) => void written.set(path, text),
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      ...over,
    };
    return mainAppBootstrap(argv, deps).then((code) => ({ code, written, out: out.join("\n"), err: err.join("\n") }));
  }

  const COMMON = ["--profile", "example", "--settings", FIXTURE];

  it("check は衝突が無ければ 0", async () => {
    const result = await run(["check", ...COMMON]);
    expect(result).toMatchObject({ code: 0 });
    expect(result.written.size).toBe(0);
  });

  it("template は書き換えたテンプレートを書き、打つ cdk bootstrap のコマンドを表示する", async () => {
    const result = await run(["template", ...COMMON, "--out", "t.json"]);
    expect(result.code).toBe(0);
    const path = join(OUT_DIR, "t.json");
    expect(JSON.parse(result.written.get(path)!).Resources.NdAppBoundary).toBeDefined();
    const qualifier = appQualifier({ prefix: "acme", environment: "test" });
    for (const part of [
      "cdk bootstrap aws://123456789012/us-west-2",
      "--profile example",
      `--template '${path}'`,
      `--qualifier ${qualifier}`,
      "--toolkit-stack-name acme-test-bootstrap",
      `--cloudformation-execution-policies arn:aws:iam::${FAKE_ACCOUNT}:policy/acme-test-app-cfn-exec`,
      "--tags app-prefix=acme",
      "--tags app-env=test",
    ]) {
      expect(result.out).toContain(part);
    }
  });

  it.each(["check", "template"])("%s は衝突すれば 1 で、何も書かない", async (sub) => {
    const argv = sub === "check" ? [sub, ...COMMON] : [sub, ...COMMON, "--out", "t.json"];
    const result = await run(argv, { reader: () => reader(true) });
    expect(result.code).toBe(1);
    expect(result.written.size).toBe(0);
    expect(result.err).toContain("qualifier");
  });

  it("リポジトリの中の --out は書かずに 1", async () => {
    const result = await run(["template", ...COMMON, "--out", join(REPO_ROOT, "infra", "t.json")]);
    expect(result.code).toBe(1);
    expect(result.written.size).toBe(0);
  });

  it("別の worktree の中の --out は書かずに 1", async () => {
    const other = join(OUT_DIR, "other-worktree");
    const result = await run(["template", ...COMMON, "--out", join(other, "t.json")], { repoRoots: () => [REPO_ROOT, other] });
    expect(result.code).toBe(1);
    expect(result.written.size).toBe(0);
  });

  it("既にあるファイルの --out は書かずに 1", async () => {
    const existing = join(OUT_DIR, "existing.json");
    writeFileSync(existing, "{}");
    const result = await run(["template", ...COMMON, "--out", existing]);
    expect(result.code).toBe(1);
    expect(result.written.size).toBe(0);
    expect(result.err).toContain("別のファイル名");
  });

  it("git の作業ディレクトリでない置き方では、そのディレクトリだけを対象にする", () => {
    expect(repositoryRoots(OUT_DIR)).toEqual([OUT_DIR]);
  });

  it("パスに改行を含む登録済みの worktree も、そのままのパスで対象にする", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "nd-app-bootstrap-git-")));
    const main = join(base, "main");
    const linked = join(base, "linked\nworktree");
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=ops", "-c", "user.email=ops@example.com", "-c", "commit.gpgsign=false", ...args]);
    git("init", "-q", main);
    git("-C", main, "commit", "-q", "--allow-empty", "--no-verify", "-m", "init");
    git("-C", main, "worktree", "add", "-q", "--detach", linked);
    expect(repositoryRoots(main)).toContain(linked);
  });

  it("使えない設定と profile は 1、引数の誤りは 2", async () => {
    expect((await run(["check", "--profile", "example", "--settings", "missing.json"])).code).toBe(1);
    expect((await run(["check", ...COMMON], { resolveProfile: async () => Promise.reject(new Error("no profile")) })).code).toBe(1);
    expect((await run(["check"])).code).toBe(2);
  });
});
