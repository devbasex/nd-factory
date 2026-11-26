import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import type { Settings } from "@nd-factory/contracts/settings";
import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import { BuildSpec, ComputeType, LinuxBuildImage, PipelineProject } from "aws-cdk-lib/aws-codebuild";
import {
  Artifact,
  ExecutionMode,
  GlobalVariables,
  Pipeline,
  PipelineType,
  ProviderType,
} from "aws-cdk-lib/aws-codepipeline";
import {
  CodeBuildAction,
  CodeStarConnectionsSourceAction,
} from "aws-cdk-lib/aws-codepipeline-actions";
import { CfnConnection } from "aws-cdk-lib/aws-codestarconnections";
import { SnsTopic } from "aws-cdk-lib/aws-events-targets";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { Topic } from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { ParameterTier, StringParameter } from "aws-cdk-lib/aws-ssm";
import { RegionInfo } from "aws-cdk-lib/region-info";
import type { Construct } from "constructs";
import { buildSync } from "esbuild";
import { appExecutionPolicy, appPermissionsBoundary } from "./app-bootstrap-template.ts";
import { type GuardConfig, policyDigest } from "./assembly-check.ts";
import { ASSEMBLY_DIGEST_SHELL } from "./assembly-digest.ts";
import {
  appBootstrapArns,
  appQualifier,
  applyTags,
  cdkRoleArn,
  deployRoleName,
  launchDeclaredParameterName,
  pipelineResourceNames,
  settingsParameterName,
  stackName,
} from "./naming.ts";

// 反映のパイプラインのスタック。取る → 準備 → 反映 を CodePipeline で直に組む。人の承認の段は持たない（持ち主の決定、2026-11-25、#164）。
// 反映するのと同じ合成の結果の差分を準備の記録に残すため、差分と要約値は準備のアクションが作り、
// 反映のアクションは同じ合成の結果を照らしてから反映する。人を待たないので、反映のアクションは
// cdk deploy の直前に、起点のブランチから変えられない検査（deploy-guard.ts）を打つ。反映するのはアプリのスタックだけで、
// このスタック自身は設置のコマンドで反映する（push だけで反映の役割の権限を広げられないようにする）

// CodeStar の接続の名前の上限
const MAX_CONNECTION_NAME = 32;

// 準備のアクションの変数の名前空間。反映の設定から #{Prepare.<名前>} で読む
const PREPARE_NAMESPACE = "Prepare";

// 準備のアクションの中で、SSM から書き出した設定のファイルを置く場所。成果物には入れない
const SETTINGS_COPY = "/tmp/nd-settings.json";
// SSM のパラメーターの値を JSON の文字列のまま受ける場所
const SETTINGS_VALUE_COPY = "/tmp/nd-settings.value.json";

// JSON の文字列を解いて改行を足さずに書き、書いた中身の SHA-256 を出す。反映の側の検査と同じ数え方にする
const DECODE_SETTINGS =
  'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));fs.writeFileSync(process.argv[2],v);process.stdout.write(require("node:crypto").createHash("sha256").update(v,"utf8").digest("hex"))';

const INFRA_DIR = '"$CODEBUILD_SRC_DIR/infra"';

// 準備と反映のプロジェクトの実行の環境
const BUILD_ENVIRONMENT = { buildImage: LinuxBuildImage.STANDARD_7_0, computeType: ComputeType.SMALL };

// 反映のアクションが入れる CDK の CLI の版。最上位の package.json の版に揃え、手元の設置のコマンドと同じ CLI で反映する
export function cdkCliVersion(): string {
  const root = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  const version = root.devDependencies?.["aws-cdk"];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("最上位の package.json の devDependencies に aws-cdk の固定の版が無い");
  }
  return version;
}

