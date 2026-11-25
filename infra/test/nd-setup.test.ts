import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "@nd-factory/contracts/exit-codes";
import { describe, expect, it } from "vitest";
import { assemblyDigest } from "../lib/assembly-digest.ts";
import {
  type DeployArgs,
  type DiffArgs,
  type RunOptions,
  type SetupDeps,
  STACKS_FILE,
  SynthError,
  checkBootstrap,
  confirmValue,
  defaultFiles,
  mainSetup,
  parseArgs,
  runDeploy,
  runDiff,
  synthesize,
} from "../setup/nd-setup.ts";
import { ProfileError, type Target } from "../setup/aws-reader.ts";

const FIXTURE = new URL("./fixtures/settings.json", import.meta.url).pathname;
const EXAMPLE = new URL("../settings.example.json", import.meta.url).pathname;
const TARGET: Target = { profile: "acme-test", account: "123456789012", region: "us-west-2" };

type Call = { command: string; args: string[]; options: RunOptions };

type FakeOptions = {
  buildCode?: number;
  synthCode?: number;
  diffCode?: number;
  deployCode?: number;
  requiredBootstrap?: number | null;
  currentBootstrap?: number | null;
  profileError?: boolean;
  target?: Target;
  azs?: number;
};

type Fake = { deps: SetupDeps; calls: Call[]; out: string[]; err: string[] };

function isCdk(call: Call, sub: string): boolean {
  return call.args.includes("cdk") && call.args.includes(sub);
}

// スタックの properties。null なら bootstrap の要求を持たない
function bootstrapProps(required: number | null): { requiresBootstrapStackVersion?: number } {
  return required === null ? {} : { requiresBootstrapStackVersion: required };
}

// 作り物の合成の結果（manifest と app の template）を置き場 dir へ書く
function writeFakeAssembly(dir: string, env: RunOptions["env"], required: number | null): void {
  mkdirSync(dir, { recursive: true });
  const props = bootstrapProps(required);
  const stacks = (env?.ND_STACKS ?? "app").split(",");
  const artifacts = Object.fromEntries(
    stacks.map((k) => [`acme-test-${k}`, { type: "aws:cloudformation:stack", properties: props }]),
  );
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: "1", artifacts }));
  writeFileSync(join(dir, "acme-test-app.template.json"), JSON.stringify({ env: env?.CDK_DEFAULT_ACCOUNT }));
}

