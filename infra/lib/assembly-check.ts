import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Stage } from "./confirmation-stage.ts";

// 反映の直前の検査のうち、合成の結果を調べる部分。合成するのは起点のブランチのコードなので、反映の側で
// 形（許した成果物だけのアプリのスタックか）、変換の有無、段階の値、IAM のロールを確かめる。反映の段に束ねるので、
// 読むのは node: の組み込みだけにする

// 検査へ渡す名前と ARN。パイプラインのスタックが作る
export type GuardConfig = {
  partition: string;
  account: string;
  region: string;
  appStack: string;
  pipelineName: string;
  pipelineStack: string;
  settingsParameter: string;
  recordParameter: string;
  qualifier: string;
  // 反映のプロジェクトのロールの名前
  deployRoleName: string;
  appArns: {
    executionRole: string;
    deployRole: string;
    filePublishingRole: string;
    assetsBucket: string;
    executionPolicy: string;
    boundaryPolicy: string;
  };
  // 承認した管理ポリシーの本文の要約値（policyDigest）
  policyDigests: { execution: string; boundary: string };
};

// 方針の本文の要約値。キーの順の違いは同じ本文とする
export function policyDigest(document: unknown): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (!isObject(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  };
  return createHash("sha256").update(JSON.stringify(sorted(document)) ?? "", "utf8").digest("hex");
}

const ALLOWED_ARTIFACT_TYPES = ["aws:cloudformation:stack", "cdk:asset-manifest", "cdk:tree", "cdk:feature-flag-report"];

const STAGE_KEY = "ND_CONFIRMATION_STAGE";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown, what: string): Json {
  if (!isObject(value)) throw new Error(`合成の結果の${what}の形が違う`);
  return value;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`合成の結果の${what}が無い`);
  return value;
}

function noLinks(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error(`合成の結果にリンクがある: ${path}`);
  if (info.isDirectory()) for (const name of readdirSync(path)) noLinks(join(path, name));
}

// 合成の結果の中の相対パスで、.. とリンクを含まないものだけを受ける
function inside(dir: string, path: unknown): string {
  const rel = text(path, "パス");
  const parts = rel.split("/");
  if (isAbsolute(rel) || parts.includes("..")) throw new Error(`合成の結果の外を指すパス: ${rel}`);
  let current = dir;
  for (const part of parts) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`合成の結果にリンクがある: ${rel}`);
  }
  noLinks(current);
  return current;
}

function readJson(path: string): Json {
  return object(JSON.parse(readFileSync(path, "utf8")), `ファイル ${path}`);
}

type Artifact = { id: string; type: string; properties: Json; dependencies: unknown[] };

function artifactsOf(dir: string): Artifact[] {
  const manifest = readJson(inside(dir, "manifest.json"));
  return Object.entries(object(manifest.artifacts, "成果物の一覧")).map(([id, raw]) => {
    const a = object(raw, `成果物 ${id}`);
    const type = text(a.type, `成果物 ${id} の種類`);
    if (!ALLOWED_ARTIFACT_TYPES.includes(type)) throw new Error(`許していない種類の成果物: ${id}（${type}）`);
    return {
      id,
      type,
      properties: a.properties === undefined ? {} : object(a.properties, `成果物 ${id} の属性`),
      dependencies: Array.isArray(a.dependencies) ? a.dependencies : [],
    };
  });
}

type Destination = { url: string; bucket: string };
type FileAsset = { path: string; destinations: Destination[] };

