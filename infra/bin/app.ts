import { fileURLToPath } from "node:url";
import { App } from "aws-cdk-lib";
import { AppStack } from "../lib/app-stack.ts";
import { STACK_KEYS, type StackKey, stackName } from "../lib/naming.ts";
import { PipelineStack } from "../lib/pipeline-stack.ts";
import { loadSettingsFile } from "../lib/settings-file.ts";

// 合成のエントリポイント。設定のファイルと作るスタックを環境変数から受ける。
// アカウントとリージョンは CDK_DEFAULT_* から受け、lookup を使わないため資格情報なしで合成できる

const DEFAULT_WEB_DIST = fileURLToPath(new URL("../../apps/web/dist", import.meta.url));

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`環境変数 ${name} が無い`);
  return value;
}

function isStackKey(value: string): value is StackKey {
  return (STACK_KEYS as readonly string[]).includes(value);
}

function selectedStacks(env: NodeJS.ProcessEnv, hasPipeline: boolean): StackKey[] {
  const raw = env.ND_STACKS;
  if (!raw) return hasPipeline ? ["app", "pipeline"] : ["app"];
  const keys = raw.split(",").map((k) => k.trim());
  const unknown = keys.filter((k) => !isStackKey(k));
  if (unknown.length > 0) throw new Error(`ND_STACKS に知らないスタックがある: ${unknown.join(", ")}（app と pipeline だけ）`);
  return keys as StackKey[];
}

export function buildApp(app: App, env: NodeJS.ProcessEnv): void {
  const settingsPath = required(env, "ND_SETTINGS");
  const account = required(env, "CDK_DEFAULT_ACCOUNT");
  const region = required(env, "CDK_DEFAULT_REGION");
  const settings = loadSettingsFile(settingsPath);
  const stacks = selectedStacks(env, settings.pipeline !== undefined);
  if (stacks.includes("pipeline") && !settings.pipeline) {
    throw new Error("設定のファイルに pipeline が無いため、pipeline のスタックは作れない");
  }
  const target = { account, region };
  const appStackName = stackName(settings, "app");

  if (stacks.includes("app")) {
    new AppStack(app, appStackName, {
      env: target,
      settings,
      webDistPath: env.ND_WEB_DIST || DEFAULT_WEB_DIST,
    });
  }
  if (stacks.includes("pipeline")) {
    new PipelineStack(app, stackName(settings, "pipeline"), { env: target, settings, appStackName });
  }
}

if (import.meta.main) {
  const app = new App();
  buildApp(app, process.env);
  app.synth();
}
