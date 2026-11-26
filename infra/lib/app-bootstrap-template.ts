import type { Settings } from "@nd-factory/contracts/settings";
import { parse } from "yaml";
import {
  appBootstrapNames,
  appQualifier,
  appResourceNames,
  cdkRoleArn,
  deployRoleName,
  launchDeclaredParameterName,
  pipelineResourceNames,
  resourceName,
  settingsParameterName,
  stackName,
  TAG_KEYS,
} from "./naming.ts";

// アプリ専用の bootstrap のテンプレート。打つ版の CDK の標準のテンプレートに、設置ごとの制約と値を当てる。
// 反映のパイプラインは人を待たずに反映するため、起点のブランチの合成が何を作っても、パイプライン自身・
// ほかの設置・段階を決める設定を書き換えられないことを、AWS の側の権限で縛る

export type BootstrapInput = {
  partition: string;
  account: string;
  region: string;
  settings: Pick<Settings, "prefix" | "environment">;
  // 反映のプロジェクトのロールのほかに、反映と公開のロールを引き受けてよい主体
  directRoleArns: string[];
};

type Statement = {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Action: string | string[];
  Resource?: unknown;
  Condition?: Record<string, unknown>;
  Principal?: unknown;
};

export type PolicyDocument = { Version: "2012-10-17"; Statement: Statement[] };

// CloudFormation の TemplateBody の上限。初めての bootstrap にはテンプレートを置くバケットが無い
const MAX_TEMPLATE_BYTES = 51_200;

// 資源の ARN の形。サービスが許すかぎり、この設置の名前の資源に限る
function arnShapes(input: BootstrapInput) {
  const { partition, account, region, settings: s } = input;
  const qualifier = appQualifier(s);
  const prefix = `${s.prefix}-${s.environment}`;
  const secretPrefix = `${s.prefix}/${s.environment}`;
  const arn = (service: string, resource: string, r = region, a = account) => `arn:${partition}:${service}:${r}:${a}:${resource}`;
  const iam = (resource: string) => arn("iam", resource, "");
  const names = appBootstrapNames(s);
  const pipeline = pipelineResourceNames(s);
  const pipelineStackName = stackName(s, "pipeline");
  return {
    function: [arn("lambda", `function:${prefix}-*`)],
    // Lambda のレイヤーの名前は CloudFormation が論理 ID から付け、接頭辞を持たない
    layer: [arn("lambda", "layer:*")],
    logGroup: [arn("logs", `log-group:/aws/lambda/${prefix}-*`), arn("logs", `log-group:${prefix}-*`)],
    table: [arn("dynamodb", `table/${prefix}-*`)],
    bucket: [`arn:${partition}:s3:::${resourceName(s, "app")}-*`],
    assetsBucket: [`arn:${partition}:s3:::cdk-${qualifier}-assets-${account}-${region}`],
    assets: [`arn:${partition}:s3:::cdk-${qualifier}-assets-${account}-${region}/*`],
    apiGateway: ["apis", "apis/*", "tags/*"].map((path) => `arn:${partition}:apigateway:${region}::/${path}`),
    // 名前で限れず、タグで限る資源（Cognito のユーザープールと CloudFront のディストリビューション）
    tagged: [arn("cognito-idp", "userpool/*"), arn("cloudfront", "distribution/*", "")],
    // タグを持てないので、この設置に限れない
    originAccessControl: [arn("cloudfront", "origin-access-control/*", "")],
    ec2: [arn("ec2", "*")],
    // 種類を * にしない。スナップショットはタグの拒否が当たらず、同じ接頭辞のバックアップを消せてしまう
    rds: ["cluster", "db", "cluster-pg", "subgrp"].map((kind) => arn("rds", `${kind}:${prefix}-*`)),
    secret: [arn("secretsmanager", `secret:${secretPrefix}/*`)],
    ecsCluster: [arn("ecs", `cluster/${prefix}-*`)],
    // パイプラインの失敗の知らせのトピックも同じ接頭辞を持つので、アプリのトピックは名前で指す
    topic: [arn("sns", appResourceNames(s).opsTopic)],
    budget: [arn("budgets", `budget/${prefix}-*`, "")],
    bootstrapVersion: [arn("ssm", `parameter/cdk-bootstrap/${qualifier}/version`)],
    serviceLinkedRole: ["rds", "ecs", "replication.dynamodb"].map((service) => iam(`role/aws-service-role/${service}.amazonaws.com/*`)),
    ecrRepository: [arn("ecr", `repository/${prefix}-*`)],
    dbCluster: [arn("rds", `cluster:${prefix}-*`)],
    distribution: [arn("cloudfront", "distribution/*", "")],
    securityGroup: [arn("ec2", "security-group/*")],
    appRole: [iam(`role/${resourceName(s, "app")}-*`)],
    boundary: iam(`policy/${names.boundaryPolicy}`),
    executionPolicy: iam(`policy/${names.executionPolicy}`),
    appStack: arn("cloudformation", `stack/${stackName(s, "app")}/*`),
    pipelineStack: arn("cloudformation", `stack/${pipelineStackName}/*`),
    pipelineRoles: [iam(`role/${deployRoleName(s, region)}`), iam(`role/${pipelineStackName}-*`)],
    pipeline: arn("codepipeline", pipeline.pipeline),
    deployProject: arn("codebuild", `project/${pipeline.deployProject}`),
    parameters: [settingsParameterName(s), launchDeclaredParameterName(s)].map((name) => arn("ssm", `parameter${name}`)),
    // 資源を指定できない操作だけに使う
    any: ["*"],
    // 作る要求に、この設置のタグを求める操作
    requestTagged: ["*"],
  };
}