function fileAssets(dir: string, manifest: Artifact, bucket: string, partition: string): FileAsset[] {
  const assets = readJson(inside(dir, manifest.properties.file as string));
  const images = assets.dockerImages === undefined ? {} : object(assets.dockerImages, "イメージのアセット");
  if (Object.keys(images).length > 0) throw new Error("コンテナのイメージのアセットは反映しない");
  const unknown = Object.keys(assets).filter((k) => !["version", "files", "dockerImages"].includes(k));
  if (unknown.length > 0) throw new Error(`アセットの定義に知らないキーがある: ${unknown.join(", ")}`);
  return Object.entries(assets.files === undefined ? {} : object(assets.files, "ファイルのアセット")).map(([id, raw]) => {
    const asset = object(raw, `アセット ${id}`);
    const source = object(asset.source, `アセット ${id} の元`);
    // executable は外部のコマンドを実行する
    const extra = Object.keys(source).filter((k) => k !== "path" && k !== "packaging");
    if (extra.length > 0) throw new Error(`アセット ${id} の元に許していないキーがある: ${extra.join(", ")}`);
    inside(dir, source.path);
    const destinations = Object.values(object(asset.destinations, `アセット ${id} の置き先`)).map((value) => {
      const d = object(value, `アセット ${id} の置き先`);
      const name = text(d.bucketName, "置き先のバケット").replaceAll("${AWS::Partition}", partition);
      // バケットの名前はアカウント ID を含むので、記録へ出さない
      if (name !== bucket) throw new Error(`アセット ${id} の置き先がアプリ専用のバケットでない`);
      return { bucket: name, url: `s3://${name}/${text(d.objectKey, "置き先のキー")}` };
    });
    if (destinations.length === 0) throw new Error(`アセット ${id} に置き先が無い`);
    return { path: source.path as string, destinations };
  });
}

export type CheckedAssembly = { templateFile: string; templateKey: string; requiredBootstrapVersion: number };

// スタックが 1 つで、アプリのスタックとアプリ専用のロールであること
function appStackOf(artifacts: Artifact[], config: GuardConfig): Artifact {
  const stacks = artifacts.filter((a) => a.type === "aws:cloudformation:stack");
  if (stacks.length !== 1) throw new Error(`スタックが 1 つでない（${stacks.length} 個）`);
  const stack = stacks[0]!;
  const p = stack.properties;
  const stackName = p.stackName ?? stack.id;
  // スタックの名前は環境の名前を含むので、記録へ出さない
  if (stackName !== config.appStack) throw new Error("アプリのスタックでない");

  const role = (value: unknown) => (typeof value === "string" ? value.replaceAll("${AWS::Partition}", config.partition) : value);
  if (role(p.cloudFormationExecutionRoleArn) !== config.appArns.executionRole) {
    throw new Error("スタックの実行のロールがアプリ専用のロールでない");
  }
  if (role(p.assumeRoleArn) !== config.appArns.deployRole) throw new Error("スタックの反映のロールがアプリ専用のロールでない");
  return stack;
}

// スタックが依存するアセットのマニフェストと、アプリ専用のバケットに置くアセット
function stackAssets(dir: string, artifacts: Artifact[], stack: Artifact, bucket: string, partition: string) {
  const manifests = artifacts.filter((a) => a.type === "cdk:asset-manifest");
  if (manifests.some((m) => !stack.dependencies.includes(m.id))) throw new Error("スタックが依存しないアセットのマニフェストがある");
  return { manifests, assets: manifests.flatMap((m) => fileAssets(dir, m, bucket, partition)) };
}

// テンプレートの URL が、アプリ専用のバケットの中身の SHA-256 のキーで、アセットの置き先と合うこと
function checkTemplateUrl(dir: string, stack: Artifact, assets: FileAsset[], bucket: string) {
  const p = stack.properties;
  // cdk deploy は手元のファイルでなく、この URL のオブジェクトを CloudFormation へ渡す
  const templateFile = text(p.templateFile, "テンプレートのファイル名");
  const digest = createHash("sha256").update(readFileSync(inside(dir, templateFile))).digest("hex");
  const url = text(p.stackTemplateAssetObjectUrl, "テンプレートの URL");
  const templateKey = `${digest}.json`;
  if (url !== `s3://${bucket}/${templateKey}`) throw new Error("テンプレートの URL がアプリ専用のバケットの、中身の SHA-256 のキーでない");
  const templates = assets.filter((a) => a.path === templateFile);
  if (templates.length !== 1 || templates[0]!.destinations.some((d) => d.url !== url)) {
    throw new Error("テンプレートの URL とアセットの置き先が違う");
  }
  const others = assets.filter((a) => a.path !== templateFile).flatMap((a) => a.destinations);
  if (others.some((d) => d.url.endsWith(".json"))) throw new Error("テンプレートのほかに .json のキーのアセットがある");
  return { templateFile, templateKey };
}