// 準備のアクションの手順。版を指定して読んだ設定を書き出し、NDF の契約を照合してから、
// アプリのスタックだけを合成して差分と要約値を作る
export function prepareBuildSpec(s: Settings, appStack: string): BuildSpec {
  const parameter = settingsParameterName(s);
  return BuildSpec.fromObject({
    version: "0.2",
    env: {
      shell: "bash",
      "exported-variables": [
        "COMMIT",
        "ASSEMBLY_DIGEST",
        "DIGEST_PREFIX",
        "STACKS",
        "BUILD_URL",
        "SETTINGS_VERSION",
        "SETTINGS_SHA256",
      ],
    },
    phases: {
      install: {
        "runtime-versions": { nodejs: 22 },
        // リポジトリの .node-version の Node で、.ts をそのまま打つ
        commands: ['n "$(cat .node-version)"', "node --version"],
      },
      build: {
        commands: [
          // 設定の全文は記録へ出さない。版を先に読み、その版の値で合成する
          `SETTINGS_VERSION="$(aws ssm get-parameter --name ${parameter} --query Parameter.Version --output text)"`,
          `aws ssm get-parameter --name "${parameter}:$SETTINGS_VERSION" --query Parameter.Value --output json > ${SETTINGS_VALUE_COPY}`,
          // 代入だけの命令にして、node の失敗を終了コードに残す
          `SETTINGS_SHA256="$(node -e '${DECODE_SETTINGS}' ${SETTINGS_VALUE_COPY} ${SETTINGS_COPY})"`,
          "export SETTINGS_VERSION SETTINGS_SHA256",
          "npm ci",
          "mkdir -p infra/approval",
          // 食い違いで合成へ進まないよう、ほかの命令とつながずに打つ
          "npm run ndf-contract -- --summary infra/approval/ndf-contract.md",
          "npm run build:web",
          `cd ${INFRA_DIR} && ND_SETTINGS=${SETTINGS_COPY} ND_STACKS=app npx --no-install cdk synth -q -o cdk.out`,
          `cd ${INFRA_DIR} && mkdir -p approval && set -o pipefail && npx --no-install cdk diff --app cdk.out --method=template ${appStack} 2>&1 | tee approval/diff.txt`,
          `cd ${INFRA_DIR} && export ASSEMBLY_DIGEST="$(cd cdk.out && ${ASSEMBLY_DIGEST_SHELL})"`,
          'export DIGEST_PREFIX="${ASSEMBLY_DIGEST:0:12}"',
          'export COMMIT="$CODEBUILD_RESOLVED_SOURCE_VERSION"',
          `export STACKS=${appStack}`,
          'export BUILD_URL="$CODEBUILD_BUILD_URL"',
          'echo "コミット $COMMIT / 合成の結果の要約値 $ASSEMBLY_DIGEST / スタック $STACKS"',
        ],
      },
    },
    artifacts: {
      "base-directory": "infra",
      files: ["cdk.out/**/*", "approval/**/*"],
    },
  });
}