// この設置のタグの条件
function ownTags(s: BootstrapInput["settings"], context: "aws:RequestTag" | "aws:ResourceTag"): Record<string, unknown> {
  const [prefixKey, envKey] = TAG_KEYS;
  return { StringEquals: { [`${context}/${prefixKey}`]: s.prefix, [`${context}/${envKey}`]: s.environment } };
}

// 別の設置のタグが付いた資源への操作を、サービスによらず拒む。タグの無い資源には当たらない
function otherInstallationDenies(s: BootstrapInput["settings"]): Statement[] {
  const [prefixKey, envKey] = TAG_KEYS;
  return [
    [prefixKey, s.prefix],
    [envKey, s.environment],
  ].map(([key, value]) => {
    const tag = `aws:ResourceTag/${key}`;
    return { Effect: "Deny", Action: "*", Resource: "*", Condition: { Null: { [tag]: "false" }, StringNotEquals: { [tag]: value } } };
  });
}

type Shapes = ReturnType<typeof arnShapes>;
type ListShape = { [K in keyof Shapes]: Shapes[K] extends string[] ? K : never }[keyof Shapes];
type Grant = { on: ListShape; actions: string[] };

const grant = (on: ListShape, service: string, actions: string): Grant => ({
  on,
  actions: actions.split(" ").map((a) => `${service}:${a}`),
});

// この設置の名前で始まる資源は、そのサービスの操作をまとめて許す。操作を 1 つずつ並べると、
// 管理ポリシーの上限の 6,144 文字に収まらない。名前で限れない資源（EC2・Cognito・CloudFront）は操作の形で限り、
// タグでも限る（Cognito と CloudFront は許可の条件、EC2 は otherInstallationDenies の拒否）
const own = (on: ListShape, service: string): Grant => grant(on, service, "*");

const ASSET_READ = grant("assets", "s3", "GetObject*");
const API_GATEWAY = [own("apiGateway", "apigateway")];
const ec2 = (actions: string): Grant[] => [grant("any", "ec2", "Describe*"), grant("ec2", "ec2", `${actions} *Tags`)];
const RDS = [grant("any", "rds", "Describe*"), own("rds", "rds")];
const userPool = [grant("any", "cognito-idp", "CreateUserPool DescribeUserPoolDomain"), grant("tagged", "cognito-idp", "*UserPool* *IdentityProvider *Resource")];
const CUSTOM_RESOURCE = [own("function", "lambda")];
const SECRET = [grant("any", "secretsmanager", "GetRandomPassword"), own("secret", "secretsmanager")];