// スタックとマニフェストが求める bootstrap の版の最大
function bootstrapVersionOf(artifacts: Artifact[]): number {
  const versions = artifacts.map((a) => a.properties.requiresBootstrapStackVersion);
  const required = Math.max(...versions.map((v) => (typeof v === "number" ? v : 0)));
  if (required <= 0) throw new Error("求める bootstrap の版が分からない");
  return required;
}

// 合成の結果が、許した形のアプリのスタックだけであることを確かめる
export function checkAssembly(dir: string, config: GuardConfig): CheckedAssembly {
  const artifacts = artifactsOf(dir);
  const stack = appStackOf(artifacts, config);
  const bucket = config.appArns.assetsBucket.split(":::")[1]!;
  const { manifests, assets } = stackAssets(dir, artifacts, stack, bucket, config.partition);
  const { templateFile, templateKey } = checkTemplateUrl(dir, stack, assets, bucket);
  const requiredBootstrapVersion = bootstrapVersionOf([stack, ...manifests]);
  return { templateFile, templateKey, requiredBootstrapVersion };
}

type Resource = { Type?: unknown; Properties?: Json };

function resourcesOf(template: unknown): Record<string, Resource> {
  return object(object(template, "テンプレート").Resources, "テンプレートの資源") as Record<string, Resource>;
}

function hasTransformFunction(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasTransformFunction);
  if (!isObject(value)) return false;
  return Object.hasOwn(value, "Fn::Transform") || Object.values(value).some(hasTransformFunction);
}

// 変換（マクロ）の違反。変換の後のテンプレートは段階と IAM のロールの検査が読めないので、変換を持つものは反映しない
export function checkTemplateTransforms(template: unknown): string[] {
  const root = object(template, "テンプレート");
  const violations: string[] = [];
  if (Object.hasOwn(root, "Transform")) violations.push("テンプレートに Transform がある");
  if (hasTransformFunction(root)) violations.push("テンプレートに Fn::Transform がある");
  return violations;
}

// 値の中の Ref・Fn::GetAtt・Fn::Sub が指す論理 ID を集める
function references(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) references(v, found);
  if (!isObject(value)) return found;
  if (typeof value.Ref === "string") found.push(value.Ref);
  const att = value["Fn::GetAtt"];
  if (Array.isArray(att) && typeof att[0] === "string") found.push(att[0]);
  if (typeof att === "string") found.push(att.split(".")[0]!);
  const sub = value["Fn::Sub"];
  const pattern = Array.isArray(sub) ? sub[0] : sub;
  if (typeof pattern === "string") for (const m of pattern.matchAll(/\$\{([A-Za-z0-9]+)(?:\.[A-Za-z0-9.]+)?\}/g)) found.push(m[1]!);
  for (const v of Object.values(value)) references(v, found);
  return found;
}

// 別名とバージョンは FunctionName の先の関数にする
function functionsBehind(resources: Record<string, Resource>, value: unknown, seen = new Set<string>()): string[] {
  return references(value).flatMap((id) => {
    if (seen.has(id)) return [];
    seen.add(id);
    const r = resources[id];
    if (r?.Type === "AWS::Lambda::Function") return [id];
    if (r?.Type === "AWS::Lambda::Alias" || r?.Type === "AWS::Lambda::Version") {
      return functionsBehind(resources, r.Properties?.FunctionName, seen);
    }
    return [];
  });
}

// テンプレートのどこかにあるキー ND_CONFIRMATION_STAGE の値を集める
function stageValues(value: unknown, found: unknown[] = []): unknown[] {
  if (Array.isArray(value)) for (const v of value) stageValues(v, found);
  if (!isObject(value)) return found;
  for (const [key, v] of Object.entries(value)) {
    if (key === STAGE_KEY) found.push(v);
    else stageValues(v, found);
  }
  return found;
}