// 反映の直前の検査を 1 つの ESM に束ね、gzip と base64 にする。反映の段は起点のブランチのソースを受けないので、
// 手順へ埋め込む。S3 のアセットにすると、反映のプロジェクトのロールに読み取りの権限が要る
export function bundleDeployGuard(): string {
  const result = buildSync({
    stdin: {
      contents: 'import { main } from "./deploy-guard.ts";\nawait main();\n',
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node22",
    minify: true,
    charset: "utf8",
    logLevel: "silent",
  });
  return gzipSync(result.outputFiles[0]!.contents, { level: 9 }).toString("base64");
}

// 反映のアクションの手順。合成し直さず、直前の検査を打ち、受けた合成の結果の要約値を数え直して、
// 準備が作った値と同じときだけ反映する
export function deployBuildSpec(appStack: string, cdkVersion: string, guard: string): BuildSpec {
  return BuildSpec.fromObject({
    version: "0.2",
    env: { shell: "bash" },
    phases: {
      install: {
        "runtime-versions": { nodejs: 22 },
        commands: [`npm install -g aws-cdk@${cdkVersion}`],
      },
      build: {
        commands: [
          `printf %s '${guard}' | base64 -d | gunzip > /tmp/nd-deploy-guard.mjs`,
          "node /tmp/nd-deploy-guard.mjs cdk.out",
          `ACTUAL_DIGEST="$(cd cdk.out && ${ASSEMBLY_DIGEST_SHELL})"`,
          'echo "準備が作った要約値 $EXPECTED_DIGEST / 数え直した要約値 $ACTUAL_DIGEST"',
          'if [ -z "$EXPECTED_DIGEST" ] || [ "$ACTUAL_DIGEST" != "$EXPECTED_DIGEST" ]; then echo "合成の結果が準備したものと違うため反映しない"; exit 1; fi',
          `cdk deploy --app cdk.out --require-approval never ${appStack}`,
        ],
      },
    },
  });
}

export type PipelineStackProps = StackProps & {
  settings: Settings;
  // パイプラインが反映するアプリのスタックの名前
  appStackName: string;
};

// 検査へ渡す名前と ARN、承認した方針の本文の要約値。パイプラインのスタックは人の承認の後に反映するので、
// この合成の時点の方針が承認したものになる
export function guardConfig(stack: Stack, s: Settings, appStack: string): GuardConfig {
  const { partition, account, region } = stack;
  const target = { partition, account, region };
  const qualifier = appQualifier(s);
  const names = pipelineResourceNames(s);
  // 方針の本文は app-bootstrap のコマンドと同じ値で作る。要約値を数えるので、パーティションは token にしない
  const input = { partition: RegionInfo.get(region).partition ?? "aws", account, region, settings: s, directRoleArns: [] };
  return {
    ...target,
    appStack,
    pipelineName: names.pipeline,
    pipelineStack: stackName(s, "pipeline"),
    settingsParameter: names.settingsParameter,
    recordParameter: launchDeclaredParameterName(s),
    qualifier,
    deployRoleName: deployRoleName(s, region),
    appArns: {
      executionRole: cdkRoleArn(target, qualifier, "cfn-exec"),
      deployRole: cdkRoleArn(target, qualifier, "deploy"),
      filePublishingRole: cdkRoleArn(target, qualifier, "file-publishing"),
      ...appBootstrapArns(target, s),
    },
    policyDigests: {
      execution: policyDigest(appExecutionPolicy(input)),
      boundary: policyDigest(appPermissionsBoundary(input)),
    },
  };
}

export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);
    const s = props.settings;
    const p = s.pipeline;
    if (!p) throw new Error("設定のファイルに pipeline が無いため、反映のパイプラインのスタックを作れない");
    const names = pipelineResourceNames(s);
    if (names.connection.length > MAX_CONNECTION_NAME) {
      throw new Error(
        `GitHub との接続の名前 ${names.connection} が ${MAX_CONNECTION_NAME} 文字を超える（${names.connection.length} 文字）。prefix か environment を短くする`,
      );
    }
    const [owner, repo] = p.repository.split("/") as [string, string];

    // 作った直後は PENDING。組織の持ち主がコンソールで有効にする
    const connection = new CfnConnection(this, "GitHubConnection", {
      connectionName: names.connection,
      providerType: "GitHub",
    });

    const artifactBucket = new Bucket(this, "ArtifactBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(30) }],
    });

    const topic = new Topic(this, "NotifyTopic", { topicName: names.notifyTopic });
    for (const email of p.notify_emails ?? []) topic.addSubscription(new EmailSubscription(email));

    // 運用する環境の設定のファイルの正本。準備のアクションがここから読む
    const settingsParam = new StringParameter(this, "SettingsParameter", {
      parameterName: names.settingsParameter,
      stringValue: JSON.stringify(s, null, 2),
      tier: ParameterTier.STANDARD,
    });

    // アプリ専用の bootstrap の役割。CodeBuild の役割はこれを引き受ける
    const guard = guardConfig(this, s, props.appStackName);
    const prepareProject = this.createPrepareProject(s, props.appStackName, guard, settingsParam);
    const deployProject = this.createDeployProject(s, props.appStackName, guard);

    const source = new Artifact("Source");
    const assembly = new Artifact("Assembly");

    const prepareAction = new CodeBuildAction({
      actionName: "Prepare",
      project: prepareProject,
      input: source,
      outputs: [assembly],
      variablesNamespace: PREPARE_NAMESPACE,
    });

    // 反映の直前の検査は始まり方が push のトリガーの実行だけを通すため、ソースの変更の検知は使わない
    const sourceAction = new CodeStarConnectionsSourceAction({
      actionName: "Source",
      connectionArn: connection.attrConnectionArn,
      owner,
      repo,
      branch: p.branch,
      output: source,
      triggerOnPush: false,
    });

    const pipeline = new Pipeline(this, "Pipeline", {
      pipelineName: names.pipeline,
      pipelineType: PipelineType.V2,
      executionMode: ExecutionMode.SUPERSEDED,
      artifactBucket,
      restartExecutionOnUpdate: false,
      triggers: [
        {
          providerType: ProviderType.CODE_STAR_SOURCE_CONNECTION,
          gitConfiguration: { sourceAction, pushFilter: [{ branchesIncludes: [p.branch] }] },
        },
      ],
      stages: [
        { stageName: "Source", actions: [sourceAction] },
        { stageName: "Prepare", actions: [prepareAction] },
        {
          stageName: "Deploy",
          actions: [
            new CodeBuildAction({
              actionName: "Deploy",
              project: deployProject,
              input: assembly,
              environmentVariables: {
                EXPECTED_DIGEST: { value: prepareAction.variable("ASSEMBLY_DIGEST") },
                SETTINGS_VERSION: { value: prepareAction.variable("SETTINGS_VERSION") },
                SETTINGS_SHA256: { value: prepareAction.variable("SETTINGS_SHA256") },
                PIPELINE_EXECUTION_ID: { value: GlobalVariables.executionId },
              },
            }),
          ],
        },
      ],
    });

    pipeline.onStateChange("FailedNotice", {
      target: new SnsTopic(topic),
      ruleName: names.failedRule,
      eventPattern: { detail: { state: ["FAILED"] } },
    });

    applyTags(this, s);
  }

  // 準備のプロジェクトと、その権限
  private createPrepareProject(s: Settings, appStack: string, guard: GuardConfig, settingsParam: StringParameter): PipelineProject {
    const prepareProject = new PipelineProject(this, "PrepareProject", {
      projectName: pipelineResourceNames(s).prepareProject,
      buildSpec: prepareBuildSpec(s, appStack),
      environment: BUILD_ENVIRONMENT,
      timeout: Duration.minutes(30),
    });
    // 読むだけ: 設定のパラメーターと、差分のための lookup の役割
    prepareProject.addToRolePolicy(
      new PolicyStatement({ actions: ["ssm:GetParameter"], resources: [settingsParam.parameterArn] }),
    );
    prepareProject.addToRolePolicy(new PolicyStatement({ actions: ["sts:AssumeRole"], resources: [cdkRoleArn(guard, guard.qualifier, "lookup")] }));
    return prepareProject;
  }

  // 反映のプロジェクトと、その役割と権限
  private createDeployProject(s: Settings, appStack: string, guard: GuardConfig): PipelineProject {
    const names = pipelineResourceNames(s);
    const bootstrapRole = (kind: string) => cdkRoleArn(guard, guard.qualifier, kind);
    const arn = (service: string, resource: string) => `arn:${this.partition}:${service}:${this.region}:${this.account}:${resource}`;

    // bootstrap の信頼ポリシーがこの名前を指すので、固定する
    const deployRole = new Role(this, "DeployProjectRole", {
      roleName: guard.deployRoleName,
      assumedBy: new ServicePrincipal("codebuild.amazonaws.com"),
    });
    const deployProject = new PipelineProject(this, "DeployProject", {
      projectName: names.deployProject,
      buildSpec: deployBuildSpec(appStack, cdkCliVersion(), bundleDeployGuard()),
      environment: BUILD_ENVIRONMENT,
      environmentVariables: { ND_GUARD_CONFIG: { value: this.toJsonString(guard) } },
      role: deployRole,
      timeout: Duration.minutes(60),
    });
    deployProject.addToRolePolicy(
      new PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: ["deploy", "file-publishing", "image-publishing", "cfn-exec"].map(bootstrapRole),
      }),
    );
    // 直前の検査の読み取り。パイプラインの ARN は参照すると循環するので名前から組み立てる
    deployProject.addToRolePolicy(
      new PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [guard.settingsParameter, guard.recordParameter].map((name) => arn("ssm", `parameter${name}`)),
      }),
    );
    deployProject.addToRolePolicy(
      new PolicyStatement({ actions: ["codepipeline:GetPipelineExecution"], resources: [arn("codepipeline", names.pipeline)] }),
    );
    deployProject.addToRolePolicy(
      new PolicyStatement({
        actions: ["iam:ListAttachedRolePolicies", "iam:ListRolePolicies", "iam:GetRole", "iam:SimulatePrincipalPolicy"],
        resources: [guard.appArns.executionRole, guard.appArns.deployRole],
      }),
    );
    deployProject.addToRolePolicy(
      new PolicyStatement({
        actions: ["iam:GetPolicy", "iam:GetPolicyVersion"],
        resources: [guard.appArns.executionPolicy, guard.appArns.boundaryPolicy],
      }),
    );
    return deployProject;
  }
}