// AWS と外部コマンドを差し替えた依存。合成は作り物の合成の結果を置き場へ書く
function fake(o: FakeOptions = {}): Fake {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: SetupDeps = {
    repoRoot: "/repo",
    cwd: "/",
    async run(command, args, options) {
      const call = { command, args, options };
      calls.push(call);
      if (command === "npm" && args.includes("build")) return o.buildCode ?? 0;
      if (isCdk(call, "synth")) {
        const dir = args[args.indexOf("-o") + 1]!;
        const required = o.requiredBootstrap === undefined ? 6 : o.requiredBootstrap;
        writeFakeAssembly(dir, options.env, required);
        return o.synthCode ?? 0;
      }
      if (isCdk(call, "diff")) return o.diffCode ?? 0;
      if (isCdk(call, "deploy")) return o.deployCode ?? 0;
      throw new Error(`想定しない呼び出し: ${command} ${args.join(" ")}`);
    },
    async resolveProfile(profile) {
      if (o.profileError) throw new ProfileError(`profile ${profile} が見つからない`);
      return o.target ?? { ...TARGET, profile };
    },
    async readBootstrapVersion() {
      return o.currentBootstrap === undefined ? 30 : o.currentBootstrap;
    },
    async readCostAllocationTags(_target, keys) {
      return Object.fromEntries(keys.map((k) => [k, "Active" as const]));
    },
    async readOrganizationManager() {
      return { member: false, managementAccount: null };
    },
    async readGetAzsCount() {
      return o.azs ?? 3;
    },
    files: defaultFiles,
    digest: assemblyDigest,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
  return { deps, calls, out, err };
}

function writes(f: Fake): number {
  return f.calls.filter((c) => isCdk(c, "deploy") || c.args.includes("bootstrap")).length;
}

function tempOut(): string {
  return join(mkdtempSync(join(tmpdir(), "nd-setup-")), "assembly");
}

function confirmFrom(f: Fake): string {
  const line = f.out.find((l) => l.startsWith("確認の値: "));
  if (!line) throw new Error("確認の値が出ていない");
  return line.slice("確認の値: ".length);
}

describe("parseArgs", () => {
  it("diff の引数を解く", () => {
    expect(parseArgs(["diff", "--profile", "p", "--settings", "s.json", "--out", "o", "--stack", "pipeline"])).toEqual({
      kind: "diff",
      profile: "p",
      settings: "s.json",
      out: "o",
      stacks: ["pipeline"],
    });
    expect(parseArgs(["diff", "--profile", "p", "--settings", "s.json", "--out", "o"])).toMatchObject({ stacks: null });
  });

  it("deploy の引数を解く", () => {
    expect(parseArgs(["deploy", "--profile", "p", "--assembly", "o", "--confirm", "c"])).toEqual({
      kind: "deploy",
      profile: "p",
      assembly: "o",
      confirm: "c",
    });
  });

  it.each([
    [[]],
    [["apply"]],
    [["diff", "--profile", "p", "--settings", "s"]],
    [["diff", "--profile", "p", "--settings", "s", "--out", "o", "--force"]],
    [["diff", "--profile", "p", "--settings", "s", "--out", "o", "--stack", "db"]],
    [["deploy", "--profile", "p", "--assembly", "o"]],
    [["deploy", "--profile", "p", "--assembly", "o", "--confirm", "c", "--stack", "app"]],
    [["deploy", "--profile", "p", "--assembly", "o", "--confirm", "c", "extra"]],
  ])("誤り %j は UsageError", (argv) => {
    expect(parseArgs(argv).kind).toBe("usage");
  });
});

describe("mainSetup", () => {
  it("diff を振り分けて 0 を返す", async () => {
    const f = fake();
    const code = await mainSetup(["diff", "--profile", "acme-test", "--settings", FIXTURE, "--out", tempOut()], f.deps);
    expect(code).toBe(EXIT.OK);
    expect(f.calls.some((c) => isCdk(c, "diff"))).toBe(true);
  });

  it("deploy を振り分ける", async () => {
    const f = fake();
    const code = await mainSetup(["deploy", "--profile", "acme-test", "--assembly", tempOut(), "--confirm", "x"], f.deps);
    expect(code).toBe(EXIT.SETTINGS);
  });

  it("未知の引数と deploy の --stack は 2 で、AWS へ書かない", async () => {
    const f = fake();
    expect(await mainSetup(["diff", "--nope"], f.deps)).toBe(EXIT.USAGE);
    expect(await mainSetup(["deploy", "--profile", "p", "--assembly", "o", "--confirm", "c", "--stack", "app"], f.deps)).toBe(EXIT.USAGE);
    expect(f.calls).toHaveLength(0);
    expect(f.err.join("\n")).toContain("npm run nd-setup --");
  });

  it("想定しない例外は 6 で、例外の名前を出す", async () => {
    const f = fake();
    f.deps.resolveProfile = async () => {
      throw new TypeError("壊れた");
    };
    const code = await mainSetup(["diff", "--profile", "p", "--settings", FIXTURE, "--out", tempOut()], f.deps);
    expect(code).toBe(EXIT.BUILD);
    expect(f.err.join("\n")).toContain("TypeError");
  });
});

// runDiff の引数。既定は作り物の設定・acme-test・新しい置き場・全部の stack
function diffOpts(overrides: Partial<Omit<DiffArgs, "kind">> = {}): DiffArgs {
  return {
    kind: "diff",
    profile: overrides.profile ?? "acme-test",
    settings: overrides.settings ?? FIXTURE,
    out: overrides.out ?? tempOut(),
    stacks: overrides.stacks === undefined ? null : overrides.stacks,
  };
}

describe("runDiff", () => {
  it("通れば 0 で、差分・資源の名前・戻り先の URL・確認の値を出し、AWS へ書かない", async () => {
    const f = fake();
    const out = tempOut();
    const code = await runDiff(diffOpts({ out }), f.deps);
    expect(code).toBe(EXIT.OK);
    expect(writes(f)).toBe(0);
    const diff = f.calls.find((c) => isCdk(c, "diff"))!;
    expect(diff.args).toEqual(expect.arrayContaining(["--app", out, "--method=template", "acme-test-app", "acme-test-pipeline"]));
    const text = f.out.join("\n");
    expect(text).toContain("acme-test-accounts");
    expect(text).toContain("https://acme-test-login.auth.us-west-2.amazoncognito.com/oauth2/idpresponse");
    const stacks = JSON.parse(readFileSync(join(out, STACKS_FILE), "utf8")) as { stacks: string[] };
    expect(stacks.stacks).toEqual(["app", "pipeline"]);
    expect(confirmFrom(f)).toBe(confirmValue(await assemblyDigest(out), TARGET, ["app", "pipeline"]));
  });

  it("出力の最後に足りない設定の欄を出す", async () => {
    const f = fake();
    await runDiff(diffOpts(), f.deps);
    const head = f.out.indexOf("足りない設定:");
    expect(head).toBeGreaterThan(f.out.findIndex((l) => l.startsWith("確認の値: ")));
    // 作り物の設定は Google のクライアントの ID と運用の知らせの宛先を持たない
    const rows = f.out.slice(head + 1);
    expect(rows).toHaveLength(2);
    expect(rows.every((l) => l.startsWith("  - "))).toBe(true);
    expect(rows.join("\n")).toContain("Google のクライアントの ID が無い");
    expect(rows.join("\n")).toContain("ops.notify_emails");
  });

  it("足りない設定があっても終了コードは 0 で、AWS へ書かない", async () => {
    const f = fake({ azs: 1 });
    const code = await runDiff(diffOpts(), f.deps);
    expect(code).toBe(EXIT.OK);
    expect(writes(f)).toBe(0);
    expect(f.out.join("\n")).toContain("Fn::GetAZs が返す AZ が 1 つ");
  });

  it("足りない設定の照らしが投げても終了コードは 0 で、確かめられない行を出す", async () => {
    const f = fake();
    f.deps.readOrganizationManager = async () => {
      throw new Error("壊れた");
    };
    f.deps.readCostAllocationTags = async () => ({ "app-prefix": "Inactive", "app-env": "Active" });
    const code = await runDiff(diffOpts(), f.deps);
    expect(code).toBe(EXIT.OK);
    expect(f.out.join("\n")).toContain("を確かめられない（Error: 壊れた）");
  });

  it("差分が失敗すれば足りない設定の欄を出さない", async () => {
    const f = fake({ diffCode: 1 });
    await runDiff(diffOpts(), f.deps);
    expect(f.out.some((l) => l.startsWith("足りない設定"))).toBe(false);
  });

  it("合成は作り物でない profile の主体とリージョンを合成へ渡す", async () => {
    const f = fake();
    await runDiff(diffOpts(), f.deps);
    const synth = f.calls.find((c) => isCdk(c, "synth"))!;
    expect(synth.options.env).toMatchObject({
      ND_SETTINGS: FIXTURE,
      ND_STACKS: "app,pipeline",
      CDK_DEFAULT_ACCOUNT: "123456789012",
      CDK_DEFAULT_REGION: "us-west-2",
    });
    expect(synth.args).toEqual(expect.arrayContaining(["--profile", "acme-test"]));
  });

  it("--stack pipeline だけなら一覧は pipeline だけ", async () => {
    const f = fake();
    const out = tempOut();
    const code = await runDiff(diffOpts({ out, stacks: ["pipeline"] }), f.deps);
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(readFileSync(join(out, STACKS_FILE), "utf8"))).toMatchObject({ stacks: ["pipeline"] });
    expect(confirmFrom(f)).toMatch(/:pipeline$/);
    expect(f.out.join("\n")).not.toContain("idpresponse");
  });

  it("pipeline の無い設定で --stack pipeline なら 2", async () => {
    const f = fake();
    const code = await runDiff(diffOpts({ profile: "p", settings: EXAMPLE, stacks: ["pipeline"] }), f.deps);
    expect(code).toBe(EXIT.USAGE);
    expect(f.calls).toHaveLength(0);
  });

  it("設定のファイルが無ければ 3 で、合成も profile も呼ばない", async () => {
    const f = fake({ profileError: true });
    const code = await runDiff(diffOpts({ profile: "p", settings: "/nd-no-such/settings.json" }), f.deps);
    expect(code).toBe(EXIT.SETTINGS);
    expect(f.calls).toHaveLength(0);
  });

  it("設定のファイルが形に合わなければ 3 で、誤ったキーを 1 件 1 行で出す", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nd-setup-bad-"));
    const path = join(dir, "s.json");
    writeFileSync(path, JSON.stringify({ prefix: "Acme", login: { google: {} } }));
    const f = fake();
    const code = await runDiff(diffOpts({ profile: "p", settings: path }), f.deps);
    expect(code).toBe(EXIT.SETTINGS);
    expect(f.err.filter((l) => l.startsWith("prefix:") || l.startsWith("environment:"))).toHaveLength(2);
    expect(writes(f)).toBe(0);
  });

  it("profile の失敗は 4 で、合成を呼ばない", async () => {
    const f = fake({ profileError: true });
    const code = await runDiff(diffOpts({ profile: "p" }), f.deps);
    expect(code).toBe(EXIT.PROFILE);
    expect(f.calls).toHaveLength(0);
  });

  it.each([
    ["画面のビルド", { buildCode: 1 }],
    ["合成", { synthCode: 1 }],
    ["差分の作成", { diffCode: 1 }],
  ])("%s の失敗は 6 で、AWS へ書かない", async (_name, opts) => {
    const f = fake(opts);
    const code = await runDiff(diffOpts({ profile: "p" }), f.deps);
    expect(code).toBe(EXIT.BUILD);
    expect(writes(f)).toBe(0);
    expect(f.out.some((l) => l.startsWith("確認の値"))).toBe(false);
  });

  it("bootstrap の版が足りなければ 5 で、求める版と今の版を出し、差分を作らない", async () => {
    const f = fake({ requiredBootstrap: 30, currentBootstrap: 21 });
    const code = await runDiff(diffOpts({ profile: "p" }), f.deps);
    expect(code).toBe(EXIT.BOOTSTRAP);
    expect(f.err.join("\n")).toMatch(/30/);
    expect(f.err.join("\n")).toMatch(/21/);
    expect(f.calls.some((c) => isCdk(c, "diff"))).toBe(false);
    expect(writes(f)).toBe(0);
  });

  it("bootstrap が無ければ 5", async () => {
    const f = fake({ currentBootstrap: null });
    const code = await runDiff(diffOpts({ profile: "p" }), f.deps);
    expect(code).toBe(EXIT.BOOTSTRAP);
    expect(writes(f)).toBe(0);
  });

  it("bootstrap の版を読めなければ 5", async () => {
    const f = fake();
    f.deps.readBootstrapVersion = async () => {
      throw new Error("AccessDenied");
    };
    const code = await runDiff(diffOpts({ profile: "p" }), f.deps);
    expect(code).toBe(EXIT.BOOTSTRAP);
    expect(writes(f)).toBe(0);
  });
});

