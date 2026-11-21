import type { OperationDef } from "@nd-factory/contracts/operation";
import type { AuditChannel } from "../audit.ts";
import type { AuthDeps, AuthEndpoint, Principal } from "../auth/authenticate.ts";
import type { ItemAuthz, ScopeReader } from "../authorize.ts";
import type { Clock } from "../clock.ts";
import type { TransactItem } from "../conditional-write.ts";
import type { Db } from "../db.ts";
import type { ItemResult } from "../idempotency.ts";
import type { Id } from "../ids.ts";
import type { Logger } from "../log.ts";

// 操作の振り分けの型（docs/design/detail.md の「内部のデータと定数」、issues/issue-2-design-detail.md の項目の並び）。
// MCP の型（McpCall ほか）は #11 が mcp.ts に置く（決定 7）

export type { ItemResult };

// 振り分けを通る受け口。GitHub の Webhook は操作の表の経路でないため振り分けを通らない
export type CallEndpoint = Exclude<AuthEndpoint, "github">;

// 要求全体の誤りの理由のうち、本文で決まるもの（readHttpCall の検査の順）
export type BodyFaultReason = "body_not_json" | "body_not_array" | "body_empty" | "too_many_items" | "duplicate_item";

// readHttpCall が見つけた要求全体の誤り。dispatch が記録の行とともに返す（405 は認証の前、400 は認証の後）。405 は理由のコードを持たない
export type RequestFault = { readonly status: 400; readonly reason: BodyFaultReason } | { readonly status: 405; readonly reason: null };

export type OperationCall = {
  readonly endpoint: CallEndpoint;
  // 入口。人の token は画面、委任の token は受け口 user で API・受け口 mcp で MCP
  readonly channel: AuditChannel;
  readonly operation: string;
  readonly token: string | null;
  // MCP の tools/call で serveMcp が決めた主体だけが入れる。あれば dispatch は認証を繰り返さない
  readonly principal?: Principal;
  readonly items: readonly unknown[];
  readonly requestId: string;
  readonly mcpClientName?: string;
  // 関数の残り時間（ミリ秒）の読み手。起点が context.getRemainingTimeInMillis を渡し、dispatch が要素ごとの前に読む
  readonly remainingMs: () => number;
  readonly fault?: RequestFault;
};

// 要求全体の誤り（application/problem+json）。reason は REQUEST_REASONS のコードで、404・405 は持たない
export type Problem = { readonly kind: "problem"; readonly status: number; readonly reason: string | null };

export type DispatchResult = { readonly kind: "items"; readonly items: readonly ItemResult[] } | Problem;

export type AllowedAuthz = Extract<ItemAuthz, { decision: "allow" }>;

export type HandlerContext = {
  readonly principal: Principal;
  readonly authz: AllowedAuthz;
  readonly clock: Clock;
  readonly db: Db;
  // authenticate の sessionRevokedAt（sessions.delete で取り消しの行があったときだけその revoked_at、ほかは null）
  readonly sessionRevokedAt: string | null;
};

// ハンドラーは状態を自分で書かない。要素の結果と組んだ書き込み（putIfAbsent・updateIfVersion・usageAddItem の戻り値）を返す。
// 要求元の照らし（人の書き込み）は dispatch が足すため、ハンドラーは要求元の行を照らさない。
// createdUserId は sessions.create の初回で利用者を作った要素だけが返し、記録の主体をその利用者の人にする（audit の actorOfCreatedUser）
export type HandlerOutput = { readonly result: ItemResult; readonly writes: readonly TransactItem[]; readonly createdUserId?: Id<"usr"> };

// 要素は操作の形の正本で検証した後の値
export type Handler = (item: unknown, ctx: HandlerContext) => Promise<HandlerOutput>;

export type DispatchDeps = {
  readonly operations: readonly OperationDef[];
  // 鍵は操作の表の名前
  readonly handlers: Readonly<Record<string, Handler>>;
  readonly scope: ScopeReader;
  readonly auth: AuthDeps;
  readonly db: Db;
  readonly clock: Clock;
  readonly log: Logger;
};

// HTTP API（ペイロードの形式 2.0）の要求のうち、振り分けが読む所
export type HttpEvent = {
  readonly rawPath: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
  readonly isBase64Encoded: boolean;
  readonly requestContext: { readonly requestId: string; readonly http: { readonly method: string } };
};

export type HttpResponse = { readonly statusCode: number; readonly headers: Readonly<Record<string, string>>; readonly body: string };
