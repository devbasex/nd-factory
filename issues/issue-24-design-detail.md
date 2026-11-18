# 詳細設計: 横断の部品が 1 か所にあり、画面・API・MCP の要求が同じ振り分けで同じ判定と記録を通る（#24）

[頭の文書](issue-24-design.md)の不変条件（I2・I4・I5・I8・I9・I12〜I15）と、[土台](issue-24-design-platform.md)の「横断の部品と定数の置き場」「アーキテクチャ」、[API と MCP](issue-24-design-api.md)の「呼び出しの規約」「認証と主体」「認可」「操作の記録」「形の正本」を、モジュールと関数の粒度へ下ろす。
扱うのは、リポジトリのモジュールの置き場と依存の向き、横断の部品の最上位の関数の仕様・異常系・並行と排他・記録の出し方・テストの観点である。
各コンテキストのモジュール（利用者とチーム・プロジェクト・実行の制御ほか）の関数は、受け持つ子の課題（K6〜K12）の詳細設計が持つ。横断の部品の形の細部（ファイルの単位・型の項目の並び）は K2 の詳細設計が決める（[子ごとの詳細設計で書くこと](issue-24-design-children.md#子ごとの詳細設計で書くこと)）。

## ファイル配置

省く: ファイルの単位の配置は子の課題（K2 ほか）の詳細設計が持つ。#24 は実装のファイルを触らない。モジュールの置き場と依存の向きは「クラスと関数の構造」にある

## クラスと関数の構造

型の関係は [形の正本](issue-24-design-api.md#形の正本) のクラス図と [コンテナの図](issue-24-design-platform.md#コンテナの図) を指し、ここでは描き直さない。モジュールの置き場はディレクトリの単位で決める（`*` は新設）。

```text
nd-factory/
├── packages/
│   ├── contracts/          形の正本（ある）。操作の表・値の形・設定の形・終了コード・生成
│   │   ├── src/
│   │   ├── data/           事実と方針のデータ（料金プラン・再試行の方針・秘密の形・終了コード）
│   │   ├── schema/         生成した JSON Schema と OpenAPI
│   │   └── scripts/        生成のスクリプト
│   └── core/             * 横断の部品（時計・ID と冪等の鍵・ログと伏せ字・外部の呼び出しと再試行・
│       └── src/              条件つきの書き込み・認証・認可の判定・使える量の判定・操作の記録の書き手・操作の振り分け）
├── apps/
│   ├── api/                API と MCP の 1 つの関数・見回り・知らせの送り手・表の移し（ある。広げる）
│   │   └── src/
│   │       ├── entries/  * Lambda ごとの起点（api-fn・patrol・notifier・migrate）
│   │       └── modules/  * コンテキストごとのモジュール（操作のハンドラーと、認可の判定へ渡す読み手）
│   ├── web/                画面（ある）
│   ├── runner/           * ランナー（ECS のタスクと手元のコンテナで同じものが動く）
│   ├── nd-runtime/       * nd ランタイム（手元のマシンで動く）
│   └── db-prep/          * DB の用意（ECS のタスク。claude と NDF を含まない）
├── infra/                  CDK のスタックと設置のコマンド（ある）
│   ├── bin/
│   ├── lib/
│   ├── setup/
│   └── test/
└── tools/                  検査（ある。広げる）
    ├── ref-check/          参照の検査（ある）
    ├── checks/           * 漏れ・境界・使える量の判定の外の比べ・I14 の対応・NDF の契約の照合
    └── test/               CI の定義のテスト（ある）
```

依存は一方向で、循環を持たない。`packages/contracts` は zod のほかに何にも依らない。`packages/core` は `packages/contracts` だけに依る。`apps/api`・`apps/runner`・`apps/nd-runtime`・`apps/db-prep` は `packages/core` と `packages/contracts` に依り、`apps/*` どうしは互いに import しない（ランナーと API は HTTP の経路だけでつながる）。`apps/web` は `packages/contracts` と、`packages/core` のうちブラウザーで動くモジュール（`clock`・`ids`・`redact`・`log`）だけに依る。`infra` は `packages/contracts` に依り、`apps/*` を import せずに起点のファイルのパスを資産として束ねるだけにする。`tools` は `packages/contracts` に依り、ほかの置き場のコードを文字として読む。`packages/core` が各コンテキストの表の行を読む所（席・割り当て・委任・マシン・レーン）は、`core` が読み手の型（ポート）だけを持ち、`apps/api/src/modules/` が中身を渡す。これで `core` から `apps` への向きの依存を作らない。

| 置き場 | モジュール | 最上位の関数 |
| --- | --- | --- |
| `packages/contracts/` | 操作の表・値の形・ID の頭・理由のコード・設定の形（ある。広げる） | 生成のスクリプトの関数（K2 の詳細設計が持つ）。操作の定義の型 `OperationDef` を `core` へ出す |
| `packages/core/`（この文書で決めた） | `clock` | `createClock`（新設） |
| `packages/core/` | `ids` | `newId`・`parseId`（新設） |
| `packages/core/` | `idempotency` | `claimIdempotency`・`settleIdempotency`（新設） |
| `packages/core/` | `redact` | `redact`（新設） |
| `packages/core/` | `log` | `createLogger`（新設） |
| `packages/core/` | `retry` | `withRetry`・`classifyFailure`（新設） |
| `packages/core/` | `outbound` | `callHttp`・`awsClient`（新設） |
| `packages/core/` | `conditional-write` | `putIfAbsent`・`updateIfVersion`・`writeAtomically`（新設） |
| `packages/core/` | `auth` | `authenticate`（新設） |
| `packages/core/` | `authorize` | `visibleProjectIds`・`authorize`（新設） |
| `packages/core/` | `usage-limit` | `judgeUsage`・`usageAddItem`（新設） |
| `packages/core/` | `audit` | `auditItem`・`appendAudit`（新設） |
| `packages/core/` | `dispatch` | `readHttpCall`・`readMcpCall`・`dispatch`・`writeHttpResponse`・`writeMcpResponse`（新設） |
| `apps/api/src/entries/`（この文書で決めた） | API と MCP の 1 つの関数の起点・見回り・知らせの送り手・表の移し | 起点の関数（`readHttpCall` か `readMcpCall` → `dispatch` → 応答の組み立てを呼ぶだけ）。中身は K2・K8・K10 の詳細設計 |
| `apps/api/src/modules/`（この文書で決めた） | コンテキストごとのモジュール | 操作ごとのハンドラーと、`authorize` へ渡す読み手。K6〜K12 の詳細設計 |
| `apps/web/` | 画面 | [画面](issue-24-design-screens.md) と K3・K4 の詳細設計 |
| `apps/runner/`（この文書で決めた） | ランナー | K8 の詳細設計。API への送信は `callHttp` を通す |
| `apps/nd-runtime/`（この文書で決めた） | nd ランタイム | K9 の詳細設計。API への送信は `callHttp` を通す |
| `apps/db-prep/`（この文書で決めた） | DB の用意 | K5・K8 の詳細設計 |
| `infra/` | スタックと設置のコマンド | 骨組みのまま。足す資源は K5 ほか |
| `tools/checks/`（この文書で決めた） | 足す検査 | K1 の詳細設計。境界の検査は下の「横断の部品の外で直に使わないもの」を `apps/` と `packages/core` の外の実行時のコードで探す |

境界の検査の対象は、実行の時に動くコード（`apps/` の 6 つの置き場）である。`infra/` と `tools/` は組み立てと反映の時だけ動くため対象から外し、`infra/setup/` の AWS SDK のクライアントの直の生成は今のまま使う（この文書で決めた）。

## 関数の仕様

型の名前（`Clock`・`Principal`・`TransactItem` など）の中身は「内部のデータと定数」にある。

| 関数 | 置き場 | 種類 | シグネチャ | 責務 1 文 | 事前条件 | 事後条件 | 副作用 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `createClock` | `packages/core`（`clock`） | 新設 | `(source?: () => number) => Clock` | 今の時刻を UTC で返す時計を作り、テストで時刻の元を差し替えられるようにする | `source` は UNIX のミリ秒を返す | `now()` は `Date`、`iso()` は末尾 `Z`・ミリ秒 3 桁の RFC 3339 を返す。同じ時計から得た値は減らない | 無し |
| `newId` | `packages/core`（`ids`） | 新設 | `(kind: IdKind, clock: Clock) => Id` | 種類の頭と UUIDv7 から ID を作る | `kind` は形の正本の ID の頭の集まりの 1 つ | 戻り値は `<頭>_<UUIDv7>` の小文字で、時刻の順に並ぶ。乱数は Web Crypto の乱数だけから取る | 無し |
| `parseId` | `packages/core`（`ids`） | 新設 | `(kind: IdKind, value: string) => Id \| null` | 受けた ID が指定の種類の形かを照らす | 無し | 頭と UUIDv7 の形が合えば値を、合わなければ `null` を返す（呼び手は 404 と同じに扱う） | 無し |
| `claimIdempotency` | `packages/core`（`idempotency`） | 新設 | `(db: Db, claim: IdempotencyClaimInput, clock: Clock) => Promise<IdempotencyClaim>` | 主体・操作・鍵の組の 1 回目を押さえ、2 回目以降に前の結果か状態を返す | `claim.fingerprint` は要素の正規化した JSON の SHA-256 | 戻り値は `fresh`（押さえた）・`replay`（前の要素の結果）・`in_progress`（他が処理中）・`reused`（中身が違う）のどれか。`fresh` のとき冪等の表に借りの行がある | DynamoDB の `db-idempotency` への条件つきの書き込みと強い整合の読み |
| `settleIdempotency` | `packages/core`（`idempotency`） | 新設 | `(claim: IdempotencyClaimInput, result: ItemResult, clock: Clock) => TransactItem` | 借りの行を「済み」と要素の結果へ書き換える書き込みを組む | `claimIdempotency` が `fresh` を返した組 | 戻り値は借りの行の持ち主を条件にした更新の 1 件。1 回だけ返す値（token など）は結果から `null` に替えて控える | 無し |
| `redact` | `packages/core`（`redact`） | 新設 | `(value: unknown) => unknown` | 値の木を写し、秘密の鍵の名前と秘密の形の値を伏せる | 無し | 戻り値に、秘密の形のデータに当たる鍵の値と、秘密の形に当たる文字列が残らない。元の値は変えない。循環は `"[cycle]"` に替える | 無し |
| `createLogger` | `packages/core`（`log`） | 新設 | `(context: LogContext, sink?: (line: string) => void) => Logger` | 要求の ID などの文脈を持った、JSON の 1 行を出すログの書き手を作る | `context.request_id` がある | `Logger.info`・`warn`・`error` は、文脈と項目を `redact` に通して 1 行の JSON にし、`sink` へ渡す | 標準出力へ 1 行を書く（Lambda では CloudWatch Logs へ届く） |
| `withRetry` | `packages/core`（`retry`） | 新設 | `<T>(op: (attempt: number) => Promise<T>, policy: RetryPolicy, opts: { classify: (e: unknown) => FailureClass; deadline?: number; sleep?: (ms: number) => Promise<void> }) => Promise<T>` | 方針のデータに従って、再試行してよい失敗だけを待って繰り返す | `op` は同じ引数で繰り返してよい処理（冪等か、届かなかったと分かる失敗だけを繰り返す方針） | 成功の値を返すか、最後の失敗を `RetryExhausted`（回数と分類を持つ）で投げる。`deadline` を越えて待たない | 渡した処理の副作用を最大 `policy.max_attempts` 回起こし、間で待つ |
| `classifyFailure` | `packages/core`（`retry`） | 新設 | `(e: unknown) => FailureClass` | HTTP の状態・AWS SDK の例外の名前・網の誤りを 5 つの分類に分ける | 無し | 戻り値は `retryable`・`conflict`・`not_found`・`rejected`・`unknown` のどれか | 無し |
| `callHttp` | `packages/core`（`outbound`） | 新設 | `(req: OutboundRequest, policyName: RetryPolicyName, deps: OutboundDeps) => Promise<OutboundResult>` | 外への HTTP の呼び出しを時間切れ・再試行・分類つきで行う | `req.url` は `https:`。`req.idempotent` を呼び手が決めている | 戻り値は状態・頭書きの一部・本文と分類。冪等でない要求は、届かなかったと分かる失敗（接続の拒否・429）だけを繰り返す | 外部への HTTPS の要求（GitHub・IdP の鍵・Web Push・Slack・ランナーから API） |
| `awsClient` | `packages/core`（`outbound`） | 新設 | `<C>(make: (config: AwsClientConfig) => C, policyName: RetryPolicyName) => C` | AWS SDK のクライアントを、方針のデータの回数と時間切れで作る | `make` は SDK のクライアントの構築子を包む関数 | 戻り値のクライアントは `maxAttempts` と要求ごとの時間切れが方針のデータの値。同じ方針の名前の 2 回目は同じクライアントを返す | 無し |
| `putIfAbsent` | `packages/core`（`conditional-write`） | 新設 | `(spec: { table: TableName; item: Row; onConflict: ConflictRule }) => TransactItem` | 行が無いときだけ足す書き込みを組む | `item` は `pk`・`sk`・`schema_version` を持つ | 戻り値は `attribute_not_exists(pk)` を条件にした 1 件で、外れたときの扱い（`state_mismatch`・`return_existing` など）を持つ | 無し |
| `updateIfVersion` | `packages/core`（`conditional-write`） | 新設 | `(spec: { table: TableName; key: RowKey; version: number; set: Record<string, unknown>; extra?: Condition; onConflict: ConflictRule }) => TransactItem` | 読んだときの版と同じときだけ書き、版を 1 つ上げる書き込みを組む | `version` は 1 以上の整数。`set` に `pk`・`sk`・`version` を含まない | 戻り値は `version = :expected`（と `extra`）を条件にし、`version` を 1 上げる 1 件 | 無し |
| `writeAtomically` | `packages/core`（`conditional-write`） | 新設 | `(db: Db, items: readonly TransactItem[]) => Promise<WriteOutcome>` | 組んだ書き込みを 1 つのトランザクションで確定し、外れた条件を件ごとの扱いへ訳す | `items` は 1〜100 件で、同じ行を 2 回指さない | `ok` のとき全件が書かれている。`conflict` のときどれも書かれておらず、外れた件の番号と扱いを返す | DynamoDB の `TransactWriteItems`（表をまたいでよい） |
| `authenticate` | `packages/core`（`auth`） | 新設 | `(req: InboundRequest, deps: AuthDeps) => Promise<AuthResult>` | 受け口の種類と token の種類から、要求の主体を 1 つに決める | `req.endpoint` は受け口（`user`・`mcp`・`runner`・`machine`・`github`・`db_prep`。受けた HTTP の経路の頭で決まる）。`deps` は鍵と読み手を持つ | 戻り値は主体（人・委任・ランナー・手元のマシン・GitHub・DB の用意のタスク）か、`unauthorized`・`unavailable`。受け口に合わない token は `unauthorized` | IdP の公開鍵の取得（HTTPS、関数の中で控える）・DynamoDB の強い整合の読み・委任の最後に使った時刻の条件つきの更新 |
| `visibleProjectIds` | `packages/core`（`authorize`） | 新設 | `(principal: Principal, scope: ScopeReader) => Promise<readonly ProjectId[]>` | 主体が今見られるプロジェクトの ID の集まりを求める | `principal` は `authenticate` が返したもの | 人は席を持つチームに今割り当てたプロジェクト、委任は委任した人の範囲と委任の範囲の重なり、ランナーと手元のマシンは自分のレーンのプロジェクトだけ、DB の用意のタスクは token に結んだ用意するプロジェクトだけを返す | 読み手を通した DynamoDB の読み（席・割り当て・レーン） |
| `authorize` | `packages/core`（`authorize`） | 新設 | `(principal: Principal, op: OperationDef, items: readonly unknown[], scope: ScopeReader) => Promise<AuthzDecision>` | 操作の表の印と主体から、要求全体と要素ごとに通すかを 1 か所で決める | `items` は形の正本の検証を通った要素の配列 | 戻り値は要求全体の拒み（`human_only`・`scope_insufficient`）か、要素ごとの `allow`（対象のプロジェクトの ID と席の役割つき）・`404 not_found`・`403 role_insufficient`・`403 human_only` | 読み手を通した DynamoDB の読み |
| `judgeUsage` | `packages/core`（`usage-limit`） | 新設 | `(input: UsageInput, plan: PlanRow) => UsageVerdict` | 料金プランの値と使った量から、始めてよいか・割り当ててよいか・次の区間を起こしてよいかと理由を返す | `input.used` と `input.cap` は同じ形の金額（I15） | 戻り値は `allowed: true` か、`allowed: false` と理由のコード（`monthly_cap_reached`・`place_not_allowed`・`inference_not_allowed`・`concurrency_full`・`currency_mismatch`）と待てば解けるか。プランの名前で分けない | 無し |
| `usageAddItem` | `packages/core`（`usage-limit`） | 新設 | `(team: TeamId, cost: Money, clock: Clock) => TransactItem` | チームの月の使った量の行へ費用を足す書き込みを組む | `cost.amount_minor` は 0 以上の整数 | 戻り値は `USAGE#<UTC の年月>` の行の通貨が同じことを条件にした加算の 1 件。行が無ければ作る | 無し |
| `auditItem` | `packages/core`（`audit`） | 新設 | `(entry: AuditEntry, op: OperationDef \| null, clock: Clock) => TransactItem` | 操作の記録の 1 行を、許した鍵だけを写して組む | `entry` は主体・入口・結果を持つ | 戻り値は記録の表への `putIfAbsent` の 1 件。対象の ID は `op.auditKeys` の鍵だけ。本文・秘密・個人情報の値を持たない。区切りの鍵は見られたプロジェクトがあればそのプロジェクト、無ければ主体 | 無し |
| `appendAudit` | `packages/core`（`audit`） | 新設 | `(db: Db, entry: AuditEntry, op: OperationDef \| null, clock: Clock) => Promise<void>` | 状態を書かない要求（読む操作・断った要求・要求全体の要約）の記録を 1 行追記する | 状態の書き込みを伴う要素の記録には使わない（それは `auditItem` をトランザクションへ入れる） | 戻ったとき記録の表に 1 行がある。書けなければ `AuditUnavailable` を投げる | DynamoDB の `db-audit` への書き込み |
| `readHttpCall` | `packages/core`（`dispatch`） | 新設 | `(event: HttpEvent) => OperationCall \| Problem` | HTTP の要求を、受け口の種類・入口・操作の名前・token・要素の配列を持つ共通の呼び出しへ読む | `event` は HTTP API の要求の形 | 戻り値は呼び出しか、要求全体の誤り（`body_not_json`・`body_not_array`・`body_empty`・`too_many_items`・`duplicate_item`・405）。HTTP の経路は形の正本の HTTP の経路の表だけで引く | 無し |
| `readMcpCall` | `packages/core`（`dispatch`） | 新設 | `(event: HttpEvent, webOrigin: string) => McpCall \| McpReply` | `/mcp` の JSON-RPC の要求を、道具の呼び出しなら共通の呼び出しへ、それ以外ならその場の応答へ読む | `webOrigin` は画面のオリジン | `tools/call` は入口「MCP」の印と `arguments.items` を要素にした呼び出し。`initialize`・`tools/list`・知らせ・知らない方法・`Origin` の違い・`GET` と `DELETE` はその場の応答 | 無し |
| `dispatch` | `packages/core`（`dispatch`） | 新設 | `(call: OperationCall, deps: DispatchDeps) => Promise<DispatchResult>` | 認証・形の検証・認可・冪等の鍵・ハンドラー・書き込みの確定・操作の記録を、どの受け口でも同じ順で通す | `deps` は操作の表・ハンドラーの表・読み手・`Db`・時計・ログを持つ | 戻り値は要求全体の誤りか、要求と同じ数・同じ順の要素の結果。状態を書いた要素には同じトランザクションに記録の行がある。要求ごとに記録の要約の行がある | 認証と認可の読み・ハンドラーが組んだ書き込みの確定（DynamoDB）・記録の追記 |
| `writeHttpResponse` | `packages/core`（`dispatch`） | 新設 | `(result: DispatchResult) => HttpResponse` | 振り分けの結果を HTTP の応答へ書く | 無し | 要素の結果は 200 と配列、要求全体の誤りは `application/problem+json`。どの応答も `Cache-Control: no-store`。500 を返さない | 無し |
| `writeMcpResponse` | `packages/core`（`dispatch`） | 新設 | `(result: DispatchResult \| McpReply, rpcId: string \| number \| null) => HttpResponse` | 振り分けの結果を MCP の JSON の 1 応答へ書く | 無し | 要素の結果は `structuredContent` と同じ値の JSON の文字列の `content`。要求全体の誤りは `isError: true` と problem の JSON | 無し |

ハンドラーは状態を自分で書かない。`dispatch` から要素を 1 つ受け、要素の結果と、組んだ書き込み（`putIfAbsent`・`updateIfVersion`・`usageAddItem` の戻り値）を返す。確定は `dispatch` が記録の行と冪等の鍵の済みの行と一緒に `writeAtomically` で行う。これで記録の無い状態の書き込み（I9）と、済みにならない冪等の鍵が起こらない。

## 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `claimIdempotency` | 同じ組が処理中 | 並んだ 2 つの要求か、前の要求の途中 | 借りの行の条件の外れと、借りの期限の前 | 呼び出し元へ返す | 要素の 409 `in_progress` | 後始末なし。呼び手は待って同じ要素を送り直せる |
| `claimIdempotency` | 中身が違う | 同じ鍵を別の要素に使い回した | 借りの行の `fingerprint` と比べた所 | 呼び出し元へ返す | 要素の 422 `idempotency_key_reused` | 再実行しても同じ。呼び手が新しい鍵を作る |
| `claimIdempotency` | 表に届かない | DynamoDB の失敗・時間切れ | `writeAtomically` と読みの例外 | 再試行（方針 `dynamodb`）の後に呼び出し元へ返す | 要求全体の 503 `unavailable` | 借りの行は書けていないか、書けても期限で取り直せる。再実行できる |
| `createLogger` | 書けない | 標準出力の誤り・値を JSON にできない | `sink` の呼び出しと `JSON.stringify` | 既定値で続ける（JSON にできない値は `"[unserializable]"` に替える。`sink` の例外は捨てる） | 無し（ログの欠けは操作の結果を変えない） | 後始末なし |
| `withRetry` | 回数を使い切った | 再試行してよい失敗が続いた | 回数の数え | 呼び出し元へ返す（`RetryExhausted`） | 呼び手が決める。API では 503 `unavailable` | 後始末なし。後から再実行できる |
| `withRetry` | 再試行してはいけない失敗 | 分類が `conflict`・`not_found`・`rejected` | `classify` の戻り値 | 呼び出し元へ返す（最初の失敗のまま） | 呼び手が決める | 繰り返さない |
| `withRetry` | 期限に届く | 次の待ちが `deadline` を越える | 待つ前の残り時間の照らし | 呼び出し元へ返す（`RetryExhausted`、理由は期限） | 呼び手が決める。API では 503 `unavailable` | 後から再実行できる |
| `callHttp` | 時間切れ | 相手が遅い・網の不調 | `AbortSignal` の時間切れ | 冪等な要求は再試行、冪等でない要求は呼び出し元へ返す（届いたか分からない） | 呼び手が決める。届いたか分からない外への作成は「行う予定」の行に印を残し、作り直さない（[起票の依頼](issue-24-design-execution.md#起票の依頼)） | 冪等なら再実行できる |
| `callHttp` | 相手の 429・5xx | 呼びすぎ・相手の障害 | 応答の状態 | 再試行（`Retry-After` を方針の上限まで守る） | 使い切れば呼び手へ `retryable` の結果 | 再実行できる |
| `callHttp` | 相手の 4xx（429 を除く） | 要求の誤り・権限の無さ | 応答の状態 | 呼び出し元へ返す（`rejected`・`not_found`・`conflict`） | 呼び手が決める | 同じ要求の再実行は同じ結果 |
| `callHttp` | `https:` でない URL | 呼び手の誤り | 送る前の照らし | 止める（例外） | API では 503 `unavailable` とログの error | 直すまで再実行しない |
| `writeAtomically` | 条件の外れ | 版の違い・状態の違い・既にある行 | `TransactionCanceledException` の件ごとの理由が `ConditionalCheckFailed` | 呼び出し元へ返す（件の番号と `onConflict` の扱い） | 呼び手が要素の 409 `version_mismatch`・`state_mismatch` か、`return_existing` なら前の 1 件の結果にする | 何も書かれていない。読み直して送り直せる |
| `writeAtomically` | トランザクションどうしの衝突 | 同じ行を同時に書く別の要求 | 件ごとの理由が `TransactionConflict` | 再試行（方針 `dynamodb`） | 使い切れば要求全体の 503 `unavailable` | 何も書かれていない。再実行できる |
| `writeAtomically` | 表に届かない | 呼びすぎ・障害・時間切れ | SDK の例外 | 再試行の後に呼び出し元へ返す | 要求全体の 503（記録の行を含むなら `audit_unavailable`、含まなければ `unavailable`） | 何も書かれていない。冪等の鍵で再実行できる |
| `writeAtomically` | 件の数が上限を越える | ハンドラーが組んだ書き込みが多すぎる | 送る前の数え | 止める（例外） | 要求全体の 503 `unavailable` とログの error | 設計の誤りで、テストが先に落とす |
| `authenticate` | token が無い・形が違う・署名が違う・期限切れ・取り消し済み・受け口に合わない | 呼び手の誤りか古い token | 種類ごとの照らし | 呼び出し元へ返す（`unauthorized`） | 要求全体の 401 `unauthorized`（理由によらず同じ本文） | 後始末なし。新しい token で再実行できる |
| `authenticate` | IdP の公開鍵を取れない・表に届かない | 網・依存先の障害 | `callHttp` と読みの失敗 | 再試行の後に呼び出し元へ返す（`unavailable`） | 要求全体の 503 `unavailable`（401 にしない） | 再実行できる |
| `authenticate` | 委任の最後に使った時刻を書けない | 表の失敗・条件の外れ | 条件つきの更新の失敗 | 既定値で続ける（主体は決めたまま） | 無し。ログの warn | 次の要求で書き直す |
| `visibleProjectIds` | 読み手が失敗する | 表に届かない | 読み手の例外 | 呼び出し元へ返す | 要求全体の 503 `unavailable` | 再実行できる |
| `authorize` | 対象が見えない・無い | 割り当ての外・ID の種類の違い・消えた対象 | 対象のプロジェクトの引きと見える集まりの照らし | 呼び出し元へ返す（要素の拒み） | 要素の 404 `not_found`（無い対象と同じ本文） | 後始末なし |
| `authorize` | 委任で人だけの操作・委任の種類が足りない | 呼び手の範囲の外 | 操作の印と委任の範囲の照らし | 呼び出し元へ返す（要求全体の拒み） | 要求全体の 403 `human_only`・`scope_insufficient` | 何も保存しない |
| `authorize` | 役割が足りない・要素だけ人だけ | 席がメンバー・レッドラインに当たる問い | 席の役割と要素の区分の照らし | 呼び出し元へ返す（要素の拒み） | 要素の 403 `role_insufficient`・`human_only` | 後始末なし |
| `authorize` | 読み手が失敗する | 表に届かない | 読み手の例外 | 呼び出し元へ返す | 要求全体の 503 `unavailable`（迷うときは見せない） | 再実行できる |
| `appendAudit` | 書けない | 表に届かない・再試行の使い切り | `writeAtomically` の失敗 | 呼び出し元へ返す（`AuditUnavailable`） | 読む操作は値を返さず要求全体の 503 `audit_unavailable` | 再実行できる。値は渡していない |
| `dispatch` | 要求全体の形の誤り | 本文の誤り | `readHttpCall`・`readMcpCall` の戻り値 | 呼び出し元へ返す | 要求全体の 400 と理由のコード。記録の行を 1 件書く | 後始末なし |
| `dispatch` | 要素の形の誤り | 要素が操作の形に合わない | 形の正本の zod の検証 | 呼び出し元へ返す（要素ごと） | 要素の 400 `item_invalid` と `fields` | 後始末なし |
| `dispatch` | 全部か無かの操作で 1 つの要素が失敗 | どれかの要素の拒みか条件の外れ | 要素の結果の集め | 呼び出し元へ返す | 失敗した要素はその誤り、ほかの要素は 409 `not_applied` | 何も書かない。直して全体を送り直す |
| `dispatch` | ハンドラーの想定しない例外 | 実装の誤り・依存先の障害 | ハンドラーの呼び出しの外側 | 呼び出し元へ返す | 要求全体の 503 `unavailable`。要求の ID とともにログの error | その要素の書き込みは確定していない。前の要素は確定済みで、冪等の鍵の送り直しで同じ結果が返る |
| `dispatch` | 要素の確定の途中で記録を書けない | 表に届かない | `writeAtomically` の失敗 | 呼び出し元へ返す（残りの要素を処理しない） | 要求全体の 503 `audit_unavailable` | その要素は書かれていない。前の要素は確定済みで、冪等の鍵で再実行できる |
| `dispatch` | 要約の記録の行を書けない | 表に届かない | `appendAudit` の失敗 | 呼び出し元へ返す | 要求全体の 503 `audit_unavailable`。読む操作は値を返さない | 書く要素は要素の記録の行とともに確定済み。冪等の鍵で再実行すると同じ結果が返る |
| `dispatch` | 関数の残り時間が足りない | 要素が多い・依存先が遅い | 要素ごとの前の残り時間の照らし | 呼び出し元へ返す（残りの要素を処理しない） | 要求全体の 503 `unavailable` | 処理した要素は確定済み。冪等の鍵で再実行できる |

## 処理の手順

| 関数 | 条件の組み合わせ | 結果 |
| --- | --- | --- |
| `dispatch` | 受けた方法が `POST` でない | 405。記録の行を 1 件 |
| `dispatch` | `authenticate` が `unauthorized` | 要求全体の 401。主体の無い記録の行を 1 件 |
| `dispatch` | `authenticate` が `unavailable` | 要求全体の 503 `unavailable`。記録の行を試み、書けなくても 503 のまま |
| `dispatch` | 主体の種類が受け口に合わない（例: 人の token で `/mcp`、委任の token で `/v1/runner/…`） | 要求全体の 401（`authenticate` が返す） |
| `dispatch` | 本文の誤り（`readHttpCall` の順: JSON でない → 配列でない → 空 → 101 個以上 → 同じ対象の重なり） | 最初に当たった理由で要求全体の 400 |
| `dispatch` | 操作が人だけ（`always`）で主体が委任 | 要求全体の 403 `human_only`。ハンドラーを呼ばない |
| `dispatch` | 委任の種類（`read`・`run`・`manage`）が操作の印より弱い | 要求全体の 403 `scope_insufficient` |
| `dispatch` | 上を通った要素ごと: 形の誤り → 見えない → 人だけの要素 → 役割 → 冪等の鍵 → ハンドラー | 先に当たったものを要素の結果にする。見えない要素は役割を照らさない（403 で存在を明かさない） |
| `dispatch` | 書く操作の要素で、ハンドラーが書き込みを返した | 書き込み・`auditItem` の要素の行・`settleIdempotency` を 1 つの `writeAtomically` で確定する |
| `dispatch` | 読む操作 | ハンドラーの値を集め、`appendAudit` が成功してから返す |
| `dispatch` | 全部か無かの印のある操作 | すべての要素の書き込みを 1 つの `writeAtomically` に集め、要素の失敗が 1 つでもあれば確定しない |
| `authenticate` | 受け口 `user` で、token が 3 つの部分の JWT | Cognito の access token として、署名（`kid` の公開鍵）・発行元・`client_id`・`token_use` が `access`・期限を照らす。通れば人 |
| `authenticate` | 受け口 `user` か `mcp` で、token が `ndfd_` で始まる | 委任として、中の利用者と委任の ID で行を強い整合で読み、秘密の部分の SHA-256 を一定時間で比べ、期限と取り消しを照らす。入口は受け口で `API` か `MCP` |
| `authenticate` | 受け口 `mcp` で、token が JWT | `unauthorized` |
| `authenticate` | 受け口 `runner` | Ed25519 の JWT で宛先「レーン」。引き換えの HTTP の経路だけ引き換えの token、ほかはレーンの token。レーンの行が終わっていないことと世代の番号を照らす |
| `authenticate` | 受け口 `machine` で、token が `ndfm_` で始まる | 中のチームとマシンの ID で行を強い整合で読み、要約を一定時間で比べ、取り消しと期限を照らす |
| `authenticate` | 受け口 `github` | `Authorization` を読まず、本文の HMAC-SHA256 を秘密の器の値と一定時間で比べる |
| `authenticate` | 受け口 `db_prep` | Ed25519 の JWT で宛先「DB の用意」。引き換えの HTTP の経路だけ引き換えの token、終わりの報告の HTTP の経路だけ終わりの報告の token。どちらも 1 回だけで、そのプロジェクトの進行表の DB が作成中か差し替えの途中であることを照らす |
| `authenticate` | JWT の `kid` が控えに無い | 公開鍵を 1 回だけ取り直す（関数の中で 1 分に 1 回まで）。それでも無ければ `unauthorized` |
| `authorize` | 主体が人 | 見える集まり = 席を持つチームの今の割り当て。役割は席の役割 |
| `authorize` | 主体が委任 | 見える集まり = 委任した人の今の集まり ∩ 委任の範囲のプロジェクト。役割は委任した人の席の役割 |
| `authorize` | 主体がランナーか手元のマシン | 自分向けの HTTP の経路の操作だけ。見える集まりは自分のレーンのプロジェクトだけ |
| `authorize` | 主体が DB の用意のタスク | 自分向けの HTTP の経路の操作だけ。見える集まりは token に結んだ用意するプロジェクトだけ |
| `authorize` | 主体が見回り | 保守の操作だけ。利用者向けの操作は要求全体で拒む |
| `authorize` | 要素の対象が割り当てを移す途中のプロジェクトで、主体が移す先のチームの持ち主 | 名前だけを読む操作の要素だけ通す（I2 の例外）。ほかは 404 |
| `authorize` | 対象の ID の種類の頭が操作と合わない | 404 `not_found`（`parseId` が `null`） |
| `claimIdempotency` | 行が無い | 借りの行（持ち主の要求の ID・`fingerprint`・借りの期限）を条件つきで書き、`fresh` |
| `claimIdempotency` | 済みの行で `fingerprint` が同じ | `replay`（控えた要素の結果） |
| `claimIdempotency` | 行があり `fingerprint` が違う | `reused` |
| `claimIdempotency` | 借りの行で期限の前 | `in_progress` |
| `claimIdempotency` | 借りの行で期限を過ぎた | 持ち主を自分へ替える条件つきの更新に勝てば `fresh`、負ければ `in_progress` |
| `judgeUsage` | 時点が「始める」 | 実行の場所と推論の手段がプランに無ければ `place_not_allowed`・`inference_not_allowed`。上限額があり使った額が上限額以上なら `monthly_cap_reached`（待っても解けない） |
| `judgeUsage` | 時点が「割り当てる」 | 同時に動くレーンの数がプランの数以上なら `concurrency_full`（待てば解ける）。上限なしの行は照らさない |
| `judgeUsage` | 時点が「区間の境」 | 使った額が上限額以上なら `monthly_cap_reached`（待てば解ける: 上限額を変えるか月が替わる） |
| `judgeUsage` | 使った額と上限額の通貨が違う | `currency_mismatch`（通さない。換算しない） |
| `classifyFailure` | 429・500・502・503・504・網の誤り・時間切れ・`ThrottlingException`・`ProvisionedThroughputExceededException`・`TransactionConflict` | `retryable` |
| `classifyFailure` | 409・`ConditionalCheckFailedException` | `conflict` |
| `classifyFailure` | 404・`ResourceNotFoundException` | `not_found` |
| `classifyFailure` | ほかの 4xx・`ValidationException`・`AccessDeniedException` | `rejected` |
| `classifyFailure` | 上のどれでもない | `unknown`（再試行しない） |
| `readMcpCall` | `Origin` の頭書きがあり画面のオリジンでない | 403 |
| `readMcpCall` | 方法が `initialize` | サーバーの名前と能力（道具だけ）を返す |
| `readMcpCall` | 方法が `tools/list` | 形の正本から生成した道具の一覧（人だけでない操作、操作の表の順）。記録の行を 1 件 |
| `readMcpCall` | 方法が `tools/call` で、名前が道具の一覧に無い | JSON-RPC の誤り `-32602`。記録の行を 1 件（操作は空） |
| `readMcpCall` | 方法が知らせ（`notifications/` で始まる） | 202 で本文なし |

- 繰り返しの終わる条件: `withRetry` は `policy.max_attempts` 回か `deadline` で終わる。`dispatch` の要素の繰り返しは要素の数（1〜100）で終わり、各要素の前に関数の残り時間が `DISPATCH_RESERVE_MS` を下回れば打ち切る。`claimIdempotency` の取り直しは 1 回だけ。
- 計算量の注意: `dispatch` は書く要素ごとに 1 つのトランザクションを順に確定する（100 要素で 100 回）。`visibleProjectIds` は要求ごとに 1 回だけ求め、要素ごとに求め直さない。委任の照らしと見える集まりは要求をまたいで控えない（取り消しと席の変化を次の要求から効かせるため）。

## 内部のデータと定数

| 名前 | 種類 | 置き場 | 既定値 |
| --- | --- | --- | --- |
| `Clock` | 型 | `packages/core`（`clock`） | `{ now(): Date; iso(): string }` |
| `IdKind` | 型（値の集合は形の正本） | `packages/contracts`（ID の頭の集まり） | `usr`・`team`・`inv`・`prj`・`repo`・`trf`・`spr`・`lane`・`apr`・`qst`・`ntc`・`dst`・`dlg`・`mch`・`key`・`aud`（[値の形](issue-24-design-api.md#値の形)） |
| `IdempotencyClaimInput` | 型 | `packages/core`（`idempotency`） | `{ principalKey, operation, key, fingerprint, requestId }` |
| `IdempotencyClaim` | 型 | `packages/core`（`idempotency`） | `fresh`・`replay`・`in_progress`・`reused` の 4 つの形 |
| `IDEMPOTENCY_TTL_SECONDS` | 定数 | `packages/contracts`（操作の規約の値） | 86400（24 時間） |
| `IDEMPOTENCY_LEASE_MS` | 定数 | `packages/core`（`idempotency`） | API の関数の時間切れ（今 10 秒）の 2 倍。時間切れの値は形の正本の設定から読み、ここで数を重ねて持たない |
| `LogContext`・`Logger` | 型 | `packages/core`（`log`） | 文脈は `request_id`・`fn`・`endpoint`（受け口）。項目は `level`・`msg`・`time` と任意の ID と数 |
| 秘密の形のデータ | 設定値（データ） | `packages/contracts/data/`（秘密の形） | 鍵の名前（`authorization`・`token`・`secret`・`password`・`credentials`・`private_key`・`dsn` を含む名前）と値の形（`ndfd_`・`ndfm_`・JWT の形・`ghs_` などの GitHub の token・私有鍵の頭・利用者と合言葉を含む接続の URL・AWS の一時の鍵の形）。漏れの検査（K1）も同じデータを読み、2 か所に持たない |
| `RetryPolicy` | 型 | `packages/contracts`（形） | `{ max_attempts, base_ms, cap_ms, timeout_ms, honor_retry_after }`。待ちは上限つきの指数と全幅のゆらぎ |
| 再試行の方針の表 | 設定値（データ） | `packages/contracts/data/`（再試行の方針） | `dynamodb` 3 回・50〜1000 ミリ秒・2 秒、`aws-control`（ECS・Secrets Manager・STS）3 回・200〜2000 ミリ秒・5 秒、`http-github` 3 回・500〜5000 ミリ秒・10 秒、`http-idp-keys` 2 回・200〜1000 ミリ秒・3 秒、`http-notify`（Web Push・Slack）3 回・500〜5000 ミリ秒・5 秒、`runner-to-api` 5 回・1000〜30000 ミリ秒・10 秒。値の調整は K2 の詳細設計 |
| `FailureClass` | 型 | `packages/core`（`retry`） | `retryable`・`conflict`・`not_found`・`rejected`・`unknown` |
| `OutboundRequest`・`OutboundResult` | 型 | `packages/core`（`outbound`） | 要求は `{ method, url, headers, body, idempotent }`、結果は `{ status, headers, body, class }` |
| `TransactItem` | 型 | `packages/core`（`conditional-write`） | SDK の 1 件と、外れたときの扱い `onConflict`（`version_mismatch`・`state_mismatch`・`return_existing`・`fail`） |
| `TRANSACT_MAX_ITEMS` | 定数（外部の仕様の値） | `packages/core`（`conditional-write`） | 100（DynamoDB の 1 つのトランザクションの件の上限。出所を添える） |
| `WriteOutcome` | 型 | `packages/core`（`conditional-write`） | `{ ok: true }` か `{ ok: false; failed: { index, onConflict }[] }` |
| `Principal` | 型 | `packages/core`（`auth`） | `human`（利用者の ID）・`delegation`（利用者の ID・委任の ID・範囲・クライアントの名前）・`runner`（レーンの ID・世代）・`machine`（チームの ID・マシンの ID）・`github`・`db_prep`（プロジェクトの ID・用意の ID）・`patrol` |
| `AuthDeps` | 型 | `packages/core`（`auth`） | IdP の発行元とクライアント ID（設定）・レーンの検証の鍵（秘密の器から起動のときに 1 回読む）・Webhook の秘密・委任とマシンとレーンの行の読み手・時計 |
| 委任の token の形 | 定数（形） | `packages/contracts`（token の形） | `ndfd_<利用者の ID>.<委任の ID>.<秘密の部分 32 バイトの base64url>`（この文書で決めた。行を区切りの鍵で強い整合で読むため） |
| 登録の token の形 | 定数（形） | `packages/contracts`（token の形） | `ndfm_<チームの ID>.<マシンの ID>.<秘密の部分 32 バイトの base64url>`（この文書で決めた） |
| `JWKS_CACHE_MS` | 定数 | `packages/core`（`auth`） | 3600000（1 時間）。`kid` が無いときの取り直しは 60000 ミリ秒に 1 回まで |
| `DELEGATION_TOUCH_MS` | 定数 | `packages/core`（`auth`） | 3600000（最後に使った時刻を、前の値から 1 時間以上たったときだけ書く） |
| `ScopeReader` | 型（ポート） | `packages/core`（`authorize`） | `seatsOf`・`projectsOfTeams`・`projectOfTarget`・`laneOf`・`transferTargetOf`・`isHumanOnlyItem`。中身は `apps/api/src/modules/` |
| `AuthzDecision` | 型 | `packages/core`（`authorize`） | `{ reject: "human_only" \| "scope_insufficient" }` か `{ items: ItemAuthz[] }` |
| 料金プランの表 | 設定値（データ） | `packages/contracts/data/`（料金プラン） | 自分で設置した環境の既定は「上限なし」の行（[料金プランと月の上限額](issue-24-design-execution.md#料金プランと月の上限額)）。値の集合は K12 |
| `UsageInput`・`UsageVerdict` | 型 | `packages/core`（`usage-limit`） | 入力は時点・実行の場所・推論の手段・使った額・上限額・同時に動くレーンの数。結果は `allowed` と理由のコードと `waitable` |
| `AuditEntry` | 型 | `packages/core`（`audit`） | 記録の ID・要求の ID・時刻・主体・委任・クライアント（委任の名前と MCP の名乗り）・入口・操作・対象の ID・プロジェクト・結果・要素の番号（要約の行は空） |
| 記録の区切りの鍵 | 定数（形） | `packages/core`（`audit`） | 見られたプロジェクトがあれば `PROJECT#<ID>`、無ければ主体の `USER#<ID>`、主体の無い 401 は `ANON#<UTC の年月日>`（この文書で決めた。土台の表と鍵にも写した） |
| `AUDIT_RETENTION_DAYS` | 設定値 | 設置の設定のファイル（形は `packages/contracts`） | 365 |
| `OperationCall` | 型 | `packages/core`（`dispatch`） | `{ endpoint, channel: "screen" \| "api" \| "mcp" \| "runner" \| "machine" \| "github" \| "patrol" \| "db_prep", operation, token, items, requestId, mcpClientName? }`。`endpoint` は受け口、`channel` は入口。人の token の入口は「画面」 |
| `DispatchDeps` | 型 | `packages/core`（`dispatch`） | 操作の表・ハンドラーの表・`ScopeReader`・`AuthDeps`・`Db`・時計・ログ・残り時間の読み手 |
| `DISPATCH_RESERVE_MS` | 定数 | `packages/core`（`dispatch`） | 1500（要約の記録と応答に残す時間） |
| `MAX_ITEMS` | 定数 | `packages/contracts`（操作の規約の値） | 100。全部か無かの操作は、要素 1 つの書き込みの件の数から `TRANSACT_MAX_ITEMS` に収まる値を操作の定義に持つ |

## 並行と排他

| 同時に走りうる処理 | 共有する資源 | 排他の取り方 | 冪等性と中断からの再開 |
| --- | --- | --- | --- |
| 同じ主体・操作・冪等の鍵の 2 つの要求（Lambda の別の実行環境） | `db-idempotency` の 1 行 | `claimIdempotency` の条件つきの書き込みで 1 つだけが借りる | 負けた側は 409 `in_progress`。借りた側が落ちても、借りの期限の後に取り直せる。状態と済みの行は同じトランザクションのため、半端に書いた状態は残らない |
| 同じエンティティを書く 2 つの要求（画面と委任など） | エンティティの行と `version` | `updateIfVersion` の版の条件 | 後の側は 409 `version_mismatch`。読み直して送り直す |
| 同じ行に触る 2 つのトランザクション | 複数の表の行 | DynamoDB のトランザクションの衝突の検出 | `TransactionConflict` は `withRetry` の方針 `dynamodb` で繰り返す。どちらも書かれないか片方だけが書かれる |
| 同じレーンの同じ連番の事象の再送（ランナーの再試行） | `db-events` の 1 行 | `putIfAbsent` と `onConflict: return_existing` | 2 回目は前の 1 件を返して足さない（I13） |
| 承認の確定の 2 つの要求（2 つの端末） | 承認の依頼の行 | `updateIfVersion` に `extra`（状態が待っている・要約値が同じ）を足す | 1 つだけが確定し、他は 409（I4）。答えの ID が冪等の鍵のため、同じ端末の送り直しは同じ結果（I5） |
| 1 つのレーンへの 2 つ目のコンテナの割り当て | レーンの行の割り当て | `updateIfVersion` の `extra`（割り当てが空か同じ世代） | 2 つ目を拒む（I7） |
| 月の使った量の加算と区間の境の判定 | `db-teams` の `USAGE#<年月>` の行 | `usageAddItem` を費用の記録の追記と同じトランザクションにする。判定は加算の後の値を強い整合で読んで行う | 費用の記録が冪等（区間の ID を鍵にした `putIfAbsent`）のため、同じ区間の 2 回目は加算もしない |
| 要素の書き込みと操作の記録 | 状態の表と `db-audit` | 同じ `writeAtomically` に入れる | 片方だけが書かれることは無い（I9） |
| 公開鍵・秘密・AWS SDK のクライアントの控え | 1 つの実行環境のメモリ | 実行環境ごとに 1 つの約束（取りに行く途中の約束を共有）で、同じ値を 2 回取りに行かない | 実行環境をまたいで共有しない。取れなければ次の要求で取り直す |
| 委任の最後に使った時刻の更新 | 委任の行の 1 項目 | 「今の値が 1 時間より前」を条件にした更新 | 負けても操作は続く。どの値が勝っても 1 時間の粒度で同じ |

## ログと記録の出力

| 関数 | 出すもの | レベルまたは書き先 | 出さないもの |
| --- | --- | --- | --- |
| `createLogger` | 1 行の JSON（`time`・`level`・`msg`・`request_id`・`fn`・`endpoint` と呼び手の項目）。すべて `redact` を通す | 標準出力（CloudWatch Logs、30 日） | 秘密の形の値・秘密の鍵の名前の下の値（どの深さでも） |
| `redact` | 伏せた所を `"[redacted]"` に替えた写し | 戻り値だけ | 伏せる前の値の一部（頭や長さも残さない） |
| `withRetry` | 繰り返すたびに方針の名前・何回目・分類・待つミリ秒 | warn | 失敗の文言の中の値（例外の名前と分類だけ） |
| `callHttp` | 相手の種類（`github`・`idp`・`push`・`slack`・`api`）・方法・状態・時間・分類 | info（成功）・warn（再試行）・error（使い切り） | URL の問い合わせの部分・頭書き・本文・token |
| `writeAtomically` | 表の名前・件の数・結果（`ok`・`conflict`・`unavailable`）・外れた件の扱い | info・warn（衝突の再試行）・error（届かない） | 行の値 |
| `authenticate` | 主体の種類・結果（`ok`・`unauthorized`・`unavailable`）。`unauthorized` の内訳（形・署名・期限・取り消し・受け口）はログにだけ出す | info・warn（依存先の失敗） | token とその要約値・秘密の部分・JWT の中の項目（`sub` 以外の利用者の値） |
| `authorize` | 操作の名前・要素の数・拒んだ要素の数と理由のコード | info | 見えないプロジェクトの ID・絞る前の数（I2 の件数の出口） |
| `judgeUsage` | 無し（呼び手のハンドラーが理由のコードを要素の結果と記録に出す） | — | 料金プランの名前で分けた文 |
| `appendAudit`・`auditItem` | 操作の記録の行（主体・入口・操作・許した鍵の ID・結果） | `db-audit`（追記だけ、既定 1 年） | 本文・秘密・個人情報（呼び名・メール・IP アドレス・ブラウザーの名乗り） |
| `dispatch` | 要求の終わりに 1 行（受け口・入口・操作・要素の数・結果・状態・時間）。想定しない例外は例外の名前と要求の ID | info・error | 要素の中身・token・応答の値 |
| `claimIdempotency` | 結果の種類（`fresh`・`replay`・`in_progress`・`reused`）と操作の名前 | info | 冪等の鍵の値と `fingerprint` |

## 既存の部品の再利用

確かめた範囲は、worktree の `apps/api/src/`・`packages/contracts/src/`・`packages/contracts/scripts/`・`infra/lib/`・`infra/setup/`・`infra/bin/`・`apps/web/src/`・`tools/ref-check/src/` と、依存のライブラリ（各 `package.json` と `package-lock.json`）である。下の「骨組みの範囲」はこの 8 つの置き場を指す。

| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `createClock` | `apps/api/src/users-handler.ts` の依存の注入 `now: () => new Date()` | `grep -rnE 'Date.now\|new Date\(' <骨組みの範囲>` → 1 件 | 使う（注入で差し替える形を引き継ぐ）。時計そのものは無いため作る |
| `newId` | `node:crypto` の `randomUUID`・`uuid` の依存 | `grep -rnE 'randomUUID\|getRandomValues\|uuid' <骨組みの範囲>` → 0 件。`grep -oE '"node_modules/[^"]*uuid[^"]*"' package-lock.json` → 0 件 | 使えない（`randomUUID` は UUIDv4 で時刻の順に並ばない。UUIDv7 のライブラリは依存に無い）。Web Crypto の `getRandomValues` で RFC 9562 の形を組む |
| `parseId` | `packages/contracts/src/users-api.ts` の zod の形 | `grep -n 'export' packages/contracts/src/*.ts` | 使う（形は zod の正規表現で持ち、`parseId` はその検証を呼ぶ） |
| `claimIdempotency` | `apps/api/src/user-store.ts` の `ensureUser`（無いときだけ作る条件つきの書き込み） | `grep -rnE 'ConditionExpression\|ConditionalCheckFailed\|TransactWrite' <骨組みの範囲>` → `user-store.ts` の 3 件 | 使う（無いときだけ書く形と強い整合の読み直しを引き継ぐ）。冪等の鍵の表と期限は無いため作る |
| `settleIdempotency` | 同上 | 同上 | 使えない（済みの行へ書き換える部品は無い）。`updateIfVersion` と同じ組み方で作る |
| `redact` | 伏せ字の部品・ライブラリ | `grep -rnE 'redact\|mask\|伏せ' <骨組みの範囲>` → 0 件。`users-handler.ts` はログへ token と本文を出さない方針の注記だけを持つ | 使えない（無い）。秘密の形は漏れの検査と共有するデータから読む |
| `createLogger` | `users-handler.ts` の `LogFields` と `JSON.stringify` の 1 行のログ。ログのライブラリ | `grep -rnE 'console\.log\|JSON.stringify\(\{' <骨組みの範囲>` → `users-handler.ts` の 2 件。`grep -oE '"node_modules/[^"]*(pino\|powertools)[^"]*"' package-lock.json` → 0 件 | 使う（1 行の JSON・要求の ID・`level` の形を引き継ぎ、`core` へ移す）。ライブラリは依存に無く足さない |
| `withRetry` | AWS SDK の既定の再試行（`@smithy/core`）・`@humanwhocodes/retry` | `grep -oE '"node_modules/[^"]*(retry\|smithy)[^"]*"' package-lock.json` → `@smithy/core` と `@humanwhocodes/retry`。`grep -rnE 'retry\|backoff\|maxAttempts' <骨組みの範囲>` → 0 件 | SDK の呼び出しは SDK の再試行を使う（`awsClient` が回数を方針から渡す）。`@humanwhocodes/retry` は ESLint の開発の依存で実行の時に入らないため使えない。HTTP の呼び出しの繰り返しは作る |
| `classifyFailure` | `user-store.ts` の `isConditionFailure` | `grep -rn 'ConditionalCheckFailed' apps/api/src` → 2 件 | 使う（例外の型と名前の両方で見る形を引き継ぎ、分類を広げる） |
| `callHttp` | `fetch` の直の利用・HTTP のライブラリ | `grep -rnE 'fetch\(\|AbortSignal' <骨組みの範囲>` → 0 件（`timeout` は CDK の `Duration` だけ） | 使う（Node 24 の組み込みの `fetch` と `AbortSignal.timeout` を包む）。包む部品は無いため作る |
| `awsClient` | `users-handler.ts` の `DynamoDBDocumentClient.from(new DynamoDBClient({}))` の使い回し・`infra/setup/aws-reader.ts` の STS と SSM のクライアント | `grep -rnE 'new .*Client\(' <骨組みの範囲>` → 3 件 | 使う（実行環境ごとに 1 回作って使い回す形を引き継ぐ）。`infra/setup/` は境界の検査の外で、そのまま使う |
| `putIfAbsent` | `ensureUser` の `attribute_not_exists(pk)` | `grep -rn 'attribute_not_exists' apps/api/src` → 1 件 | 使う（条件式を移し、`TransactItem` を組む形にする） |
| `updateIfVersion` | 版の条件の書き込み | `grep -rnE 'version' apps/api/src` → `SCHEMA_VERSION`（形の版）だけ | 使えない（エンティティの版の条件は無い）。作る |
| `writeAtomically` | `@aws-sdk/lib-dynamodb` の `TransactWriteCommand` | `apps/api/package.json` の依存に `@aws-sdk/lib-dynamodb` 3.1170.0。`grep -rn 'Transact' <骨組みの範囲>` → 0 件 | 使う（ライブラリのコマンドで送る）。外れた件の訳しは作る |
| `authenticate` | API Gateway の JWT の前段（`infra/lib/app-stack.ts` の `HttpJwtAuthorizer`）・`jwt-decode`・`aws-jwt-verify`・`node:crypto` | `grep -rnE 'jwt\|jose\|verify\|authorizer' <骨組みの範囲>` → `app-stack.ts` と `users-handler.ts`。`jwt-decode` は `oidc-client-ts` の依存（画面だけ）。`grep -oE '"node_modules/(aws-jwt-verify\|jose)"' package-lock.json` → 0 件。`timingSafeEqual` → 0 件 | JWT の前段は使えない（委任の token を読めない。[認証と主体](issue-24-design-api.md#認証と主体)）。`jwt-decode` は署名を確かめないため使えない。`node:crypto` の `createPublicKey`（JWK）・`verify`（RS256 と Ed25519）・`timingSafeEqual`・`createHash` を使う（`infra/lib/assembly-digest.ts` が `createHash` を既に使う） |
| `visibleProjectIds` | 席・割り当ての読み | `grep -rnE 'authorize\|permission\|role' apps/api/src` → JWT の前段の `sub` を読む 1 件だけ | 使えない（無い）。作る |
| `authorize` | `users-handler.ts` の `answerItems`（他人の ID に表を読まず `not_found` を返す） | `grep -n 'not_found' apps/api/src/users-handler.ts` | 使う（見えないものを無いものと同じに返す形を引き継ぐ）。判定の本体は作る |
| `judgeUsage` | 料金プラン・上限の比べ | `grep -rnE 'limit\|quota\|plan' <骨組みの範囲>` → 0 件 | 使えない（無い）。作る |
| `usageAddItem` | 同上 | 同上 | 使えない（無い）。`updateIfVersion` と同じ組み方で作る |
| `auditItem` | 操作の記録 | `grep -rni 'audit' <骨組みの範囲>` → 0 件 | 使えない（無い）。作る |
| `appendAudit` | 同上 | 同上 | 使えない（無い）。`writeAtomically` を通して作る |
| `readHttpCall` | `packages/contracts/src/users-api.ts` の `parseUsersRequest`（JSON でない・配列でない・空・数の上限の順の検査）と `users-handler.ts` の `decodeBody` | `grep -rn 'parseUsersRequest\|decodeBody' <骨組みの範囲>` → 3 件 | 使う（理由のコードの順と base64 の本文の読み方を引き継ぎ、操作の表の共通の検査へ広げる。要素の上限は 10 から 100、重なりの検査を足す） |
| `readMcpCall` | MCP の受け口・JSON-RPC のライブラリ | `grep -rnE 'jsonrpc\|tools/list\|mcp' <骨組みの範囲>` → 0 件。`grep -oE '"node_modules/@modelcontextprotocol[^"]*"' package-lock.json` → 0 件 | 使えない（無い）。セッションを持たない JSON の 1 応答だけを受けるため、SDK を足さず作る（[MCP](issue-24-design-api.md#mcp)） |
| `dispatch` | `users-handler.ts` の `createHandler`（依存の注入・401・400・503 の扱い） | `grep -rnE 'dispatch\|route\|handler' <骨組みの範囲>` → `users-handler.ts` と `app-stack.ts` の起点の指定 | 使う（依存を注入して起点を作る形と、想定しない失敗を 503 にする扱いを引き継ぐ）。振り分けの本体は作る |
| `writeHttpResponse` | `users-handler.ts` の `json` | `grep -n 'function json' apps/api/src/users-handler.ts` → 1 件。`grep -rnE 'problem\+json\|about:blank' <骨組みの範囲>` → 0 件 | 使う（`content-type` と本文の組み立てを引き継ぐ）。problem の形と `no-store` を足す |
| `writeMcpResponse` | MCP の応答の組み立て | `grep -rnE 'structuredContent\|jsonrpc' <骨組みの範囲>` → 0 件 | 使えない（無い）。作る |

## 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `createClock` | 差し替えた元の時刻を `Date` と `iso()` で返す | ミリ秒が 0 のときも 3 桁・末尾 `Z` | 無し |
| `newId` | 頭と UUIDv7 の形。2 つ作ると後の方が大きい | 同じミリ秒の中で 1,000 個作っても重ならない | 集合に無い種類は型で弾く |
| `parseId` | 合う ID を返す | 大文字・頭の違い・版の数字が 7 でない値は `null` | 空・長すぎる値は `null` |
| `claimIdempotency` | 1 回目は `fresh` で借りの行がある | 借りの期限ちょうどの前後で `in_progress` と `fresh` が分かれる | 処理中は `in_progress`、中身の違いは `reused`、表の失敗は再試行の後に 503 |
| `settleIdempotency` | 済みの行と要素の結果を書く 1 件を返す | 1 回だけ返す値は `null` に替わる | 持ち主が違うと条件で外れる |
| `redact` | `authorization`・`token` の下の値が伏せられる | 入れ子の深い所・配列の中・鍵の名前の大文字と小文字・文字列の中に埋まった `ndfd_` | 循環する値で止まらない。元の値を変えない |
| `createLogger` | 1 行の JSON に文脈が付く | 項目が空・数だけ | JSON にできない値は替えて出す。`sink` の例外で呼び手が落ちない（「書けない」の行） |
| `withRetry` | 2 回目で成功した値を返す | `max_attempts` 回ちょうどで止まる。`Retry-After` が上限を越えると上限で待つ | 使い切りで `RetryExhausted`、`conflict` は 1 回で返す、`deadline` を越える待ちをしない |
| `classifyFailure` | 表の各行の入力が決まった分類になる | 501 は `rejected`、504 は `retryable` | 形の分からない値は `unknown` |
| `callHttp` | 200 の本文と分類 `ok` を返す | 時間切れの直前に届いた応答を受ける | 時間切れ（冪等なら繰り返す・冪等でなければ繰り返さない）、429・5xx の再試行、4xx をそのまま返す、`http:` の URL で止まる |
| `awsClient` | 方針の回数と時間切れを持つクライアント | 同じ方針の 2 回目は同じインスタンス | 知らない方針の名前は型で弾く |
| `putIfAbsent` | 条件 `attribute_not_exists(pk)` と扱いを持つ 1 件 | `schema_version` の無い行を型で弾く | 無し |
| `updateIfVersion` | 版の条件と `version + 1` を持つ 1 件 | `version` が 1・`extra` あり | `set` に `version` を含むと型で弾く |
| `writeAtomically` | 全件が書かれ `ok` | 1 件と 100 件 | 条件の外れの件の番号と扱いを返す、衝突は再試行、届かないは再試行の後に投げる、101 件で止まる |
| `authenticate` | 人・委任・ランナー・手元のマシン・GitHub の 5 つが決まる | 期限の 1 秒前と 1 秒後・`kid` の取り直しが 1 分に 1 回 | 形・署名・期限・取り消し・受け口の違いはすべて同じ `unauthorized`、鍵と表に届かないは `unavailable`、最後に使った時刻を書けなくても続く |
| `visibleProjectIds` | 人・委任・ランナーの集まり | 委任した人がチームを外れた次の要求で集まりから消える | 読み手の失敗を投げる |
| `authorize` | 見える要素を `allow` | 見える要素と見えない要素の混ざり・移す途中の名前だけの読み | 見えないは 404、委任の人だけは要求全体の 403、種類の不足は 403、メンバーの持ち主だけの操作は要素の 403、読み手の失敗は投げる |
| `judgeUsage` | 上限の内で `allowed` | 使った額が上限額ちょうど・同時の数がちょうど・上限なしの行 | 上限額に当たる、場所と推論の手段が許されない、同時の数が満ちる、通貨の違い |
| `usageAddItem` | 通貨の条件と加算を持つ 1 件 | 金額 0 | 通貨の違いで条件が外れる |
| `auditItem` | 許した鍵だけを写した 1 行 | 見られたプロジェクトがない・主体の無い 401 の区切りの鍵 | 本文・秘密・メールを渡しても行に残らない |
| `appendAudit` | 1 行を追記する | 断った要求の行 | 書けなければ `AuditUnavailable` |
| `readHttpCall` | HTTP の経路から操作の名前と要素を読む | 要素 1 個と 100 個・base64 の本文 | JSON でない・配列でない・空・101 個・重なり・`POST` でない |
| `readMcpCall` | `tools/call` を呼び出しへ読む | `arguments.items` が 1 個 | `Origin` の違いは 403、知らない道具は `-32602`、`GET` と `DELETE` は 405、知らせは 202 |
| `dispatch` | 書く要素ごとに状態と記録が同じトランザクションで書かれる。画面と MCP から同じ操作を呼ぶと同じ要素の結果になる | 全部か無かで 1 つだけ失敗・残り時間がちょうど予備の時間 | 401・400・403・要素の 404 と 409・ハンドラーの例外は 503・要素の記録を書けないと 503 で残りを処理しない・要約の行を書けないと読む値を返さない |
| `writeHttpResponse` | 200 と配列・`no-store` | 要求全体の誤りの problem の形 | 想定しない結果の形でも 500 にしない |
| `writeMcpResponse` | `structuredContent` と `content` が同じ値 | 要素の結果が 1 個 | 要求全体の誤りは `isError: true` |
