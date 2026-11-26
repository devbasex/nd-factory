import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { buildApp } from "../bin/app.ts";
import { appExecutionPolicy, appPermissionsBoundary } from "../lib/app-bootstrap-template.ts";
import { type GuardConfig, policyDigest } from "../lib/assembly-check.ts";
import { appQualifier } from "../lib/naming.ts";
import { tempWebDist } from "./support.ts";

// 反映の直前の検査にかかわるテストが共有する作り物の値と、実際のアプリの合成の結果

export const QUALIFIER = appQualifier({ prefix: "acme", environment: "test" });
export const ACCOUNT_ARN = "arn:aws:iam::123456789012";
export const cdkRole = (kind: string, qualifier = QUALIFIER) =>
  `${ACCOUNT_ARN}:role/cdk-${qualifier}-${kind}-role-123456789012-us-west-2`;
export const BUCKET = `cdk-${QUALIFIER}-assets-123456789012-us-west-2`;
export const BOUNDARY_ARN = `${ACCOUNT_ARN}:policy/acme-test-app-boundary`;

const POLICY_INPUT = {
  partition: "aws",
  account: "123456789012",
  region: "us-west-2",
  settings: { prefix: "acme", environment: "test" },
  directRoleArns: [],
};

export const GUARD: GuardConfig = {
  partition: "aws",
  account: "123456789012",
  region: "us-west-2",
  appStack: "acme-test-app",
  pipelineName: "acme-test-pipeline",
  pipelineStack: "acme-test-pipeline",
  settingsParameter: "/acme/test/settings",
  recordParameter: "/acme/test/launch-declared",
  qualifier: QUALIFIER,
  deployRoleName: "acme-test-deploy-us-west-2",
  appArns: {
    executionRole: cdkRole("cfn-exec"),
    deployRole: cdkRole("deploy"),
    filePublishingRole: cdkRole("file-publishing"),
    assetsBucket: `arn:aws:s3:::${BUCKET}`,
    executionPolicy: `${ACCOUNT_ARN}:policy/acme-test-app-cfn-exec`,
    boundaryPolicy: BOUNDARY_ARN,
  },
  policyDigests: {
    execution: policyDigest(appExecutionPolicy(POLICY_INPUT)),
    boundary: policyDigest(appPermissionsBoundary(POLICY_INPUT)),
  },
};

// 実際のアプリのスタックを束ねも含めて合成した結果。壊すテストは写しを書き換える
let assemblyDir: string | undefined;
export function realAssembly(): string {
  if (assemblyDir) return assemblyDir;
  const outdir = mkdtempSync(join(tmpdir(), "nd-assembly-"));
  const app = new App({ outdir });
  buildApp(app, {
    ND_SETTINGS: new URL("./fixtures/settings.json", import.meta.url).pathname,
    ND_STACKS: "app",
    CDK_DEFAULT_ACCOUNT: "123456789012",
    CDK_DEFAULT_REGION: "us-west-2",
    ND_WEB_DIST: tempWebDist(),
  });
  app.synth();
  assemblyDir = outdir;
  return outdir;
}

export type Manifest = { artifacts: Record<string, { type: string; properties: Record<string, unknown>; dependencies?: string[] }> };

export const readJsonFile = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;

export function mutated<T>(file: string, mutate: (value: T, dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "nd-assembly-copy-"));
  cpSync(realAssembly(), dir, { recursive: true });
  const value = readJsonFile<T>(join(dir, file));
  mutate(value, dir);
  writeFileSync(join(dir, file), JSON.stringify(value));
  return dir;
}

export const stackProps = (m: Manifest) => m.artifacts["acme-test-app"]!.properties;
