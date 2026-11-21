import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Tags } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { TAG_KEYS, appResourceNames, applyTags, resourceName, secretName, settingsParameterName, stackName } from "../lib/naming.ts";
import { BASE_SETTINGS, TEST_ENV, untaggedResources } from "./support.ts";

describe("resourceName", () => {
  it("<prefix>-<environment>-<用途> を返す", () => {
    expect(resourceName(BASE_SETTINGS, "accounts")).toBe("acme-test-accounts");
    expect(resourceName(BASE_SETTINGS, "deny-approval")).toBe("acme-test-deny-approval");
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
