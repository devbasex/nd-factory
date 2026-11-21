import { CostExplorerClient, ListCostAllocationTagsCommand } from "@aws-sdk/client-cost-explorer";
import { DescribeAvailabilityZonesCommand, DescribeSubnetsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { DescribeOrganizationCommand, OrganizationsClient } from "@aws-sdk/client-organizations";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { fromIni } from "@aws-sdk/credential-providers";

// 設置のコマンドが AWS から読むものだけを置く。ここから AWS へ書き込まない。
// 資格情報は渡された profile だけから受け、環境変数の資格情報を混ぜない

export type Target = { profile: string; account: string; region: string };

// 既定の qualifier の bootstrap の版を持つパラメーター
export const BOOTSTRAP_VERSION_PARAMETER = "/cdk-bootstrap/hnb659fds/version";

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

export class BootstrapReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapReadError";
  }
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : "unknown";
}

export async function resolveProfile(profile: string): Promise<Target> {
  const credentials = fromIni({ profile });
  try {
    await credentials();
  } catch (e) {
    throw new ProfileError(`profile ${profile} の資格情報を得られない（${errorName(e)}）。profile の名前とログインの期限を確かめる`);
  }

  // リージョンは profile の設定から読む（環境変数 AWS_REGION があればそれが先になる）
  const sts = new STSClient({ profile, credentials });
  let region: string;
  try {
    region = await sts.config.region();
  } catch {
    region = "";
  }
  if (!region) throw new ProfileError(`profile ${profile} にリージョンが無い。~/.aws/config の profile に region を書く`);

  let account: string | undefined;
  try {
    account = (await sts.send(new GetCallerIdentityCommand({}))).Account;
  } catch (e) {
    throw new ProfileError(`profile ${profile} の主体を読めない（${errorName(e)}）`);
  }
  if (!account) throw new ProfileError(`profile ${profile} の主体のアカウントが分からない`);
  return { profile, account, region };
}

export async function readBootstrapVersion(target: Target): Promise<number | null> {
  const ssm = new SSMClient({ region: target.region, credentials: fromIni({ profile: target.profile }) });
  let value: string | undefined;
  try {
    value = (await ssm.send(new GetParameterCommand({ Name: BOOTSTRAP_VERSION_PARAMETER }))).Parameter?.Value;
  } catch (e) {
    if (errorName(e) === "ParameterNotFound") return null;
    throw new BootstrapReadError(`bootstrap の版を読めない（${errorName(e)}）`);
  }
  const version = Number(value);
  if (!Number.isInteger(version)) throw new BootstrapReadError(`bootstrap の版が数でない: ${JSON.stringify(value)}`);
  return version;
}

export type CostAllocationTagStatus = "Active" | "Inactive" | "Missing";

// 渡したタグのキーごとの状態。コスト配分タグの一覧に無いキーは Missing（資源にまだ付いていないか、まだ集計に現れていない）。
// Cost Explorer の端点は us-east-1 の 1 つだけで、SDK はどのリージョンを渡しても同じ区画のその端点へ解く。
// 区画（aws・aws-cn など）を設置先に合わせるため、設置先のリージョンを渡す
export async function readCostAllocationTags(target: Target, keys: string[]): Promise<Record<string, CostAllocationTagStatus>> {
  const ce = new CostExplorerClient({ region: target.region, credentials: fromIni({ profile: target.profile }) });
  const result: Record<string, CostAllocationTagStatus> = Object.fromEntries(keys.map((k) => [k, "Missing"]));
  let token: string | undefined;
  do {
    const page = await ce.send(new ListCostAllocationTagsCommand({ TagKeys: keys, Type: "UserDefined", NextToken: token }));
    for (const tag of page.CostAllocationTags ?? []) {
      if (tag.TagKey && Object.hasOwn(result, tag.TagKey) && (tag.Status === "Active" || tag.Status === "Inactive")) {
        result[tag.TagKey] = tag.Status;
      }
    }
    token = page.NextToken;
  } while (token);
  return result;
}

// member は「組織のメンバーで、このアカウントではコスト配分タグを有効にできない」ことを表す。
// 組織に入っていないアカウントと組織の管理のアカウントは member: false（このアカウントで有効にできる）
export type OrganizationManager = { member: boolean; managementAccount: string | null } | "unknown";

export async function readOrganizationManager(target: Target): Promise<OrganizationManager> {
  const org = new OrganizationsClient({ region: target.region, credentials: fromIni({ profile: target.profile }) });
  let manager: string | undefined;
  try {
    manager = (await org.send(new DescribeOrganizationCommand({}))).Organization?.MasterAccountId;
  } catch (e) {
    if (errorName(e) === "AWSOrganizationsNotInUseException") return { member: false, managementAccount: null };
    // 権限が無いなどで読めない。組織に入っているかが分からない
    return "unknown";
  }
  if (!manager) return "unknown";
  return { member: manager !== target.account, managementAccount: manager };
}

// Fn::GetAZs が返す AZ の数の見なし。既定の VPC の既定のサブネットがあれば、それのある AZ だけを返し、
// 無ければ使える AZ をすべて返す
export async function readGetAzsCount(target: Target): Promise<number> {
  const ec2 = new EC2Client({ region: target.region, credentials: fromIni({ profile: target.profile }) });
  const zones = new Set<string>();
  let token: string | undefined;
  do {
    const page = await ec2.send(
      new DescribeSubnetsCommand({ Filters: [{ Name: "default-for-az", Values: ["true"] }], NextToken: token }),
    );
    for (const subnet of page.Subnets ?? []) if (subnet.AvailabilityZone) zones.add(subnet.AvailabilityZone);
    token = page.NextToken;
  } while (token);
  if (zones.size > 0) return zones.size;

  const available = await ec2.send(
    new DescribeAvailabilityZonesCommand({
      Filters: [
        { Name: "state", Values: ["available"] },
        { Name: "zone-type", Values: ["availability-zone"] },
      ],
    }),
  );
  return (available.AvailabilityZones ?? []).length;
}