// 段階の値の違反。API Gateway が呼ぶ関数は、期待が ai なら全部が ai を持ち、human なら未設定も許す
export function checkTemplateStage(template: unknown, expected: Stage): string[] {
  const resources = resourcesOf(template);
  const violations: string[] = [];
  const targets = new Set<string>();
  let integrations = 0;
  for (const [id, r] of Object.entries(resources)) {
    const integration = r.Type === "AWS::ApiGatewayV2::Integration";
    const authorizer = r.Type === "AWS::ApiGatewayV2::Authorizer" && r.Properties?.AuthorizerType === "REQUEST";
    if (!integration && !authorizer) continue;
    const found = functionsBehind(resources, integration ? r.Properties?.IntegrationUri : r.Properties?.AuthorizerUri);
    if (found.length === 0) violations.push(`${id} の呼び出し先を関数に結び付けられない`);
    if (integration) integrations += found.length;
    for (const f of found) targets.add(f);
  }
  if (integrations === 0) violations.push("API の統合の呼び出し先の関数が 1 つも無い");
  if (expected === "ai") {
    for (const id of targets) {
      const variables = (resources[id]!.Properties?.Environment as { Variables?: Json } | undefined)?.Variables;
      if (variables?.[STAGE_KEY] !== expected) violations.push(`${id} の ${STAGE_KEY} が ${expected} でない`);
    }
  }
  const wrong = stageValues(template).filter((v) => v !== expected);
  if (wrong.length > 0) violations.push(`期待する段階 ${expected} と違う ${STAGE_KEY} が ${wrong.length} 件ある`);
  return violations;
}

// 境界の指定は、文字列か、パーティションだけを埋める組み込み関数
function resolveArn(value: unknown, partition: string): string | undefined {
  if (typeof value === "string") return value;
  if (!isObject(value)) return undefined;
  if (typeof value["Fn::Sub"] === "string") return value["Fn::Sub"].replaceAll("${AWS::Partition}", partition);
  if (value.Ref === "AWS::Partition") return partition;
  const join = value["Fn::Join"];
  if (!Array.isArray(join) || typeof join[0] !== "string" || !Array.isArray(join[1])) return undefined;
  const parts = join[1].map((part) => resolveArn(part, partition));
  return parts.includes(undefined) ? undefined : parts.join(join[0]);
}

// 信頼する主体が AWS のサービスだけか
function trustsServicesOnly(document: unknown): boolean {
  if (!isObject(document) || !Array.isArray(document.Statement)) return false;
  return document.Statement.every((s: unknown) => {
    if (!isObject(s) || s.NotPrincipal !== undefined) return false;
    if (s.Effect === "Deny") return true;
    const principal = s.Principal;
    if (!isObject(principal) || Object.keys(principal).join() !== "Service") return false;
    const services = [principal.Service].flat();
    return services.length > 0 && services.every((v) => typeof v === "string" && v.endsWith(".amazonaws.com"));
  });
}

const FORBIDDEN_IAM = ["AWS::IAM::User", "AWS::IAM::Group", "AWS::IAM::AccessKey", "AWS::IAM::UserToGroupAddition"];

// IAM の違反。境界の無いロール、AWS のサービス以外を信頼するロール、ユーザー・グループ・アクセスキー
export function checkTemplateRoles(template: unknown, boundaryArn: string): string[] {
  const partition = boundaryArn.split(":")[1]!;
  return Object.entries(resourcesOf(template)).flatMap(([id, r]) => {
    if (FORBIDDEN_IAM.includes(r.Type as string)) return [`${id}: ${String(r.Type)} は作れない`];
    if (r.Type !== "AWS::IAM::Role") return [];
    const violations: string[] = [];
    if (resolveArn(r.Properties?.PermissionsBoundary, partition) !== boundaryArn) violations.push(`${id} に権限の境界が無いか違う`);
    if (!trustsServicesOnly(r.Properties?.AssumeRolePolicyDocument)) violations.push(`${id} が AWS のサービス以外を信頼する`);
    return violations;
  });
}
