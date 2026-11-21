import { readFileSync } from "node:fs";
import type { Settings } from "@nd-factory/contracts/settings";
import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import { BuildSpec, ComputeType, LinuxBuildImage, PipelineProject } from "aws-cdk-lib/aws-codebuild";
import { Artifact, ExecutionMode, Pipeline, PipelineType } from "aws-cdk-lib/aws-codepipeline";
import {
  CodeBuildAction,
  CodeStarConnectionsSourceAction,
  ManualApprovalAction,
} from "aws-cdk-lib/aws-codepipeline-actions";
import { CfnConnection } from "aws-cdk-lib/aws-codestarconnections";
import { SnsTopic } from "aws-cdk-lib/aws-events-targets";
import { Effect, ManagedPolicy, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { Topic } from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { ParameterTier, StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { ASSEMBLY_DIGEST_SHELL } from "./assembly-digest.ts";
import { applyTags, pipelineResourceNames, settingsParameterName } from "./naming.ts";

// 反映のパイプラインのスタック。取る → 準備 → 承認 → 反映 を CodePipeline で直に組む。
// 承認の資料に、反映するのと同じ合成の結果の差分を示すため、差分と要約値は準備のアクションが作り、
// 反映のアクションは同じ合成の結果を照らしてから反映する。反映するのはアプリのスタックだけで、
// このスタック自身は設置のコマンドで反映する（push だけで反映の役割の権限を広げられないようにする）

// CodeStar の接続の名前の上限
const MAX_CONNECTION_NAME = 32;

// 準備のアクションの変数の名前空間。承認と反映の設定から #{Prepare.<名前>} で読む
const PREPARE_NAMESPACE = "Prepare";

// 既定の qualifier の bootstrap の役割。CodeBuild の役割はこれを引き受けるだけで、ほかの権限を持たない
const BOOTSTRAP_QUALIFIER = "hnb659fds";

// 準備のアクションの中で、SSM から書き出した設定のファイルを置く場所。成果物には入れない
const SETTINGS_COPY = "/tmp/nd-settings.json";

const INFRA_DIR = '"$CODEBUILD_SRC_DIR/infra"';

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

// 準備のアクションの手順。設定を SSM から書き出し、アプリのスタックだけを合成して差分と要約値を作る
export function prepareBuildSpec(s: Settings, appStack: string): BuildSpec {
  return BuildSpec.fromObject({
    version: "0.2",
    env: {
      shell: "bash",
      "exported-variables": ["COMMIT", "ASSEMBLY_DIGEST", "DIGEST_PREFIX", "STACKS", "BUILD_URL"],
    },
    phases: {
      install: {
        "runtime-versions": { nodejs: 22 },
        // リポジトリの .node-version の Node で、.ts をそのまま打つ
        commands: ['n "$(cat .node-version)"', "node --version"],
      },
      build: {
        commands: [
          // 設定の全文は記録へ出さない
          `aws ssm get-parameter --name ${settingsParameterName(s)} --query Parameter.Value --output text > ${SETTINGS_COPY}`,
          "npm ci",
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

// 反映のアクションの手順。合成し直さず、受けた合成の結果の要約値を数え直し、承認した値と同じときだけ反映する
export function deployBuildSpec(appStack: string, cdkVersion: string): BuildSpec {
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
          `ACTUAL_DIGEST="$(cd cdk.out && ${ASSEMBLY_DIGEST_SHELL})"`,
          'echo "承認した要約値 $EXPECTED_DIGEST / 数え直した要約値 $ACTUAL_DIGEST"',
          'if [ -z "$EXPECTED_DIGEST" ] || [ "$ACTUAL_DIGEST" != "$EXPECTED_DIGEST" ]; then echo "合成の結果が承認したものと違うため反映しない"; exit 1; fi',
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

    // 承認の結果を送る操作を拒む方針。作るだけで、AI が使う主体へ付けるのは人の作業にする
    new ManagedPolicy(this, "DenyApprovalPolicy", {
      managedPolicyName: names.denyApprovalPolicy,
      description: "反映のパイプラインの承認を送らせない。設置のコマンドを打つ AI の主体へ人が付ける",
      statements: [
        new PolicyStatement({ effect: Effect.DENY, actions: ["codepipeline:PutApprovalResult"], resources: ["*"] }),
      ],
    });

    const bootstrapRole = (kind: string) =>
      `arn:${this.partition}:iam::${this.account}:role/cdk-${BOOTSTRAP_QUALIFIER}-${kind}-role-${this.account}-${this.region}`;

    const buildEnvironment = { buildImage: LinuxBuildImage.STANDARD_7_0, computeType: ComputeType.SMALL };

    const prepareProject = new PipelineProject(this, "PrepareProject", {
      projectName: names.prepareProject,
      buildSpec: prepareBuildSpec(s, props.appStackName),
      environment: buildEnvironment,
      timeout: Duration.minutes(30),
    });
    // 読むだけ: 設定のパラメーターと、差分のための lookup の役割
    prepareProject.addToRolePolicy(
      new PolicyStatement({ actions: ["ssm:GetParameter"], resources: [settingsParam.parameterArn] }),
    );
    prepareProject.addToRolePolicy(new PolicyStatement({ actions: ["sts:AssumeRole"], resources: [bootstrapRole("lookup")] }));

    const deployProject = new PipelineProject(this, "DeployProject", {
      projectName: names.deployProject,
      buildSpec: deployBuildSpec(props.appStackName, cdkCliVersion()),
      environment: buildEnvironment,
      timeout: Duration.minutes(60),
    });
    deployProject.addToRolePolicy(
      new PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [bootstrapRole("deploy"), bootstrapRole("file-publishing")],
      }),
    );

    const source = new Artifact("Source");
    const assembly = new Artifact("Assembly");

    const prepareAction = new CodeBuildAction({
      actionName: "Prepare",
      project: prepareProject,
      input: source,
      outputs: [assembly],
      variablesNamespace: PREPARE_NAMESPACE,
    });

    const pipeline = new Pipeline(this, "Pipeline", {
      pipelineName: names.pipeline,
      pipelineType: PipelineType.V2,
      executionMode: ExecutionMode.SUPERSEDED,
      artifactBucket,
      restartExecutionOnUpdate: false,
      stages: [
        {
          stageName: "Source",
          actions: [
            new CodeStarConnectionsSourceAction({
              actionName: "Source",
              connectionArn: connection.attrConnectionArn,
              owner,
              repo,
              branch: p.branch,
              output: source,
              triggerOnPush: true,
            }),
          ],
        },
        { stageName: "Prepare", actions: [prepareAction] },
        {
          stageName: "Approve",
          actions: [
            new ManualApprovalAction({
              actionName: "Approve",
              notificationTopic: topic,
              additionalInformation: `コミット ${prepareAction.variable("COMMIT")} / 合成の結果 ${prepareAction.variable("DIGEST_PREFIX")} / ${prepareAction.variable("STACKS")}。差分の全文は準備の記録にある`,
              externalEntityLink: prepareAction.variable("BUILD_URL"),
            }),
          ],
        },
        {
          stageName: "Deploy",
          actions: [
            new CodeBuildAction({
              actionName: "Deploy",
              project: deployProject,
              input: assembly,
              environmentVariables: { EXPECTED_DIGEST: { value: prepareAction.variable("ASSEMBLY_DIGEST") } },
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
}
