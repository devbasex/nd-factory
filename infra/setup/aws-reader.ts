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
