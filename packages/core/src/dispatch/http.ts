import { MAX_ITEMS, type OperationDef } from "@nd-factory/contracts/operation";
import { operationByRoute } from "@nd-factory/contracts/operations";
import type { AuditChannel } from "../audit.ts";
import type { BodyFaultReason, CallEndpoint, DispatchResult, HttpEvent, HttpResponse, OperationCall, Problem, RequestFault } from "./types.ts";

// HTTP の要求を共通の呼び出しへ読み、振り分けの結果を HTTP の応答へ書く（docs/design/api.md の「呼び出しの規約」）

export function problem(status: number, reason: string | null): Problem {
  return { kind: "problem", status, reason };
}

// キーの順によらない JSON（同じ対象の重なりと冪等の鍵の fingerprint に使う）。
// 本文は JSON.parse を通ればどれだけ深くても受けるため、再帰せずに積みで書き出す（深い入れ子でスタックを使い切らない）
type Piece = { readonly value: unknown } | { readonly text: string };

export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  const stack: Piece[] = [{ value }];
  for (let piece = stack.pop(); piece !== undefined; piece = stack.pop()) {
    if ("text" in piece) {
      out.push(piece.text);
      continue;
    }
    const v = piece.value;
    if (v === null || typeof v !== "object") {
      out.push(JSON.stringify(v) ?? "null");
      continue;
    }
    // 積みは後から出すため、書き出す順の逆に積む
    const parts: Piece[] = [];
    if (Array.isArray(v)) {
      parts.push({ text: "[" });
      v.forEach((element: unknown, i) => {
        if (i > 0) parts.push({ text: "," });
        parts.push({ value: element });
      });
      parts.push({ text: "]" });
    } else {
      const entries = Object.entries(v)
        .filter(([, e]) => e !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      parts.push({ text: "{" });
      entries.forEach(([k, e], i) => {
        parts.push({ text: `${i > 0 ? "," : ""}${JSON.stringify(k)}:` });
        parts.push({ value: e });
      });
      parts.push({ text: "}" });
    }
    for (let i = parts.length - 1; i >= 0; i -= 1) stack.push(parts[i] as Piece);
  }
  return out.join("");
}

// 同じ対象かを比べる値。冪等の鍵は要素の送り直しを見分ける値で対象を指さないため、冪等の鍵を持つ操作では除いて比べる
// （同じリポジトリの追加・同じログインの外しを別の鍵で 2 回指す要求を、ハンドラーを呼ぶ前に断つ）
function targetOf(item: unknown, op: OperationDef | null): unknown {
  if (op?.idempotencyKey !== true || item === null || typeof item !== "object" || Array.isArray(item)) return item;
  const { idempotency_key: _key, ...rest } = item as Record<string, unknown>;
  return rest;
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
    const key = canonicalJson(targetOf(item, op));
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

// HTTP の経路は形の正本の操作の表だけで引く。表に無い経路（404）・経路の頭の受け口と操作の受け口の食い違い（405）・方法と本文の誤りは
// 呼び出しの fault に入れ、dispatch が要約の記録の行とともに返す（404・405 は認証の前、400 は認証の後）。表に無い経路の操作の名前は空にする。
// remainingMs は起点が渡す関数の残り時間の読み手（context.getRemainingTimeInMillis）
// 戻り値の型は詳細設計の形（OperationCall | Problem）のまま。要求全体の誤りも記録の行を残すため、今はいつも呼び出しを返す
export function readHttpCall(event: HttpEvent, remainingMs: () => number): OperationCall | Problem {
  const op = operationByRoute(event.rawPath);
  const endpoint = endpointOfPath(event.rawPath);
  const token = bearerOf(event);
  const base = { endpoint, channel: channelOf(endpoint, token), operation: op?.name ?? "", token, requestId: event.requestContext.requestId, remainingMs };
  const withFault = (fault: RequestFault): OperationCall => ({ ...base, items: [], fault });

  if (op === undefined) return withFault({ status: 404, reason: null });
  if (op.endpoint !== endpoint) return withFault({ status: 405, reason: null });
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
