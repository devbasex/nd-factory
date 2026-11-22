import type { OperationDef } from "@nd-factory/contracts/operation";
import type { AuditChannel } from "../audit.ts";
import type { AuthEndpoint, AuthSetup, Principal } from "../auth/authenticate.ts";
import type { ItemAuthz, ScopeReader } from "../authorize.ts";
import type { Clock } from "../clock.ts";
import type { TransactItem } from "../conditional-write.ts";
import type { Db, StoredRow } from "../db.ts";
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

// readHttpCall が見つけた要求全体の誤り。dispatch が記録の行とともに返す（404・405 は認証の前、400 は認証の後）。404・405 は理由のコードを持たない。
// 404 は表に無い HTTP の経路で、呼び出しの操作の名前は空（記録の行の操作は null）
export type RequestFault = { readonly status: 400; readonly reason: BodyFaultReason } | { readonly status: 404 | 405; readonly reason: null };

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
  // 要求の中で同期に外へ働きかける操作（logins.delete の Cognito の呼び出し・notification_targets.test の送信）が、働きかける直前に呼ぶ要求元の照らし
  // （docs/design/data.md の「人の書き込みの要求元の照らし」の「要求の中で同期に外へ働きかける操作」）。照らしの 2 件だけのトランザクションを打ち、
  // 外れたら false を返す。false のときハンドラーは外へ働きかけずに返し、dispatch はハンドラーの戻り値によらず要素を 409 state_mismatch にして何も確定しない。
  // 照らしの要らない主体と操作では打たずに true。表に届かなければ要求全体の 503 unavailable
  readonly checkRequester: () => Promise<boolean>;
};

// 書き込みの件が外れたときの要素の結果。result は操作の契約にある失敗の結果（logins.delete の最後のログイン・logins.create の already_linked など）。
// existing は onConflict が return_existing の件で、既にある行（強い整合で読んだ行。読んだ時に無ければ null）から今回の結果を組む
export type WriteConflict = { readonly result: ItemResult } | { readonly existing: (row: StoredRow | null) => ItemResult };

// ハンドラーは状態を自分で書かない。要素の結果と組んだ書き込み（putIfAbsent・replaceIfVersion・deleteIfVersion・usageAddItem の戻り値）を返す。
// onConflict が rebuild の件だけが外れたら、dispatch が同じ要素と借りた冪等の鍵のままハンドラーを呼び直す（ハンドラーは行を読み直して組む）。
// 要求元の照らし（人の書き込み）は dispatch が足すため、ハンドラーは要求元の行を照らさない。
// conflicts は writes と同じ番号の件が外れたときの結果（無い件は onConflict の version_mismatch・state_mismatch を要素の 409 にする）。
// createdUserId は sessions.create の初回で利用者を作った要素だけが返し、記録の主体をその利用者の人にする（audit の actorOfCreatedUser）
export type HandlerOutput = {
  readonly result: ItemResult;
  readonly writes: readonly TransactItem[];
  readonly conflicts?: readonly (WriteConflict | undefined)[];
  readonly createdUserId?: Id<"usr">;
};

// 要素は操作の形の正本で検証した後の値
export type Handler = (item: unknown, ctx: HandlerContext) => Promise<HandlerOutput>;

export type DispatchDeps = {
  readonly operations: readonly OperationDef[];
  // 鍵は操作の表の名前
  readonly handlers: Readonly<Record<string, Handler>>;
  readonly scope: ScopeReader;
  // 認証の依存のうち Db と ScopeReader を除くもの。dispatch（と serveMcp）が下の db（委任の使った時刻の行の読み書き）と scope（委任の範囲と委任した人が今見られるプロジェクトの重なりの照らし）を渡す
  readonly auth: AuthSetup;
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
