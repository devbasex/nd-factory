import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { OPERATIONS } from "@nd-factory/contracts/operations";
import type { AuthReaders } from "@nd-factory/core/auth";
import type { ScopeReader } from "@nd-factory/core/authorize";
import { createClock } from "@nd-factory/core/clock";
import { createDb, dynamoDocumentClient, TABLE_PURPOSES, type Db, type TableNames } from "@nd-factory/core/db";
import { dispatch, readHttpCall, writeHttpResponse, type DispatchDeps, type HttpResponse } from "@nd-factory/core/dispatch";
import { createLogger, type LogContext, type Logger } from "@nd-factory/core/log";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from "aws-lambda";

// HTTP の振り分けの起点（issues/issue-2-design-detail.md の「API の起点と骨組みの移し」）。readHttpCall → dispatch → writeHttpResponse を通す。
// アプリのスタックへ入れて PUT /v1/users を置き換えるのは #4（決定 11）で、この課題は反映しない

// 関数の名前（ログの文脈の fn）
const FN = "api-fn";

// 振り分けの依存。ログの書き手は要求ごとに文脈（要求の ID と受け口）を持って作るため、作り方を渡す
export type ApiDeps = Omit<DispatchDeps, "log"> & { readonly log: (context: LogContext) => Logger };

function unavailable(): HttpResponse {
  return writeHttpResponse({ kind: "problem", status: 503, reason: "unavailable" });
}

// 事前条件: deps.handlers の鍵は操作の表の名前。どの応答も Cache-Control: no-store を持ち、500 を返さない
export function createApiHandler(deps: ApiDeps): (event: APIGatewayProxyEventV2, context: Context) => Promise<APIGatewayProxyResultV2> {
  const { log: logOf, ...rest } = deps;
  return async (event, context) => {
    try {
      const call = readHttpCall(event, () => context.getRemainingTimeInMillis());
      if ("kind" in call) return writeHttpResponse(call);
      const log = logOf({ request_id: call.requestId, fn: FN, endpoint: call.endpoint });
      return writeHttpResponse(await dispatch(call, { ...rest, log }));
    } catch {
      // 要求を読めない（形の違うイベント）か、振り分けの外で投げた。ログの書き手を作れないこともあるため、値を出さずに 503 にする
      return unavailable();
    }
  };
}

// 表の用途ごとの環境変数の名前（USERS_TABLE・…・IDEMPOTENCY_TABLE）
const tableEnvOf = (purpose: string): string => `${purpose.toUpperCase()}_TABLE`;

// 表の名前を環境変数から組む。1 つでも無いか空なら null
export function tableNamesOf(env: Readonly<Record<string, string | undefined>>): TableNames | null {
  const entries = TABLE_PURPOSES.map((purpose) => [purpose, env[tableEnvOf(purpose)]] as const);
  if (entries.some(([, name]) => name === undefined || name.length === 0)) return null;
  return Object.fromEntries(entries) as TableNames;
}

// 表の名前が足りない環境の Db。表へ送らずに投げ、振り分けが 503 にする
function missingTablesDb(): Db {
  const fail = async (): Promise<never> => {
    throw Object.assign(new Error("表の名前の環境変数が足りない"), { name: "TableNamesMissing" });
  };
  return { get: fail, query: fail, queryIndex: fail, scan: fail, transactWrite: fail, update: fail };
}

// 認証の行の読み手は、行の持ち主の子（#4・#6・#7・#11・#13）が apps/api/src/modules/ に書くまで「無い」を返す（どの token も通さない）
const closedReaders: AuthReaders = {
  userOfSubject: async () => null,
  sessionRevocation: async () => null,
  cognitoIdentity: async () => null,
  delegation: async () => null,
  touchDelegation: async () => {},
  machine: async () => null,
  lane: async () => null,
};

// 認可の読み手も同じく、持ち主の子が書くまで何も見せない（ハンドラーの表が空のため、今は呼ばれない）
const closedScope: ScopeReader = {
  seatsOf: async () => [],
  projectsOfTeams: async () => [],
  projectOfTarget: async () => null,
  laneOf: async () => [],
  transferTargetOf: async () => null,
  isHumanOnlyItem: async () => true,
};

// 既定の依存。時計・awsClient の文書のクライアント・createDb・ログ・ハンドラーの表（今は空）を組む。
// 認証は閉じる: Cognito の照らし・署名の鍵・Webhook の秘密を持たず（人・ランナー・DB の用意の token を断つ）、行の読み手は「無い」を返す
export function defaultApiDeps(env: Readonly<Record<string, string | undefined>>, client?: DynamoDBDocumentClient): ApiDeps {
  const clock = createClock();
  const names = tableNamesOf(env);
  return {
    operations: OPERATIONS,
    handlers: {},
    scope: closedScope,
    auth: { cognito: null, signingKey: null, webhookSecret: null, readers: closedReaders, clock },
    db: names === null ? missingTablesDb() : createDb(client ?? dynamoDocumentClient(), names),
    clock,
    log: (context) => createLogger(context),
  };
}

// 実行環境ごとに 1 回組む
export const handler = createApiHandler(defaultApiDeps(process.env));
