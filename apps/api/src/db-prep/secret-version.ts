import {
  DescribeSecretCommand,
  GetSecretValueCommand,
  type SecretsManagerClient,
  UpdateSecretVersionStageCommand,
} from "@aws-sdk/client-secrets-manager";

// ランナーへ渡す URL を読む版に付くラベル。関数は SQL を終えた版へだけ移す（docs/design/data.md のパスワードの版の 4）
export const CURRENT_STAGE = "AWSCURRENT";

// プロジェクトの秘密の器の、行に結んだ版の URL からパスワードを読む。ラベル（AWSPENDING・AWSCURRENT）では読まない。
// 例外の文に URL とパスワードを入れない（ログへ流れうるため）。URL の照らしの例外は入力を持つため、元の例外を繋がない
export async function readVersionPassword(client: SecretsManagerClient, secret: string, versionId: string): Promise<string> {
  const out = await client.send(new GetSecretValueCommand({ SecretId: secret, VersionId: versionId }));
  if (typeof out.SecretString !== "string") throw new Error("秘密の器の版が文字列の値を持たない");
  let url: URL;
  try {
    url = new URL(out.SecretString);
  } catch {
    throw new Error("秘密の器の版の値が URL の形でない");
  }
  if (url.password === "") throw new Error("秘密の器の版の URL にパスワードが無い");
  try {
    return decodeURIComponent(url.password);
  } catch {
    throw new Error("秘密の器の版の URL のパスワードを読めない");
  }
}

async function currentHolder(client: SecretsManagerClient, secret: string): Promise<string | undefined> {
  const out = await client.send(new DescribeSecretCommand({ SecretId: secret }));
  const stages = out.VersionIdsToStages ?? {};
  return Object.keys(stages).find((id) => stages[id]?.includes(CURRENT_STAGE) === true);
}

export type PromoteOptions = {
  // 移した後の読み直しを続ける期限と、間隔の初めと上限（既定 20,000・250・2,000）。読みは結果整合で、移した直後の
  // DescribeSecret は移す前のラベルを返しうるため、期限まで読み直す（移しは打ち直さない）
  confirmDeadlineMs?: number;
  confirmInitialMs?: number;
  confirmMaxMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

// 版へ AWSCURRENT を移し、読み直して付いたことを確かめる。既に付いていれば移さない（中断からの再開）。
// 移すのは 1 回だけで、読み直しが期限まで移した版を返さなければ投げる。期限は、呼ぶ側が差し替えの鎖を持つトランザクション
// （Data API は 3 分の無通信で巻き戻す）と関数の時間切れ（5 分）の内に収める
export async function promoteVersion(
  client: SecretsManagerClient,
  secret: string,
  versionId: string,
  options: PromoteOptions = {},
): Promise<void> {
  const holder = await currentHolder(client, secret);
  if (holder === versionId) return;
  await client.send(
    new UpdateSecretVersionStageCommand({
      SecretId: secret,
      VersionStage: CURRENT_STAGE,
      MoveToVersionId: versionId,
      ...(holder === undefined ? {} : { RemoveFromVersionId: holder }),
    }),
  );
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.confirmDeadlineMs ?? 20_000);
  const maxMs = options.confirmMaxMs ?? 2_000;
  let waitMs = options.confirmInitialMs ?? 250;
  for (;;) {
    if ((await currentHolder(client, secret)) === versionId) return;
    const left = deadline - now();
    if (left <= 0) throw new Error("版へ AWSCURRENT を移せなかった");
    await sleep(Math.min(waitMs, left));
    waitMs = Math.min(waitMs * 2, maxMs);
  }
}