// アプリのスタックの CloudFormation の資源の型ごとに、作成・更新・削除に要る操作と資源の形。
// IAM のロールと方針の操作は、条件つきの文（iamStatements）が持つ
export const EXECUTION_ALLOW: Readonly<Record<string, readonly Grant[]>> = {
  "AWS::ApiGatewayV2::Api": API_GATEWAY,
  "AWS::ApiGatewayV2::Authorizer": API_GATEWAY,
  "AWS::ApiGatewayV2::Integration": API_GATEWAY,
  "AWS::ApiGatewayV2::Route": API_GATEWAY,
  "AWS::ApiGatewayV2::Stage": API_GATEWAY,
  "AWS::Budgets::Budget": [own("budget", "budgets")],
  "AWS::CDK::Metadata": [],
  // CreateDistribution は資源の ARN を指定できない。作る時点のタグ付けは、資源にまだタグが無いので要求のタグで許す
  "AWS::CloudFront::Distribution": [
    grant("requestTagged", "cloudfront", "CreateDistribution TagResource"),
    grant("tagged", "cloudfront", "*Distribution* *Resource*"),
  ],
  "AWS::CloudFront::OriginAccessControl": [
    grant("any", "cloudfront", "CreateOriginAccessControl"),
    grant("originAccessControl", "cloudfront", "*OriginAccessControl*"),
  ],
  "AWS::Cognito::UserPool": userPool,
  "AWS::Cognito::UserPoolClient": userPool,
  "AWS::Cognito::UserPoolDomain": userPool,
  "AWS::Cognito::UserPoolIdentityProvider": userPool,
  // ListTables は資源を指定できない。サービスリンクロールは、アカウントで初めて作るグローバルテーブルが要る
  "AWS::DynamoDB::GlobalTable": [
    own("table", "dynamodb"),
    grant("any", "dynamodb", "ListTables"),
    grant("serviceLinkedRole", "iam", "CreateServiceLinkedRole"),
  ],
  "AWS::EC2::InternetGateway": ec2("*InternetGateway"),
  "AWS::EC2::Route": ec2("*Route"),
  "AWS::EC2::RouteTable": ec2("*RouteTable"),
  "AWS::EC2::SecurityGroup": ec2("*SecurityGroup*"),
  "AWS::EC2::SecurityGroupEgress": ec2("*SecurityGroup*"),
  "AWS::EC2::SecurityGroupIngress": ec2("*SecurityGroup*"),
  "AWS::EC2::Subnet": ec2("*Subnet *SubnetAttribute"),
  "AWS::EC2::SubnetRouteTableAssociation": ec2("*RouteTable ReplaceRouteTableAssociation"),
  "AWS::EC2::VPC": ec2("*Vpc *VpcAttribute"),
  "AWS::EC2::VPCEndpoint": ec2("*VpcEndpoint*"),
  "AWS::EC2::VPCGatewayAttachment": ec2("*InternetGateway"),
  "AWS::ECS::Cluster": [grant("any", "ecs", "CreateCluster"), own("ecsCluster", "ecs")],
  "AWS::IAM::Policy": [],
  "AWS::IAM::Role": [],
  "AWS::Lambda::EventInvokeConfig": [own("function", "lambda")],
  "AWS::Lambda::Function": [own("function", "lambda"), grant("layer", "lambda", "GetLayerVersion"), ASSET_READ],
  "AWS::Lambda::LayerVersion": [grant("layer", "lambda", "*LayerVersion"), ASSET_READ],
  "AWS::Lambda::Permission": [own("function", "lambda")],
  "AWS::Logs::LogGroup": [grant("any", "logs", "Describe*"), own("logGroup", "logs")],
  "AWS::RDS::DBCluster": [...RDS, grant("serviceLinkedRole", "iam", "CreateServiceLinkedRole")],
  "AWS::RDS::DBClusterParameterGroup": RDS,
  "AWS::RDS::DBInstance": RDS,
  "AWS::RDS::DBSubnetGroup": RDS,
  "AWS::S3::Bucket": [own("bucket", "s3")],
  "AWS::S3::BucketPolicy": [own("bucket", "s3")],
  "AWS::SNS::Subscription": [own("topic", "sns")],
  "AWS::SNS::Topic": [own("topic", "sns")],
  "AWS::SNS::TopicPolicy": [own("topic", "sns")],
  "AWS::SecretsManager::Secret": SECRET,
  "AWS::SecretsManager::SecretTargetAttachment": SECRET,
  "Custom::CDKBucketDeployment": CUSTOM_RESOURCE,
  "Custom::VpcRestrictDefaultSG": CUSTOM_RESOURCE,
};

