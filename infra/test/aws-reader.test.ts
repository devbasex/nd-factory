import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import { EC2Client } from "@aws-sdk/client-ec2";
import { OrganizationsClient } from "@aws-sdk/client-organizations";
import { SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOTSTRAP_VERSION_PARAMETER,
  BootstrapReadError,
  ProfileError,
  readBootstrapVersion,
  readCostAllocationTags,
  readGetAzsCount,
  readOrganizationManager,
  resolveProfile,
} from "../setup/aws-reader.ts";

// 手元の AWS の設定を読まないよう、設定のファイルを一時のものへ向け、資格情報の環境変数を外す
const CLEARED = [
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(CLEARED.map((k) => [k, process.env[k]]));
  for (const k of CLEARED) delete process.env[k];
  process.env.AWS_EC2_METADATA_DISABLED = "true";
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

function awsFiles(config: string): void {
  const dir = mkdtempSync(join(tmpdir(), "nd-aws-"));
  writeFileSync(join(dir, "config"), config);
  writeFileSync(
    join(dir, "credentials"),
    "[acme-test]\naws_access_key_id = test-access-key-id\naws_secret_access_key = example-secret-not-real\n",
  );
  process.env.AWS_CONFIG_FILE = join(dir, "config");
  process.env.AWS_SHARED_CREDENTIALS_FILE = join(dir, "credentials");
}

const TARGET = { profile: "acme-test", account: "123456789012", region: "us-west-2" };

describe("resolveProfile", () => {
  it("主体のアカウントと profile のリージョンを返す", async () => {
    awsFiles("[profile acme-test]\nregion = us-west-2\n");
    const send = vi.spyOn(STSClient.prototype, "send").mockResolvedValue({ Account: "123456789012" } as never);
    expect(await resolveProfile("acme-test")).toEqual(TARGET);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("profile が無ければ ProfileError", async () => {
    awsFiles("[profile acme-test]\nregion = us-west-2\n");
    vi.spyOn(STSClient.prototype, "send").mockResolvedValue({ Account: "123456789012" } as never);
    await expect(resolveProfile("nobody")).rejects.toBeInstanceOf(ProfileError);
  });

  it("リージョンが無ければ ProfileError", async () => {
    awsFiles("[profile acme-test]\noutput = json\n");
    vi.spyOn(STSClient.prototype, "send").mockResolvedValue({ Account: "123456789012" } as never);
    await expect(resolveProfile("acme-test")).rejects.toThrow(/リージョン/);
  });

  it("主体を読めなければ ProfileError", async () => {
    awsFiles("[profile acme-test]\nregion = us-west-2\n");
    vi.spyOn(STSClient.prototype, "send").mockRejectedValue(Object.assign(new Error("expired"), { name: "ExpiredToken" }) as never);
    await expect(resolveProfile("acme-test")).rejects.toBeInstanceOf(ProfileError);
  });
});

describe("readBootstrapVersion", () => {
  beforeEach(() => awsFiles("[profile acme-test]\nregion = us-west-2\n"));

  it("既定の qualifier の版を数で返す", async () => {
    const send = vi.spyOn(SSMClient.prototype, "send").mockResolvedValue({ Parameter: { Value: "30" } } as never);
    expect(await readBootstrapVersion(TARGET)).toBe(30);
    const input = (send.mock.calls[0]![0] as { input: { Name: string } }).input;
    expect(input.Name).toBe(BOOTSTRAP_VERSION_PARAMETER);
    expect(BOOTSTRAP_VERSION_PARAMETER).toBe("/cdk-bootstrap/hnb659fds/version");
  });

  it("パラメーターが無ければ null", async () => {
    vi.spyOn(SSMClient.prototype, "send").mockRejectedValue(
      Object.assign(new Error("not found"), { name: "ParameterNotFound" }) as never,
    );
    expect(await readBootstrapVersion(TARGET)).toBeNull();
  });

  it("権限の失敗は BootstrapReadError", async () => {
    vi.spyOn(SSMClient.prototype, "send").mockRejectedValue(
      Object.assign(new Error("denied"), { name: "AccessDeniedException" }) as never,
    );
    await expect(readBootstrapVersion(TARGET)).rejects.toBeInstanceOf(BootstrapReadError);
  });

  it("数でない値は BootstrapReadError", async () => {
    vi.spyOn(SSMClient.prototype, "send").mockResolvedValue({ Parameter: { Value: "abc" } } as never);
    await expect(readBootstrapVersion(TARGET)).rejects.toBeInstanceOf(BootstrapReadError);
  });
});

type Sent = { constructor: { name: string }; input: Record<string, unknown> };

function sentName(call: unknown[]): string {
  return (call[0] as Sent).constructor.name;
}

function sentInput(call: unknown[]): Record<string, unknown> {
  return (call[0] as Sent).input;
}

describe("readCostAllocationTags", () => {
  beforeEach(() => awsFiles("[profile acme-test]\nregion = us-west-2\n"));

  it("渡したキーの状態を返し、一覧に無いキーは Missing", async () => {
    const send = vi
      .spyOn(CostExplorerClient.prototype, "send")
      .mockResolvedValue({ CostAllocationTags: [{ TagKey: "app-prefix", Type: "UserDefined", Status: "Active" }] } as never);
    expect(await readCostAllocationTags(TARGET, ["app-prefix", "app-env"])).toEqual({ "app-prefix": "Active", "app-env": "Missing" });
    expect(sentInput(send.mock.calls[0]!)).toMatchObject({ TagKeys: ["app-prefix", "app-env"], Type: "UserDefined" });
  });

  it("続きのページも読む", async () => {
    const send = vi
      .spyOn(CostExplorerClient.prototype, "send")
      .mockResolvedValueOnce({ CostAllocationTags: [{ TagKey: "app-prefix", Status: "Inactive" }], NextToken: "next" } as never)
      .mockResolvedValueOnce({ CostAllocationTags: [{ TagKey: "app-env", Status: "Active" }] } as never);
    expect(await readCostAllocationTags(TARGET, ["app-prefix", "app-env"])).toEqual({ "app-prefix": "Inactive", "app-env": "Active" });
    expect(sentInput(send.mock.calls[1]!)).toMatchObject({ NextToken: "next" });
  });

  it("端点は us-east-1 に解く", async () => {
    const client = new CostExplorerClient({ region: TARGET.region });
    const endpoint = await client.config.endpointProvider({ Region: TARGET.region, UseFIPS: false, UseDualStack: false });
    expect(endpoint.url.hostname).toBe("ce.us-east-1.amazonaws.com");
  });

  it("読めなければ投げる", async () => {
    vi.spyOn(CostExplorerClient.prototype, "send").mockRejectedValue(
      Object.assign(new Error("denied"), { name: "AccessDeniedException" }) as never,
    );
    await expect(readCostAllocationTags(TARGET, ["app-prefix"])).rejects.toThrow();
  });
});

describe("readOrganizationManager", () => {
  beforeEach(() => awsFiles("[profile acme-test]\nregion = us-west-2\n"));

  it("組織のメンバーなら管理のアカウントを返す", async () => {
    vi.spyOn(OrganizationsClient.prototype, "send").mockResolvedValue({
      Organization: { MasterAccountId: "210987654321" },
    } as never);
    expect(await readOrganizationManager(TARGET)).toEqual({ member: true, managementAccount: "210987654321" });
  });

  it("組織の管理のアカウント自身なら member: false", async () => {
    vi.spyOn(OrganizationsClient.prototype, "send").mockResolvedValue({
      Organization: { MasterAccountId: "123456789012" },
    } as never);
    expect(await readOrganizationManager(TARGET)).toEqual({ member: false, managementAccount: "123456789012" });
  });

  it("組織に入っていなければ member: false", async () => {
    vi.spyOn(OrganizationsClient.prototype, "send").mockRejectedValue(
      Object.assign(new Error("not in use"), { name: "AWSOrganizationsNotInUseException" }) as never,
    );
    expect(await readOrganizationManager(TARGET)).toEqual({ member: false, managementAccount: null });
  });

  it("権限が無ければ unknown", async () => {
    vi.spyOn(OrganizationsClient.prototype, "send").mockRejectedValue(
      Object.assign(new Error("denied"), { name: "AccessDeniedException" }) as never,
    );
    expect(await readOrganizationManager(TARGET)).toBe("unknown");
  });
});

describe("readGetAzsCount", () => {
  beforeEach(() => awsFiles("[profile acme-test]\nregion = us-west-2\n"));

  function subnets(zones: string[]) {
    return { Subnets: zones.map((z) => ({ AvailabilityZone: z, DefaultForAz: true })) };
  }

  const AVAILABLE = { AvailabilityZones: ["us-west-2a", "us-west-2b", "us-west-2c"].map((z) => ({ ZoneName: z })) };

  it("既定のサブネットが 3 つの AZ にあれば 3", async () => {
    const send = vi
      .spyOn(EC2Client.prototype, "send")
      .mockResolvedValue(subnets(["us-west-2a", "us-west-2b", "us-west-2c"]) as never);
    expect(await readGetAzsCount(TARGET)).toBe(3);
    expect(send).toHaveBeenCalledTimes(1);
    expect(sentName(send.mock.calls[0]!)).toBe("DescribeSubnetsCommand");
    expect(sentInput(send.mock.calls[0]!)).toMatchObject({ Filters: [{ Name: "default-for-az", Values: ["true"] }] });
  });

  it("既定のサブネットが 1 つの AZ にだけあれば、使える AZ が 3 つでも 1", async () => {
    const send = vi.spyOn(EC2Client.prototype, "send").mockImplementation((async (command: Sent) =>
      command.constructor.name === "DescribeSubnetsCommand" ? subnets(["us-west-2a"]) : AVAILABLE) as never);
    expect(await readGetAzsCount(TARGET)).toBe(1);
    expect(send.mock.calls.map(sentName)).toEqual(["DescribeSubnetsCommand"]);
  });

  it("既定のサブネットが無ければ使える AZ の数", async () => {
    const send = vi.spyOn(EC2Client.prototype, "send").mockImplementation((async (command: Sent) =>
      command.constructor.name === "DescribeSubnetsCommand" ? subnets([]) : AVAILABLE) as never);
    expect(await readGetAzsCount(TARGET)).toBe(3);
    expect(send.mock.calls.map(sentName)).toEqual(["DescribeSubnetsCommand", "DescribeAvailabilityZonesCommand"]);
    expect(sentInput(send.mock.calls[1]!)).toMatchObject({
      Filters: [
        { Name: "state", Values: ["available"] },
        { Name: "zone-type", Values: ["availability-zone"] },
      ],
    });
  });

  it("既定のサブネットの続きのページも数え、同じ AZ は 1 つに数える", async () => {
    vi.spyOn(EC2Client.prototype, "send")
      .mockResolvedValueOnce({ ...subnets(["us-west-2a", "us-west-2a"]), NextToken: "next" } as never)
      .mockResolvedValueOnce(subnets(["us-west-2b"]) as never);
    expect(await readGetAzsCount(TARGET)).toBe(2);
  });
});
