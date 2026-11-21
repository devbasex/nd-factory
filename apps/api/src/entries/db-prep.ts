import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DB_PREP_ENV } from "@nd-factory/contracts/db-prep";
import { type PrepCompletionPort, createDbPrepHandler, createPrepLogger } from "../db-prep/handler.ts";
import { promoteVersion, readVersionPassword } from "../db-prep/secret-version.ts";
import { createDataApiExecutor, createRdsDataClient } from "../db-prep/sql-executor.ts";

// DB の用意の関数（Lambda）の起点。本番の依存を実行環境ごとに 1 回組み、createDbPrepHandler の結果を呼ぶ

export type DbPrepConfig = { clusterArn: string; adminSecretArn: string; secretPrefix: string };

// 資源（DbPrepFunction）が渡す環境変数を読む。秘密の器の頭は終わりの記録の口の本番の実装（#6）が使う。
// 無ければ投げ、何も打たない（例外の文に値を入れない）
export function readDbPrepConfig(env: Record<string, string | undefined>): DbPrepConfig {
  const read = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.trim() === "") throw new Error(`環境変数 ${name} が無い`);
    return value;
  };
  return {
    clusterArn: read(DB_PREP_ENV.clusterArn),
    adminSecretArn: read(DB_PREP_ENV.adminSecretArn),
    secretPrefix: read(DB_PREP_ENV.secretPrefix),
  };
}

// 終わりの記録の口の本番の実装は #6 がこのファイルで渡す。それまでは呼ばれたら投げる（関数を呼ぶ側も #6 が作り、
// それまで誰も呼ばない）。isCurrent が投げるため、SQL の前に止まり、終わりは記さない
export const UNWIRED_COMPLETION: PrepCompletionPort = Object.freeze({
  isCurrent: async () => {
    throw new Error("終わりの記録の口がまだつながっていない（#6）");
  },
  readTarget: async () => {
    throw new Error("終わりの記録の口がまだつながっていない（#6）");
  },
  record: async () => {
    throw new Error("終わりの記録の口がまだつながっていない（#6）");
  },
});

function build(): (event: unknown) => Promise<void> {
  const config = readDbPrepConfig(process.env);
  // Data API は 45 秒で文を取り消す。SDK の時間切れをそれより長くし、Data API が終えた文を SDK の側で打ち直さない
  const rds = createRdsDataClient({ requestHandler: { requestTimeout: 60_000 } });
  const secrets = new SecretsManagerClient({});
  return createDbPrepHandler({
    sql: createDataApiExecutor({ client: rds, resourceArn: config.clusterArn, secretArn: config.adminSecretArn }),
    completion: UNWIRED_COMPLETION,
    readPassword: (secret, versionId) => readVersionPassword(secrets, secret, versionId),
    promote: (secret, versionId) => promoteVersion(secrets, secret, versionId),
    logger: createPrepLogger(),
    now: () => performance.now(),
  });
}

let built: ((event: unknown) => Promise<void>) | undefined;

export async function handler(event: unknown): Promise<void> {
  built ??= build();
  await built(event);
}
