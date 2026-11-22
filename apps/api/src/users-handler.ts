import {
  STORE_UNAVAILABLE,
  type UserAnswer,
  type UserRef,
  type UserRow,
  type UsersErrorBody,
  parseUsersRequest,
} from "@nd-factory/contracts/users-api";
import { createClock, type Clock } from "@nd-factory/core/clock";
import { createDb, dynamoDocumentClient, TABLE_PURPOSES, type Db, type TableNames } from "@nd-factory/core/db";
import { createLogger, type Logger } from "@nd-factory/core/log";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { StoreError, ensureUser } from "./user-store.ts";

// PUT /v1/users の入口。利用者の ID は認可の前段が照らした token の sub だけを使い、本文の値を利用者の ID として信じない

export type HandlerDeps = {
  // 利用者の表の実際の名前から Db を得る。名前が無いときは呼ばない
  db: (usersTable: string) => Db;
  table: () => string | undefined;
  clock: Clock;
  // 要求ごとのログの書き手（文脈に要求の ID を持つ）
  log: (requestId: string) => Logger;
};

// 要素ごとに答えを決める。ほかの利用者の ID には表を読まずに not_found を返し、無い ID と見分けられなくする
export async function answerItems(sub: string, items: UserRef[], self: () => Promise<UserRow>): Promise<UserAnswer[]> {
  let selfRow: Promise<UserRow> | undefined;
  const answers: UserAnswer[] = [];
  for (const item of items) {
    if (item.id === "self" || item.id === sub) {
      selfRow ??= self();
      answers.push({ status: "ok", item: await selfRow });
    } else {
      answers.push({ status: "not_found" });
    }
  }
  return answers;
}

function json(statusCode: number, body: UserAnswer[] | UsersErrorBody): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function decodeBody(event: APIGatewayProxyEventV2WithJWTAuthorizer): string | undefined {
  if (event.body === undefined) return undefined;
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

// ログは JSON の 1 行で、要求の ID と結果だけを出す。token・本文・利用者の ID は出さない
type LogFields = { status: number } & Record<string, string | number>;

export function createHandler(deps: HandlerDeps) {
  return async function handle(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> {
    const requestId = event.requestContext?.requestId ?? "unknown";
    const logger = deps.log(requestId);

    const sub = event.requestContext?.authorizer?.jwt?.claims?.sub;
    if (typeof sub !== "string" || sub.length === 0) {
      // 認可の前段を通った要求には必ず sub がある。無いのは前段の設定の誤りなので error で残す
      logger.error("認可の前段から利用者の ID を受けていない", { status: 401 } satisfies LogFields);
      return { statusCode: 401 };
    }

    const parsed = parseUsersRequest(decodeBody(event));
    if (!parsed.ok) {
      logger.info("本文が形に合わない", { status: 400, reason: parsed.reason } satisfies LogFields);
      return json(400, { reason: parsed.reason });
    }

    const table = deps.table();
    try {
      if (!table) throw new StoreError("put", new Error("USERS_TABLE が無い"));
      const db = deps.db(table);
      const answers = await answerItems(sub, parsed.items, () => ensureUser(db, "users", sub, deps.clock));
      logger.info("利用者の要素に答えた", { status: 200, items: answers.length } satisfies LogFields);
      return json(200, answers);
    } catch (e) {
      const operation = e instanceof StoreError ? e.operation : "unknown";
      const error = e instanceof StoreError ? e.causeName : e instanceof Error ? e.name : "Unknown";
      logger.error("利用者の表に届かない", { status: 503, operation, error } satisfies LogFields);
      return json(503, { reason: STORE_UNAVAILABLE });
    }
  };
}

// 骨組みは利用者の表だけを使う。ほかの用途の表の名前は持たず、引かれたら投げる（表へ送る前に 503 にする）
function usersOnly(usersTable: string): TableNames {
  const names = { users: usersTable } as Record<string, string>;
  for (const purpose of TABLE_PURPOSES) {
    if (purpose === "users") continue;
    Object.defineProperty(names, purpose, {
      enumerable: true,
      get: () => {
        throw new Error(`骨組みは ${purpose} の表を持たない`);
      },
    });
  }
  return names as TableNames;
}

// 本物の依存。クライアントは awsClient が実行環境ごとに 1 つ作り、Db は最初の要求で組んで Lambda の実行環境が続く間は使い回す
let sharedDb: { table: string; db: Db } | undefined;

export const handler = createHandler({
  db: (table) => {
    if (sharedDb?.table !== table) sharedDb = { table, db: createDb(dynamoDocumentClient(), usersOnly(table)) };
    return sharedDb.db;
  },
  table: () => process.env.USERS_TABLE,
  clock: createClock(),
  log: (requestId) => createLogger({ request_id: requestId, fn: "users-api", endpoint: "user" }),
});
