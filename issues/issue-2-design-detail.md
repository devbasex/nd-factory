# #2 の詳細設計: 形の正本・横断の部品・API の起点・サービスの表

設計文書 [issue-2-design.md](./issue-2-design.md) の構成要素を、ファイルと関数の粒度へ下ろした文書である。横断の部品の最上位の関数の仕様・異常系・処理の手順・並行と排他・ログ・再利用・テストの観点は全体の詳細設計（[detail.md](../docs/design/detail.md)）が決めており、この文書は写さずに指す。ここに書くのは、detail.md が「#2 が決める」と回したものと、この課題が新しく置く関数だけである。回されたものは、ファイルの単位・型の項目の並び・操作の表の形・生成物の置き場・ダミーデータの作り方・表の列と索引・表の移しである。

## 地図

パッケージ・モジュール構成（触るファイルだけ。`*` は新設）:

```text
packages/contracts/
├── package.json                    exports と開発の依存（ajv）を足す
├── src/
│   ├── values.ts               *   値の形（日時・月・金額・言語・時刻帯・GitHub の参照・要素の配列）
│   ├── ids.ts                  *   ID の頭と ID の形
│   ├── tokens.ts               *   委任と登録の token の形
│   ├── reasons.ts              *   理由のコードの共通の集まり
│   ├── operation.ts            *   操作の定義の型・defineOperation・pendingShape・結果の封筒
│   ├── operations/
│   │   ├── index.ts            *   操作の表（OPERATIONS）と引き当て
│   │   ├── users.ts            *   sessions・users・logins
│   │   ├── teams.ts            *   teams・seats・invitations
│   │   ├── projects.ts         *   projects・github_installations・repositories・project_transfers
│   │   ├── sprints.ts          *   waiting_counts・issue_candidates・sprints・lanes・progress_events
│   │   ├── decisions.ts        *   approvals・questions
│   │   ├── notices.ts          *   notices・notification_targets
│   │   ├── delegations.ts      *   delegations・audit_records
│   │   ├── execution.ts        *   execution_settings・model_keys
│   │   ├── machines.ts         *   machines
│   │   ├── usage.ts            *   usage・usage_records・spend_caps
│   │   ├── runner.ts           *   ランナー向けの 5 つの HTTP の経路
│   │   ├── machine-endpoint.ts *   手元のマシン向けの 2 つの HTTP の経路
│   │   └── db-prep.ts          *   DB の用意のタスク向けの 2 つの HTTP の経路（形は #13 の db-prep-api.ts）
│   ├── rows/
│   │   ├── common.ts           *   共通の列・TTL の列・上書きの行と追記の行の基の形
│   │   ├── users.ts            *   利用者・ログインの組・IdP の主体の一意の行・委任
│   │   ├── teams.ts            *   チーム・席・招待・手元のマシン・月の使った量
│   │   ├── projects.ts         *   リポジトリ・渡した GitHub の token の記録（プロジェクト・割り当ては全体の設計の列）
│   │   ├── sprints.ts          *   スプリント・区間（レーンは全体の設計の列）
│   │   ├── events.ts           *   進捗の事象
│   │   ├── decisions.ts        *   問い・答え（承認の依頼は全体の設計の列）
│   │   ├── notices.ts          *   知らせ・通知先
│   │   ├── usage.ts            *   費用の記録
│   │   ├── audit.ts            *   操作の記録（全体の設計の列）
│   │   └── idempotency.ts      *   冪等の鍵
│   ├── tables.ts               *   10 の表の仕様（名前の末尾・鍵・索引・TTL・行の種類）
│   ├── row-codec.ts            *   行の版の読み手（RowCodec・readRow）
│   ├── ndf.ts                  *   受ける NDF の契約の組の形・答えの語
│   └── data.ts                 *   data/*.json の読みと検証
├── data/
│   ├── exit-codes.json             （今のまま）
│   ├── retry-policies.json     *
│   ├── secret-shapes.json      *
│   ├── ndf-contracts.json      *
│   └── plans.json              *   料金プランの既定の行（「上限なし」の 1 行。値の集合は #29）
├── scripts/
│   ├── generate.ts                 生成物を足す
│   └── artifacts.ts            *   生成物を組む関数
├── generated/                  *   生成物（手で直さない）
└── test/                           足す: values・operations・operations-roundtrip・rows・row-codec・ndf・data・artifacts
packages/core/                  *
├── package.json · tsconfig.json
├── src/
│   ├── clock.ts · ids.ts · idempotency.ts · redact.ts · log.ts · retry.ts · outbound.ts
│   ├── db.ts                       Db のポートと DynamoDB の実装
│   ├── conditional-write.ts · authorize.ts · usage-limit.ts · audit.ts
│   ├── auth/  authenticate.ts · jwks.ts · tokens.ts
│   └── dispatch/  types.ts · http.ts · dispatch.ts
└── test/                           モジュールごとに 1 つと fakes/（偽の表・偽の ScopeReader）
apps/api/
├── package.json                    @nd-factory/core を足す
├── src/
│   ├── entries/api-fn.ts       *   HTTP の振り分けの起点（反映は #4）
│   ├── entries/migrate.ts      *   表の移しの起点と migrateTable（資源は最初に版を上げる子）
│   ├── users-handler.ts            横断の部品を通す形へ
│   └── user-store.ts               同上
└── test/                           api-fn・migrate を足す。今の 2 つは依存の注入の形だけ直す
infra/
├── lib/service-table.ts        *   表の仕様から表と索引を作る部品
├── lib/api-routes.ts           *   HTTP の経路の登録から経路を作る部品
└── test/service-table.test.ts · api-routes.test.ts  *
```

