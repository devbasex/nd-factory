import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOTSTRAP_VERSION_PARAMETER,
  BootstrapReadError,
  ProfileError,
  readBootstrapVersion,
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