// アプリのスタックが渡すロールの渡し先
const PASSED_TO_SERVICES = ["lambda.amazonaws.com", "ecs-tasks.amazonaws.com"];

// 境界を指定した場合だけ許す、ロールの権限を変える操作
const BOUNDED_ROLE_ACTIONS = [
  "iam:CreateRole",
  "iam:PutRolePolicy",
  "iam:AttachRolePolicy",
  "iam:DetachRolePolicy",
  "iam:DeleteRolePolicy",
  "iam:PutRolePermissionsBoundary",
];

// CDK の標準の反映のロールが DeployPermissions の文で許す操作。標準の文と順まで照合する
const STANDARD_DEPLOY_PERMISSIONS = [
  "CreateChangeSet",
  "DeleteChangeSet",
  "ExecuteChangeSet",
  "CreateStack",
  "UpdateStack",
  "RollbackStack",
  "ContinueUpdateRollback",
].map((a) => `cloudformation:${a}`);

function iamStatements(shapes: Shapes): Statement[] {
  return [
    {
      Effect: "Allow",
      Action: BOUNDED_ROLE_ACTIONS,
      Resource: shapes.appRole,
      Condition: { ArnEquals: { "iam:PermissionsBoundary": shapes.boundary } },
    },
    {
      Effect: "Allow",
      Action: ["iam:UpdateAssumeRolePolicy", "iam:UpdateRole*", "iam:DeleteRole", "iam:*TagRole", "iam:Get*", "iam:List*"],
      Resource: shapes.appRole,
    },
    {
      Effect: "Allow",
      Action: "iam:PassRole",
      Resource: shapes.appRole,
      Condition: { StringEquals: { "iam:PassedToService": PASSED_TO_SERVICES } },
    },
  ];
}

// パイプライン自身・段階を決める設定・上限を決める方針を変える操作の拒否。
// 対象の資源はアプリの反映が触らないので、サービスの操作をまとめて拒む
function denyStatements(shapes: Shapes): Statement[] {
  return [
    {
      Effect: "Deny",
      Action: ["cloudformation:*", "codepipeline:*", "codebuild:*", "iam:*"],
      Resource: [
        shapes.pipelineStack,
        shapes.pipeline,
        shapes.deployProject,
        ...shapes.pipelineRoles,
        shapes.boundary,
        shapes.executionPolicy,
      ],
    },
    { Effect: "Deny", Action: "iam:DeleteRolePermissionsBoundary", Resource: "*" },
    { Effect: "Deny", Action: ["ssm:PutParameter", "ssm:DeleteParameter*"], Resource: shapes.parameters },
  ];
}

// サービスの操作をまとめて許す条件なしの文を 1 つにする。操作はそのサービスの資源の ARN にしか当たらないので、
// 許可の範囲は変わらず、文ごとの繰り返しの分だけ短くなる
function mergeWholeService(statements: Statement[]): Statement[] {
  const whole = (s: Statement) => s.Condition === undefined && (s.Action as string[]).every((a) => a.endsWith(":*"));
  const merged = statements.filter(whole);
  if (merged.length === 0) return statements;
  return [
    {
      Effect: "Allow",
      Action: merged.flatMap((s) => s.Action),
      Resource: merged.flatMap((s) => s.Resource as string[]),
    },
    ...statements.filter((s) => !whole(s)),
  ];
}

// 同じ資源の形の操作を 1 つの文にまとめる。管理ポリシーの上限（6,144 文字）に収める
function allowStatements(
  grants: readonly Grant[],
  shapes: Shapes,
  conditions: Partial<Record<ListShape, Record<string, unknown>>> = {},
): Statement[] {
  const byShape = new Map<ListShape, Set<string>>();
  for (const g of grants) {
    const actions = byShape.get(g.on) ?? new Set<string>();
    for (const a of g.actions) actions.add(a);
    byShape.set(g.on, actions);
  }
  return mergeWholeService(
    [...byShape].map(([on, actions]) => ({
      Effect: "Allow",
      Action: [...actions].sort(),
      Resource: shapes[on],
      ...(conditions[on] ? { Condition: conditions[on] } : {}),
    })),
  );
}