async function diffThen(f: Fake): Promise<{ out: string; confirm: string }> {
  const out = tempOut();
  const code = await runDiff(diffOpts({ out }), f.deps);
  expect(code).toBe(EXIT.OK);
  return { out, confirm: confirmFrom(f) };
}

function deployOpts(out: string, confirm: string, overrides: Partial<Pick<DeployArgs, "profile">> = {}): DeployArgs {
  return { kind: "deploy", profile: overrides.profile ?? "acme-test", assembly: out, confirm };
}

describe("runDeploy", () => {
  it("確認の値が同じなら、保存した置き場を cdk deploy --app で 1 回だけ反映し、合成しない", async () => {
    const first = fake();
    const { out, confirm } = await diffThen(first);
    const f = fake();
    const code = await runDeploy(deployOpts(out, confirm), f.deps);
    expect(code).toBe(EXIT.OK);
    const deploys = f.calls.filter((c) => isCdk(c, "deploy"));
    expect(deploys).toHaveLength(1);
    expect(deploys[0]!.args).toEqual(
      expect.arrayContaining(["--app", out, "--profile", "acme-test", "acme-test-app", "acme-test-pipeline"]),
    );
    expect(f.calls.filter((c) => isCdk(c, "synth") || c.args.includes("build"))).toHaveLength(0);
  });

  it("置き場を書き換えると 7 で、AWS へ書かない", async () => {
    const { out, confirm } = await diffThen(fake());
    writeFileSync(join(out, "acme-test-app.template.json"), "{}");
    const f = fake();
    expect(await runDeploy(deployOpts(out, confirm), f.deps)).toBe(EXIT.CONFIRM_MISMATCH);
    expect(writes(f)).toBe(0);
  });

  it("別のアカウントの profile なら 7 で、AWS へ書かない", async () => {
    const { out, confirm } = await diffThen(fake());
    const f = fake({ target: { profile: "other", account: "210987654321", region: "us-west-2" } });
    expect(await runDeploy(deployOpts(out, confirm, { profile: "other" }), f.deps)).toBe(EXIT.CONFIRM_MISMATCH);
    expect(writes(f)).toBe(0);
  });

  it("置き場とアカウントが同じでも、確認の値だけが違えば 7 で、AWS へ書かない", async () => {
    const { out, confirm } = await diffThen(fake());
    const [digest, ...rest] = confirm.split(":");
    const other = [digest === "0".repeat(12) ? "f".repeat(12) : "0".repeat(12), ...rest].join(":");
    expect(other).not.toBe(confirm);
    const f = fake();
    expect(await runDeploy(deployOpts(out, other), f.deps)).toBe(EXIT.CONFIRM_MISMATCH);
    expect(writes(f)).toBe(0);
  });

  it("置き場が無ければ 3", async () => {
    const f = fake();
    expect(await runDeploy(deployOpts(tempOut(), "x", { profile: "p" }), f.deps)).toBe(EXIT.SETTINGS);
    expect(f.calls).toHaveLength(0);
  });

  it("スタックの一覧が無ければ 3", async () => {
    const out = tempOut();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "manifest.json"), "{}");
    const f = fake();
    expect(await runDeploy(deployOpts(out, "x", { profile: "p" }), f.deps)).toBe(EXIT.SETTINGS);
    expect(writes(f)).toBe(0);
  });

  it("profile の失敗は 4", async () => {
    const { out, confirm } = await diffThen(fake());
    const f = fake({ profileError: true });
    expect(await runDeploy(deployOpts(out, confirm, { profile: "p" }), f.deps)).toBe(EXIT.PROFILE);
    expect(writes(f)).toBe(0);
  });

  it("bootstrap の失敗は 5", async () => {
    const { out, confirm } = await diffThen(fake());
    const f = fake({ currentBootstrap: 1 });
    expect(await runDeploy(deployOpts(out, confirm), f.deps)).toBe(EXIT.BOOTSTRAP);
    expect(writes(f)).toBe(0);
  });

  it("cdk deploy の失敗は 8", async () => {
    const { out, confirm } = await diffThen(fake());
    const f = fake({ deployCode: 1 });
    expect(await runDeploy(deployOpts(out, confirm), f.deps)).toBe(EXIT.DEPLOY_FAILED);
    expect(f.calls.filter((c) => isCdk(c, "deploy"))).toHaveLength(1);
  });
});