依存の向き: `packages/contracts`（zod だけ）← `packages/core`（contracts・AWS SDK・`uuid`・`aws-jwt-verify`）← `apps/api`。`infra` は `packages/contracts` の `tables.ts` と `generated/routes.json` だけを読む。`packages/core` と `apps/*` は import しない。`apps/web` が使ってよい `core` のモジュールは `clock`・`ids`・`redact`・`log` の 4 つである。この 4 つは `node:` の組み込みと AWS SDK を import しない（`ids` の乱数は `uuid` を通す）。型の関係は [detail.md のクラス図](../docs/design/detail.md#クラスと関数の構造) のまま変えない。

| パス | 種類 | 役割 1 文 | 依存する先 | モジュール | 最上位の関数と定数（新設 / 変更） |
| --- | --- | --- | --- | --- | --- |
| `packages/contracts/src/values.ts` | 新設 | 国や地域で読み違えない値の形を 1 か所に置く | zod | values | `utcDateTime`・`calendarMonth`・`money`・`currencyCode`・`languageTag`・`timeZone`・`githubRepo`・`githubIssueRef`・`itemsArray` |
| `packages/contracts/src/ids.ts` | 新設 | ID の頭の集まりと ID の形 | values | ids | `ID_KINDS`・`IdKind`・`idOf` |
| `packages/contracts/src/tokens.ts` | 新設 | 委任と登録の token の形 | ids | tokens | `delegationToken`・`machineToken` |
| `packages/contracts/src/reasons.ts` | 新設 | 理由のコードの共通の集まり | zod | reasons | `REQUEST_REASONS`・`ITEM_REASONS` |
| `packages/contracts/src/operation.ts` | 新設 | 操作の定義の型と組み立て | values・reasons | operation | `defineOperation`・`pendingShape`・`isPending`・`okItem`・`okList`・`itemFailure`・`OperationDef`・`ItemOf`・`ResultOf` |
| `packages/contracts/src/operations/*.ts` | 新設 | 操作の表の全行 | operation・ids・values | operations | `OPERATIONS`・`operationByName`・`operationByRoute` |
| `packages/contracts/src/rows/*.ts` | 新設 | 表の行の形 | values・ids | rows | 行ごとの `<行>Row` の zod と `ROW_CODECS` |
| `packages/contracts/src/tables.ts` | 新設 | 10 の表の仕様 | rows | tables | `TABLES`・`TableSpec` |
| `packages/contracts/src/row-codec.ts` | 新設 | 行の版の読み手 | rows | row-codec | `rowCodec`・`readRow` |
| `packages/contracts/src/ndf.ts` | 新設 | NDF の契約の値 | zod | ndf | `ndfContractSet`・`ndfAnswerWord` |
| `packages/contracts/src/data.ts` | 新設 | データのファイルを形で検証して出す | ndf・values | data | `RETRY_POLICIES`・`SECRET_SHAPES`・`NDF_CONTRACTS`・`PLANS` |
| `packages/contracts/scripts/artifacts.ts` | 新設 | 生成物を組む | operations・data | artifacts | `buildOperationSchemas`・`buildOpenApi`・`buildMcpTools`・`buildRoutes`・`buildReasons`・`buildDummy`・`buildPending`・`checkExamples` |
| `packages/contracts/scripts/generate.ts` | 変更 | 生成物を書く・差を照らす | artifacts | generate | `generateArtifacts`（変更） |
| `packages/core/src/*` | 新設 | 横断の部品 | contracts | detail.md の 13 のモジュール（MCP の 5 つの関数を除く）と `db` | detail.md の関数と `createDb` |
| `apps/api/src/entries/api-fn.ts` | 新設 | HTTP の振り分けの起点 | core・contracts | api-fn | `createApiHandler`・`handler` |
| `apps/api/src/entries/migrate.ts` | 新設 | 表の移し | core・contracts | migrate | `migrateTable`・`createMigrateHandler` |
| `apps/api/src/users-handler.ts` | 変更 | 骨組みの `PUT /v1/users` | core・contracts | users-handler | `handler`（既定の依存の組み立てだけ変更） |
| `apps/api/src/user-store.ts` | 変更 | 骨組みの利用者の行 | core | user-store | `ensureUser`（シグネチャを変更） |
| `infra/lib/service-table.ts` | 新設 | 表と索引の資源 | contracts（tables） | service-table | `ServiceTable` |
| `infra/lib/api-routes.ts` | 新設 | HTTP の経路の資源 | contracts（generated/routes.json） | api-routes | `ApiRoutes` |

## 形の正本: 値の形と ID

満たす決定: 決定 4・5、受け入れ条件 6・7

値の形は zod の正規表現・長さ・列挙・整数だけで書き、`refine` と `transform` を使わない（往復のテストが落とす。決定 4）。

### 関数の仕様

| 関数・定数 | 保存先 | 種類 | シグネチャと形 | 責務 |
| --- | --- | --- | --- | --- |
| `utcDateTime` | `values.ts` | 新設 | `z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/)` | RFC 3339 の UTC の日時だけを通す（I15） |
| `calendarMonth` | `values.ts` | 新設 | `z.strictObject({ month: /^\d{4}-(0[1-9]\|1[0-2])$/, time_zone: timeZone })` | 時刻帯つきの暦の月 |
| `currencyCode` | `values.ts` | 新設 | `z.string().regex(/^[A-Z]{3}$/)` | ISO 4217 の英字 3 字 |
| `money` | `values.ts` | 新設 | `z.strictObject({ amount_minor: z.int().min(0), currency: currencyCode })` | 通貨つきの最小単位の整数（I15） |
| `languageTag` | `values.ts` | 新設 | `/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}\|\d{3}))?$/` | BCP 47 の言語・文字・地域（決定 5） |
| `timeZone` | `values.ts` | 新設 | `/^(UTC\|[A-Z][A-Za-z_]+(\/[A-Za-z0-9_+\-]+)+)$/` | IANA の名前の形。略称と差を通さない（決定 5） |
| `githubRepo`・`githubIssueRef` | `values.ts` | 新設 | `/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/`、課題はその後に `#<1 以上の整数>` | GitHub の参照 |
| `itemsArray` | `values.ts` | 新設 | `<T>(item: T, max = MAX_ITEMS) => z.array(item).min(1).max(max)` | 要求の本文の配列（I12） |
| `ID_KINDS` | `ids.ts` | 新設 | `["usr","team","inv","prj","repo","trf","spr","lane","apr","qst","ntc","dst","dlg","mch","key","aud"] as const` | ID の頭（[値の形](../docs/design/api.md#値の形)） |
| `idOf` | `ids.ts` | 新設 | `(kind: IdKind) => z.ZodString`。形は `^<頭>_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` | 種類ごとの ID の形。`parseId`（core）はこれを呼ぶ |
| `delegationToken`・`machineToken` | `tokens.ts` | 新設 | `^ndfd_<usr の形>\.<dlg の形>\.[A-Za-z0-9_-]{43}$`・`^ndfm_<team の形>\.<mch の形>\.[A-Za-z0-9_-]{43}$` | token の形（[detail.md の内部のデータと定数](../docs/design/detail.md#内部のデータと定数)） |
| `REQUEST_REASONS` | `reasons.ts` | 新設 | `body_not_json`・`body_not_array`・`body_empty`・`too_many_items`・`duplicate_item`・`cursor_invalid`・`unauthorized`・`human_only`・`scope_insufficient`・`unavailable`・`audit_unavailable`・`too_many_requests` | 要求全体の理由のコード |
| `ITEM_REASONS` | `reasons.ts` | 新設 | `item_invalid`・`not_found`・`role_insufficient`・`human_only`・`version_mismatch`・`state_mismatch`・`idempotency_key_reused`・`in_progress`・`not_applied` | どの操作の要素にも出うる理由のコード。操作ごとのコードは `reasons` に足す |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `utcDateTime` | `2026-11-17T03:04:05.123Z` | 小数なし・小数 1 桁 | `+09:00`・時刻帯なし・小数 4 桁・小文字の `z` |
| `money` | `{"amount_minor": 1234, "currency": "USD"}` | `amount_minor` が 0 | 通貨なし・`12.34`・`"usd"`・負の数 |
| `timeZone` | `Asia/Tokyo`・`UTC`・`America/Argentina/Buenos_Aires` | `Etc/GMT+9` | `JST`・`+09:00`・`asia/tokyo` |
| `languageTag` | `ja`・`pt-BR`・`zh-Hant-TW` | `es-419` | `ja_JP`・`JA`・空 |
| `idOf` | 頭と UUIDv7 が合う | 版の数字が 7 | 大文字・頭の違い・版 4・変種の違い |

## 形の正本: 操作の表

満たす決定: 決定 1、受け入れ条件 1・5

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `defineOperation` | `operation.ts` | 新設 | `<N extends string, I extends ZodType, R extends ZodType>(def: OperationInput<N, I, R>) => OperationDef<N, I, R>` | 印を照らし、HTTP の経路と既定の値を足した定義を返す |
| `pendingShape` | `operation.ts` | 新設 | `(owner: `#${number}`) => PendingShape` | どの値も通さない形と、受け持つ子の番号 |
| `isPending` | `operation.ts` | 新設 | `(shape: ZodType \| PendingShape) => shape is PendingShape` | 形の未定かを返す |
| `okItem`・`okList`・`itemFailure` | `operation.ts` | 新設 | `(item: R) => z.ZodObject`・`(item: R) => z.ZodObject`・`(reasons: readonly string[]) => z.ZodObject` | 要素の結果の封筒（`{ok: true, item}`・`{ok: true, items, next_cursor}`・`{ok: false, status, reason, fields?}`） |
| `operationByName` | `operations/index.ts` | 新設 | `(name: string) => OperationDef \| undefined` | 名前で引く |
| `operationByRoute` | `operations/index.ts` | 新設 | `(path: string) => OperationDef \| undefined` | `/v1/...` の経路で引く（`readHttpCall` が使う） |

- `defineOperation`
  - 事前条件: 受け口が `user` の操作の名前は `<entity>.<verb>`（`^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`）。ほかの受け口の操作の名前は、経路の path の `/v1/` の後ろを `.` でつないだ `<受け口>.<entity>.<verb>`（例 `runner.events.create`。頭は受け口の値と同じ）
  - 事後条件: `route` は受け口 `user` なら `/v1/<entity>/<verb>`、ほかは `/v1/<受け口>/<entity>/<verb>`。次のどれかに当たれば例外を投げる（モジュールの読み込みで落ち、`check` の型検査とテストが先に落とす）
    - `access` が `read` で `idempotencyKey` が真
    - `allOrNothing` があって `access` が `read`
    - `humanOnly` が `always` で `mcpRead` が無い
    - `humanOnly` が `never` で `mcpRead` がある
  - 副作用: 無し
- `operations/index.ts` の `OPERATIONS` は全体の設計の操作の一覧の表の順（F1〜F20 の表の上から、続けてランナー・手元のマシン・DB の用意のタスク）に並べる。名前と経路の重なりは読み込みのときに例外を投げる

### 内部のデータと定数

`OperationDef` の項目の並び（型の宣言の順で、生成物の JSON の鍵の順もこれに従う）:

| 順 | 項目 | 型 | 既定 |
| --- | --- | --- | --- |
| 1 | `name` | 文字列 | — |
| 2 | `entity`・`verb` | 文字列 | 名前から分ける |
| 3 | `endpoint` | `"user" \| "runner" \| "machine" \| "db_prep"` | `user` |
| 4 | `route` | 文字列 | `defineOperation` が作る |
| 5 | `features` | `` `F${number}`[] `` | 受け口が `user` なら 1 つ以上、ほかは空 |
| 6 | `access` | `"read" \| "write"` | — |
| 7 | `humanOnly` | `"always" \| "per_item" \| "never"` | `never` |
| 8 | `mcpRead` | 操作の名前 \| `null` | `null` |
| 9 | `delegationKind` | `"read" \| "run" \| "manage" \| null` | 受け口が `user` で人だけでなければ必須、ほかは `null` |
| 10 | `ownerOnly` | 真偽 | 偽 |
| 11 | `allOrNothing` | `{ maxItems: number } \| null` | `null` |
| 12 | `idempotencyKey` | 真偽 | 偽 |
| 13 | `item`・`result` | zod \| `PendingShape` | — |
| 14 | `reasons` | 文字列の配列 | `[]`（共通の `ITEM_REASONS` は足さずに生成が合わせる） |
| 15 | `auditKeys` | 要素の鍵の名前の配列 | `[]` |
| 16 | `order` | 文字列 \| `null` | `list` 以外は `null` |
| 17 | `examples` | `{ normal: unknown[]; edge: unknown[] } \| null` | 形の未定なら `null`、形があれば必須 |
| 18 | `description_en` | 文字列 | `"<verb> <entity>"` |
| 19 | `owner` | `` `#${number}` `` | — |

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `MAX_ITEMS` | 定数 | `operation.ts` | 100（今の `users-api.ts` の 10 は骨組みの経路の値のまま残し、#4 が消す） |
| `IDEMPOTENCY_TTL_SECONDS` | 定数 | `operation.ts` | 86400 |
| `PendingShape` | 型 | `operation.ts` | `{ kind: "pending"; owner: string; schema: z.ZodNever }` |
| 全部か無かの上限 | 操作の定義の値 | `projects.ts` | `projects.create` は 20（要素 1 つでプロジェクト・主リポジトリ・割り当ての 3 件と記録の行・冪等の済みの行の 5 件 → 100 ÷ 5）、`repositories.add` は 25（リポジトリの行・プロジェクトの行の照らし・記録の行・冪等の済みの行の 4 件） |

`allOrNothing.maxItems` の値は、受け持つ子（#5）が要素 1 つの書き込みの件の数を決めたときに直す。この課題は全体の設計の行（プロジェクト・主リポジトリ・割り当て）と、新しいものを作る操作が持つ冪等の鍵（[冪等の鍵](../docs/design/api.md#冪等の鍵)）から見積もった値を置く。

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `defineOperation` | 経路が名前から作られる。受け口 `runner` は `/v1/runner/…` | `allOrNothing.maxItems` が 1 | 読む操作に冪等の鍵・人だけの操作に読み出しの道具が無い・名前の形の違いで投げる |
| `OPERATIONS` | 66 + 9 行。利用者向けの操作の名前と経路と機能と人だけかが [操作の一覧](../docs/design/api.md#操作の一覧) と一致する（表の文字を読まずに、テストに一覧の写しを持つ） | — | 名前か経路の重なりで投げる |
| `pendingShape` | `isPending` が真。どの値も zod の検証を通らない | — | — |

## 形の正本: データと NDF の契約

満たす決定: 決定 10・13、受け入れ条件 10

### 関数の仕様

| 関数・定数 | 保存先 | 種類 | シグネチャと形 | 責務 |
| --- | --- | --- | --- | --- |
| `ndfContractSet` | `ndf.ts` | 新設 | `z.strictObject({ accepted: z.array(z.strictObject({ version: z.int().min(1), sha256: /^[0-9a-f]{64}$/ })).min(1) })`。重なりは `data.ts` の読みで照らす | 受ける契約の組の集合の形 |
| `ndfAnswerWord` | `ndf.ts` | 新設 | `z.enum(["approved","rejected","request_changes","retry","finish","cancel"])` | 答えの語（出所: 固定の点の `C/facts/answers.json`） |
| `RETRY_POLICIES` | `data.ts` | 新設 | `Record<RetryPolicyName, RetryPolicy>` | `data/retry-policies.json` を形で検証して出す |
| `SECRET_SHAPES` | `data.ts` | 新設 | `{ keyNames: readonly string[]; valuePatterns: readonly { name: string; pattern: string }[] }` | 秘密の形（`redact` と漏れの検査と生成の照らしが読む） |
| `NDF_CONTRACTS` | `data.ts` | 新設 | `ndfContractSet` の型 | 受ける組（ランナー（#6）が読む） |
| `PLANS` | `data.ts` | 新設 | 料金プランの行の配列。この課題は「上限なし」の 1 行だけ | `judgeUsage` が読む |

- `data.ts` はモジュールの読み込みのときに検証し、形が違えば例外を投げる（データの誤りを実行の時でなく `check` で落とす）。受ける組の重なり（同じ版か同じ sha256 が 2 つ）も例外にする

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `data/ndf-contracts.json` | 設定値 | `packages/contracts/data/` | `{"accepted": [{"version": 8, "sha256": "ed8b036584bec284dfc93a2bb5b988e2385b4f8f297d659399f5d3cb91b520c4"}]}` |
| `data/retry-policies.json` | 設定値 | 同上 | detail.md の 6 つの方針の値のまま（`dynamodb`・`aws-control`・`http-github`・`http-idp-keys`・`http-notify`・`runner-to-api`）。鍵は `max_attempts`・`base_ms`・`cap_ms`・`timeout_ms`・`honor_retry_after` |
| `data/secret-shapes.json` | 設定値 | 同上 | 鍵の名前に含む語 `authorization`・`token`・`secret`・`password`・`credentials`・`private_key`・`dsn`。値の形 `ndfd_`・`ndfm_` の頭・JWT（`eyJ` で始まる 3 つの部分）・`ghs_`・`ghp_`・`gho_`・`github_pat_`・`-----BEGIN .*PRIVATE KEY-----`・利用者と合言葉を含む接続の URL（`://[^/:]+:[^@]+@`）・AWS の一時の鍵（`ASIA[0-9A-Z]{16}`） |
| `data/plans.json` | 設定値 | 同上 | `[{"name": "unlimited", "places": ["hosted","machine"], "inference": ["managed","byok"], "concurrency": null, "monthly_cap": null}]`（値の集合と量は #29） |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `ndfContractSet` | 今のデータが通る | 組が 1 つ | 空・63 桁・大文字の 16 進・版 0・同じ版の重なり |
| `RETRY_POLICIES` | 6 つの方針が detail.md の値 | — | 鍵の欠け・負の数で読み込みが投げる |
| `SECRET_SHAPES` | 値の形の各行に当たる作り物の値と当たらない値の組 | — | 正規表現として読めない行で投げる |

## 形の正本: 生成

満たす決定: 決定 2・3・4、受け入れ条件 1・7

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `checkExamples` | `scripts/artifacts.ts` | 新設 | `(ops: readonly OperationDef[]) => ExampleProblem[]` | 見本を結果の形・秘密の形・作り物の値の決まりで照らす |
| `buildOperationSchemas` | 同上 | 新設 | `(ops) => JsonSchemaDoc` | 操作ごとの要素と結果の JSON Schema を `$defs` に並べる |
| `buildOpenApi` | 同上 | 新設 | `(ops, schemas) => OpenApiDoc` | OpenAPI 3.1 の文書を組む |
| `buildMcpTools` | 同上 | 新設 | `(ops, schemas) => McpToolDoc[]` | 人だけでない利用者向けの操作の道具の定義 |
| `buildRoutes` | 同上 | 新設 | `(ops) => RouteDoc[]` | 経路の登録 |
| `buildReasons` | 同上 | 新設 | `(ops) => ReasonsDoc` | 理由のコードの一覧 |
| `buildDummy` | 同上 | 新設 | `(op) => DummyDoc \| null` | 1 つの操作のダミーデータ（形の未定は `null`） |
| `buildPending` | 同上 | 新設 | `(ops) => PendingDoc[]` | 形の未定の操作と受け持つ子 |
| `generateArtifacts` | `scripts/generate.ts` | 変更 | `(root: string, mode: "write" \| "check") => Promise<string[]>`（変えない） | 今の 3 つに上の生成物を足す。`generated/dummy/` の中の、どの操作にも当たらないファイルは `check` で差に数え、`write` で消す |

- `checkExamples`
  - 事前条件: 無し
  - 事後条件: 次のどれかを問題として返す。`generateArtifacts` は問題が 1 つでもあれば書かずに `GenerateError`（終了コード 2）を投げる
    - 形があるのに `examples` が無い
    - 見本が `ResultOf` の zod を通らない
    - 見本の文字列に `SECRET_SHAPES` の値の形が当たる
    - 12 桁の数で `123456789012` でないもの
    - `@` を含む値で域名が `example.com` でないもの
- `buildMcpTools` の道具の入力の形は、要素の形を持たない（[detail.md の `createMcpHandler`](../docs/design/detail.md#関数の仕様)）。入力の形は次のとおりである

```json
{"type": "object", "properties": {"items": {"type": "array", "minItems": 1, "maxItems": <MAX_ITEMS か allOrNothing.maxItems>}}, "required": ["items"]}
```

- `buildMcpTools` の道具の出力の形は、結果の配列の JSON Schema である。注記は次の条件で付ける

| 注記 | 条件 |
| --- | --- |
| `readOnlyHint` | `access` が `read` |
| `idempotentHint` | `idempotencyKey` |
| `destructiveHint` | 動詞が `delete`・`remove`・`cancel`・`revoke` |

### 内部のデータと定数

| 生成物 | 形（鍵の順） |
| --- | --- |
| `generated/operations.schema.json` | `{"$schema": "https://json-schema.org/draft/2020-12/schema", "$defs": {"<操作>.item": …, "<操作>.result": …}}`。形の未定は `{"not": {}}` |
| `generated/openapi.json` | `openapi: "3.1.1"`・`info`（題 `nd-factory API`・版 `1`）・`paths`（受け口 `user` の操作だけ。`post` の `operationId` は操作の名前、要求は `itemsArray(item)`、応答 200 は結果の配列、`default` は problem）・`components.schemas`（`operations.schema.json` の `$defs` の写し）・`components.securitySchemes.bearer` |
| `generated/mcp-tools.json` | `[{name, description, inputSchema, outputSchema, annotations}]`（操作の表の順） |
| `generated/routes.json` | `[{method: "POST", path, operation, endpoint}]`（操作の表の順。GitHub の Webhook は I12 の外のため載せず、受け持つ #5 が足す） |
| `generated/reasons.json` | `{"request": [...REQUEST_REASONS], "item": [...ITEM_REASONS], "operations": {"<操作>": [...]}}` |
| `generated/dummy/<操作>.json` | `{"operation", "normal": [...], "empty": [...], "edge": [...], "failures": [{"ok": false, "status", "reason"}…]}`。`empty` は `list` で `[{"ok": true, "items": [], "next_cursor": null}]`、`get` で `[{"ok": false, "status": 404, "reason": "not_found"}]`、それ以外は `[]`。`failures` は `reasons` と `ITEM_REASONS` のうちその操作で起きうるもの（読む操作は `version_mismatch` などの書く理由を含めない）ごとに 1 つ |
| `generated/pending.json` | `[{"operation", "owner"}]` |

理由のコードと HTTP の状態の対応は `reasons.ts` に表で持つ（`not_found` → 404 ほか）。操作ごとのコードは、定義の `reasons` の要素に `{code, status}` で書く。

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| 往復（`operations-roundtrip.test.ts`） | 形のある操作ごとに、見本と反例（時刻帯の無い日時・通貨の無い金額・頭の違う ID・配列でない本文）が zod と Ajv（`Ajv2020`、`strict: true`、`validateFormats: false`）で同じ合否 | 要素 1 個と上限ちょうどの配列 | `refine` を使う形をテストの中で足すと食い違いを検出する（検出の仕組みのテスト） |
| `checkExamples` | 作り物の値だけの見本は問題 0 | — | 通貨の無い金額・`ghs_` の値・`ops@corp.test`・12 桁の別の数で問題が出る |
| `buildMcpTools` | 人だけの操作と受け口 `user` でない操作が無い。道具の順が操作の表の順 | 全部か無かの操作の `maxItems` | — |
| `buildDummy` | `list` の空・`get` の 404・理由のコードごとの失敗 | 形の未定は `null` | — |
| `generateArtifacts` | `write` の後の `check` が空 | 消えた操作のダミーのファイルが `check` で差になる | 見本の誤りで書かずに投げる |

## 横断の部品

満たす決定: 決定 6・7・13・14、受け入れ条件 2・3・4・5

関数の仕様・異常系・処理の手順・並行と排他・ログ・再利用・単体テストの観点は [detail.md](../docs/design/detail.md) のとおりで、ここでは置き場（ファイル）・型の項目の並び・この課題で足すものだけを書く。MCP の受け口の 5 つの関数と `McpCall` ほかの MCP の型は、#11 が `src/dispatch/mcp.ts` に置く（決定 7）。5 つは `readMcpCall`・`createMcpHandler`・`createMcpServer`・`serveMcp`・`writeMcpResponse` である。

### ファイルと exports

| モジュール | ファイル | `exports` のエントリポイント | 関数（detail.md の名前のまま） |
| --- | --- | --- | --- |
| clock | `src/clock.ts` | `./clock` | `createClock` |
| ids | `src/ids.ts` | `./ids` | `newId`・`parseId` |
| idempotency | `src/idempotency.ts` | `./idempotency` | `claimIdempotency`・`settleIdempotency` |
| redact | `src/redact.ts` | `./redact` | `redact` |
| log | `src/log.ts` | `./log` | `createLogger` |
| retry | `src/retry.ts` | `./retry` | `withRetry`・`classifyFailure` |
| outbound | `src/outbound.ts` | `./outbound` | `callHttp`・`awsClient` |
| db | `src/db.ts` | `./db` | `createDb`（新設） |
| conditional-write | `src/conditional-write.ts` | `./conditional-write` | `putIfAbsent`・`updateIfVersion`・`writeAtomically` |
| auth | `src/auth/authenticate.ts`・`jwks.ts`・`tokens.ts` | `./auth` | `authenticate`・`createJwksCache` |
| authorize | `src/authorize.ts` | `./authorize` | `visibleProjectIds`・`authorize` |
| usage-limit | `src/usage-limit.ts` | `./usage-limit` | `judgeUsage`・`usageAddItem` |
| audit | `src/audit.ts` | `./audit` | `auditItem`・`appendAudit` |
| dispatch | `src/dispatch/types.ts`・`http.ts`・`dispatch.ts` | `./dispatch` | `readHttpCall`・`dispatch`・`writeHttpResponse` |

`package.json` の依存は次のとおりである。

| 依存 | 版 |
| --- | --- |
| `@nd-factory/contracts` | — |
| `uuid` | 14.0.3（LIB46） |
| `aws-jwt-verify` | 5.2.1（LIB41） |
| `@aws-sdk/client-dynamodb`・`@aws-sdk/lib-dynamodb` | `apps/api` と同じ 3.1170.0 |

`log` の既定の書き先は `process.stdout.write` で、`console.log` を使わない。

### 関数の仕様（この課題で足すもの）

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `createDb` | `src/db.ts` | 新設 | `(client: DynamoDBDocumentClient, names: TableNames) => Db` | detail.md の `Db` のポートを DynamoDB の文書のクライアントで満たす |
| `dispatch` | `src/dispatch/dispatch.ts` | 新設（detail.md のとおり。下の 2 つの分岐を足す） | `(call: OperationCall, deps: DispatchDeps) => Promise<DispatchResult>` | detail.md のとおり |
| `visibleProjectIds`・`authorize` | `src/authorize.ts` | 新設（detail.md のとおり。読み手の確かめ方を足す） | detail.md のとおり | detail.md のとおり |

- `dispatch` に足す分岐（[detail.md の処理の手順](../docs/design/detail.md#処理の手順) に無いもの）
  - 操作が形の未定（`isPending`）か、ハンドラーの表に無い: 要求全体の 503 `unavailable` とログの error（操作の名前だけ）。記録の要約の行を 1 件書く
  - 受け口が `user` でない操作を受け口 `user` の経路で引いた（またはその逆）: `readHttpCall` が経路の表で受け口ごとに引くため起きず、起きたら 405
- `ScopeReader`（決定 14）。中身は表の持ち主の子が `apps/api/src/modules/` に書き、次を満たす。`seatsOf` は #4、`laneOf` は #6、`isHumanOnlyItem` は #8 が書く。`projectsOfTeams`・`projectOfTarget`・`transferTargetOf` は #5 が書く。この課題は偽の読み手で `authorize` の側の約束を確かめる
  - `seatsOf(userId)` は `user-seats` の索引で候補のチームを読む。候補ごとに `db-teams` の `TEAM#<チーム>` / `SEAT#<利用者>` を強い整合で読み直して、在る席だけを返す
  - `projectsOfTeams(teamIds)` は `team-projects` の索引で候補を読む。候補のプロジェクトの行を強い整合で読み直し、`current_team_id` が席のチームのものだけを返す
  - `projectOfTarget(item)` は要素の対象から、プロジェクトの行を強い整合で読む。`authorize` は要素ごとにこの値で照らし、索引の値だけで通さない
  - 索引の遅れで新しく足した席や割り当てが 1 回の要求で見えないことはある。見えるべきでないものが見えることは無い（迷うときは見せない、Value 9）

### 内部のデータと定数（型の項目の並び）

detail.md の「内部のデータと定数」の型を、宣言の項目の順で決める。値と既定は detail.md のまま。

| 型 | 保存先 | 項目の並び |
| --- | --- | --- |
| `Clock` | `clock.ts` | `now(): Date`・`iso(): string`・`epochMs(): number`（`epochMs` を足す。`newId` と TTL の計算が使う） |
| `Logger` | `log.ts` | `info(msg, fields?)`・`warn(msg, fields?)`・`error(msg, fields?)`・`child(fields)` |
| `LogContext` | `log.ts` | `request_id`・`fn`・`endpoint?` |
| `RetryPolicy` | contracts `data.ts` | `max_attempts`・`base_ms`・`cap_ms`・`timeout_ms`・`honor_retry_after` |
| `OutboundRequest` | `outbound.ts` | `method`・`url`・`headers`・`body`・`idempotent`・`peer`（ログの相手の種類 `github`・`idp`・`push`・`slack`・`api`） |
| `OutboundResult` | `outbound.ts` | `status`・`headers`・`body`・`class` |
| `TransactItem` | `conditional-write.ts` | `table`・`op`（`put`・`update`・`delete`・`check`）・`key`・`item?`・`update?`・`condition`・`onConflict` |
| `WriteOutcome` | `conditional-write.ts` | `{ ok: true }` か `{ ok: false; failed: { index; onConflict }[] }` |
| `Db` | `db.ts` | `get(table, key, consistent)`・`query(table, keyCond, opts)`・`queryIndex(table, index, keyCond, opts)`・`transactWrite(items)`・`update(table, key, update, condition)` |
| `Principal` | `auth/authenticate.ts` | 判別の鍵 `kind` を先頭に。`{kind: "human", userId}`・`{kind: "delegation", userId, delegationId, scope: {projectIds, operations}, clientName}`・`{kind: "runner", laneId, projectId, generation}`・`{kind: "machine", teamId, machineId}`・`{kind: "github"}`・`{kind: "db_prep", projectId, prepId}`・`{kind: "patrol"}` |
| `AuthResult` | `auth/authenticate.ts` | `{ ok: true; principal }`・`{ ok: false; reason: "unauthorized" \| "unavailable" }` |
| `ScopeReader` | `authorize.ts` | `seatsOf`・`projectsOfTeams`・`projectOfTarget`・`laneOf`・`transferTargetOf`・`isHumanOnlyItem` |
| `ItemAuthz` | `authorize.ts` | `{decision: "allow", projectId, role}`・`{decision: "deny", status: 404 \| 403, reason}` |
| `AuditEntry` | `audit.ts` | `auditId`・`requestId`・`at`・`actor`・`channel`・`operation`・`targetIds`・`projectId`・`result`・`itemIndex` |
| `OperationCall` | `dispatch/types.ts` | `endpoint`・`channel`・`operation`・`token`・`principal?`・`items`・`requestId`・`mcpClientName?`・`remainingMs` |
| `DispatchDeps` | `dispatch/types.ts` | `operations`・`handlers`・`scope`・`auth`・`db`・`clock`・`log` |
| `Handler` | `dispatch/types.ts` | `(item, ctx: { principal; authz: ItemAuthz; clock; db }) => Promise<{ result; writes: TransactItem[] }>` |
| `TableNames` | `db.ts` | 表の用途（`users`・`teams`・…・`idempotency`）から実際の表の名前への対応。値は起点が環境変数から渡す |

### 単体テストの観点（detail.md に足すもの）

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `authorize`（I2・受け入れ条件 3） | 席のチームに割り当てたプロジェクトの要素は `allow` | 索引にまだ載る外した席（偽の索引に残し、本体からは消す）では見えない | 割り当ての外の要素は 404 `not_found` で、見えるときと本文が同じ。見えない要素では役割の 403 を返さない |
| `dispatch`（I9・受け入れ条件 4） | 書く要素の記録の行が状態と同じ `writeAtomically` に入る | — | 記録の表への更新か削除の書き込みをハンドラーが返すと `dispatch` が 503 で確定しない。本文に `ghs_` の値を入れると記録の行とログに残らない。記録の書き込みの失敗で 503 `audit_unavailable` を返し、状態も書かれない |
| `dispatch`（I12・受け入れ条件 5） | — | — | `{"a": 1}` の本文で 400 `body_not_array`。400 以外が返ると落ちる |
| `dispatch`（形の未定） | — | — | 形の未定の操作で 503 `unavailable` |
| `createDb` | 偽のクライアントへ渡る命令の形 | — | — |

## API の起点と骨組みの移し

満たす決定: 決定 11、受け入れ条件 2・5

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `createApiHandler` | `apps/api/src/entries/api-fn.ts` | 新設 | `(deps: ApiDeps) => (event: APIGatewayProxyEventV2, context: Context) => Promise<APIGatewayProxyResultV2>` | `readHttpCall` → `dispatch` → `writeHttpResponse` を通す |
| `handler` | 同上 | 新設 | 既定の依存で作った `createApiHandler` の戻り値 | 実行環境ごとに 1 回、時計・`awsClient`・`createDb`・ログ・ハンドラーの表（今は空）を組む |
| `ensureUser` | `apps/api/src/user-store.ts` | 変更 | `(db: Db, table: string, sub: string, clock: Clock) => Promise<UserRow>` | `putIfAbsent` と `writeAtomically` で行を作り、外れたら強い整合で読み直す |
| `handler` | `apps/api/src/users-handler.ts` | 変更 | 変えない | 既定の依存を `createClock`・`awsClient`・`createDb`・`createLogger` で組む。`HandlerDeps` の `client` は `Db` に、`now` は `Clock` に、`log` は `Logger` に替える |

- `createApiHandler`
  - 事前条件: `deps.handlers` の鍵は操作の表の名前
  - 事後条件: どの応答も `Cache-Control: no-store` を持ち、500 を返さない。`context.getRemainingTimeInMillis()` を `OperationCall.remainingMs` に渡す
  - 副作用: `dispatch` の副作用のとおり
- 骨組みの `PUT /v1/users` の応答の形・状態・ログの項目は変えない。今のテストは依存の注入の形（`now` → `clock`・`log` → `Logger`・`client` → `Db`）だけを直し、確かめる振る舞いは変えない

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `createApiHandler` | 偽の操作とハンドラーで 200 と配列・`no-store` | base64 の本文 | 配列でない本文で 400、ハンドラーの例外で 503 |
| `ensureUser` | 無ければ作る | 同時に作られて条件が外れたら読み直した行を返す | 表の失敗で `StoreError`（今の扱いのまま） |

## サービスの表

満たす決定: 決定 8・14、受け入れ条件 8

共通の列（`pk`・`sk`・`schema_version`・上書きの行の `version`）は [データの共通の列](../docs/design/data.md#共通の列) のとおりで、ここでは書かない。全体の設計が列を決めた行（プロジェクト・割り当て・レーン・承認の依頼・答えの `ndf_event_seqs`・操作の記録）もそのまま形の正本へ写し、ここでは書かない。閉じた語の集まりは英小文字の識別子で持ち、画面の文言は翻訳のファイルが識別子から作る。

### 関数の仕様

| 関数・定数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `TABLES` | `packages/contracts/src/tables.ts` | 新設 | `Record<TablePurpose, TableSpec>` | 10 の表の仕様 |
| `ServiceTable` | `infra/lib/service-table.ts` | 新設 | `new ServiceTable(scope, id, { purpose: TablePurpose; names: AppResourceNames })` | 仕様から `TableV2`（要求の数の課金・PITR・`RemovalPolicy.RETAIN`・TTL・索引）を作る |
| `ApiRoutes` | `infra/lib/api-routes.ts` | 新設 | `new ApiRoutes(scope, id, { api: HttpApi; fn: IFunction; endpoints: readonly Endpoint[] })` | `routes.json` のうち渡した受け口の経路を `POST` で登録する |

`TableSpec` の項目の並び:

| 順 | 項目 | 中身 |
| --- | --- | --- |
| 1 | `purpose` | — |
| 2 | `suffix` | `db-users` ほか |
| 3 | `partitionKey` | `pk` |
| 4 | `sortKey` | `sk` か `null` |
| 5 | `ttlAttribute` | `expire_at` か `null` |
| 6 | `indexes` | `{name, partitionKey, sortKey, projection}` の配列 |
| 7 | `rows` | 行の種類の名前と `RowCodec` の配列 |

### 決めた書き方

| 決まり | 中身 |
| --- | --- |
| 列の名前 | 英小文字と `_`。ID の列は `<種類>_id`、日時は `<出来事>_at`、真偽は形容の語（`is_` を付けない） |
| 状態の識別子 | 全体の設計の日本語の状態の名前と次の対応で持つ。スプリント: `running`（動いている）・`finished`（終わった）・`stopped`（止まった）・`canceled`（取り消した）。承認の依頼と問い: `waiting`・`answered`・`canceled`。答えの送達: `pending`（未渡し）・`delivering`（渡し中）・`delivered`（届いた）・`failed`（失敗）。区間の結果: `done`（完了）・`needs_decision`（判断が要る）・`failed`（できなかった）。手元のマシン: `pending`（登録待ち）・`online`・`offline`。席の役割: `owner`・`member`。IdP: `google`・`github`。通知先の種類: `web_push`・`slack`。量の種類: `compute`・`inference`・`byok_inference`・`machine_time`。知らせの種類: `approval`・`question`・`sprint_finished`・`sprint_stopped`・`cap_reached` |
| TTL の列 | `expire_at`（UNIX の秒の整数。DynamoDB の TTL の属性）。持つのは冪等の鍵（作成から 24 時間）・渡した GitHub の token の記録（token の期限）・操作の記録（`AUDIT_RETENTION_DAYS` 日。設定のファイルの値） |
| 冪等の鍵の表の `sk` | 持たない（区切りの鍵だけの表）。共通の列の `sk` の例外として表の仕様に書く |
| 答えの ID | 答えの要素の `idempotency_key`（UUID）をそのまま答えの ID にする。答えの ID の頭は ID の頭の集まりに無く、全体の設計が「答えの ID を冪等の鍵として」と書くため、頭を足さない |
| 区間の ID | `<レーンの ID>#SEG#<連番>`。連番はレーンの中で 1 から上げる。費用の記録の冪等の鍵と `COST#` の `<ID>` に使う |
| 費用の記録の鍵の時刻 | 区間の終わりの事象の時刻（ランナーが付ける）。同じ区間の送り直しで同じ `sk` になり、`putIfAbsent` が 2 回目を足さない |
| 渡した GitHub の token の記録の連番 | 記録を足したときのプロジェクトの行の `gh_token_generation` の値 |
| 招待の置き場 | `db-teams` の `TEAM#<チーム>` / `INVITE#<招待>`（チームの集約の中の行。全体の設計の表と鍵の表の `db-teams` の並びの鍵に足す） |

### 行ごとの列

| 行（表 / 並びの鍵） | 列（型、空を許すものに `?`） | 上書きか追記か |
| --- | --- | --- |
| 利用者（`db-users` / `USER`） | `user_id`・`display_name`（0〜32 字）・`language?`（`languageTag`）・`time_zone?`（`timeZone`）・`created_at` | 上書き |
| ログインの組（`db-users` / `LOGIN#<IdP>#<主体>`） | `user_id`・`idp`・`subject`・`linked_at` | 作ると消すだけ（`version` を持たない） |
| IdP の主体の一意の行（全体の設計が列を決めた行で、19 の行に数えない） | 全体の設計のまま（`user_id`） | 作ると消すだけ |
| 委任（`db-users` / `DELEGATION#<委任>`） | `delegation_id`・`user_id`・`client_name`（1〜64 字）・`scope_project_ids`（`prj` の ID の配列、1 以上）・`scope_kind`（`read`・`run`・`manage`）・`secret_sha256`（64 桁）・`expires_at`・`created_at`・`last_used_at?`・`revoked_at?` | 上書き（状態は `expires_at`・`revoked_at` から導き、列に持たない） |
| チーム（`db-teams` / `TEAM`） | `team_id`・`name`（1〜100 字）・`plan`（料金プランの行の名前）・`currency`（`currencyCode`）・`monthly_cap?`（`money`）・`default_place`（`hosted`・`machine`）・`default_inference`（`managed`・`byok`）・`created_at` | 上書き |
| 席（`db-teams` / `SEAT#<利用者>`） | `team_id`・`user_id`・`role`・`added_at`・`us_pk`・`us_sk`（索引の鍵） | 上書き |
| 招待（`db-teams` / `INVITE#<招待>`） | `invitation_id`・`team_id`・`role`・`state`（`open`・`accepted`・`deleted`）・`created_by`・`created_at`・`expires_at`・`accepted_by?`・`accepted_at?` | 上書き（期限の値と招く相手の指定の仕方は #4 が決め、列を足す） |
| 手元のマシン（`db-teams` / `MACHINE#<マシン>`） | `machine_id`・`team_id`・`name`（1〜64 字）・`state`・`token_sha256`・`token_expires_at`・`last_heartbeat_at?`・`lane_capacity?`（1〜16）・`created_at`・`revoked_at?` | 上書き（`offline` への移しは見回りが書く。#7） |
| 月の使った量（`db-teams` / `USAGE#<UTC の年月>`） | `team_id`・`month`（`YYYY-MM`）・`used`（`money`） | 上書き（`usageAddItem` が加算） |
| リポジトリ（`db-projects` / `REPO#<リポジトリ>`） | `repo_id`・`project_id`・`github_repo`（`githubRepo`）・`installation_id`（GitHub の整数）・`primary`（真偽）・`added_at` | 上書き |
| 渡した GitHub の token の記録（`db-projects` / `GHTOKEN#<期限>#<レーン>#<連番>`） | `project_id`・`lane_id`・`generation`・`expires_at`・`expire_at`（TTL）。token の値と識別は #33 の答えで足す | 追記だけ |
| スプリント（`db-sprints` / `SPRINT#<スプリント>`） | `sprint_id`・`project_id`・`title`（1〜200 字）・`issues`（`githubIssueRef` の配列、1〜20）・`place`・`inference`・`state`・`started_by`（利用者の ID。委任なら委任した人）・`started_at`・`ended_at?`・`end_reason?`（理由のコード） | 上書き |
| 区間（`db-sprints` / `…#LANE#<レーン>#SEG#<連番>`） | `project_id`・`sprint_id`・`lane_id`・`seq`・`started_at`・`ended_at?`・`result?`・`category?`（区分の文字列）・`failure_reason?`（`result_line_missing`・`result_value_unknown`・`segment_crashed`・`segment_timeout`）・`duration_ms?` | 上書き（閉じるときに結果を書く） |
| 進捗の事象（`db-events` / `SEQ#<連番>`） | `project_id`・`lane_id`・`seq`・`generation`・`kind`（形の正本の事象の種類。値の集合は #6）・`occurred_at`・`body`（種類ごとの形。`redact` を通す） | 追記だけ |
| 問い（`db-decisions` / `QUESTION#<問い>`） | `question_id`・`project_id`・`sprint_id`・`lane_id`・`category`・`human_only`（真偽）・`state`・`body`・`options?`（`{key, label, description}` の配列）・`recommended?`（選択肢の鍵）・`ndf_gate_id?`・`machine_id?`（どちらも契約の `fields` の答えを待つ。#6）・`answer_id?`・`delivery?`・`waiting_since?`・`wt_pk?`・`wt_sk?` | 上書き |
| 答え（`db-decisions` / `APPROVAL#<依頼>#ANSWER#<答え>`・`QUESTION#<問い>#ANSWER#<答え>`） | `answer_id`・`project_id`・`parent_id`（依頼か問いの ID）・`word`（承認は `ndfAnswerWord`、問いは選択肢の鍵）・`reason?`（0〜2,000 字）・`notes?`（差し戻しの指摘、0〜10,000 字）・`drop_issues?`（整数の配列）・`material_digest?`・`head_sha?`・`answered_by`（`{kind, user_id, delegation_id?}`）・`answered_at`・`claimed_generation?`・`ndf_event_seqs?`（全体の設計のとおり） | 追記だけ（`claimed_generation` と `ndf_event_seqs` は空のときに 1 回だけ書く） |
| 知らせ（`db-notices` / `NOTICE#<時刻>#<ID>`） | `notice_id`・`user_id`・`project_id`・`kind`・`target_id`（依頼・問い・スプリントの ID）・`occurred_at`・`read_at?`・`deliveries`（通知先の ID から `{state: pending・sent・failed・skipped, attempts}` への地図） | 上書き（既読は画面、送達は送り手。どちらも `updateIfVersion` で書き、外れたら読み直して 1 回やり直す） |
| 通知先（`db-notices` / `DEST#<通知先>`） | `destination_id`・`user_id`・`kind`・`team_id?`（`slack` だけ）・`secret_name`（秘密の器の名前）・`fingerprint`（宛先の値の SHA-256 の 64 桁）・`last4`・`state`（`active`・`invalid`・`failed`）・`created_at` | 上書き |
| 費用の記録（`db-usage` / `COST#<時刻>#<区間の ID>`） | `project_id`・`sprint_id`・`lane_id`・`segment_id`・`kind`・`quantity`（`{unit: seconds・tokens_in・tokens_out・tokens_cache, value}` の配列）・`amount`（`money`。量だけのものは 0）・`occurred_at` | 追記だけ |
| 冪等の鍵（`db-idempotency`） | `principal_key`・`operation`・`key`・`fingerprint`・`state`（`leased`・`settled`）・`owner_request_id`・`lease_until`・`result?`・`expire_at` | 借りから済みへ 1 回だけ書き換える（`version` を持たない） |

全体の設計の版の列の一覧（[共通の列](../docs/design/data.md#共通の列)）に載らない行のうち、招待と区間は上書きするため `version` を持ち、ログインの組は作ると消すだけのため持たない。持ち込みのキー（`model_keys.*`）と GitHub App の導入（`github_installations.*`）の行は 19 の行に入っていない。置き場と列は、それぞれ #6 と #5 の詳細設計が決める。

### 索引

| 索引 | 表 | 区切り / 並び | 写す列 | 載る行 | 答える問い |
| --- | --- | --- | --- | --- | --- |
| `user-seats` | `db-teams` | `us_pk = USER#<利用者>` / `us_sk = TEAM#<チーム>` | `team_id`・`role` | 席の行だけ（書き手が席の行にだけ 2 列を書く） | 主体が席を持つチームの候補（`ScopeReader.seatsOf`） |
| `team-projects` | `db-projects` | `tp_pk = TEAM#<current_team_id>` / `tp_sk = PROJECT#<プロジェクト>` | `project_id`・`name`・`current_assign_id` | `current_team_id` のあるプロジェクトの行だけ（閉じると 2 列を消す） | チームに今割り当てたプロジェクトの候補（`projectsOfTeams`） |
| `waiting` | `db-decisions` | `wt_pk = PROJECT#<プロジェクト>` / `wt_sk = <waiting_since>#<依頼か問いの ID>` | `kind`（`approval`・`question`）・`sprint_id`・`lane_id`・`gate?`・`category?`・`state` | `state` が `waiting` の依頼と問いだけ（答えるか取り消すと 2 列を消す） | 見えるプロジェクトの待っているもの。古い順（`approvals.list`・`questions.list`・`waiting_counts.get`） |

どの索引も結果整合で、候補を出すだけに使う。認可と確定の照らしは表の本体を強い整合で読む（決定 14）。索引の鍵の 2 列は、元の行を書く同じ `TransactItem` で書く。

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| 行の形（受け入れ条件 8） | 行ごとの作り物の行が通る | 空を許す列が欠けた行 | `schema_version` の無い行・上書きの行で `version` の無い行・時刻帯の無い日時・通貨の無い金額が落ちる |
| `TABLES` | 10 の表・3 つの索引が上の表と一致 | — | 同じ索引の名前の重なりで投げる |
| `ServiceTable` | 合成の出力に PITR・`Retain`・TTL・索引の鍵がある | `sortKey` の無い表（`db-idempotency`） | — |
| `ApiRoutes` | 渡した受け口の経路の数が `routes.json` と同じ | 受け口 `runner` だけ | 経路の重なりで合成が投げる |

## 表の移し

満たす決定: 決定 9、受け入れ条件 9

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `rowCodec` | `packages/contracts/src/row-codec.ts` | 新設 | `<C, P>(spec: { current: number; schema: ZodType<C>; previous?: { version: number; schema: ZodType<P>; upgrade: (row: P) => C } }) => RowCodec<C>` | 行の種類の今と 1 つ前の版をまとめる |
| `readRow` | 同上 | 新設 | `<C>(codec: RowCodec<C>, raw: unknown) => ReadRowResult<C>` | 今の版はそのまま、1 つ前の版は引き上げて返し、ほかは拒む |
| `migrateTable` | `apps/api/src/entries/migrate.ts` | 新設 | `(input: { purpose: TablePurpose; cursor: Cursor \| null }, deps: MigrateDeps) => Promise<{ done: boolean; cursor: Cursor \| null; rewritten: number }>` | 1 つ前の版の行を今の版へ書き換える |
| `createMigrateHandler` | 同上 | 新設 | `(deps: MigrateDeps) => (event: MigrateEvent, context: Context) => Promise<void>` | `migrateTable` を呼び、終わっていなければ続きの位置を持って自分を非同期で起こし直す |

- `readRow`
  - 事後条件: 戻り値は `{ ok: true; row: C; upgraded: boolean }` か `{ ok: false; reason: "version_unsupported" \| "shape_invalid" }`。2 つ前より古い版と、今より新しい版は `version_unsupported`
- `migrateTable`
  - 事前条件: `deps` は `Db`・時計・ログ・残り時間の読み手・`TABLES`
  - 事後条件: 走査した行のうち 1 つ前の版の行を、`schema_version = <前の版>` を条件にした更新で今の版へ書き換えた。条件が外れた行（同時に書き手が今の版で書いた）は飛ばす。残り時間が `MIGRATE_RESERVE_MS` を下回れば、最後に読んだ位置を `cursor` に返す
  - 副作用: 表の走査と条件つきの更新（`updateIfVersion` の組み方を使い、`writeAtomically` で 1 件ずつ確定）

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `MIGRATE_RESERVE_MS` | 定数 | `migrate.ts` | 10000 |
| `MIGRATE_PAGE_SIZE` | 定数 | `migrate.ts` | 100 |
| 版を上げる子の手順 | 手順 | この節 | 1. 行の形の次の版と `upgrade` を足し、`current` を上げずに読み手を両方の版にする（1 段目の反映）2. `current` を上げて書き手を次の版にし、`migrate` の Lambda（`createMigrateHandler`、権限はその表の読みと更新だけ）と起こし方を足す（2 段目の反映）3. 2 段目を戻すときは書き手だけを前の版へ戻す。読み手は両方を読むため、書き換えた行は次の版のまま残す |

### 並行と排他

| 同時に走りうる処理 | 共有する資源 | 排他の取り方 | 冪等性と中断からの再開 |
| --- | --- | --- | --- |
| 表の移しと、同じ行を書く API の要求 | 行の `schema_version` と `version` | 移しは `schema_version = <前の版>` と読んだ `version` を条件に書く | 外れたら飛ばす（書き手が今の版で書いた）。2 回走らせても書き換えは 1 回 |
| 2 つの移しの起動 | 同じ表 | 取らない（条件つきの更新で同じ行を 2 回書き換えない） | 続きの位置から再開できる。最初からやり直しても結果は同じ |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `readRow` | 今の版と 1 つ前の版を読む（1 つ前は引き上げる） | 1 つ前の版が無い行の種類 | 2 つ前の版・今より新しい版・形の違いを拒む |
| `migrateTable` | 前の版の行が今の版になる | 残り時間がちょうど予備の時間で続きの位置を返す | 2 回走らせても行が同じ。途中で書き手が今の版にした行を飛ばす |

## #1 へ渡す欠け

| 欠け | この課題が用意するもの | #1 がすること |
| --- | --- | --- |
| 操作の一覧と画面と MCP の対応・HTTP の経路の登録の照らし | `generated/mcp-tools.json`・`generated/routes.json`・`OPERATIONS` の `features` | 生成物を読んで対応の検査を作り、CI の必須のチェックへ載せる |
| 形の往復 | `operations-roundtrip.test.ts`（CI の `check` で走る） | 必須のチェックに `check` が載っていることを CI の定義のテストで照らす（今のまま） |
| 境界の検査 | `packages/core` の `exports` のエントリポイントの一覧と、置き場の外で直に使わないもの（[土台の表](../docs/design/platform.md#横断の部品の置き場の基準)） | `apps/` の実行の時のコードを探す検査を作る。画面が import してよいエントリポイントは `clock`・`ids`・`redact`・`log` |
| 漏れの検査 | `data/secret-shapes.json` | 同じデータを読む |
| 骨組みの経路 | `PUT /v1/users` は操作の表に無い | #4 が消すまで、経路の登録の照らしでこの 1 本を受け持つ子 #4 の印つきで外す |