export function appExecutionPolicy(input: BootstrapInput): PolicyDocument {
  const shapes = arnShapes(input);
  // BootstrapVersion のパラメーターの解決は、資源の型によらず要る
  const base = grant("bootstrapVersion", "ssm", "GetParameter GetParameters");
  return {
    Version: "2012-10-17",
    Statement: [
      ...allowStatements([base, ...Object.values(EXECUTION_ALLOW).flat()], shapes, {
        tagged: ownTags(input.settings, "aws:ResourceTag"),
        requestTagged: ownTags(input.settings, "aws:RequestTag"),
      }),
      ...iamStatements(shapes),
      ...denyStatements(shapes),
      ...otherInstallationDenies(input.settings),
    ],
  };
}

// アプリのロールが使う操作と、この設置の資源の形
const APP_BOUNDARY: readonly Grant[] = [
  grant("logGroup", "logs", "CreateLogGroup CreateLogStream PutLogEvents"),
  grant(
    "table",
    "dynamodb",
    "BatchGetItem BatchWriteItem ConditionCheckItem DeleteItem DescribeTable GetItem GetRecords GetShardIterator PutItem Query Scan UpdateItem",
  ),
  // 画面の配置の関数: アセットを読み、画面のバケットへ書く
  grant("assetsBucket", "s3", "GetObject* GetBucket* List*"),
  grant("assets", "s3", "GetObject* GetBucket* List*"),
  grant(
    "bucket",
    "s3",
    "GetObject* GetBucket* List* DeleteObject* PutObject PutObjectLegalHold PutObjectRetention PutObjectTagging PutObjectVersionTagging Abort*",
  ),
  grant("distribution", "cloudfront", "GetInvalidation CreateInvalidation"),
  // 既定の SG の規則を外す関数
  grant("securityGroup", "ec2", "AuthorizeSecurityGroupIngress AuthorizeSecurityGroupEgress RevokeSecurityGroupIngress RevokeSecurityGroupEgress"),
  // ランナーのタスクの実行のロール
  grant("any", "ecr", "GetAuthorizationToken"),
  grant("ecrRepository", "ecr", "BatchCheckLayerAvailability GetDownloadUrlForLayer BatchGetImage"),
  // DB の用意の関数
  grant("dbCluster", "rds-data", "ExecuteStatement BeginTransaction CommitTransaction RollbackTransaction"),
  grant("secret", "secretsmanager", "GetSecretValue DescribeSecret UpdateSecretVersionStage"),
];

export function appPermissionsBoundary(input: BootstrapInput): PolicyDocument {
  const shapes = arnShapes(input);
  return {
    Version: "2012-10-17",
    Statement: [
      // ディストリビューションは名前で限れないので、この設置のタグが付いたものの無効化だけを許す
      ...allowStatements(APP_BOUNDARY, shapes, { distribution: ownTags(input.settings, "aws:ResourceTag") }),
      { Effect: "Deny", Action: ["ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters"], Resource: shapes.parameters },
      // SG の規則は名前で限れないので、別の設置の分をタグで拒む
      ...otherInstallationDenies(input.settings),
    ],
  };
}

type Resource = { Type: string; Properties: Record<string, unknown>; DependsOn?: string };
type Template = { Parameters: Record<string, { Default?: string }>; Resources: Record<string, Resource> };

function unexpected(what: string): never {
  throw new Error(`CDK の標準の bootstrap のテンプレートが知っている形でない: ${what}。版を上げたときは、制約の当て方を直す`);
}