describe("synthesize", () => {
  it("置き場に合成の結果と選んだスタックの一覧を書く", async () => {
    const f = fake();
    const out = tempOut();
    await synthesize(FIXTURE, out, ["app"], TARGET, f.deps);
    expect(existsSync(join(out, "manifest.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(out, STACKS_FILE), "utf8"))).toEqual({
      stacks: ["app"],
      stack_names: ["acme-test-app"],
    });
    expect(f.calls[0]).toMatchObject({ command: "npm", args: ["run", "build", "-w", "apps/web"] });
  });

  it("前の置き場の中身は消える", async () => {
    const out = tempOut();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "old.txt"), "old");
    await synthesize(FIXTURE, out, ["app"], TARGET, fake().deps);
    expect(existsSync(join(out, "old.txt"))).toBe(false);
  });

  it("ビルドの失敗は SynthError", async () => {
    await expect(synthesize(FIXTURE, tempOut(), ["app"], TARGET, fake({ buildCode: 2 }).deps)).rejects.toBeInstanceOf(SynthError);
  });

  it("合成の失敗は SynthError", async () => {
    await expect(synthesize(FIXTURE, tempOut(), ["app"], TARGET, fake({ synthCode: 1 }).deps)).rejects.toBeInstanceOf(SynthError);
  });
});

