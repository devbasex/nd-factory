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
│   ├── row-codec.ts            *   行の版の読み手と書き手（RowCodec・readRow・writeRow・rowUpdateOf）
│   ├── ndf.ts                  *   受ける NDF の契約の組の形・答えの語
│   ├── data.ts                 *   data/*.json の読みと検証
│   └── client.ts               *   画面とテストが操作を呼ぶ口・ダミーの送り手（決定 16）
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
└── test/                           足す: values・operations・operations-roundtrip・rows・row-codec・ndf・data・artifacts と fixtures/operations.ts（往復のテスト用の操作）
packages/core/                  *
├── package.json · tsconfig.json
├── src/
│   ├── clock.ts · ids.ts · idempotency.ts · redact.ts · log.ts · retry.ts · outbound.ts
│   ├── db.ts                       Db のポートと DynamoDB の実装
│   ├── conditional-write.ts · authorize.ts · usage-limit.ts · audit.ts
│   ├── auth/  authenticate.ts · tokens.ts
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

依存の向き: `packages/contracts`（zod だけ）← `packages/core`（contracts・AWS SDK・`uuid`・`aws-jwt-verify`・`ky`・`p-retry`・`pino`）← `apps/api`。`infra` は `packages/contracts` の `tables.ts` と `generated/routes.json` だけを読む。`packages/core` と `apps/*` は import しない。`apps/web` が使ってよい `core` のモジュールは `clock`・`ids`・`redact`・`log` の 4 つである。この 4 つは `node:` の組み込みと AWS SDK を import しない（`ids` の乱数は `uuid` を通す）。型の関係は [detail.md のクラス図](../docs/design/detail.md#クラスと関数の構造) のまま変えない。

| パス | 種類 | 役割 1 文 | 依存する先 | モジュール | 最上位の関数と定数（新設 / 変更） |
| --- | --- | --- | --- | --- | --- |
| `packages/contracts/src/values.ts` | 新設 | 国や地域で読み違えない値の形を 1 か所に置く | zod | values | `utcDateTime`・`calendarMonth`・`money`・`currencyCode`・`languageTag`・`timeZone`・`githubRepo`・`githubIssueRef`・`itemsArray` |
| `packages/contracts/src/ids.ts` | 新設 | ID の頭の集まりと ID の形 | values | ids | `ID_KINDS`・`IdKind`・`idOf` |
| `packages/contracts/src/tokens.ts` | 新設 | 委任と登録の token の形 | ids | tokens | `delegationToken`・`machineToken` |
| `packages/contracts/src/reasons.ts` | 新設 | 理由のコードの共通の集まりと型 | zod | reasons | `REQUEST_REASONS`・`ITEM_REASONS`・`ReasonDef` |
| `packages/contracts/src/operation.ts` | 新設 | 操作の定義の型と組み立て | values・reasons | operation | `defineOperation`・`pendingShape`・`isPending`・`okItem`・`okList`・`itemFailure`・`itemReasonsOf`・`resultSchemaOf`・`OperationDef`・`ItemOf`・`ResultOf`・`ResultShapeOf`・`ItemFailureSchema`・`ReasonsOf`・`SuccessEnvelope`・`ResultShape` |
| `packages/contracts/src/operations/*.ts` | 新設 | 操作の表の全行 | operation・ids・values | operations | `OPERATIONS`・`operationByName`・`operationByRoute` |
| `packages/contracts/src/rows/*.ts` | 新設 | 表の行の形 | values・ids | rows | 行ごとの `<行>Row` の zod と `ROW_CODECS` |
| `packages/contracts/src/tables.ts` | 新設 | 10 の表の仕様 | rows | tables | `TABLES`・`TableSpec` |
| `packages/contracts/src/row-codec.ts` | 新設 | 行の版の読み手と書き手 | rows | row-codec | `rowCodec`・`readRow`・`writeRow`・`rowUpdateOf` |
| `packages/contracts/src/ndf.ts` | 新設 | NDF の契約の値 | zod | ndf | `ndfContractSet`・`ndfAnswerWord` |
| `packages/contracts/src/data.ts` | 新設 | データのファイルを形で検証して出す | ndf・values | data | `RETRY_POLICIES`・`SECRET_SHAPES`・`NDF_CONTRACTS`・`PLANS` |
| `packages/contracts/src/client.ts` | 新設 | 操作の名前で型を引く呼び出しの口と、生成したダミーを返す送り手 | operations | client | `createOperationClient`・`createDummyTransport` |
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
| `utcDateTime` | `values.ts` | 新設 | `z.string().regex(UTC_DATE_TIME)`。`UTC_DATE_TIME` は下の正規表現 | RFC 3339 の UTC の日時のうち、実在する日付と範囲の中の時刻だけを通す（I15） |
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
| `ReasonDef` | `reasons.ts` | 新設 | `{ code: string; status: 400 \| 401 \| 403 \| 404 \| 409 \| 422 \| 429 \| 503; when: "always" \| "write" \| "idempotency" \| "all_or_nothing" \| "human_only_per_item" }`。`code` は `^[a-z][a-z0-9_]*$` | 理由のコード・HTTP の状態・起きうる操作の条件の 1 組。共通の集まりも操作ごとのコードもこの型で持つ |
| `REQUEST_REASONS` | `reasons.ts` | 新設 | `ReasonDef` の配列。`body_not_json`・`body_not_array`・`body_empty`・`too_many_items`・`duplicate_item`・`cursor_invalid`・`unauthorized`・`human_only`・`scope_insufficient`・`unavailable`・`audit_unavailable`・`too_many_requests` | 要求全体の理由のコード |
| `ITEM_REASONS` | `reasons.ts` | 新設 | `ReasonDef` の配列。`item_invalid`（400・`always`）・`not_found`（404・`always`）・`role_insufficient`（403・`always`）・`human_only`（403・`human_only_per_item`）・`version_mismatch`（409・`write`）・`state_mismatch`（409・`write`）・`idempotency_key_reused`（422・`idempotency`）・`in_progress`（409・`idempotency`）・`not_applied`（409・`all_or_nothing`） | どの操作の要素にも出うる理由のコード。操作ごとのコードは `reasons` に足す |

`UTC_DATE_TIME`（`values.ts` の定数。`refine` を使わずに日付の実在を照らすため、月ごとの日の数とうるう年を正規表現で書く。JSON Schema の `pattern` へそのまま写り、Ajv も同じ合否になる）:

```text
^(?:\d{4}-(?:(?:0[1-9]|1[0-2])-(?:0[1-9]|1\d|2[0-8])|(?:0[13-9]|1[0-2])-(?:29|30)|(?:0[13578]|1[02])-31)|(?:\d{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)-02-29)T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$
```

- 2 月 29 日は 4 で割れる年（100 で割れて 400 で割れない年を除く）だけを通す
- 時は 00〜23、分と秒は 00〜59。うるう秒の `60` は通さない（RFC 3339 は許すが、この製品の日時は時計と DynamoDB の値から作り、`60` を出さないため。入力に来たら要素の 400 `item_invalid`）

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `utcDateTime`（zod と、生成した JSON Schema を Ajv で検証した結果の両方で同じ合否を確かめる） | `2026-11-17T03:04:05.123Z` | 小数なし・小数 1 桁・`2024-02-29`・`2000-02-29`・各月の末日・`23:59:59` | `+09:00`・時刻帯なし・小数 4 桁・小文字の `z`・`2026-02-30T25:00:00Z`・`2026-02-29`・`1900-02-29`・`2026-04-31`・月 `00` と `13`・日 `00`・時 `24`・分 `60`・秒 `60`。加えて 1896〜2104 年の毎日を `Date.UTC` の実在と照らし、食い違いが 0 件 |
| `money` | `{"amount_minor": 1234, "currency": "USD"}` | `amount_minor` が 0 | 通貨なし・`12.34`・`"usd"`・負の数 |
| `timeZone` | `Asia/Tokyo`・`UTC`・`America/Argentina/Buenos_Aires` | `Etc/GMT+9` | `JST`・`+09:00`・`asia/tokyo` |
| `languageTag` | `ja`・`pt-BR`・`zh-Hant-TW` | `es-419` | `ja_JP`・`JA`・空 |
| `idOf` | 頭と UUIDv7 が合う | 版の数字が 7 | 大文字・頭の違い・版 4・変種の違い |

## 形の正本: 操作の表

満たす決定: 決定 1、受け入れ条件 1・5

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `defineOperation` | `operation.ts` | 新設 | `<N extends string, I extends Shape, R extends SuccessEnvelope \| PendingShape>(def: OperationInput<N, I, R>) => OperationDef<N, I, R>` | 印を照らし、HTTP の経路と既定の値を足した定義を返す |
| `pendingShape` | `operation.ts` | 新設 | `(owner: `#${number}`) => PendingShape` | どの値も通さない形と、受け持つ子の番号 |
| `isPending` | `operation.ts` | 新設 | `(shape: ZodType \| PendingShape) => shape is PendingShape` | 形の未定かを返す |
| `okItem`・`okList` | `operation.ts` | 新設 | `<R extends ItemObjectShape>(item: R) => z.ZodObject<{ ok: z.ZodLiteral<true>; item: R }, z.core.$strict>`（`ItemObjectShape` は `z.ZodObject \| z.ZodUnion<readonly z.ZodObject[]>`。`okItem(z.string())` は型で拒む）・`<R extends ZodType>(item: R) => z.ZodObject<{ ok: z.ZodLiteral<true>; items: z.ZodArray<R>; next_cursor: z.ZodNullable<z.ZodString> }, z.core.$strict>` | 成功の要素の結果の封筒（`{ok: true, item}`・`{ok: true, items, next_cursor}`）。`okItem` の `item` はオブジェクトの形（`z.object` か、どの選択肢もオブジェクトの和）だけを受ける（`docs/design/api.md` の「本文は配列」の `item: {…}`）。`z.strictObject` で組み、封筒の余分なキー（`reason` など）を拒む。既定の `z.object` は余分なキーを落として通すため、`{ok: true, item: <有効な値>, reason: "not_found"}` が成功として通ってしまう。JSON Schema では `additionalProperties: false` になり、往復のテストで Ajv と合否がそろう |
| `itemFailure` | `operation.ts` | 新設 | `<const RS extends readonly [ReasonDef, ...ReasonDef[]]>(reasons: RS) => ItemFailureSchema<RS>` | 失敗の要素の結果（`{ok: false, status, reason, fields?}`）。渡した `ReasonDef` ごとに `status` と `reason` を `z.literal` で縛ったオブジェクトを 1 つ作り、`reason` を判別の鍵にした和にする |
| `resultSchemaOf` | `operation.ts` | 新設 | `<Op extends OperationDef>(op: Op) => z.ZodDiscriminatedUnion<[ResultShapeOf<Op>, ItemFailureSchema<ReasonsOf<Op>>], "ok">` | その操作の要素の結果の zod。`z.discriminatedUnion("ok", [op.result, itemFailure(itemReasonsOf(op))])`。`ResultOf<Op>` はこの戻り値の `z.infer` で、成功の側は `z.infer<ResultShapeOf<Op>>`（`PendingShape` を和の選択肢に含まない）。`op.result` が `PendingShape` なら投げる（形の未定の操作は呼び手が `isPending` で先に外す）。戻り値の型は宣言の上で `PendingShape` を外した `ResultShapeOf<Op>` にし、関数の中で `isPending` で外した後の `op.result` をその型として渡す |
| `itemReasonsOf` | `operation.ts` | 新設 | `<Op extends OperationDef>(op: Op) => ReasonsOf<Op>` | その操作で起きうる要素の理由。`ITEM_REASONS` のうち `when` が操作に当たるもの（`write` は `access` が `write`、`idempotency` は `idempotencyKey`、`all_or_nothing` は `allOrNothing`、`human_only_per_item` は `humanOnly` が `per_item`）に、`op.reasons` を続けた配列。結果の形の `itemFailure`・`generated/reasons.json`・失敗のダミーはどれもこの戻り値から作る |
| `operationByName` | `operations/index.ts` | 新設 | `(name: string) => OperationDef \| undefined` | 名前で引く |
| `operationByRoute` | `operations/index.ts` | 新設 | `(path: string) => OperationDef \| undefined` | `/v1/...` の経路で引く（`readHttpCall` が使う） |

- `defineOperation`
  - 事前条件: 受け口が `user` の操作の名前は `<entity>.<verb>`（`^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`）。ほかの受け口の操作の名前は、経路の path の `/v1/` の後ろを `.` でつないだ `<受け口>.<entity>.<verb>`（例 `runner.events.create`。頭は受け口の値と同じ）
  - 事後条件: `route` は受け口 `user` なら `/v1/<entity>/<verb>`、ほかは `/v1/<受け口>/<entity>/<verb>`。次のどれかに当たれば例外を投げる（モジュールの読み込みで落ち、`check` の型検査とテストが先に落とす）
    - `access` が `read` で `idempotencyKey` が真
    - `allOrNothing` があって `access` が `read`
    - `humanOnly` が `always` で `mcpRead` が無い
    - `humanOnly` が `never` で `mcpRead` がある
    - `result` が `PendingShape` でなく、次の成功の封筒の規則のどれかを外れる（`checkResult` が照らす）
      - `ok` を `z.literal(true)` で持つ `z.strictObject` でない
      - `verb` が `list` で、`ok`・`items`・`next_cursor` のどれかが無いか省ける（optional）、または `items` が配列でないか、`next_cursor` が文字列か `null`（`z.string().nullable()`）でない
      - `verb` が `list` でなく、`ok`・`item` のどちらかが無いか省ける（optional）、または `item` がオブジェクトの形（`z.object` か、オブジェクトだけの和）でない
      - 受け口 `user` の操作で、封筒が上の決まったキーのほかのキーを持つ（ほかの受け口は文書が応答に足す値を持つため、足したキーを許す）
      - 封筒が失敗の要素のキー（`status`・`reason`・`fields`）を持つ
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
| 13 | `onceOnly` | 成功の結果の中の場所（`item.token` の形）の配列 | `[]`。冪等の鍵を持つ操作だけが持ち、場所は成功の結果にあって `null` を受ける形でなければ `defineOperation` が投げる（場所の途中は optional・nullable・default などの包みを外し、配列は要素へ下りる。末尾は配列や包みを含めたその場所の形そのものが `null` を受ける）。`settleIdempotency` はこの場所だけを `null` に替える |
| 14 | `item`・`result` | `item` は zod \| `PendingShape`。`result` は `SuccessEnvelope`（`ok` を `z.literal(true)` で持つ `strictObject`。`okItem`・`okList` が作る） \| `PendingShape` | —。`result` が `ok: true` の strict な封筒でなければ `defineOperation` が投げる（`z.object` と `z.strictObject` は型で見分けられないため、型の制約に加えて実行の時にも照らす）。あわせて、list の封筒は `ok`・`items`・`next_cursor` を、list でなければ `ok`・`item`（オブジェクトの形）を必ず持ち、受け口 `user` はそのキーだけを持ち、どの封筒も失敗の要素のキー（`status`・`reason`・`fields`）を置かない。照らす規則の全部は `defineOperation` の事後条件に書く |
| 15 | `reasons` | `readonly ReasonDef[]`（操作ごとのコードだけ。`when` は `always`） | `[]`（共通の `ITEM_REASONS` は書かずに `itemReasonsOf` が合わせる）。`ITEM_REASONS` と同じコードを書くと `defineOperation` が投げる |
| 16 | `auditKeys` | 要素の鍵の名前の配列 | `[]` |
| 17 | `order` | 文字列 \| `null` | `list` 以外は `null` |
| 18 | `examples` | `{ normal?: unknown[]; edge?: unknown[]; empty?: unknown } \| null` | `null`。書いたときだけ、生成した見本をその場面で上書きする（決定 3）。`empty` は空の場面の結果 1 件（`null` で空の場面を持たない） |
| 19 | `description_en` | 文字列 | `"<verb> <entity>"` |
| 20 | `owner` | `` `#${number}` `` | — |

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `MAX_ITEMS` | 定数 | `operation.ts` | 100（今の `users-api.ts` の 10 は骨組みの経路の値のまま残し、#4 が消す） |
| `IDEMPOTENCY_TTL_SECONDS` | 定数 | `operation.ts` | 86400 |
| `PendingShape` | 型 | `operation.ts` | `{ kind: "pending"; owner: string; schema: z.ZodNever }` |
| `ItemFailureSchema<RS>` | 型 | `operation.ts` | `z.ZodDiscriminatedUnion<{ [K in keyof RS]: z.ZodObject<{ ok: z.ZodLiteral<false>; status: z.ZodLiteral<RS[K]["status"]>; reason: z.ZodLiteral<RS[K]["code"]>; fields: z.ZodOptional<z.ZodArray<z.ZodString>> }> }, "reason">`。`ZodObject` 1 つでは理由ごとの `status` と `reason` の組を縛れないため、理由ごとのオブジェクトの和を型に出す |
| `ResultShapeOf<Op>` | 型 | `operation.ts` | `Exclude<Op["result"], PendingShape>`。`OperationDef` の `result` は zod か `PendingShape` を許すため、`resultSchemaOf` の和の成功の選択肢はこの型で zod だけに絞る。形の未定の操作では `never` になり、その操作の `ResultOf` は失敗の側だけになる（`resultSchemaOf` は投げるため値は作られない） |
| `ReasonsOf<Op>` | 型 | `operation.ts` | `readonly [ReasonDef, ...ReasonDef[]]`。`ITEM_REASONS` の `item_invalid`・`not_found`・`role_insufficient` は `when` が `always` でどの操作にも入るため、空にならない。型の上では要素を `ReasonDef` に広げるため、`ResultOf<Op>` の失敗の側は `{ ok: false; status: ReasonDef["status"]; reason: string; fields?: string[] }` になる。理由ごとの `status` と `reason` の組は、`itemFailure` が実行の時に作る zod の和が縛る |
| 結果の和の組み方 | 決まり | `operation.ts` | 成功と失敗を合わせる外側の和は `ok` を判別の鍵にし、失敗の側には `itemFailure` の和（`reason` が判別の鍵）をそのまま 1 つの要素として入れる（zod 4 の `discriminatedUnion` は、要素の和の各分岐が外側の鍵を `z.literal` で持てば入れ子にできる）。失敗の分岐はどれも `ok: false` を持つが、外側の和から見ると失敗の側は 1 つの要素のため、鍵の値は重ならない。理由ごとの分岐を外側の和へ平らに並べない（`ok: false` が重なって組めない） |
| 全部か無かの上限 | 操作の定義の値 | `projects.ts` | `projects.create` は 19（要素 1 つでプロジェクト・主リポジトリ・割り当ての 3 件と記録の行・冪等の済みの行の 5 件。主体が人の書く操作のため、トランザクションに 1 回入る要求元の照らしの 2 件（[データの文書の人の書き込みの要求元の照らし](../docs/design/data.md#人の書き込みの要求元の照らし)）を残す → (100 − 2) ÷ 5 の切り捨て）、`repositories.add` は 24（リポジトリの行・プロジェクトの行の照らし・記録の行・冪等の済みの行の 4 件。委任からも呼べるが、人が呼ぶと要求元の照らしの 2 件が入るため残す → (100 − 2) ÷ 4 の切り捨て） |

`allOrNothing.maxItems` の値は、受け持つ子（#5）が要素 1 つの書き込みの件の数を決めたときに直す。この課題は全体の設計の行（プロジェクト・主リポジトリ・割り当て）と、新しいものを作る操作が持つ冪等の鍵（[冪等の鍵](../docs/design/api.md#冪等の鍵)）から見積もった値を置く。

要求ごとの記録の要約の行は、この 100 件に数えない。要約は状態の `writeAtomically` に入れず、その確定の後に `appendAudit` で別に 1 行書く（[detail.md の `appendAudit`](../docs/design/detail.md#関数の仕様) と `dispatch` の異常系）。同じトランザクションに入れないのは、要素の記録の行が状態と同じトランザクションにあるため I9 は要約なしで満たされ、要約まで入れると全部か無かの上限が 1 件ずつ減るからである。要約の書き込みが外れたときは次のとおりにする。

| 場面 | 返すもの | 状態 | 送り直し |
| --- | --- | --- | --- |
| 書く操作で、状態の確定の後に要約を書けない（1 回だけ返す値を発行する操作は次の行） | 要求全体の 503 `audit_unavailable`（要素の結果を返さない） | 確定のまま（要素の記録の行と冪等の鍵の済みの行も確定） | 冪等の鍵を持つ操作は、同じ鍵で送り直すと済みの行から前の結果が返り、要約がもう 1 度書かれる。冪等の鍵を持たない書く操作は、送り直すと 1 回目の書き込みで版か状態が変わっているため、条件の外れの要素の 409 `version_mismatch`・`state_mismatch` になる。呼び手は読み直して、書けているかを確かめてから送り直す（[detail.md の並行と排他](../docs/design/detail.md#並行と排他) の同じエンティティを書く 2 つの要求の扱いのまま。状態は 2 回書かれない） |
| 1 回だけ返す値（委任の token・登録の token）を発行する操作（`delegations.create`・`machines.create`）で、状態の確定の後に要約を書けない | 要求全体の 503 `audit_unavailable`（発行した token を返さない） | 確定のまま（資格情報の行は有効で、要約は持たない。サービスは秘密の部分の要約しか持たないため、token を後から返せない） | 同じ鍵で送り直すと、済みの行から前の要素の結果が返り、token は `null`、資格情報の ID（委任の ID・マシンの ID）は値のまま返る。呼び手（画面）は「成功で token が `null`」を受けたら、その ID を取り消し（`delegations.revoke`・`machines.delete`）、新しい冪等の鍵で発行し直す。画面は token を見せられなかったことと、取り消して発行し直したことを人に示す。送り直さずに諦めた呼び手の資格情報は、誰も token を持たないまま期限まで有効に残るため、一覧（`delegations.list`・`machines.list`）に「最後に使った時刻」が無い行として出し、人が取り消せる |
| 読む操作で要約を書けない | 要求全体の 503 `audit_unavailable`（値を返さない） | 書いていない | そのまま送り直せる |

1 回だけ返す値を持つ操作の結果の形は、資格情報の ID を必ず持つ（`settleIdempotency` が `null` に替えるのは 1 回だけ返す値だけで、ID は控える）。これで送り直しの結果から、取り消す相手を決められる。API の側で自動では取り消さない。要約を書けない原因（記録の表の書き込みの外れ）が続く間は取り消しの記録も書けず、取り消しは人の操作として記録に残すためである。

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `defineOperation` | 経路が名前から作られる。受け口 `runner` は `/v1/runner/…` | `allOrNothing.maxItems` が 1 | 読む操作に冪等の鍵・人だけの操作に読み出しの道具が無い・名前の形の違いで投げる |
| `OPERATIONS` | 66 + 9 行。利用者向けの操作の名前と経路と機能と人だけかが [操作の一覧](../docs/design/api.md#操作の一覧) と一致する（テストは `docs/design/api.md` の操作の一覧の表を読んで照らし、一覧の写しをテストに持たない） | — | 名前か経路の重なりで投げる |
| `pendingShape` | `isPending` が真。どの値も zod の検証を通らない | — | — |
| `itemFailure`・`resultSchemaOf` | `ok: false` の理由を 3 つ持つ操作で、成功の結果と各理由の失敗をどちらも通す（失敗の分岐が `ok: false` を共有しても組める） | 理由が 1 つ（`itemFailure` の和の分岐が 1 つ） | 理由と `status` の組み替え（`not_found` と 409）・`ReasonDef` に無い `reason`・`okItem` と `okList` のどちらの封筒でも、`ok: true` に有効な `item`（`items`・`next_cursor`）と `reason: "not_found"` を持つ値を拒む。`op.result` が `PendingShape` で投げる。型のテスト（`expectTypeOf`）で、`ResultOf` の `ok: true` の側が `okItem` に渡した要素の型と一致し、`PendingShape` が和に入らない |

## 形の正本: データと NDF の契約

満たす決定: 決定 10・13、受け入れ条件 10

### 関数の仕様

| 関数・定数 | 保存先 | 種類 | シグネチャと形 | 責務 |
| --- | --- | --- | --- | --- |
| `ndfContractSet` | `ndf.ts` | 新設 | `z.strictObject({ accepted: z.array(z.strictObject({ version: z.int().min(1), sha256: /^[0-9a-f]{64}$/ })).min(1) })`。重なりは `data.ts` の読みで照らす | 受ける契約の組の集合の形 |
| `ndfAnswerWord` | `ndf.ts` | 新設 | `z.enum(["approved","rejected","request_changes","retry","finish","cancel"])` | 答えの語（出所: 固定の点の `C/facts/answers.json`） |
| `RETRY_POLICIES` | `data.ts` | 新設 | `RetryPolicies`（名前から種類の形を引く対応表。`dynamodb`・`aws-control` は `AwsRetryPolicy`、`dynamodb-transaction` は `TransactionRetryPolicy`、`http-github`・`http-notify`・`runner-to-api` は `HttpRetryPolicy`、`http-idp-keys` は `JwksRetryPolicy`。`RetryPolicyOf<N>` で引く） | `data/retry-policies.json` を形で検証して出す。名前ごとに種類を 1 つに固定し、名前と `kind` の取り違えを読み込みで拒む。`http` は `timeout_ms <= total_timeout_ms`、`transaction` は `min_ms <= max_ms` も照らす |
| `SECRET_SHAPES` | `data.ts` | 新設 | `{ keyNames: readonly string[]; valuePatterns: readonly { name: string; pattern: string }[] }` | 秘密の形（`redact` と漏れの検査と生成の照らしが読む） |
| `NDF_CONTRACTS` | `data.ts` | 新設 | `ndfContractSet` の型 | 受ける組（ランナー（#6）が読む） |
| `PLANS` | `data.ts` | 新設 | 料金プランの行の配列。この課題は「上限なし」の 1 行だけ | `judgeUsage` が読む |

- `data.ts` はモジュールの読み込みのときに検証し、形が違えば例外を投げる（データの誤りを実行の時でなく `check` で落とす）。受ける組の重なり（同じ版か同じ sha256 が 2 つ）も例外にする

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `data/ndf-contracts.json` | 設定値 | `packages/contracts/data/` | `{"accepted": [{"version": 8, "sha256": "ed8b036584bec284dfc93a2bb5b988e2385b4f8f297d659399f5d3cb91b520c4"}]}` |
| `data/retry-policies.json` | 設定値 | 同上 | 全体の設計の detail.md の「再試行の方針の表」の 7 つの方針（`dynamodb`・`aws-control`・`dynamodb-transaction`・`http-github`・`http-notify`・`runner-to-api`・`http-idp-keys`）。形は `RetryPolicy` の 4 つの種類（`aws`・`http`・`jwks`・`transaction`） |
| `data/secret-shapes.json` | 設定値 | 同上 | 鍵の名前に含む語 `authorization`・`token`・`secret`・`password`・`credentials`・`private_key`・`dsn`。値の形 `ndfd_`・`ndfm_` の頭・JWT（`eyJ` で始まる 3 つの部分）・`ghs_`・`ghp_`・`gho_`・`github_pat_`・`-----BEGIN .*PRIVATE KEY-----`・利用者と合言葉を含む接続の URL（`://[^/:]+:[^@]+@`）・AWS の一時の鍵（`ASIA[0-9A-Z]{16}`） |
| `data/plans.json` | 設定値 | 同上 | `[{"name": "unlimited", "places": ["hosted","machine"], "inference": ["managed","byok"], "concurrency": null, "monthly_cap": null}]`（値の集合と量は #29） |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `ndfContractSet` | 今のデータが通る | 組が 1 つ | 空・63 桁・大文字の 16 進・版 0・同じ版の重なり |
| `RETRY_POLICIES` | 7 つの方針が detail.md の値で、種類ごとの形に合う | — | 鍵の欠け・負の数・種類に無い鍵・名前と種類が合わない（`dynamodb` に `jwks`・`http-idp-keys` に `aws` など）・`min_ms > max_ms`・`timeout_ms > total_timeout_ms` で読み込みが投げる。型のテストで、名前から引いた方針が種類の形に絞られている |
| `SECRET_SHAPES` | 値の形の各行に当たる作り物の値と当たらない値の組 | — | 正規表現として読めない行で投げる |

## 形の正本: 生成

満たす決定: 決定 2・3・4、受け入れ条件 1・7

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `checkExamples` | `scripts/artifacts.ts` | 新設 | `(ops: readonly OperationDef[]) => ExampleProblem[]` | 見本（`normal`・`edge`・`empty`。`empty` は動詞によらず `null` でなければ照らす）を結果の形・秘密の形・作り物の値の決まりで照らす。秘密の形と作り物の値は、文字列と数の値に加えてオブジェクトのキー（`z.record` の見本のキーなど）も照らす。`list` の封筒が `ok`・`items`・`next_cursor` のほかに必須の項目を持つのに `examples.empty` を書いていなければ問題にする（下の生成物の表の `empty`）。診断は操作の名前・見本の場面と位置・違反の種類（形に合わないときは Zod の issue の code）だけを持ち、当たった値を含めない（生成のコマンドが標準エラーに出し、CI のログに残るため） |
| `buildOperationSchemas` | 同上 | 新設 | `(ops) => JsonSchemaDoc` | 操作ごとの要素と結果の JSON Schema を `$defs` に並べる。要素は入力のモード（`io: "input"`）、結果は出力のモードで出し、`zod-openapi` が要求と応答に使うモードとそろえる（`z.object` の要素は追加の項目を受け、`strictObject` だけが拒む）。各形の `$ref` は生成物の中のその形の場所を根に付け替え、再帰する形（自分へ戻る `"#"` と共有した `"#/$defs/…"`）も生成物の中で解ける |
| `buildOpenApi` | 同上 | 新設 | `(ops) => OpenApiDoc` | `zod-openapi`（LIB42。開発の依存）の `createDocument` に、操作の表の要素と結果の zod の形（`.meta({ id: "<操作>.item" })` で名前を付ける）を渡して OpenAPI 3.1.1 の文書を組む（全体の設計の決定 55） |
| `buildMcpTools` | 同上 | 新設 | `(ops, schemas) => McpToolDoc[]` | 人だけでない利用者向けの操作の道具の定義 |
| `buildRoutes` | 同上 | 新設 | `(ops) => RouteDoc[]` | 経路の登録 |
| `buildReasons` | 同上 | 新設 | `(ops) => ReasonsDoc` | 理由のコードの一覧 |
| `buildDummy` | 同上 | 新設 | `(op) => DummyDoc \| null` | 1 つの操作のダミーデータ（形の未定は `null`）。`normal` と `edge` は `examples` があればそれを、無ければ `fakeExamples` の値を使う。`empty` は `examples.empty` があればそれを、無ければ下の生成物の表の既定を使う |
| `fakeExamples` | 同上 | 新設 | `(op) => { normal: unknown[]; edge: unknown[] }` | 結果の zod の形から `zod-schema-faker`（`zod-schema-faker/v4` の `fake`）で見本を作る。種は操作の名前の SHA-256 の頭 8 桁、`normal` は 3 件、`edge` は上の端（文字列を上限の長さ・配列を上限の件数・数を上限・省ける項目を置く）と下の端（文字列を下限の長さ・配列を下限の件数・数を下限・省ける項目を省く）の 2 件（形の `max`・`min` を受け取る faker の関数を端へ寄せたものに差し替えて寄せる。文字列の元は形の中の最も長い上限か 1024 字の長い方、倍数の数は端そのものが倍数なら端を、そうでなければ範囲の内側で端に最も近い倍数を選ぶ。倍数かは Zod の `multipleOf` と同じ判定で照らし、小数の倍数の丸めの誤差は倍数の小数の桁でそろえるため、`min(0.1).max(0.3).multipleOf(0.1)` の上の端は `0.3`）。メール・アカウント ID の形（`values.ts` の `awsAccountId`）・接頭辞（`settings.ts` の `PREFIX_SHAPE`）は、生成の前に形の木を写してそれぞれの作り物の値（`ops@example.com`・`123456789012`・`acme`）の literal へ置き換える（`zod-schema-faker` の `custom` は `z.custom` の形にしか効かず、メールは内部の randexp で作るため、faker の上書きでは届かない）。再帰する形（`z.lazy` と shape に getter を持つ object）は、子を写す前に写しを作り、子は初めて読まれたときに写すため、循環で戻った深い層も作り物の値になる |
| `buildPending` | 同上 | 新設 | `(ops) => PendingDoc[]` | 形の未定の操作と受け持つ子 |
| `generateArtifacts` | `scripts/generate.ts` | 変更 | `(root: string, mode: "write" \| "check") => Promise<string[]>`（変えない） | 今の 3 つに上の生成物を足す。`generated/dummy/` の直下の `.json` で終わる通常のファイルのうち、どの操作にも当たらないもの（古いダミー）は `check` で差に数え、`write` で消す。サブディレクトリと `.json` でないファイルは生成物でないため数えず、消さない |

- `checkExamples`
  - 事前条件: 無し
  - 事後条件: 次のどれかを問題として返す。`generateArtifacts` は問題が 1 つでもあれば書かずに `GenerateError`（終了コード 2）を投げる
    - 見本が `resultSchemaOf` の zod を通らない
    - 見本の文字列に `SECRET_SHAPES` の値の形が当たる
    - 12 桁の数で `123456789012` でないもの
    - `@` を含む値で域名が `example.com` でないもの
- `buildMcpTools` の道具の入力の形は、要素の形を持たない（[detail.md の `createMcpHandler`](../docs/design/detail.md#関数の仕様)）。入力の形は次のとおりである

```json
{"type": "object", "properties": {"items": {"type": "array", "minItems": 1, "maxItems": <MAX_ITEMS か allOrNothing.maxItems>}}, "required": ["items"]}
```

- `buildMcpTools` の道具の出力の形は、結果の配列の JSON Schema である。全体の設計（[api.md の MCP の出力の形](../docs/design/api.md) と STD40）が採る MCP の仕様 2026-07-28 版は、`structuredContent` に配列を含む任意の JSON の値を許す（2025-11-25 版はオブジェクトに限っていた）。#11 の `writeMcpResponse` も同じ配列を `structuredContent` に入れるため、出力の形と応答はそろっている。注記は次の条件で付ける

| 注記 | 条件 |
| --- | --- |
| `readOnlyHint` | `access` が `read` |
| `idempotentHint` | `idempotencyKey` |
| `destructiveHint` | 動詞が `delete`・`remove`・`cancel`・`revoke` |

### 内部のデータと定数

| 生成物 | 形（鍵の順） |
| --- | --- |
| `generated/operations.schema.json` | `{"$schema": "https://json-schema.org/draft/2020-12/schema", "$defs": {"<操作>.item": …, "<操作>.result": …}}`。形の未定は `{"not": {}}`。`z.toJSONSchema` は自分へ戻る形を `"#"`、共有した形を `"#/$defs/__schema0"` のように形の根から指すため、各形の `$ref` を、生成物の中でその形を置いた `#/$defs/<操作>.item`（または `.result`）を根にした参照へ付け替える（形の中の `$defs` はその形の下に残す） |
| `generated/openapi.json` | `openapi: "3.1.1"`・`info`（題 `nd-factory API`・版 `1`）・`paths`（受け口 `user` の操作だけ。`post` の `operationId` は操作の名前、要求は `itemsArray(item)`、応答 200 は結果の配列、`default` は problem）・`components.schemas`（`zod-openapi` が `.meta({ id })` の名前で出す。生成元は `z.toJSONSchema` で、再帰しない形は `operations.schema.json` の `$defs` と同じ値になることを生成のテストが照らす。再帰する形は `zod-openapi` が再帰を `components.schemas` の別の名前（`__schema0` など）へ切り出して `#/components/schemas/…` で参照するため値は一致せず、生成のテストは参照が解けて合否が Zod と同じことを照らす）・`components.securitySchemes.bearer` |
| `generated/mcp-tools.json` | `[{name, description, inputSchema, outputSchema, annotations}]`（操作の表の順）。`outputSchema` は単独の文書のため、`operations.schema.json` の結果の形の `$ref` を `#/items` を根にした参照へ付け替える |
| `generated/routes.json` | `[{method: "POST", path, operation, endpoint}]`（操作の表の順。GitHub の Webhook は I12 の外のため載せず、受け持つ #5 が足す） |
| `generated/reasons.json` | `{"request": [{code, status}…], "item": [{code, status}…], "operations": {"<操作>": [{code, status}…]}}`。`operations` の値は `itemReasonsOf(op)` の `code` と `status` |
| `generated/dummy/<操作>.json` | `{"operation", "normal": [...], "empty": <結果 1 件> | null, "edge": [...], "failures": [{"ok": false, "status", "reason"}…]}`。`normal` と `failures` は送り手が要素ごとに 1 件を選ぶ元の並びで、要求の件数の写しではない。`empty` は要素 1 個に返す結果 1 件である。`examples.empty` を書いた操作は、動詞によらずその値を使う（`null` なら空の場面を持たない。`null` でない値は `checkExamples` が結果の形と作り物の値の決まりで照らし、ダミーの送り手は `create` などでもその値を `empty` の場面に返す）。`examples.empty` が無ければ、`list` で `{"ok": true, "items": [], "next_cursor": null}`（その要素の空の一覧）、`get` で `{"ok": false, "status": 404, "reason": "not_found"}`、それ以外は `null`（空の場面が無く、`normal` と同じに返す）。封筒が `ok`・`items`・`next_cursor` のほかに必須の項目を持つ `list`（たとえば `runner.answers.list` の `delivered_seqs`）は、`examples.empty` を必須にする。その項目の空の一覧での値は件数などで `items` と結びつきうる。正常の見本から写すと `items: []` と食い違う値（`total: 3` など）が結果の形を通って入るため、生成で決めずに書き手が書く（書かなければ `checkExamples` が問題にする）。`failures` は `itemReasonsOf(op)` の要素ごとに 1 つで、`status` と `reason` はその `ReasonDef` の値（読む操作は `when` が `write` の `version_mismatch` などを含めない）。どの失敗のダミーも、同じ `itemReasonsOf(op)` から作った `resultSchemaOf` の zod を通る |
| `generated/pending.json` | `[{"operation", "owner"}]` |

理由のコードと HTTP の状態の対応は、共通の集まりも操作ごとのコードも `ReasonDef` の `status` だけが持つ（別の対応の表を持たない）。

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| 往復（`operations-roundtrip.test.ts`） | 比べる操作は、`OPERATIONS` のうち形のある操作と、テスト用の操作（下の段落）の和。操作ごとに、要素（見本と反例: 時刻帯の無い日時・通貨の無い金額・頭の違う ID・配列でない本文・追加の項目。追加の項目は `z.object` の要素で受け、`strictObject` で拒む。受け口 `user` の操作では、要素の見本と反例のすべての合否を、`buildOpenApi` が出した `components.schemas` の `<操作>.item` を Ajv（`strict: false`）で検証した結果とも比べる）・成功の結果（`examples` の `normal` と `edge`）・失敗の結果（`buildDummy` の `failures` と、`ReasonDef` に無い `status` と `reason` の組の反例）を、zod（`ItemOf`・`resultSchemaOf`）と、`buildOperationSchemas` が出した `<操作>.item`・`<操作>.result` を Ajv（`Ajv2020`、`strict: true`、`validateFormats: false`）で検証した結果とで同じ合否 | 要素 1 個と上限ちょうどの配列 | `refine` を使う形をテストの中で足すと食い違いを検出する（検出の仕組みのテスト）。比べた操作・要素・OpenAPI で照らした要素・成功・失敗のどれかの件の数が 0 なら落ちる |
| `checkExamples` | 作り物の値だけの見本は問題 0。メール・アカウント ID・接頭辞を持つ結果の形は見本を書かずに問題 0 | 1024 字を超える上限の文字列の上の端が上限の長さ。下限と倍数だけの数の下の端が形を通る。`min(0.1).max(0.3).multipleOf(0.1)` の上の端が `0.3`、下の端が `0.1`。再帰する形（`z.lazy`・getter の object）の深い層のメールとアカウント ID が作り物の値 | 通貨の無い金額・`ghs_` の値・`ops@corp.test`・12 桁の別の数・形に合わない空の結果（`create` に書いた `empty` も）・見本のレコードのキーの `ops@corp.test` や 12 桁の別の数・`examples.empty` の無い、必須の項目を足した `list` の封筒で問題が出る。診断に当たった値とキーが入らない |
| `buildMcpTools` | 人だけの操作と受け口 `user` でない操作が無い。道具の順が操作の表の順 | 全部か無かの操作の `maxItems`。再帰する結果の形の `outputSchema` が単独で解け、深い層の誤りを拒む | — |
| `buildOpenApi` | 文書が OpenAPI 3.1.1 で、再帰しない形の `components.schemas` の各値が `operations.schema.json` の同じ名前の `$defs` と一致する | 形の未定の操作の `not` の形。自分へ戻る形は、`components.schemas` を 1 つの文書として Ajv に渡し、`#/components/schemas/…` の参照が解けて深い層まで Zod と同じ合否になる | 一致しないと落ちる（`zod-openapi` と `z.toJSONSchema` の出力の差を拾う） |
| `buildDummy` | `list` の空・`get` の 404・`itemReasonsOf(op)` のコードごとの失敗で、`status` が `ReasonDef` と同じ。どの失敗も `resultSchemaOf` の zod を通る | 形の未定は `null` | — |
| `itemReasonsOf` | 書く操作は `version_mismatch` を含み、操作ごとのコードが後ろに続く | 冪等の鍵の無い操作は `in_progress` を含まない | 操作ごとのコードに `not_found` を書くと `defineOperation` が投げる |
| `generateArtifacts` | `write` の後の `check` が空 | 消えた操作のダミーのファイルが `check` で差になる | 見本の誤りで書かずに投げる |

往復のテスト用の操作（`test/fixtures/operations.ts`）: この課題の間は全操作の要素と結果が `pendingShape` のため、`OPERATIONS` だけを比べると、実際の形の生成物を 1 件も比べずに受け入れ条件 7 を通せてしまう。そこで、本番の操作と同じ `defineOperation` で組んだ 2 つの操作を置き、本番と同じ `buildOperationSchemas`・`buildDummy` に `OPERATIONS` と並べて渡す（テスト用の経路を作らない）。生成物のファイルには書かない。

| テスト用の操作 | 受け口・読み書き | 要素の形 | 結果の形 | 足す印 |
| --- | --- | --- | --- | --- |
| `fixture_notes.create` | `user`・`write` | `{project_id: idOf("prj"), title: 1〜200 字, due_at: utcDateTime, budget: money, language: languageTag, time_zone: timeZone, repo: githubRepo}` | `okItem({note_id: idOf("ntc"), version: 1 以上の整数, created_at: utcDateTime})` | `features: ["F1"]`・`delegationKind: "run"`・`idempotencyKey`・`allOrNothing: {maxItems: 2}`・操作ごとのコード `{code: "fixture_limit", status: 409, when: "always"}` |
| `fixture_notes.list` | `user`・`read` | `{project_id: idOf("prj"), cursor: 文字列か null}` | `okList({note_id, title, due_at})` | `features: ["F1"]`・`delegationKind: "read"` |

子が実際の形を入れた後も、テスト用の操作は残す（形の正本の値の形を 1 か所でまとめて往復させる見本として使い、本番の操作の形の入れ替えでこのテストが空にならないようにする）。

## 形の正本: 画面とテストが操作を呼ぶ口

満たす決定: 決定 16（決定 140 の改め）、受け入れ条件 1

画面の実装方針の正本は [platform.md の言語と書き方の決まり](../docs/design/platform.md#言語と書き方の決まり) と決定 140 で、画面は React 19 の関数の部品を TSX で書き、画面の外のコードは TSX と React を import しない。`client.ts` は形の正本（画面の外）に置くため、zod と `operations/` だけを import し、React・DOM・`node:` の組み込みを import しない。画面（React 19 の TSX）・e2e・API のテストが同じ口を使う。React のフックの包みと、取得の控えの層（LIB-A20）・Service Worker のダミー（LIB-A21）を採るかは画面の基盤（#12）が決める。

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `createOperationClient` | `packages/contracts/src/client.ts` | 新設 | `(transport: Transport) => { call<N extends OperationName>(name: N, items: readonly ItemOf<N>[]): Promise<CallResult<N>> }` | 要素の配列を送り、応答を結果の zod で検証して型つきで返す |
| `httpTransport` | 同上 | 新設 | `(opts: { baseUrl: string; fetch: typeof fetch; token: () => Promise<string \| null> }) => Transport` | `POST <baseUrl>/v1/<entity>/<verb>` に `Authorization: Bearer` と JSON の本文で送る |
| `createDummyTransport` | 同上 | 新設 | `(dummies: Readonly<Record<OperationName, DummyDoc \| null>>, scenario: () => DummyScenario) => Transport` | 生成したダミーから、要求の各要素に結果を 1 件ずつ組み、`{ status: 200, body: <要求と同じ件数・同じ順の配列> }` を返す。`i` 番目の要素の結果は、`normal`・`slow` で `normal[i % normal.length]`（待ちは画面の基盤が足す）、`empty` で `empty`（`null` なら `normal` と同じ）、`error` で `failures[i % failures.length]`（理由のコードを `itemReasonsOf(op)` の順に回す）、`notFound` で `{ ok: false, status: 404, reason: "not_found" }` |

- `createOperationClient`
  - 事前条件: `items` は 1 個以上で、`ItemOf<N>` の形（型で縛る）
  - 事後条件: 戻り値は `{ ok: true; results: ResultOf<N>[] }`（要求と同じ数・同じ順）か、要求全体の誤り `{ ok: false; status; reason }`（problem の本文）。要求全体の誤りとして受けるのは、HTTP の状態が 200 でなく、本文が生成物の problem と同じ形（`problemBody`。`type: "about:blank"`・`status`・要求全体の理由のコードの `reason` だけを持つ）で、本文の `status` が HTTP の状態と同じで、`status` と `reason` が `REQUEST_REASONS` の組のときだけである。そうでない非 200 の応答（中継が返した 502 の本文など）は `response_invalid` にする。応答が結果の zod に合わなければ `{ ok: false; status: 0; reason: "response_invalid" }` を返し、例外を投げない
  - 副作用: `transport` の副作用だけ
- `createDummyTransport`
  - 事前条件: `items` は 1 個以上（`createOperationClient` が縛る）
  - 事後条件: 本文の配列は要求の `items` と同じ件数・同じ順で、各要素は `resultSchemaOf(op)` の zod を通る。一覧の空は要素ごとの空の一覧（`items: []`）で表し、配列そのものを空にしない。ダミーの無い操作（形の未定）・`normal` が 0 件・`error` の場面で `failures` が 0 件のときは、要求全体の `{ status: 503, body: { reason: "unavailable" } }`（problem の本文）を返す
  - 副作用: 無し（`scenario` を呼ぶたびに読み、要求ごとに場面を切り替えられる）

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `Transport` | 型 | `client.ts` | `(op: OperationDef, items: readonly unknown[]) => Promise<{ status: number; body: unknown }>` |
| `DummyScenario` | 型 | `client.ts` | `normal`・`empty`・`error`・`slow`・`notFound`（[画面のダミーデータで作り切る段](../docs/design/screens.md#ダミーデータで作り切る段) の値） |
| `generated/dummy/index.json` | 生成物 | `packages/contracts/generated/` | 操作の名前からダミーのファイルへの対応。Vite は JSON を import できるため、画面は生成物をそのまま読む |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `createOperationClient` | 偽の送り手の応答を型つきの結果で返す | 要素 1 個と上限ちょうど | 結果の形に合わない応答で `response_invalid`、problem の本文で要求全体の誤り。非 200 の本文が problem の形でない・表に無い理由・本文の `status` が HTTP の状態と違う・`status` と `reason` が表の組でないときは `response_invalid` |
| `createDummyTransport` | 場面ごとに `normal`・`empty`・`failures`・404 を要素ごとに 1 件ずつ返し、`createOperationClient` を通して結果の zod に合う | 要素 1 個の `normal` は 1 件（見本 3 件を返さない）、要素 5 個の `normal` は見本を順に回して 5 件。要素 1 個の `error` は 1 件、`list` の要素 2 個の `empty` は空の一覧 2 件、`create` の `empty` は `normal` と同じ（`examples.empty` を書いた `create` はその値）。要素 1 個と上限ちょうどで件数が要求と同じ | 形の未定の操作・`failures` が 0 件の操作の `error` は要求全体の `unavailable` の 503 |

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
| retry | `src/retry.ts` | `./retry` | `classifyFailure`（共通の再試行の関数は持たない。全体の設計の detail.md の「既存の部品の再利用」の再試行の行） |
| outbound | `src/outbound.ts` | `./outbound` | `callHttp`・`awsClient` |
| db | `src/db.ts` | `./db` | `createDb`（新設） |
| conditional-write | `src/conditional-write.ts` | `./conditional-write` | `putIfAbsent`・`updateIfVersion`・`writeAtomically`・`updateIfSchemaVersion`（新設。[表の移し](#表の移し)） |
| auth | `src/auth/authenticate.ts`・`tokens.ts` | `./auth` | `authenticate`（公開鍵の控えは `aws-jwt-verify` の組み込み。全体の設計の決定 48） |
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
| `ky` | 2.2.0（LIB91）。`callHttp` |
| `p-retry` | 9.0.0（LIB92）。`writeAtomically` のトランザクションの衝突だけ |
| `pino` | 10.4.0（LIB93）。`createLogger`。画面では `pino` のブラウザー版（`browser.write` に書き先を渡す） |
| `@aws-sdk/client-dynamodb`・`@aws-sdk/lib-dynamodb` | `apps/api` と同じ 3.1170.0 |

`log` の既定の書き先は `pino` の既定（Node では標準出力、ブラウザーでは渡した `write`）で、`console.log` を直に使わない。`pino` の鍵のパスの伏せ字（`redact`）の設定は使わず、鍵の名前と値の形の伏せ字は自前の `redact` だけが持つ（同じ規則を 2 か所に置かない）。

### 関数の仕様（この課題で足すもの）

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `createDb` | `src/db.ts` | 新設 | `(client: DynamoDBDocumentClient, names: TableNames) => Db` | detail.md の `Db` のポートと、この課題が足す `scan` を DynamoDB の文書のクライアントで満たす |
| `updateIfVersion` | `src/conditional-write.ts` | 新設（detail.md のとおり。`remove` を足す） | `(spec: { table: TableName; key: RowKey; version: number; set: Record<string, unknown>; remove?: readonly string[]; extra?: Condition; onConflict: ConflictRule }) => TransactItem` | detail.md のとおり。`remove` が空でなければ、更新の式は `SET <set の列>, version = version + 1` に `REMOVE <remove の列>` を続けた 1 つの式で、同じ条件の下で一緒に効くか一緒に外れる。`remove` は `set` の鍵と重ならず、`pk`・`sk`・`version`・`schema_version` を含まない。書き手は `rowUpdateOf` の戻り値を渡す（[表の移し](#表の移し) の書き手の決まり） |
| `updateIfSchemaVersion` | `src/conditional-write.ts` | 新設 | [表の移し](#表の移し) のとおり | 行の形の版を条件にした書き換えを組む（`version` を持たない行にも使う） |
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
| `RetryPolicy` | contracts `data.ts` | 判別の鍵 `kind` を先頭に。`aws`: `retry_mode`・`max_attempts`・`request_timeout_ms`。`http`: `limit`・`timeout_ms`・`total_timeout_ms`・`backoff_limit_ms`・`max_retry_after_ms`。`jwks`: `response_timeout_ms`。`transaction`: `retries`・`min_ms`・`max_ms` |
| `OutboundRequest` | `outbound.ts` | `method`・`url`・`headers`・`body`・`idempotent`・`peer`（ログの相手の種類 `github`・`idp`・`push`・`slack`・`api`） |
| `OutboundResult` | `outbound.ts` | `status`・`headers`・`body`・`class` |
| `TransactItem` | `conditional-write.ts` | `table`・`op`（`put`・`update`・`delete`・`check`）・`key`・`item?`・`update?`・`condition`・`onConflict` |
| `WriteOutcome` | `conditional-write.ts` | `{ ok: true }` か `{ ok: false; failed: { index; onConflict }[] }` |
| `Db` | `db.ts` | `get(table, key, consistent)`・`query(table, keyCond, opts)`・`queryIndex(table, index, keyCond, opts)`・`scan(table, opts)`（足す。[表の移し](#表の移し)）・`transactWrite(items)`・`update(table, key, update, condition)` |
| `Principal` | `auth/authenticate.ts` | 判別の鍵 `kind` を先頭に。`{kind: "human", userId, cognitoSub, sessionId, bindingEpoch}`（`sessionId` は署名を検証した token の空でない `origin_jti`）・`{kind: "newcomer", login: CognitoLogin}`（`sessions.create` だけに渡る）・`{kind: "delegation", userId, delegationId, scope: {projectIds, operations}, clientName}`・`{kind: "runner", laneId, projectId, generation}`・`{kind: "machine", teamId, machineId}`・`{kind: "github"}`・`{kind: "db_prep", projectId, prepId}`・`{kind: "patrol"}` |
| `InboundRequest` | `auth/authenticate.ts` | `endpoint`（受け口。受けた HTTP の経路の頭で決まる）・`operation`（`OperationName`。`dispatch` が受けた HTTP の経路を形の正本の操作の表で引いた操作の名前で、表に無い経路は `authenticate` を呼ぶ前に 404。要求の本文や頭書きから採らない）・`path`（受けた経路。ランナーと DB の用意の引き換えと報告の経路の見分けに使う）・`headers`・`rawBody`（受けたままのバイト列。`github` の HMAC に使う） |
| `AuthResult` | `auth/authenticate.ts` | `{ ok: true; principal: Principal; sessionRevokedAt: string \| null }`・`{ ok: false; reason: "unauthorized" \| "unavailable" }`。`principal` は `Principal` のどれか（まだ結んでいない人の `{kind: "newcomer", login: CognitoLogin}` を含み、これを返すのは `operation` が `sessions.create` のときだけ）。`sessionRevokedAt` は、`operation` が `sessions.delete` で要求のセッションの取り消しの行があったときだけその `revoked_at`、ほかは `null`（`sessions.delete` 以外の操作では取り消しの行があれば `unauthorized`） |
| `ScopeReader` | `authorize.ts` | `seatsOf`・`projectsOfTeams`・`projectOfTarget`・`laneOf`・`transferTargetOf`・`isHumanOnlyItem` |
| `ItemAuthz` | `authorize.ts` | `{decision: "allow", projectId, role}`・`{decision: "deny", status: 404 \| 403, reason}` |
| `AuditEntry` | `audit.ts` | `auditId`・`requestId`・`at`・`actor`・`channel`・`operation`・`targetIds`・`projectId`・`result`・`itemIndex`。`actor` は主体の種類と当たる ID だけを持つ記録の主体で、`Principal` から作る。`newcomer` は `{kind: "newcomer"}`（ID も `CognitoLogin` の値も持たない）にし、`sessions.create` の初回で利用者を作った要素と要約は `{kind: "human", userId: <作った利用者の ID>}` に入れ替える（[detail.md の `auditItem`](../docs/design/detail.md#関数の仕様)） |
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
| `updateIfVersion`（`remove`） | `remove` の列が `REMOVE` 句に並び、`SET` と同じ 1 つの更新の式に入る | `remove` が空か無い（`REMOVE` 句を持たない。detail.md の形と同じ） | `remove` が `set` の鍵か `pk`・`sk`・`version`・`schema_version` を含むと投げる |

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
| 7 | `rows` | `{name, skPattern, codec}` の配列。`skPattern` は並びの鍵で行の種類を決める正規表現（区切りの鍵だけの表は `null`）で、上から当てて最初に当たったものを使う |

### 決めた書き方

| 決まり | 中身 |
| --- | --- |
| 列の名前 | 英小文字と `_`。ID の列は `<種類>_id`、日時は `<出来事>_at`、真偽は形容の語（`is_` を付けない） |
| 状態の識別子 | 全体の設計の日本語の状態の名前と次の対応で持つ。スプリント: `running`（動いている）・`finished`（終わった）・`stopped`（止まった）・`canceled`（取り消した）。承認の依頼と問い: `waiting`・`answered`・`canceled`。答えの送達: `pending`（未渡し）・`delivering`（渡し中）・`delivered`（届いた）・`failed`（失敗）。区間の結果: `done`（完了）・`needs_decision`（判断が要る）・`failed`（できなかった）。手元のマシン: `pending`（登録待ち）・`online`・`offline`。席の役割: `owner`・`member`。IdP: `google`・`github`。通知先の種類: `web_push`・`slack`。量の種類: `compute`・`inference`・`byok_inference`・`machine_time`。知らせの種類: `approval`・`question`・`sprint_finished`・`sprint_stopped`・`cap_reached` |
| TTL の列 | `expire_at`（UNIX の秒の整数。DynamoDB の TTL の属性）。持つのは冪等の鍵（作成から 24 時間）・渡した GitHub の token の記録（token の期限）・操作の記録（`AUDIT_RETENTION_DAYS` 日。設定のファイルの値）・ログインをつなぐ流れ（`open` と `verified` は作成から `LOGIN_LINK_TTL_MS`、`used` は確定から 24 時間）・セッションの取り消し（`revoked_at` から `SESSION_REVOKED_KEEP_MS`）。値はどの書き手も、期限の UNIX のミリ秒を `expireAtSeconds(ms)`（`packages/contracts` の `rows/common.ts`。`Math.floor(ms / 1000)`）で秒の整数にして書く（DynamoDB の TTL は秒で読み、ミリ秒の値を遠い先の時刻と見て消さない）。行の形の `expire_at` は 10 桁の秒の整数だけを通す。TTL を有効にする表は `users`・`projects`・`idempotency`・`audit` の 4 つで、`TABLES` の `users` の `ttlAttribute` を `expire_at` にする（ログインをつなぐ流れとセッションの取り消しの行が `db-users` にあるため。無効のままでは属性を書いても `code_verifier` とセッションの識別子が期限の後も残る） |
| 冪等の鍵の表の `sk` | 持たない（区切りの鍵だけの表）。共通の列の `sk` の例外として表の仕様に書く |
| 答えの ID | 答えの要素の `idempotency_key`（UUID）をそのまま答えの ID にする。答えの ID の頭は ID の頭の集まりに無く、全体の設計が「答えの ID を冪等の鍵として」と書くため、頭を足さない |
| 区間の ID | `<レーンの ID>#SEG#<連番>`。連番はレーンの中で 1 から上げる。費用の記録の冪等の鍵と `COST#` の `<ID>` に使う |
| 費用の記録の鍵の時刻 | 区間の終わりの事象の時刻（ランナーが付ける）。同じ区間の送り直しで同じ `sk` になり、`putIfAbsent` が 2 回目を足さない |
| 渡した GitHub の token の記録の連番 | 記録を足したときのプロジェクトの行の `gh_token_generation` の値 |
| 招待の置き場 | `db-teams` の `TEAM#<チーム>` / `INVITE#<招待>`（チームの集約の中の行。全体の設計の表と鍵の表の `db-teams` の並びの鍵に足す） |

### 行ごとの列

| 行（表 / 並びの鍵） | 列（型、空を許すものに `?`） | 上書きか追記か |
| --- | --- | --- |
| 利用者（`db-users` / `USER`） | `user_id`・`login_count`（結んだログインの数、1 以上。結ぶ・外すトランザクションがこの行の版を条件に足し引きし、外すときは 2 以上を条件にする）・`display_name`（0〜32 字）・`language?`（`languageTag`）・`time_zone?`（`timeZone`）・`created_at` | 上書き |
| ログインの組（`db-users` / `LOGIN#<IdP>#<主体>`） | `user_id`・`idp`・`subject`・`cognito_sub`（外すときに Cognito の主体の対応の行の鍵を組む）・`linked_at` | 作ると消すだけ（`version` を持たない） |
| IdP の主体の一意の行（全体の設計が列を決めた行で、19 の行に数えない） | 全体の設計の `user_id` に、鍵を組む `idp`・`subject` と、Cognito の主体の対応の行の鍵を組む `cognito_sub` を足す | 作ると消すだけ |
| Cognito の主体の対応の行（`db-users` / `COGNITO`。認証が Cognito の `sub` から利用者を引くために足した行で、19 の行に数えない） | `cognito_sub`・`cognito_username`（結ぶのに使った token の `username`。外した後の `AdminUserGlobalSignOut` に渡す）・`idp`・`subject`・`state`（`bound`・`signing_out`・`unlinked`）・`binding_epoch`（外した回数。`sessions.create` の冪等の鍵に入れる）・`user_id?`・`bound_auth_time?`（`bound` の間。結ぶのに使った token の `auth_time`。これより前にサインインした token を断つ）・`revoked_before?`（`unlinked` の間。失効を済ませた時刻。これ以前にサインインした token では結び直せない）・`signout_lease_id?`・`signout_lease_until?`（`signing_out` の間の、外した世代の `AdminUserGlobalSignOut` の呼び出しの借り）・`signout_unsettled_until?`（応答を失った呼び出しの結果の分からない期間の終わり。この後に始めた呼び出しの成功だけで `unlinked` へ進める） | 上書き（外しても消さず、失効の境を残す。[Cognito の主体の対応の行](../docs/design/data.md#cognito-の主体の対応の行)） |
| ログインをつなぐ流れ（`db-users` / `LINK#<流れの ID>`。`logins.create` を今の利用者とセッションに結ぶために足した行で、19 の行に数えない） | `link_id`（UUID。認可の要求の `state`）・`state`（`open`・`verified`・`used`）・`created_at`・`user_id`・`session_sub`（流れを始めた要求の Cognito の `sub`）・`session_id`（その token の `origin_jti`）・`session_epoch`（開始元の対応の行の `binding_epoch`）・`idp`・`code_verifier?`（PKCE。サーバーだけが持つ。`open` の間だけ）・`exchange_idempotency_key?`・`candidate_sub?`・`candidate_username?`・`candidate_idp?`・`candidate_subject?`・`candidate_auth_time?`・`candidate_epoch?`・`candidate_version?`・`account_label?`（`verified` の間）・`used_idempotency_key?`・`linked_idp?`・`linked_subject?`（`used` の間）・`expires_at`・`expire_at`（TTL） | 作って 2 回だけ書き換える（`login_links.create` が `open` で作り、`logins.create` の交換の要素が `verified` へ、確定の要素がログインを結ぶのと同じトランザクションで `used` へ書き換える。`version` を持たず、`state` を条件にする） |
| 失効の予定（`db-users` / 区切り `SIGNOUT_DUE`・並び `COGNITO#<Cognito の sub>#<binding_epoch>`。外したログインの `AdminUserGlobalSignOut` の「行う予定」で、19 の行に数えない） | `cognito_sub`・`binding_epoch`・`next_attempt_at`・`stuck?`・`stuck_reason?` | 上書き（`version` を持ち、再試行の時刻・`stuck`・消すをどれも読んだ `version` を条件に書く。済んだら消す。[データの文書の「行う予定」の行](../docs/design/data.md#cognito-の主体の対応の行)） |
| セッションの取り消し（`db-users` / 区切り `COGNITO#<Cognito の sub>`・並び `REVOKED#<origin_jti>`。サインアウトしたセッションを API の側で断つために足した行で、19 の行に数えない） | `cognito_sub`・`session_id`（取り消したセッションの `origin_jti`）・`revoked_at`・`expire_at`（TTL） | 作るだけ（`sessions.delete` が無いときだけ書き、TTL で消える。`version` を持たない。[データの文書のセッションの取り消しの行](../docs/design/data.md#セッションの取り消しの行)） |
| 委任（`db-users` / `DELEGATION#<委任>`） | `delegation_id`・`user_id`・`client_name`（1〜64 字）・`scope_project_ids`（`prj` の ID の配列、1 以上）・`scope_kind`（`read`・`run`・`manage`）・`secret_sha256`（64 桁）・`expires_at`・`created_at`・`last_used_at?`・`revoked_at?` | 上書き（状態は `expires_at`・`revoked_at` から導き、列に持たない） |
| チーム（`db-teams` / `TEAM`） | `team_id`・`name`（1〜100 字）・`plan`（料金プランの行の名前）・`currency`（`currencyCode`）・`monthly_cap?`（`money`）・`default_place`（`hosted`・`machine`）・`default_inference`（`managed`・`byok`）・`created_at` | 上書き |
| 席（`db-teams` / `SEAT#<利用者>`） | `team_id`・`user_id`・`role`・`added_at` | 上書き |
| 招待（`db-teams` / `INVITE#<招待>`） | `invitation_id`・`team_id`・`role`・`created_by`・`created_at`・`expires_at`・`accepted_by?`・`accepted_at?`・`withdrawn_at?` | 上書き（状態は `accepted_at`・`withdrawn_at`・`expires_at` から導き、列に持たない。期限の値と招く相手の指定の仕方は #4 が決め、列を足す） |
| 手元のマシン（`db-teams` / `MACHINE#<マシン>`） | `machine_id`・`team_id`・`name`（1〜64 字）・`token_sha256`・`token_expires_at`・`last_heartbeat_at?`・`lane_capacity?`（1〜16）・`created_at`・`revoked_at?` | 上書き（状態は導く。`last_heartbeat_at` が無ければ `pending`、600 秒以内なら `online`、それより前なら `offline`。見回りが `offline` で行う止め方は #7） |
| 月の使った量（`db-teams` / `USAGE#<UTC の年月>`） | `team_id`・`month`（`YYYY-MM`）・`used_amount_minor`（最小単位の整数）・`used_currency`（`currencyCode`）。金額の地図の 1 列にしないのは、DynamoDB の 1 つの更新の式が親の地図の無い入れ子の道（`used.amount_minor`）へ書けず、行の無いときの作成と加算を 1 つの式にできないためで、2 列はどちらも必ず持たせて I15 を守る | 上書き（`usageAddItem` が加算） |
| リポジトリ（`db-projects` / `REPO#<リポジトリ>`） | `repo_id`・`project_id`・`github_repo`（`githubRepo`）・`installation_id`（GitHub の整数）・`primary`（真偽）・`added_at` | 上書き |
| 渡した GitHub の token の記録（`db-projects` / `GHTOKEN#<期限>#<レーン>#<連番>`） | `project_id`・`lane_id`・`generation`・`expires_at`・`expire_at`（TTL）。token の値と識別は #33 の答えで足す | 追記だけ |
| スプリント（`db-sprints` / `SPRINT#<スプリント>`） | `sprint_id`・`project_id`・`title`（1〜200 字）・`issues`（`githubIssueRef` の配列、1〜20）・`place`・`inference`・`state`・`started_by`（利用者の ID。委任なら委任した人）・`started_at`・`ended_at?`・`end_reason?`（理由のコード） | 上書き |
| 区間（`db-sprints` / `…#LANE#<レーン>#SEG#<連番>`） | `project_id`・`sprint_id`・`lane_id`・`seq`・`started_at`・`ended_at?`・`result?`・`category?`（区分の文字列）・`failure_reason?`（`result_line_missing`・`result_value_unknown`・`segment_crashed`・`segment_timeout`） | 上書き（閉じるときに結果を書く） |
| 進捗の事象（`db-events` / `SEQ#<連番>`） | `project_id`・`lane_id`・`seq`・`generation`・`kind`（形の正本の事象の種類。値の集合は #6）・`occurred_at`・`body`（種類ごとの形。`redact` を通す） | 追記だけ |
| 問い（`db-decisions` / `QUESTION#<問い>`） | `question_id`・`project_id`・`sprint_id`・`lane_id`・`category`・`human_only`（真偽）・`state`・`body`・`options?`（`{key, label, description}` の配列）・`recommended?`（選択肢の鍵）・`ndf_gate_id?`・`machine_id?`（どちらも契約の `fields` の答えを待つ。#6）・`answer_id?`・`delivery?`・`waiting_since?` | 上書き |
| 答え（`db-decisions` / `APPROVAL#<依頼>#ANSWER#<答え>`・`QUESTION#<問い>#ANSWER#<答え>`） | `answer_id`・`project_id`・`parent_id`（依頼か問いの ID）・`word`（承認は `ndfAnswerWord`、問いは選択肢の鍵）・`reason?`（0〜2,000 字）・`notes?`（差し戻しの指摘、0〜10,000 字）・`drop_issues?`（整数の配列）・`material_digest?`・`head_sha?`・`answered_by`（`{kind, user_id, delegation_id?}`）・`answered_at`・`claimed_generation?`・`ndf_event_seqs?`（全体の設計のとおり） | 追記だけ（`claimed_generation` と `ndf_event_seqs` は空のときに 1 回だけ書く） |
| 知らせ（`db-notices` / `NOTICE#<時刻>#<ID>`） | `notice_id`・`user_id`・`project_id`・`kind`・`target_id`（依頼・問い・スプリントの ID）・`occurred_at`・`read_at?`・`deliveries`（通知先の ID から `{state: pending・sent・failed・skipped, attempts}` への地図） | 上書き（既読は画面、送達は送り手。どちらも `updateIfVersion` で書き、外れたら読み直して 1 回やり直す） |
| 通知先（`db-notices` / `DEST#<通知先>`） | `destination_id`・`user_id`・`kind`・`team_id?`（`slack` だけ）・`secret_name`（秘密の器の名前）・`fingerprint`（宛先の値の SHA-256 の 64 桁）・`last4`・`state`（`active`・`invalid`・`failed`）・`created_at` | 上書き |
| 費用の記録（`db-usage` / `COST#<時刻>#<区間の ID>`） | `project_id`・`sprint_id`・`lane_id`・`segment_id`・`kind`・`quantity`（`{unit: seconds・tokens_in・tokens_out・tokens_cache, value}` の配列）・`amount`（`money`。量だけのものは 0）・`occurred_at` | 追記だけ |
| 冪等の鍵（`db-idempotency`） | `principal_key`・`operation`・`key`・`fingerprint`・`state`（`leased`・`settled`）・`owner_request_id`・`lease_until`・`result?`・`expire_at` | 借りから済みへ 1 回だけ書き換える（`version` を持たない） |

全体の設計の版の列の一覧（[共通の列](../docs/design/data.md#共通の列)）に載らない行のうち、招待と区間は上書きするため `version` を持ち、ログインの組は作ると消すだけのため持たない。持ち込みのキー（`model_keys.*`）と GitHub App の導入（`github_installations.*`）の行は 19 の行に入っていない。置き場と列は、それぞれ #6 と #5 の詳細設計が決める。

### 索引

| 索引 | 表 | 区切り / 並び | 写す列 | 載る行 | 答える問い |
| --- | --- | --- | --- | --- | --- |
| `user-seats` | `db-teams` | `user_id` / `team_id` | `role` | `user_id` の列を持つ行（`db-teams` で `user_id` を持つのは席の行だけにする。ほかの行の利用者の ID は `created_by` などの別の名前） | 主体が席を持つチームの候補（`ScopeReader.seatsOf`） |
| `team-projects` | `db-projects` | `current_team_id` / `project_id` | `name`・`current_assign_id` | `current_team_id` のあるプロジェクトの行だけ（閉じたら列を消す。DynamoDB は索引の鍵に空の文字列を許さないため、全体の設計の「空」は列が無いことで表す） | チームに今割り当てたプロジェクトの候補（`projectsOfTeams`） |
| `waiting` | `db-decisions` | `project_id` / `waiting_since` | `sprint_id`・`lane_id`・`gate?`・`category?`（依頼か問いかは表の `sk` の頭で分かる） | `waiting_since` のある依頼と問いだけ（答えるか取り消すと列を消す。答えの行は `waiting_since` を持たない） | 見えるプロジェクトの待っているもの。古い順（`approvals.list`・`questions.list`・`waiting_counts.get`） |

どの索引も結果整合で、候補を出すだけに使う。認可と確定の照らしは表の本体を強い整合で読む（決定 14）。索引の鍵は元の行の列そのもので、索引のための写しの列を持たない（Value 10）。

索引を置く根拠（読む速さのための写しを足す根拠。Value 10）:

| 索引 | 無いと何が起きるか |
| --- | --- |
| `user-seats` | 主体の席は `TEAM#<チーム>` の区切りの下にあり、利用者から引くには `db-teams` の全体を走査するしかない。要求ごとに `visibleProjectIds` が引くため、走査では要求の数とチームの数に比例して読む量が増える |
| `team-projects` | プロジェクトは `PROJECT#<プロジェクト>` の区切りで、チームから引くには `db-projects` の全体の走査になる。一覧（`projects.list`）と見える集まりが要求ごとに引く |
| `waiting` | 待っている依頼と問いは区切り（プロジェクト）の中の全行に混ざる。ホーム（いま）と待ちの数が要求ごとに引くため、区切りの全行を読んで絞ると、答えた行の数だけ読む量が増え続ける |

月の使った量の行（`USAGE#<UTC の年月>`）は費用の記録の集計の写しで、全体の設計が決めた行である（使える量の判定が加算の後の値を強い整合で 1 行で読むため。費用の記録を毎回足し合わせない）。

鍵の列（`pk`・`sk`）は行の列から組む写しで、行の種類ごとの `RowCodec` の `keyOf` だけが組む。書き手が鍵を手で組まないため、鍵と列が食い違わない（Value 13）。

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| 行の形（受け入れ条件 8） | 行ごとの作り物の行が通る | 空を許す列が欠けた行 | `schema_version` の無い行・上書きの行で `version` の無い行・時刻帯の無い日時・通貨の無い金額が落ちる |
| `TABLES` | 10 の表・3 つの索引が上の表と一致 | — | 同じ索引の名前の重なりで投げる |
| `ServiceTable` | 合成の出力に PITR・`Retain`・TTL・索引の鍵がある | `sortKey` の無い表（`db-idempotency`） | — |
| `ApiRoutes` | 渡した受け口の経路の数が `routes.json` と同じ | 受け口 `runner` だけ | 経路の重なりで合成が投げる |

## 表の移し

満たす決定: 決定 9、受け入れ条件 9

行の種類ごとの `RowCodec` は、読み手が受ける版（`latest` と `previous` の 2 つ）と、書き手が出す版（`writeVersion`）を分けて持つ。読み手はどちらの版も `latest` の形へそろえて返し、書き手は `writeVersion` の形で書く。こうすると、次の版を読めるが前の版だけを書く 1 段目と、2 段目の後に書き手だけを戻した状態が、同じ `RowCodec` の値（`writeVersion` が前の版）で表せる。

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `rowCodec` | `packages/contracts/src/row-codec.ts` | 新設 | `<L, P>(spec: { latest: { version: number; schema: ZodType<L> }; previous?: { version: number; schema: ZodType<P>; upgrade: (row: P) => L; downgrade: (row: L) => P }; writeVersion: number; downgradable?: boolean; keyOf: (row: L) => { pk: string; sk: string \| null } }) => RowCodec<L>` | 行の種類の、読み手が受ける 2 つの版と書き手が出す版をまとめる |
| `readRow` | 同上 | 新設 | `<L>(codec: RowCodec<L>, raw: unknown) => ReadRowResult<L>` | `latest` の版はそのまま、`previous` の版は `upgrade` で `latest` の形へそろえて返し、ほかは拒む |
| `writeRow` | 同上 | 新設 | `<L>(codec: RowCodec<L>, row: L) => Record<string, unknown>` | `writeVersion` の形の行（`schema_version` を含む）を返す。`writeVersion` が `previous.version` なら `downgrade` を通す。`downgradable` なら `writeVersion` によらず、下げた行を `upgrade` で上げ直して元の行（`latest` の形）に戻らなければ投げる（書き手を前の版へ戻せる間に、前の版で表せない値を書かない） |
| `rowUpdateOf` | 同上 | 新設 | `<L>(codec: RowCodec<L>, raw: Record<string, unknown>, row: L) => { set: Record<string, unknown>; remove: string[] }` | 読んだ行（`raw`）を `row` へ書き換える更新の `set` と `remove` を作る。`set` は `writeRow(codec, row)` の戻り値から `pk`・`sk`・`version` を外したもの。`remove` は `raw` の列のうち `writeRow` の戻り値に無く、`pk`・`sk`・`version` でもない列の名前。`downgradable` の間に `raw` が `previous` の版なら、`raw` を `previous.schema` に通した行が `downgrade(upgrade(その行))` で元に戻らなければ（`previous.schema` を通らなければ）投げる（移しと通常の書き換えのどちらでも、`upgrade` で失う前の版の値を書き換えで消さない）。`writeRow` の戻り値の `pk`・`sk`（`keyOf` が書き換え後の列から組む鍵）が `raw` の `pk`・`sk` と違えば投げる。例外には違った列の名前（`pk`・`sk`）だけを載せ、鍵の値を載せない（ログインの組の鍵は IdP の主体の識別子を、ほかの行の鍵は利用者の ID を含み、処理されない例外はログに残るため）（鍵の列を書き換えると、読んだ行の鍵の行へ別の鍵の中身を書き、主キーで読む行と索引で引く行が食い違うため。鍵を変えるのは古い行を消して新しい行を作る書き込みで行う） |
| `migrateTable` | `apps/api/src/entries/migrate.ts` | 新設 | `(input: { purpose: TablePurpose; cursor: RowKey \| null }, deps: MigrateDeps) => Promise<{ done: boolean; failed: boolean; cursor: RowKey \| null; rewritten: number; skipped: number; refused: number }>` | `previous` の版の行を `latest` の版へ書き換える |
| `createMigrateHandler` | 同上 | 新設 | `(deps: MigrateDeps) => (event: MigrateEvent, context: Context) => Promise<void>` | `migrateTable` を呼び、終わっていなければ続きの位置と、ここまでの `refused` の合計を持って自分を非同期で起こし直す。`MigrateEvent` は `{ purpose: TablePurpose; cursor: RowKey \| null; refused: number; failures: number }`（運用者が起こすときは `cursor: null`・`refused: 0`・`failures: 0`）。`migrateTable` が一時の失敗（`unavailable`）で止まったときも投げずに、返した続きの位置（失敗した行の前まで）と `refused` の合計を持ち、`failures` を 1 足して自分を起こし直す。起こし直す前に `MIGRATE_RETRY_BASE_MS` の 2 の `failures` 乗（残り時間の内）を待つ。1 ページでも進めば `failures` を 0 に戻す。`failures` が `MIGRATE_MAX_FAILURES` に達したら起こし直さず、`migrate_stalled`（`purpose` と `failures` だけ。続きの位置は鍵の値を含むため載せない）を `error` の水準で出す。起こし直しの非同期の起動そのものに失敗したときも `migrate_stalled` を出す。呼ぶごとに `migrate_page`（`purpose`・`rewritten`・`skipped`・`refused`）を、終わったら `migrate_done`（`purpose` と `refused` の合計）をログへ出す。`refused` の合計が 1 以上なら `migrate_done` を `error` の水準で出す（運用者はこれで、移せずに前の版のまま残った行があると気づく） |

- `rowCodec`
  - 事前条件: `previous` があれば `previous.version = latest.version - 1`。`writeVersion` は `latest.version` か `previous.version`。`downgradable: false` なら `writeVersion` は `latest.version`
  - `downgradable`: 書き手を前の版へ戻せる間（版を上げる子の手順の 1 から 4 の前まで）を表す。`previous` があれば既定は `true`、無ければ `false`。`false` にするのは手順の 4 の反映だけ
  - 事後条件: 事前条件を外れれば例外を投げる（モジュールの読み込みで落ちる）
- `readRow`
  - 事後条件: 戻り値は `{ ok: true; row: L; from: number }`（`from` は読んだ行の `schema_version`）か `{ ok: false; reason: "version_unsupported" \| "shape_invalid" }`。`latest.version` より新しい版と、`previous.version`（無ければ `latest.version`）より古い版は `version_unsupported`。`writeVersion` によらず同じ結果を返す
- `writeRow`
  - 事後条件: 戻り値は `writeVersion` の版の zod を通る。通らなければ例外を投げる（書き手の誤りで、テストが先に落とす）。`downgradable` なら、`writeVersion` が次の版でも、`upgrade(downgrade(行))` が元の行に戻らない行を書かずに投げる
  - 元の行に戻るかの比べは、列を中身まで比べる。DynamoDB の集合（文字列・数・バイナリの集合）を表す `Set` は要素まで、バイナリ（型付きの配列・`DataView` と `ArrayBuffer` 本体。DynamoDB SDK はどちらもバイナリとして書く）は中身のバイトまで比べる（`Object.entries` は `Set` の中身を並べず、中身の違う集合を等しいと見るため）
  - `downgrade` と `upgrade` には、渡す値の独立した写し（`structuredClone`）を渡す。`readRow` が前の版の行を上げるときも同じ（`z.looseObject` の下の `Set` などは読んだ行と同じ物を指すため、写さないと `upgrade` のその場の変更が、呼び出し元が `rowUpdateOf` へ渡す読んだ行まで変え、値の損失を見逃す）。変換が引数をその場で書き換えても、比べる元の行（`latest` の形）と書く前の版の行は変わらない。`SharedArrayBuffer`（それを裏に持つ型付きの配列・`DataView` を含む）を持つ値は `structuredClone` の後も元とバイトを共有し写しが独立しないため、写さずに `RowCodecError` を投げる（`readRow` は `shape_invalid` を返し、`writeRow` と `rowUpdateOf` は投げる。DynamoDB の SDK は共有バッファを返さず、表の行に現れない）
  - `RowCodecError` は固定の理由の符号 `code`（`codec_invalid`: `rowCodec` の引数の誤り・`shared_buffer`・`row_invalid`: `writeRow` の行が `latest` の形を通らない・`downgrade_invalid`: `downgrade` の結果が前の版の形を通らない・`previous_shape_invalid`: `rowUpdateOf` が読んだ前の版の行が前の版の形を通らない・`value_lost`: 版の変換で値が失われる・`key_mismatch`: 書き換え後の鍵が読んだ行の鍵と違う）を持つ。`message` は Zod の `issue.path`（`z.record` の検証に外れた鍵の値を含みうる）を載せるため、ログへは `message` でなく `code` を載せる
  - 書き手の決まり: 行を作る書き込み（`putIfAbsent`）は、行の列を `writeRow` の戻り値から作り、`schema_version` を必ず書く。書き換える書き込み（`updateIfVersion`・`updateIfSchemaVersion`）は、読んだ行と書き換えた後の形から `rowUpdateOf` で `set` と `remove` を作り、その 2 つを同じ書き込みに渡す（`set` は `schema_version` を含む）。これで、どの書き換えも `schema_version` を書き手の版にし、移しの条件（下）が同時の書き込みを見つけられる。また、2 段目の書き手が前の版の行を先に書き換えて `schema_version` を最新にしても、`latest` の版で消した列は同じ書き込みの `REMOVE` で消える。`migrateTable` は `schema_version` が最新の行を飛ばすため、書き手が消さなければ、消した列が索引（GSI）の鍵のときその行は移しの後も索引に残る。書き手を前の版へ戻した状態では、`rowUpdateOf` の `remove` が次の版だけの列を消す（行の zod は知らない列を落とすため読みでも捨てられるが、索引に残さないよう書き込みで消す）。消しても値を失わないよう、書き手を前の版へ戻せる間（版を上げる子の手順の 2 から 4 の前まで）は、次の版の行に前の版で表せる値（`upgrade(downgrade(行))` が元の行に戻る値）だけを書く。`writeRow` は `downgradable` の間、前の版で書くときも次の版で書くときも（2 段目）これを確かめ、戻らない行を書かずに投げる
- `migrateTable`
  - 事前条件: `deps` は `Db`・時計・ログ・残り時間の読み手・`TABLES`。`cursor` は前の呼び出しが返した値か `null`
  - 処理の手順:
    1. `db.scan(table, { limit: MIGRATE_PAGE_SIZE, startKey: cursor, consistent: true })` で 1 ページ読む
    2. ページの行を順に、行ごとに次を行う。行に取りかかる前に残り時間が `MIGRATE_RESERVE_MS` 以下なら、そこで止めて `{ done: false, cursor: <最後に処理を終えた行の鍵> }` を返す（このページでまだ 1 行も終えていなければ、受け取った `cursor` をそのまま返す）
       - `TableSpec.rows` の `skPattern` で行の種類を決める。どれにも当たらない行と、`schema_version` が `previous.version` でない行と、`writeVersion` が `latest.version` でない行の種類（1 段目か、書き手を戻した状態）の行は、書かずに処理を終えたものとする
       - `readRow` で `latest` の形にし、`rowUpdateOf(codec, 読んだ行, その形)` で `set` と `remove` を作る。`set` は `writeRow` が返す行全体から鍵（`pk`・`sk`）と `version` を外したもので、`updateIfSchemaVersion` の事前条件（`set` に `pk`・`sk`・`version` を含まない）を満たす。鍵は `key` に、読んだ `version` は条件に回し、`set` で書き換えない。`remove` は読んだ行にあって `writeRow` の戻り値に無い列（`latest` の版で消した列）。`updateIfSchemaVersion`（`key` は読んだ行の `pk`・`sk`、`set` と `remove` は `rowUpdateOf` の戻り値、`from` は `previous.version`、`version` は読んだ行の `version` か `null`）を `writeAtomically` で 1 件だけ確定する。条件が外れたら飛ばして `skipped` を 1 足す（同時に書き手が `latest` で書いたか、行が消えた）。`unavailable`（読みか書き込みの一時の失敗）は投げずに、その行を終えずに止め、`{ done: false, cursor: <最後に処理を終えた行の鍵>, failed: true }` を返す（このページでまだ 1 行も終えていなければ受け取った `cursor`。`refused` はその呼び出しで拒んだ数）。`createMigrateHandler` がその位置から起こし直す（`MaximumRetryAttempts` 0 の Lambda の外へ投げると、続きの位置ごと失われ、後ろの行が移されない）
       - `readRow` が `ok: false` を返した行と、`rowUpdateOf` が `RowCodecError` を投げた行（`downgradable` の間に、`upgrade` で値を失う前の版の行。鍵の不一致も含む）は、書かずに処理を終えたものとして続ける（例外を Lambda の外へ出さない。出すと `MaximumRetryAttempts` 0 のため起こし直しも知らせも無く、後ろの行が移されない）。`refused` を 1 足し、行の種類の名前と固定の理由の符号（`readRow` が返した `reason` の `shape_invalid`・`version_unsupported` か、`rowUpdateOf` が投げた `RowCodecError` の `code`。`previous_shape_invalid`・`value_lost`・`key_mismatch`・`shared_buffer` など）だけを `migrate_refused` として `error` の水準でログへ出す。例外の文（`RowCodecError` の `message`）はログに載せない（Zod の `issue.path` を含み、`deliveries` などの `z.record` で検証に外れた鍵の値がそのまま入るため）。鍵の値もログに載せない（IdP の主体や利用者の ID を含むため）。`skipped` には数えない（`skipped` は書き手と競った正常な飛ばし）。`RowCodecError` でない例外は投げる
       - 処理を終えた行の鍵を「最後に処理を終えた行」として覚える
    3. ページの行を終えたら、`lastKey` が `null` なら `{ done: true, cursor: null }` を返す。でなければ `cursor` を `lastKey` にして 1 へ戻る
  - 事後条件: 返した `cursor` より前（走査の順）の行は、どれも `previous` の版でないか、書き手が同時に書いた行か、拒んだ行（`refused` に数えた、前の版のまま残した行）である。戻り値の `refused` は、止まって返す（`done: false`）ときも走査を終えて返す（`done: true`）ときも、その呼び出しで拒んだ行の数（受け取った `cursor` の後から返す `cursor` までの分。前の呼び出しの分を含めない）で、呼び出しをまたぐ合計は `createMigrateHandler` が `MigrateEvent` の `refused` に足して持ち回る。返した `cursor` より後の行は 1 行も飛ばしていない。`cursor` を次の呼び出しへ渡すと、その鍵の次の行から読む（DynamoDB の `Scan` の `ExclusiveStartKey` は、返された `LastEvaluatedKey` でなく既にある行の鍵でもその次から読む。偽の `Db` も同じ順と同じ再開をする）
  - 副作用: 表の走査と、行ごとの条件つきの更新

`Db` に足すポートと、`version` を持たない行にも使える条件つきの更新（`packages/core`。[横断の部品の関数の仕様](#関数の仕様この課題で足すもの) にも並べる）:

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `Db.scan` | `packages/core/src/db.ts` | 新設（`Db` に足す） | `(table: TableName, opts: { limit: number; startKey: RowKey \| null; consistent: boolean }) => Promise<{ items: Row[]; lastKey: RowKey \| null }>` | 表を走査の順に 1 ページ読む。`createDb` は `ScanCommand` の `Limit`・`ExclusiveStartKey`・`ConsistentRead` へ渡す。使うのは表の移しだけで、API の要求の処理は使わない |
| `updateIfSchemaVersion` | `packages/core/src/conditional-write.ts` | 新設 | `(spec: { table: TableName; key: RowKey; from: number; set: Record<string, unknown>; remove: readonly string[]; version: number \| null; onConflict: ConflictRule }) => TransactItem` | 行の形の版が `from` のときだけ、行の列を `set` で書き換え、`remove` の列を消す書き込みを組む |

- `updateIfSchemaVersion`
  - 事前条件: `set` は `schema_version` を含み、その値は `from` より大きい。`set` と `remove` に `pk`・`sk`・`version` を含まない。`remove` は `set` の鍵と重ならず、`schema_version` を含まない
  - 事後条件: 更新の式は `SET <set の列>` に、`remove` が空でなければ `REMOVE <remove の列>` を続けた 1 つの式で、`SET` と `REMOVE` は同じ条件の下で一緒に効くか一緒に外れる。消した列が索引（GSI）の鍵なら、DynamoDB はその行を索引から外す（`readRow` が列を捨てるだけでは索引に残る）。戻り値は `attribute_exists(pk) AND schema_version = :from`（`version` が `null` でなければ `AND version = :version` も）を条件にした 1 件。`version` を上げない（中身の意味を変えない書き換えのため。同時に読んだ書き手の `updateIfVersion` を外さない）。行が消えていれば条件が外れ、行を作り直さない
  - `version` を持たない行（ログインの組・IdP の主体の一意の行・冪等の鍵・追記だけの行）は `version: null` で使う。追記だけの行は書き手が書き換えず、冪等の鍵の借りから済みへの書き換えは上の書き手の決まりで `schema_version` を書くため、`schema_version` の条件だけで同時の書き込みを見つけられる

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `MIGRATE_RESERVE_MS` | 定数 | `migrate.ts` | 10000 |
| `MIGRATE_PAGE_SIZE` | 定数 | `migrate.ts` | 100 |
| `MIGRATE_RETRY_BASE_MS` | 定数 | `migrate.ts` | 1000 |
| `MIGRATE_MAX_FAILURES` | 定数 | `migrate.ts` | 5 |
| `RowCodec<L>` | 型 | `row-codec.ts` | `{ latest; previous: … \| null; writeVersion; downgradable; keyOf }`（`rowCodec` の引数のまま。`downgradable` は既定を埋めた値。`writeRow` は `keyOf` の戻り値を `pk`・`sk` に入れる） |
| 版を上げる子の手順 | 手順 | この節 | 1. 次の版の zod を `latest` に、今の版を `previous` に移し、`upgrade` と `downgrade` を足す。`downgrade` は、前の版で表せる次の版の値を失わずに下げる（`upgrade(downgrade(行))` が元の行に戻る）。`upgrade` は、既にある前の版の行の値を失わずに上げる（`downgrade(upgrade(前の版の行))` が元の行に戻る）。`downgrade` が次の版の値から作り直せない前の版の列（固定値で補うしかない列）は、`downgradable` が `true` の間は次の版の形から消さず、消すのは手順の 4 の後の版上げまで延ばす（消すと、移しの `remove` でその値が消え、書き手を戻しても戻らない。前の版で書く通常の書き換えでも `downgrade` の補った値で上書きされる）。`rowUpdateOf` は `downgradable` の間、読んだ前の版の行でこれを確かめ、戻らない行の書き換えを投げる。`writeVersion` は今の版のまま（1 段目の反映。読み手は両方の版を読み、書き手は前の版だけを書く。1 段目のコードは次の版だけの列を使う機能を出さない）2. `writeVersion` を次の版へ上げ、`migrate` の Lambda（`createMigrateHandler`、権限はその表の読みと更新だけ。非同期の起動の設定は `MaximumEventAgeInSeconds` 60・`MaximumRetryAttempts` 0）を足す（2 段目の反映）。移しを起こすのは、この反映が終わってから API の Lambda の時間切れ（今の `app-stack.ts` で 10 秒）より長く待った後で、反映とは別の手順で 1 回起こす（前の版で書く古い書き手が走り終えてから読む）。移しが終わったら `migrate_done` の `refused` が 0 であることを確かめる。`migrate_done` の代わりに `migrate_stalled` が出たとき、または起こしてから `migrate_page` が Lambda の時間切れの 2 倍より長く途絶えて `migrate_done` も出ないとき（時間切れ・メモリの不足など、`createMigrateHandler` が起こし直せずに止まった）は、一時の失敗が収まった後に `cursor` `null`・`refused` 0・`failures` 0 で起こし直す（移した行は `previous` の版でないため飛ばされ、拒んだ行は数え直されるため、最初からでも結果と `refused` の合計は同じ）。1 以上なら、次の 2a から 2d で直し、`refused` が 0 になるまで手順の 4 へ進まない（`downgradable` を `false` にすると `rowUpdateOf` がその行を拒まず、移しが `upgrade` で失う値を消す）。2a. 元の値の保全: 何も書き換える前に、表のオンデマンドのバックアップを取る（拒んだ行は前の版のまま残っているが、2c の書き換えの前に元の値を戻せる形で持つ。バックアップは表と同じ権限の下に置き、利用者のデータとして扱う）。2b. 拒んだ行の特定: `migrate_refused` の行の種類ごとに、表を走査して `schema_version` が `previous.version` の行を `readRow` と `rowUpdateOf` に通し、拒まれた行とその理由の符号を運用者の手元で確かめる（鍵の値をログへ出さない）。2c. 理由の符号ごとの直し: (i) 形の不正（`shape_invalid`・`previous_shape_invalid`）は、行の値が前の版の決まりとして正しいのに `previous.schema` か `upgrade` が表せないなら、`previous.schema`・`upgrade`・`downgrade` を直す反映を出す。行の値そのものが誤り（前の版の書き手の誤りで形を外れた値）なら、その行の種類の書き手の決まりのとおり、前の版の形へ直す書き換えを `updateIfVersion`（`version` を持たない行の種類は、4b と同じく書き換える経路を止めたうえで `schema_version` の条件）で書く。(ii) 鍵の不一致（`key_mismatch`）は、`upgrade` が鍵に使う列を変えた誤りのため、`upgrade` を鍵の列を保つよう直す反映を出す（行は書き換えない）。(iii) 値の損失（`value_lost`）は、`upgrade` と `downgrade` を、前の版の行の値を失わないよう直す反映を出す。直せない列（`downgrade` が次の版の値から作り直せない列）は手順の 1 のとおり次の版の形に残す。(iv) `shared_buffer` は表の行に現れないため、出たら書き手の誤りとして調べ、移しを進めない。2d. 再走査での確認: 直しの反映の後に移しを `cursor` `null` から起こし直し（書き換え済みの行は `previous` の版でないため飛ばされる）、`migrate_done` の `refused` が 0 になったことを確かめる。0 でなければ 2b へ戻る。2 段目のコードも、1 段目と同じく前の版で表せない値（次の版だけの列を使う機能）を書かない（書き手を前の版へ戻した後に、`downgrade` が持たない値が `remove` で消えるか、その行の書き換えを `writeRow` が拒むため）。この保証は書き込みの前に `writeRow` が持つ: `downgradable` が `true`（既定）の間、`writeVersion` が次の版でも `upgrade(downgrade(行))` が元の行に戻らない行を書かずに投げる。2 段目のコードはこの例外を書き手の誤りとして扱い、テスト（`row-codec.test.ts` の 2 段目で次の版だけの値を拒む観点と、その行の種類を書く経路のテスト）で先に落とす3. 2 段目を戻すときは、[並行と排他](#並行と排他) の「表の移しと、前の版で書く書き手」の行のとおり、次の 2 回の反映で戻す。3a. 移しの止め: `migrate` の Lambda の予約の同時実行を 0 にする反映を出す（新しい起動も、自分を起こし直す非同期の起動も走らない。止められた非同期の起動は 60 秒で捨てられる）。続けて `migrate` の Lambda の時間切れと 60 秒の長いほうを待ち、その Lambda の同時実行の数が 0 であることを CloudWatch の `ConcurrentExecutions` で確かめる 3b. 書き手の戻し: `writeVersion` だけを前の版へ戻す反映を出す。読み手は両方を読むため、書き換えた行は次の版のまま読め、書き手が次に書き換えるときに `downgrade` で前の版になる。戻した状態では `migrateTable` は何も書き換えず、予約の同時実行は 0 のまま置く。3a と 3b を 1 回の反映にまとめない 4. 戻さないと決めたら、次の版だけの列を使う機能を、その行の種類の `downgradable` を `false` にして出す反映を出す（`false` の前は `writeRow` がその値を拒む）。この反映より後は `writeVersion` を前の版へ戻さない（戻すと、前の版で表せない値を持つ行の書き換えを `writeRow` が拒む）。戻す必要が出たら、次の順で戻す。4a. 次の版だけの値を新たに作る経路（その機能）を止める反映を、`downgradable: false` のまま出す（ここで `true` にすると、次の版だけの値を持つ既存の行は、利用者がほかの列だけを書き換えても `writeRow` が行全体を拒む）。続けて API の Lambda の時間切れより長く待ち、止める前のコードの実行が終わるのを待つ 4b. `downgradable: false` のまま、既存の行の次の版だけの値を前の版で表せる値へ書き換える（その行の種類の書き手の決まりのとおり `rowUpdateOf` で書く）。4a の後も利用者のほかの列の書き換えは続き、`rowUpdateOf` の `set` は行全体を含むため、読んだ後に確定した書き換えを上書きしないよう次の条件で書く。`version` を持つ行の種類は、`updateIfVersion` で読んだ `version` を条件に書き、条件が外れたらその行を読み直して書き換えをやり直す（`version` を 1 上げる。中身を変える書き換えのため）。`version` を持たない行の種類（ログインの組・IdP の主体の一意の行・冪等の鍵）は `schema_version` の条件では同じ版で確定した書き換えを見つけられないため、4a の反映でその行の種類を書き換える経路も止め、4a の待ちの後に 4b を行い、止めた経路は 4d の反映で戻す（[並行と排他](#並行と排他) の「表の移しと、前の版で書く書き手」の行と同じく、書き込みのときに見つける条件は採らない）4c. 表を走査し、その行の種類のどの行も前の版で表せる（`upgrade(downgrade(行))` が元の行に戻る）ことを確かめる。戻らない行が残れば 4b へ戻る 4d. `downgradable` を `true` に戻す反映を出し、その後に 3 を行う |

### 並行と排他

| 同時に走りうる処理 | 共有する資源 | 排他の取り方 | 冪等性と中断からの再開 |
| --- | --- | --- | --- |
| 表の移しと、同じ行を書く API の要求 | 行の `schema_version` と `version` | 移しは `updateIfSchemaVersion` で、`schema_version = <前の版>` と（行が持てば）読んだ `version` を条件に書く。書き手はどの書き込みでも `schema_version` を書く | 外れたら飛ばす（書き手が `latest` で書いたか行が消えた）。2 回走らせても書き換えは 1 回 |
| 表の移しと、前の版で書く書き手（2 段目の反映の直後に残る古い書き手と、2 段目を戻した後の書き手） | `version` を持たない行（ログインの組・IdP の主体の一意の行・冪等の鍵） | 同時に走らせない。移しの条件は `schema_version = <前の版>` だけのため、移しが前の版の行を読んだ後に書き手が前の版のままその行を書き換えると、条件が外れず古い中身で上書きする。そこで、移しを起こすのは前の版で書く書き手が走り終えた後（2 段目の反映から API の Lambda の時間切れより後）に限り、書き手を前の版へ戻すのは移しの起動と起こし直しを止め、走っている移しが終わった後（版を上げる子の手順の 3a）に限る。書き込みのときに見つける条件（行のすべての列の一致）は、冪等の鍵の行が持つ要素の結果が大きく条件の式の上限を超えうるため採らない | 止めた後に移しを再び許すのは、次に 2 段目を反映するとき（上の起こし方の待ちを守る）。3a の待ちの途中で止めた移しは、続きの位置を持った非同期の起動ごと捨てられるが、次に起こすときに最初から走らせても結果は同じ |
| 2 つの移しの起動 | 同じ表 | 取らない（条件つきの更新で同じ行を 2 回書き換えない） | 最後に処理を終えた行の鍵から再開できる。最初からやり直しても結果は同じ |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `rowCodec` | 版 1 と 2 の組で作れる | `previous` の無い行の種類 | `writeVersion` が 3・`previous.version` が `latest.version - 1` でない・`previous` があって `downgrade` が無い組・`downgradable: false` で `writeVersion` が前の版の組で投げる |
| `readRow`・`writeRow` | 1 段目（`latest` 2・`previous` 1・`writeVersion` 1）で、版 1 の行と版 2 の行をどちらも版 2 の形で読み、`writeRow` は版 1 の行を出す。2 段目（`writeVersion` 2）で、同じ 2 つの行を同じに読み、`writeRow` は版 2 の行を出す。書き手を戻した状態（1 段目と同じ値に戻した `RowCodec`）で、2 段目に書いた版 2 の行と版 1 の行をどちらも読み、`writeRow` は版 1 の行を出す。2 段目に書いた版 2 の行を戻した書き手が別の列だけ書き換えても（`rowUpdateOf` の `set` と `remove` を当てた後に読んでも）、版 2 で書いた値が残る。版 1 → `upgrade` → `downgrade` で元の行に戻る | `previous` の無い行の種類（版 1 だけを読む） | 版 0・版 3（`latest` より新しい）・形の違いを拒む。`writeRow` に版の形を外れた値を渡すと投げる。前の版で書くときと、2 段目（`downgradable` の間）に次の版で書くとき、下げると失われる値（次の版だけの列）を持つ行で投げ、`downgradable: false` では書ける。`downgrade` が引数の列をその場で消しても値を失う行を通さず、`upgrade` が引数の列をその場で改めても書く前の版の行は前の版の形のまま。行の `z.looseObject` の下の集合（`Set`）から下げで要素が落ちる行を、前の版で書くときも次の版で書くときも投げ、要素の同じ集合は書ける。`upgrade` が集合から要素をその場で消しても、`readRow` の後の読んだ行は変わらず、`rowUpdateOf` が値の損失を投げる。`ArrayBuffer` 本体のバイナリでバイト列が下げで変わる行を投げ、同じバイト列は書ける |
| 移しの止め（`infra/test/app-stack.test.ts`） | `migrate` の Lambda の非同期の起動の設定が `MaximumEventAgeInSeconds` 60・`MaximumRetryAttempts` 0。止める設定で合成すると予約の同時実行が 0 | — | — |
| `rowUpdateOf` | `set` が `writeRow` の戻り値から `pk`・`sk`・`version` を外したものと一致し、`schema_version` を含む。`latest` の版で消した列が `remove` に並ぶ | `version` を持たない行（`set` と `remove` に `version` が出ない）・消した列が無い（`remove` が空） | `set` と `remove` のどちらにも `pk`・`sk`・`version` が出ない（`raw` が持っていても）。書き換え後の鍵（席の `user_id` を変えたときなど）が `raw` の `pk`・`sk` と違うと投げる。`downgradable` の間、`upgrade` が前の版の列を捨て `downgrade` が固定値で補う組で、その列に値を持つ既にある前の版の行を、移し（`writeVersion` が次の版）でも通常の書き換え（前の版）でも投げ、`downgradable: false` では書ける。前の版の形を通らない `raw` で投げる |
| `migrateTable` | 前の版の行が `latest` の版になり、`version` は変わらない。ログインの組（`version` を持たない行）も書き換わる。`latest` の版で消した列が行から消え、その列を鍵にした索引の引き（偽の `Db` の `queryIndex`）でその行が出なくなる | 残り時間がちょうど予備の時間で、取りかかる前に止まる。ページの途中（100 行のうち 3 行目を終えたところ）で残り時間が尽き、返した `cursor` が 3 行目の鍵で、その `cursor` で再び呼ぶと 4 行目から読み、2 回の呼び出しの後に前の版の行が 1 行も残らない。ページの 1 行目の前で尽きると受け取った `cursor` を返す | 2 回走らせても行が同じ。`rowUpdateOf` が投げる行（`upgrade` で値を失う前の版の行）と `readRow` が読めない行は、書かずに `refused` に数えて `migrate_refused` のログ（鍵の値も例外の文も含まず、行の種類の名前と理由の符号だけ。`z.record` の鍵が検証に外れた行でも、その鍵の値がログに出ない）を出し、後ろの行は移す。拒んだ行の後で止まった呼び出しも、走査を終えた呼び出しも、その呼び出しで拒んだ数を `refused` に返す。`createMigrateHandler` は起こし直しに `refused` の合計を渡し、合計が 1 以上なら `migrate_done` を `error` で出す。書き込みが `unavailable` を返した行で止まった呼び出しは投げずに `failed: true` と失敗した行の前の `cursor` を返し、`createMigrateHandler` はその位置と `refused` の合計と 1 足した `failures` で起こし直し、`MIGRATE_MAX_FAILURES` 回続けば起こし直さずに `migrate_stalled` を出す（続きの位置の鍵の値を載せない）。読んだ後に書き手が `latest` で書いた行と、消えた行を飛ばし、消えた行を作り直さない。`writeVersion` が前の版の行の種類は書き換えない。2 段目の書き手が先に `updateIfVersion`（`rowUpdateOf` の `set` と `remove`）で前の版の行を最新にした場合、移しはその行を飛ばし、`latest` の版で消した列は書き手の書き込みで消えていて、その列を鍵にした索引の引きでその行が出ない |
| `updateIfSchemaVersion` | `schema_version` の条件と `attribute_exists(pk)` を持つ 1 件。`remove` の列が `REMOVE` 句に並ぶ | `version: null`・`version` あり・`remove` が空（`REMOVE` 句を持たない） | `remove` が `set` の鍵か `pk`・`sk`・`version`・`schema_version` を含むと投げる。`set` に `version` を含むと型で弾く |
| `Db.scan`（`createDb`） | 偽のクライアントへ `Limit`・`ExclusiveStartKey`・`ConsistentRead` が渡る | `startKey` が `null` | — |

## #1 へ渡す欠け

| 欠け | この課題が用意するもの | #1 がすること |
| --- | --- | --- |
| 操作の一覧と画面と MCP の対応・HTTP の経路の登録の照らし | `generated/mcp-tools.json`・`generated/routes.json`・`OPERATIONS` の `features` | 生成物を読んで対応の検査を作り、CI の必須のチェックへ載せる |
| 形の往復 | `operations-roundtrip.test.ts`（CI の `check` で走る） | 必須のチェックに `check` が載っていることを CI の定義のテストで照らす（今のまま） |
| 境界の検査 | `packages/core` の `exports` のエントリポイントの一覧と、置き場の外で直に使わないもの（[プラットフォームの表](../docs/design/platform.md#横断の部品の置き場の基準)） | `apps/` の実行の時のコードを探す検査を作る。画面が import してよいエントリポイントは `clock`・`ids`・`redact`・`log` |
| 漏れの検査 | `data/secret-shapes.json` | 同じデータを読む |
| 骨組みの経路 | `PUT /v1/users` は操作の表に無い | #4 が消すまで、経路の登録の照らしでこの 1 本を受け持つ子 #4 の印つきで外す |