function resource(template: Template, id: string): Resource {
  return template.Resources?.[id] ?? unexpected(`資源 ${id} が無い`);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// 反映のロールの方針の、知っている文。キーは Sid（無い文は iam:PassRole だけ）
const DEPLOY_ROLE_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  DeployPermissions: STANDARD_DEPLOY_PERMISSIONS,
  PipelineCrossAccountArtifactsBucket: ["s3:GetObject*", "s3:GetBucket*", "s3:List*", "s3:Abort*", "s3:DeleteObject*", "s3:PutObject*"],
  PipelineCrossAccountArtifactsKey: ["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*"],
  PassRole: ["iam:PassRole"],
  CliPermissions: ["cloudformation:DeleteStack", "cloudformation:UpdateTerminationProtection", "sts:GetCallerIdentity"],
  CliStagingBucket: ["s3:GetObject*", "s3:GetBucket*", "s3:List*"],
  ReadVersion: ["ssm:GetParameter", "ssm:GetParameters"],
  Refactor: ["cloudformation:CreateStackRefactor", "cloudformation:ExecuteStackRefactor"],
};

// CloudFormation の書き込みを、この設置のアプリのスタックと実行のロールに限る
function restrictDeployStatements(statements: Statement[], appStack: string, executionRole: string): Statement[] {
  const conditioned = ["cloudformation:CreateChangeSet", "cloudformation:CreateStack", "cloudformation:UpdateStack"];
  const seen = new Set<string>();
  const result = statements.flatMap((s): Statement[] => {
    const key = s.Sid ?? "PassRole";
    const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
    if (seen.has(key) || s.Effect !== "Allow" || !same(actions, DEPLOY_ROLE_ACTIONS[key])) unexpected(`反映のロールの文 ${key}`);
    seen.add(key);
    switch (key) {
      case "DeployPermissions":
        return [
          {
            Sid: key,
            Effect: "Allow",
            Action: conditioned,
            Resource: appStack,
            Condition: { StringEquals: { "cloudformation:RoleArn": executionRole } },
          },
          { Sid: "DeployExistingChanges", Effect: "Allow", Action: actions.filter((a) => !conditioned.includes(a)), Resource: appStack },
        ];
      case "CliPermissions":
        return [
          { Sid: key, Effect: "Allow", Action: actions.filter((a) => a.startsWith("cloudformation:")), Resource: appStack },
          { Sid: "CliIdentity", Effect: "Allow", Action: "sts:GetCallerIdentity", Resource: "*" },
        ];
      case "PassRole":
        if (!same(s.Resource, { "Fn::Sub": "${CloudFormationExecutionRole.Arn}" })) unexpected("iam:PassRole の対象");
        return [s];
      // スタックの再構成は、アプリのスタックの資源をほかのスタックへ移せる
      case "Refactor":
        return [];
      default:
        return [s];
    }
  });
  const missing = Object.keys(DEPLOY_ROLE_ACTIONS).filter((key) => !seen.has(key));
  if (missing.length > 0) unexpected(`反映のロールの文 ${missing.join(", ")} が無い`);
  return result;
}

// 準備のビルドは起点のブランチのコードを実行し、lookup のロールを引き受ける。標準の ReadOnlyAccess は
// DynamoDB の項目などの利用者のデータも読めるので外し、cdk diff --method=template の読み取りだけを許す
function restrictLookupRole(role: Resource, shapes: Shapes): void {
  const standard = [{ "Fn::Sub": "arn:${AWS::Partition}:iam::aws:policy/ReadOnlyAccess" }];
  if (!same(role.Properties.ManagedPolicyArns, standard)) unexpected("lookup のロールの管理ポリシー");
  const policies = role.Properties.Policies as Array<{ PolicyDocument: { Statement: Statement[] } }> | undefined;
  const statements = policies?.length === 1 ? policies[0]!.PolicyDocument.Statement : undefined;
  if (!statements || statements.some((s) => s.Effect !== "Deny")) unexpected("lookup のロールのインラインの方針");
  delete role.Properties.ManagedPolicyArns;
  statements.push(
    { Sid: "NdReadAppStack", Effect: "Allow", Action: ["cloudformation:DescribeStacks", "cloudformation:GetTemplate"], Resource: shapes.appStack },
    { Sid: "NdReadBootstrapVersion", Effect: "Allow", Action: "ssm:GetParameter", Resource: shapes.bootstrapVersion },
  );
}

const ACCOUNT_PRINCIPAL = { AWS: { Ref: "AWS::AccountId" } };

