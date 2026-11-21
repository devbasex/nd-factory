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

export type PromoteOptions = {
  // 最初の読みから、移しと読み直しまでを収める期限（既定 20,000）と、読み直しの間隔の初めと上限（既定 250・2,000）。
  // 読みは結果整合で、移した直後の DescribeSecret は移す前のラベルを返しうるため、期限まで読み直す（移しは打ち直さない）
  deadlineMs?: number;
  confirmInitialMs?: number;
  confirmMaxMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  // 残りの時間で打ち切る信号を作る（既定 AbortSignal.timeout）。テストは差し替える
  abortAfter?: (ms: number) => AbortSignal;
};

// 期限を過ぎた。値を持たない
export class PromoteDeadlineError extends Error {
  override name = "PromoteDeadlineError";
}

// 送るたびに、期限までの残りで打ち切る信号を作る。残りが無ければ送らずに投げる
type Budget = () => { abortSignal: AbortSignal };

async function currentHolder(client: SecretsManagerClient, budget: Budget, secret: string): Promise<string | undefined> {
  const out = await client.send(new DescribeSecretCommand({ SecretId: secret }), budget());
  const stages = out.VersionIdsToStages ?? {};
  return Object.keys(stages).find((id) => stages[id]?.includes(CURRENT_STAGE) === true);
}

// 版へ AWSCURRENT を移し、読み直して付いたことを確かめる。既に付いていれば移さない（中断からの再開）。
// 移すのは 1 回だけで、読み直しが期限まで移した版を返さなければ投げる。
// 期限は最初の読みの前に決め、移しと読み直しを含むすべての送信を収める。送る前に残りが無ければ送らずに投げ、
// 送った要求も残りの時間で打ち切る（SDK の打ち直しも打ち切った後は送らない）。呼ぶ側は差し替えの鎖を持つトランザクションの
// 中で呼ぶため、期限は Data API の無通信の巻き戻り（3 分）より十分短くし、鎖が外れた後に移しを送らない
// （鎖が外れた後に新しい番号の呼び出しが移した版を、古い呼び出しが RemoveFromVersionId に渡して戻さないように）
export async function promoteVersion(
  client: SecretsManagerClient,
  secret: string,
  versionId: string,
  options: PromoteOptions = {},
): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const abortAfter = options.abortAfter ?? ((ms: number) => AbortSignal.timeout(ms));
  const deadline = now() + (options.deadlineMs ?? 20_000);
  const budget: Budget = () => {
    const left = deadline - now();
    if (left <= 0) throw new PromoteDeadlineError("版へ AWSCURRENT を移す期限を過ぎた");
    return { abortSignal: abortAfter(Math.ceil(left)) };
  };
  const holder = await currentHolder(client, budget, secret);
  if (holder === versionId) return;
  await client.send(
    new UpdateSecretVersionStageCommand({
      SecretId: secret,
      VersionStage: CURRENT_STAGE,
      MoveToVersionId: versionId,
      ...(holder === undefined ? {} : { RemoveFromVersionId: holder }),
    }),
    budget(),
  );
  const maxMs = options.confirmMaxMs ?? 2_000;
  let waitMs = options.confirmInitialMs ?? 250;
  for (;;) {
    if ((await currentHolder(client, budget, secret)) === versionId) return;
    const left = deadline - now();
    if (left <= 0) throw new Error("版へ AWSCURRENT を移せなかった");
    await sleep(Math.min(waitMs, left));
    // 待ちで期限に届いたら、次の読みを送らない
    if (deadline - now() <= 0) throw new Error("版へ AWSCURRENT を移せなかった");
    waitMs = Math.min(waitMs * 2, maxMs);
  }
}