describe("checkBootstrap", () => {
  function assemblyRequiring(required: number | null): string {
    const dir = mkdtempSync(join(tmpdir(), "nd-boot-"));
    const props = bootstrapProps(required);
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ artifacts: { a: { type: "aws:cloudformation:stack", properties: props }, b: { type: "cdk:tree" } } }),
    );
    return dir;
  }

  it("今の版が求める版より高ければ ok", async () => {
    expect(await checkBootstrap(assemblyRequiring(6), TARGET, fake({ currentBootstrap: 30 }).deps)).toEqual({ ok: true });
  });

  it("同じ版でも ok", async () => {
    expect(await checkBootstrap(assemblyRequiring(6), TARGET, fake({ currentBootstrap: 6 }).deps)).toEqual({ ok: true });
  });

  it("低ければ 2 つの版つきで ng", async () => {
    expect(await checkBootstrap(assemblyRequiring(6), TARGET, fake({ currentBootstrap: 5 }).deps)).toEqual({
      ok: false,
      required: 6,
      current: 5,
    });
  });

  it("無ければ current は null", async () => {
    expect(await checkBootstrap(assemblyRequiring(6), TARGET, fake({ currentBootstrap: null }).deps)).toEqual({
      ok: false,
      required: 6,
      current: null,
    });
  });

  it("manifest に版が無ければ投げる", async () => {
    await expect(checkBootstrap(assemblyRequiring(null), TARGET, fake().deps)).rejects.toThrow(/bootstrap/);
  });
});

describe("confirmValue", () => {
  const digest = "0123456789abcdef".repeat(4);

  it("<要約値の先頭 12 桁>:<アカウント>:<リージョン>:<スタック> の形", () => {
    expect(confirmValue(digest, TARGET, ["app"])).toBe("0123456789ab:123456789012:us-west-2:app");
  });

  it("スタックの順は入力の順に依らず app・pipeline の順", () => {
    expect(confirmValue(digest, TARGET, ["pipeline", "app"])).toBe(confirmValue(digest, TARGET, ["app", "pipeline"]));
    expect(confirmValue(digest, TARGET, ["pipeline", "app"])).toMatch(/:app,pipeline$/);
  });
});