// アカウントの文の引き受けを、渡した ARN に限る。ほかのアカウントを信頼する文は残さない
function restrictTrust(role: Resource, id: string, principalArns: string[]): void {
  const document = role.Properties.AssumeRolePolicyDocument as { Statement: Array<Statement & { "Fn::If"?: unknown[] }> };
  const only = { ArnEquals: { "aws:PrincipalArn": principalArns } };
  const kept = document.Statement.filter((s) => {
    if (s["Fn::If"]?.[0] === "HasTrustedAccounts" || s["Fn::If"]?.[0] === "HasTrustedAccountsForLookup") return false;
    if (s.Effect !== "Allow" || !same(s.Principal, ACCOUNT_PRINCIPAL)) unexpected(`${id} の信頼ポリシー`);
    return true;
  });
  if (!same(kept.map((s) => s.Action), ["sts:AssumeRole", "sts:TagSession"])) unexpected(`${id} の信頼ポリシーの操作`);
  for (const statement of kept) {
    if (statement.Condition === undefined) {
      statement.Condition = only;
      continue;
    }
    // 標準の形: ExternalId を拒むかで条件を切り替える
    const branches = statement.Condition["Fn::If"] as [string, Record<string, unknown>, unknown] | undefined;
    if (branches?.[0] !== "ShouldDenyExternalId") unexpected(`${id} の引き受けの条件`);
    statement.Condition = { "Fn::If": [branches[0], { ...branches[1], ...only }, only] };
  }
  document.Statement = kept;
}

export function restrictBootstrapTemplate(templateYaml: string, input: BootstrapInput): string {
  const template = parse(templateYaml) as Template;
  const s = input.settings;
  const names = appBootstrapNames(s);
  const qualifier = appQualifier(s);
  const shapes = arnShapes(input);

  const variant = template.Parameters?.BootstrapVariant ?? unexpected("パラメーター BootstrapVariant が無い");
  // 違う名前にすると、CLI は標準のテンプレートでの上書きを拒む
  variant.Default = "nd-factory app";

  const principals = [
    `arn:${input.partition}:iam::${input.account}:role/${deployRoleName(s, input.region)}`,
    ...input.directRoleArns,
  ];
  for (const id of ["DeploymentActionRole", "FilePublishingRole", "ImagePublishingRole"]) {
    restrictTrust(resource(template, id), id, principals);
  }

  restrictLookupRole(resource(template, "LookupRole"), shapes);

  const policies = resource(template, "DeploymentActionRole").Properties.Policies as Array<{ PolicyDocument: { Statement: Statement[] } }>;
  if (policies?.length !== 1) unexpected("反映のロールのインラインの方針が 1 つでない");
  const deploy = policies[0]!.PolicyDocument;
  deploy.Statement = restrictDeployStatements(deploy.Statement, shapes.appStack, cdkRoleArn(input, qualifier, "cfn-exec"));

  const bucketPolicy = resource(template, "StagingBucketPolicy").Properties.PolicyDocument as { Statement: Statement[] };
  bucketPolicy.Statement.push({
    Sid: "NdDenyWritesExceptFilePublishing",
    Effect: "Deny",
    Principal: "*",
    Action: ["s3:PutObject*", "s3:DeleteObject*"],
    Resource: { "Fn::Sub": "${StagingBucket.Arn}/*" },
    Condition: { ArnNotEquals: { "aws:PrincipalArn": cdkRoleArn(input, qualifier, "file-publishing") } },
  });

  const managedPolicy = (name: string, document: PolicyDocument): Resource => ({
    Type: "AWS::IAM::ManagedPolicy",
    Properties: { ManagedPolicyName: name, PolicyDocument: document },
  });
  template.Resources.NdExecutionPolicy = managedPolicy(names.executionPolicy, appExecutionPolicy(input));
  template.Resources.NdAppBoundary = managedPolicy(names.boundaryPolicy, appPermissionsBoundary(input));
  resource(template, "CloudFormationExecutionRole").DependsOn = "NdExecutionPolicy";

  const result = JSON.stringify(template);
  if (Buffer.byteLength(result) > MAX_TEMPLATE_BYTES) {
    throw new Error(`書き換えたテンプレートが ${MAX_TEMPLATE_BYTES} バイトを超える（${Buffer.byteLength(result)} バイト）`);
  }
  return result;
}
