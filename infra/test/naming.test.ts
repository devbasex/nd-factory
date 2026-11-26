import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Tags } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import {
  TAG_KEYS,
  appBootstrapNames,
  appQualifier,
  appResourceNames,
  applyTags,
  cdkRoleArn,
  deployRoleName,
  launchDeclaredParameterName,
  pipelineResourceNames,
  resourceName,
  secretName,
  settingsParameterName,
  stackName,
} from "../lib/naming.ts";
import { BASE_SETTINGS, TEST_ENV, untaggedResources } from "./support.ts";

// 漏れの検査が ARN の直書きを当てるので、作り物のアカウントは定数から組み立てる
const FAKE_ACCOUNT = "123456789012";

describe("resourceName", () => {
  it("<prefix>-<environment>-<用途> を返す", () => {
    expect(resourceName(BASE_SETTINGS, "accounts")).toBe("acme-test-accounts");
    expect(resourceName(BASE_SETTINGS, "pipeline-failed")).toBe("acme-test-pipeline-failed");
  });

  it("用途が小文字の英数字とハイフンでなければ投げる", () => {
    expect(() => resourceName(BASE_SETTINGS, "Accounts")).toThrow(/用途/);
    expect(() => resourceName(BASE_SETTINGS, "")).toThrow(/用途/);
  });
});

describe("secretName", () => {
  it("<prefix>/<environment>/<用途> を返す", () => {
    expect(secretName(BASE_SETTINGS, "google-oauth")).toBe("acme/test/google-oauth");
  });
});

describe("settingsParameterName と stackName", () => {
  it("パラメーターは / で始まり、スタックは用途の名前を使う", () => {
    expect(settingsParameterName(BASE_SETTINGS)).toBe("/acme/test/settings");
    expect(stackName(BASE_SETTINGS, "app")).toBe("acme-test-app");
    expect(stackName(BASE_SETTINGS, "pipeline")).toBe("acme-test-pipeline");
  });
});

describe("反映に使う資源の名前", () => {
  it("パイプラインの資源の名前に、承認の方針の名前が無い", () => {
    expect(Object.keys(pipelineResourceNames(BASE_SETTINGS)).sort()).toEqual(
      ["connection", "deployProject", "failedRule", "notifyTopic", "pipeline", "prepareProject", "settingsParameter"].sort(),
    );
  });

  it("qualifier は nd と SHA-256 の先頭 8 桁の 10 文字で、組が違えば違う", () => {
    expect(appQualifier(BASE_SETTINGS)).toMatch(/^nd[0-9a-f]{8}$/);
    expect(appQualifier(BASE_SETTINGS)).not.toBe(appQualifier({ prefix: "acme", environment: "prod" }));
    expect(appQualifier(BASE_SETTINGS)).not.toBe(appQualifier({ prefix: "acme2", environment: "test" }));
  });

  it("8 桁に縮めるので、違う設置が同じ qualifier になることがある（衝突の確認で止める）", () => {
    expect(appQualifier({ prefix: "acme-58885", environment: "dev" })).toBe("nd09bda190");
    expect(appQualifier({ prefix: "acme-91474", environment: "dev" })).toBe("nd09bda190");
  });

  it("宣言の記録・bootstrap・CDK のロールの名前", () => {
    expect(launchDeclaredParameterName(BASE_SETTINGS)).toBe("/acme/test/launch-declared");
    expect(appBootstrapNames(BASE_SETTINGS)).toEqual({
      stack: "acme-test-bootstrap",
      executionPolicy: "acme-test-app-cfn-exec",
      boundaryPolicy: "acme-test-app-boundary",
    });
    expect(cdkRoleArn({ partition: "aws", account: "123456789012", region: "us-west-2" }, "nd09bda190", "deploy")).toBe(
      `arn:aws:iam::${FAKE_ACCOUNT}:role/cdk-nd09bda190-deploy-role-123456789012-us-west-2`,
    );
  });

  it("反映のプロジェクトのロールの名前は、prefix と environment が最長でも 64 文字に収まる", () => {
    expect(deployRoleName(BASE_SETTINGS, "us-west-2")).toBe("acme-test-deploy-us-west-2");
    const longest = deployRoleName({ prefix: "a".repeat(20), environment: "b".repeat(10) }, "ap-southeast-2");
    expect(longest.length).toBeLessThanOrEqual(64);
  });
});

describe("appResourceNames", () => {
  it("インフラの資源の名前は <prefix>-<environment>-<用途>、秘密の器は <prefix>/<environment>/<用途>", () => {
    expect(appResourceNames(BASE_SETTINGS)).toMatchObject({
      vpc: "acme-test-vpc",
      taskSecurityGroup: "acme-test-task-sg",
      dbSecurityGroup: "acme-test-db-sg",
      runnerCluster: "acme-test-runner",
      runnerLogGroup: "acme-test-runner",
      imageRepositories: "acme-test-*",
      progressDb: "acme-test-progress-db",
      progressDbAdminSecret: "acme/test/progress-db-admin",
      dbPrepFunction: "acme-test-db-prep",
      dbPrepLogGroup: "acme-test-db-prep",
      opsTopic: "acme-test-ops",
      budget: "acme-test-budget",
    });
  });
});

describe("applyTags", () => {
  function stackWithTwoResources(): Stack {
    const stack = new Stack(new App(), "T", { env: TEST_ENV });
    new Bucket(stack, "B");
    new Topic(stack, "N");
    return stack;
  }

  it("すべての資源に 2 つのタグが付く", () => {
    const stack = stackWithTwoResources();
    applyTags(stack, BASE_SETTINGS);
    const template = Template.fromStack(stack);
    expect(TAG_KEYS).toEqual(["app-prefix", "app-env"]);
    expect(untaggedResources(stack, BASE_SETTINGS)).toEqual([]);
    template.hasResourceProperties("AWS::S3::Bucket", {
      Tags: [
        { Key: "app-env", Value: "test" },
        { Key: "app-prefix", Value: "acme" },
      ],
    });
  });

  it("1 つの資源からタグを 1 つ外すと、欠けた資源として見つかる", () => {
    const stack = stackWithTwoResources();
    applyTags(stack, BASE_SETTINGS);
    Tags.of(stack.node.findChild("N")).remove("app-env");
    Template.fromStack(stack);
    const bad = untaggedResources(stack, BASE_SETTINGS);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain("AWS::SNS::Topic");
  });
});
