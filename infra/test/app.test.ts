import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { buildApp } from "../bin/app.ts";
import { appQualifier } from "../lib/naming.ts";
import { tempWebDist } from "./support.ts";

const EXAMPLE = new URL("../settings.example.json", import.meta.url).pathname;
const FIXTURE = new URL("./fixtures/settings.json", import.meta.url).pathname;

function env(settings: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ND_SETTINGS: settings,
    CDK_DEFAULT_ACCOUNT: "123456789012",
    CDK_DEFAULT_REGION: "us-west-2",
    ND_WEB_DIST: tempWebDist(),
    ...extra,
  };
}

// Lambda の束ねは別のテストで確かめる。ここではスタックの組み合わせだけを見るため束ねを飛ばす
function newApp(): App {
  return new App({ context: { "aws:cdk:bundling-stacks": [] } });
}

function stackNames(app: App): string[] {
  return app
    .synth()
    .stacks.map((s) => s.stackName)
    .sort();
}

describe("buildApp", () => {
  it("見本の設定ではアプリのスタックだけ", () => {
    const app = newApp();
    buildApp(app, env(EXAMPLE));
    expect(stackNames(app)).toEqual(["acme-test-app"]);
  });

  it("pipeline のある設定では 2 つのスタック", () => {
    const app = newApp();
    buildApp(app, env(FIXTURE));
    expect(stackNames(app)).toEqual(["acme-test-app", "acme-test-pipeline"]);
  });

  it("ND_STACKS=pipeline ではパイプラインのスタックだけ", () => {
    const app = newApp();
    buildApp(app, env(FIXTURE, { ND_STACKS: "pipeline" }));
    expect(stackNames(app)).toEqual(["acme-test-pipeline"]);
  });

  it("ND_STACKS=app ではパイプラインのある設定でもアプリのスタックだけ", () => {
    const app = newApp();
    buildApp(app, env(FIXTURE, { ND_STACKS: "app" }));
    expect(stackNames(app)).toEqual(["acme-test-app"]);
  });

  it("スタックは作り物のアカウントとリージョンへ向く", () => {
    const app = newApp();
    buildApp(app, env(EXAMPLE));
    const stack = app.synth().stacks[0]!;
    expect(stack.environment).toMatchObject({ account: "123456789012", region: "us-west-2" });
  });

  it("pipeline の無い設定のアプリのスタックは、既定の qualifier で合成する", () => {
    const app = newApp();
    buildApp(app, env(EXAMPLE));
    const artifact = app.synth().getStackByName("acme-test-app");
    expect(artifact.assumeRoleArn).toContain("cdk-hnb659fds-deploy-role-");
    expect(artifact.cloudFormationExecutionRoleArn).toContain("cdk-hnb659fds-cfn-exec-role-");
    expect(JSON.stringify(artifact.template)).not.toContain("PermissionsBoundary");
  });

  describe("pipeline のある設定のアプリのスタック", () => {
    const QUALIFIER = appQualifier({ prefix: "acme", environment: "test" });
    const BOUNDARY = ":policy/acme-test-app-boundary";

    it.each([{}, { ND_STACKS: "app" }] as Array<Record<string, string>>)(
      "アプリ専用の qualifier で合成し、すべてのロールが境界を持つ（%j）",
      (extra) => {
        const app = newApp();
        buildApp(app, env(FIXTURE, extra));
        const artifact = app.synth().getStackByName("acme-test-app");
        expect(artifact.assumeRoleArn).toContain(`cdk-${QUALIFIER}-deploy-role-`);
        expect(artifact.cloudFormationExecutionRoleArn).toContain(`cdk-${QUALIFIER}-cfn-exec-role-`);
        expect(JSON.stringify(artifact.template)).not.toContain("hnb659fds");
        const roles = Object.values(artifact.template.Resources as Record<string, { Type: string; Properties?: Record<string, unknown> }>).filter(
          (r) => r.Type === "AWS::IAM::Role",
        );
        expect(roles.length).toBeGreaterThanOrEqual(6);
        for (const role of roles) expect(JSON.stringify(role.Properties?.PermissionsBoundary)).toContain(BOUNDARY);
      },
    );

    it("パイプラインのスタックは既定の qualifier のままで、境界を付けない", () => {
      const app = newApp();
      buildApp(app, env(FIXTURE));
      const artifact = app.synth().getStackByName("acme-test-pipeline");
      expect(artifact.assumeRoleArn).toContain("cdk-hnb659fds-deploy-role-");
      expect(JSON.stringify(artifact.template)).not.toContain("PermissionsBoundary");
    });
  });

  it("pipeline の無い設定で ND_STACKS に pipeline があれば止める", () => {
    expect(() => buildApp(newApp(), env(EXAMPLE, { ND_STACKS: "pipeline" }))).toThrow(/pipeline/);
  });

  it("ND_STACKS に知らない名前があれば止める", () => {
    expect(() => buildApp(newApp(), env(FIXTURE, { ND_STACKS: "app,db" }))).toThrow(/ND_STACKS/);
  });

  it.each(["ND_SETTINGS", "CDK_DEFAULT_ACCOUNT", "CDK_DEFAULT_REGION"])("%s が無ければ止める", (name) => {
    const e = env(FIXTURE);
    delete e[name];
    expect(() => buildApp(newApp(), e)).toThrow(name);
  });

  it("設定のファイルが形に合わなければ止める", () => {
    const dir = mkdtempSync(join(tmpdir(), "nd-app-"));
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ prefix: "acme" }));
    expect(() => buildApp(newApp(), env(path))).toThrow(/environment/);
  });
});
