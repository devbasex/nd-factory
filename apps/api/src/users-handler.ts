import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  STORE_UNAVAILABLE,
  type UserAnswer,
  type UserRef,
  type UserRow,
  type UsersErrorBody,
  parseUsersRequest,
} from "@nd-factory/contracts/users-api";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { StoreError, ensureUser } from "./user-store.ts";

// PUT /v1/users の入口。利用者の ID は認可の前段が照らした token の sub だけを使い、本文の値を利用者の ID として信じない

export type HandlerDeps = {
  client: () => DynamoDBDocumentClient;
  table: () => string | undefined;
  now: () => Date;
  log: (line: string) => void;
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
type LogFields = { level: "info" | "error"; msg: string; status: number } & Record<string, string | number>;

export function createHandler(deps: HandlerDeps) {
  return async function handle(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> {
    const requestId = event.requestContext?.requestId ?? "unknown";
    const log = (fields: LogFields) => deps.log(JSON.stringify({ ...fields, request_id: requestId }));

    const sub = event.requestContext?.authorizer?.jwt?.claims?.sub;
    if (typeof sub !== "string" || sub.length === 0) {
      // 認可の前段を通った要求には必ず sub がある。無いのは前段の設定の誤りなので error で残す
      log({ level: "error", msg: "認可の前段から利用者の ID を受けていない", status: 401 });
      return { statusCode: 401 };
    }

    const parsed = parseUsersRequest(decodeBody(event));
    if (!parsed.ok) {
      log({ level: "info", msg: "本文が形に合わない", status: 400, reason: parsed.reason });
      return json(400, { reason: parsed.reason });
    }

    const table = deps.table();
    try {
      if (!table) throw new StoreError("put", new Error("USERS_TABLE が無い"));
      const answers = await answerItems(sub, parsed.items, () => ensureUser(deps.client(), table, sub, deps.now()));
      log({ level: "info", msg: "利用者の要素に答えた", status: 200, items: answers.length });
      return json(200, answers);
    } catch (e) {
      const operation = e instanceof StoreError ? e.operation : "unknown";
      const error = e instanceof StoreError ? e.causeName : e instanceof Error ? e.name : "Unknown";
      log({ level: "error", msg: "利用者の表に届かない", status: 503, operation, error });
      return json(503, { reason: STORE_UNAVAILABLE });
    }
  };
}

// 本物の依存。クライアントは最初の要求で作り、Lambda の実行環境が続く間は使い回す
let sharedClient: DynamoDBDocumentClient | undefined;

export const handler = createHandler({
  client: () => (sharedClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({}))),
  table: () => process.env.USERS_TABLE,
  now: () => new Date(),
  log: (line) => console.log(line),
});
