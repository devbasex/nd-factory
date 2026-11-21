import { MAX_ITEMS, type OperationDef } from "@nd-factory/contracts/operation";
import { operationByRoute } from "@nd-factory/contracts/operations";
import type { AuditChannel } from "../audit.ts";
import type { BodyFaultReason, CallEndpoint, DispatchResult, HttpEvent, HttpResponse, OperationCall, Problem, RequestFault } from "./types.ts";

// HTTP の要求を共通の呼び出しへ読み、振り分けの結果を HTTP の応答へ書く（docs/design/api.md の「呼び出しの規約」）

export function problem(status: number, reason: string | null): Problem {
  return { kind: "problem", status, reason };
}

// キーの順によらない JSON（同じ対象の重なりと冪等の鍵の fingerprint に使う）
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

// 本文の検査の順: 配列でない → 空 → 数の上限 → 同じ対象の重なり（JSON でないは読む所で先に見る）。
// 数の上限は全部か無かの操作では操作の定義の上限。MCP の入口の arguments.items も dispatch がこの関数で照らす
export function bodyFaultOf(items: unknown, op: OperationDef | null): BodyFaultReason | null {
  if (!Array.isArray(items)) return "body_not_array";
  if (items.length === 0) return "body_empty";
  const max = op?.allOrNothing?.maxItems ?? MAX_ITEMS;
  if (items.length > max) return "too_many_items";
  const seen = new Set<string>();
  for (const item of items) {
    const key = canonicalJson(item);
    if (seen.has(key)) return "duplicate_item";
    seen.add(key);
  }
  return null;
}

// 受け口は受けた HTTP の経路の頭で決まる（/v1/runner/…・/v1/machine/…・/v1/db_prep/…、ほかは利用者向け）
function endpointOfPath(path: string): CallEndpoint {
  const head = path.split("/")[2];
  return head === "runner" || head === "machine" || head === "db_prep" ? head : "user";
}

function header(event: HttpEvent, name: string): string | null {
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === name && value !== undefined) return value;
  }
  return null;
}

function bearerOf(event: HttpEvent): string | null {
  const value = header(event, "authorization");
  const matched = value === null ? null : /^Bearer\s+(\S+)$/i.exec(value);
  return matched?.[1] ?? null;
}

// 入口は token の種類と受けた HTTP の経路だけで決める（頭書きで変えられない）。主体は dispatch の認証で決まる
function channelOf(endpoint: CallEndpoint, token: string | null): AuditChannel {
  if (endpoint === "user") return token?.startsWith("ndfd_") === true ? "api" : "screen";
  return endpoint;
}

type BodyRead = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function readBody(event: HttpEvent): BodyRead {
  if (event.body === undefined) return { ok: false };
  const text = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

// HTTP の経路は形の正本の操作の表だけで引く。表に無い経路は 404、経路の頭の受け口と操作の受け口の食い違いは 405 で、振り分けへ渡さない。
// 方法と本文の誤りは呼び出しの fault に入れ、dispatch が記録の行とともに返す（405 は認証の前、400 は認証の後）。
// remainingMs は起点が渡す関数の残り時間の読み手（context.getRemainingTimeInMillis）
export function readHttpCall(event: HttpEvent, remainingMs: () => number): OperationCall | Problem {
  const op = operationByRoute(event.rawPath);
  if (op === undefined) return problem(404, null);
  const endpoint = endpointOfPath(event.rawPath);
  if (op.endpoint !== endpoint) return problem(405, null);
  const token = bearerOf(event);
  const base = { endpoint, channel: channelOf(endpoint, token), operation: op.name, token, requestId: event.requestContext.requestId, remainingMs };
  const withFault = (fault: RequestFault): OperationCall => ({ ...base, items: [], fault });

  if (event.requestContext.http.method.toUpperCase() !== "POST") return withFault({ status: 405, reason: null });
  const body = readBody(event);
  if (!body.ok) return withFault({ status: 400, reason: "body_not_json" });
  const reason = bodyFaultOf(body.value, op);
  if (reason !== null) return withFault({ status: 400, reason });
  return { ...base, items: body.value as unknown[] };
}

const BASE_HEADERS = { "cache-control": "no-store" } as const;

function problemResponse(status: number, reason: string | null): HttpResponse {
  const body = reason === null ? { type: "about:blank", status } : { type: "about:blank", status, reason };
  return { statusCode: status, headers: { ...BASE_HEADERS, "content-type": "application/problem+json" }, body: JSON.stringify(body) };
}

// 要求全体の誤りで返す状態（4xx と 503）。ほかの状態は返さない
function isProblemStatus(status: unknown): status is number {
  return typeof status === "number" && Number.isInteger(status) && ((status >= 400 && status < 500) || status === 503);
}

// 要素の結果は 200 と配列、要求全体の誤りは problem。どの応答も no-store。想定しない形でも 500 を返さず 503 にする
export function writeHttpResponse(result: DispatchResult): HttpResponse {
  try {
    if (result?.kind === "items" && Array.isArray(result.items)) {
      return { statusCode: 200, headers: { ...BASE_HEADERS, "content-type": "application/json" }, body: JSON.stringify(result.items) };
    }
    if (result?.kind === "problem" && isProblemStatus(result.status)) return problemResponse(result.status, typeof result.reason === "string" ? result.reason : null);
  } catch {
    // JSON にできない結果。下の 503 にする
  }
  return problemResponse(503, "unavailable");
}
