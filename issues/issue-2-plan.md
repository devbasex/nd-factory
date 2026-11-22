# #2: 形の正本と横断の部品の実装計画

## 関連リンク

- 要求仕様: [issue-2-requirements.md](./issue-2-requirements.md)。受け入れ条件は番号で指す
- 設計書: [issue-2-design.md](./issue-2-design.md)・詳細設計 [issue-2-design-detail.md](./issue-2-design-detail.md)・全体の詳細設計 [detail.md](../docs/design/detail.md)
- モード: `standard`（新しいパッケージと全操作の形の正本を足し、承認した設計 PR #51 がある）

## 修正対象

詳細設計の「地図」の表がそのまま修正対象である。ファイルごとの関数と仕様は、詳細設計の構成要素ごとのセクション（「形の正本: 値の形と ID」〜「表の移し」）にある。地図に無いファイルは足さない。足すときはタスクの変更内容に理由を書く。

## タスク分解

各タスクの進め方は、どれも失敗するテスト → 通す最小実装 → 整理である（`tdd-cycle`）。このリポジトリはテストを CI に寄せる（`.ndf/project.json` の `test.ci.only`）。手元では lint と型検査と `npm run generate` だけを打ち、テストの合否は単位の PR の CI の `check` で読む。

### Task 1: 値の形と ID と token と理由のコード

- **対象ファイル:** `packages/contracts/src/values.ts`・`ids.ts`・`tokens.ts`・`reasons.ts`・`test/values.test.ts`・`package.json`（`exports`）
- **変更内容:** 詳細設計の「形の正本: 値の形と ID」の関数を作る。値の形は JSON Schema で表せる zod の機能だけで書く（設計の決定 4・5）
- **満たす受け入れ条件:** 6

### Task 2: 操作の定義の枠

- **対象ファイル:** `packages/contracts/src/operation.ts`・`test/operation.test.ts`
- **変更内容:** 詳細設計の「形の正本: 操作の表」の `defineOperation`・`pendingShape`・結果の封筒と型（`ItemOf`・`ResultOf` ほか）を作る
- **満たす受け入れ条件:** 1（枠の側）・5（形の側）

### Task 3: データのファイルと NDF の契約

- **対象ファイル:** `packages/contracts/src/ndf.ts`・`data.ts`・`data/retry-policies.json`・`data/secret-shapes.json`・`data/ndf-contracts.json`・`data/plans.json`・`test/ndf.test.ts`・`test/data.test.ts`
- **変更内容:** 詳細設計の「形の正本: データと NDF の契約」を作る。再試行の方針は種類ごとの形（設計の決定 13）
- **満たす受け入れ条件:** 10

### Task 4: 操作の表の全行

- **対象ファイル:** `packages/contracts/src/operations/*.ts`・`test/operations.test.ts`
- **変更内容:** 全体の設計の操作の一覧の全行（利用者向けの 66 と自分向けの 9）を印つきで登録する。形の未定の操作は `pendingShape("#<番号>")`。DB の用意の 2 行は #13 の `db-prep-api.ts` が先にマージされていればつなぐ（設計の「同じファイルを触る別の変更」）
- **満たす受け入れ条件:** 1（印の側）

### Task 5: 生成と生成物と形の往復

- **対象ファイル:** `packages/contracts/scripts/artifacts.ts`・`scripts/generate.ts`・`generated/*`・`test/artifacts.test.ts`・`test/operations-roundtrip.test.ts`・`test/fixtures/operations.ts`・`test/generate.test.ts`・`package.json`（開発の依存 `ajv`・`zod-openapi`・`zod-schema-faker`・`@faker-js/faker`・`randexp`）・`package-lock.json`
- **変更内容:** 詳細設計の「形の正本: 生成」を作り、`npm run generate` で生成物を書いてコミットする
- **満たす受け入れ条件:** 1・7

### Task 6: 画面とテストが操作を呼ぶ口

- **対象ファイル:** `packages/contracts/src/client.ts`・`test/client.test.ts`
- **変更内容:** 詳細設計の「形の正本: 画面とテストが操作を呼ぶ口」（設計の決定 16）
- **満たす受け入れ条件:** 1（ダミーデータの読み手）

### Task 7: 横断の部品のパッケージと基本の部品

- **対象ファイル:** `packages/core/package.json`・`tsconfig.json`・`src/clock.ts`・`ids.ts`・`redact.ts`・`log.ts`・`retry.ts`・`outbound.ts`・`test/*`・`package-lock.json`
- **変更内容:** 詳細設計の「横断の部品」のファイルと exports のとおりにパッケージを作り、detail.md の関数を作る。`log` は `pino`、`outbound` は `ky` と AWS SDK の再試行の設定（設計の決定 17）
- **満たす受け入れ条件:** 2（一部）

### Task 8: 条件つきの書き込みと冪等の鍵と記録

- **対象ファイル:** `packages/core/src/db.ts`・`conditional-write.ts`・`idempotency.ts`・`audit.ts`・`test/*`・`test/fakes/*`
- **変更内容:** detail.md の関数。トランザクションの衝突だけ `p-retry` で繰り返す
- **満たす受け入れ条件:** 4

### Task 9: 認可と使える量の判定

- **対象ファイル:** `packages/core/src/authorize.ts`・`usage-limit.ts`・`test/*`
- **変更内容:** detail.md の関数と、設計の決定 14（索引は候補だけ、強い整合で読み直す）
- **満たす受け入れ条件:** 3

### Task 10: 認証と HTTP の振り分け

- **対象ファイル:** `packages/core/src/auth/*.ts`・`src/dispatch/*.ts`（MCP の 5 つの関数を除く）・`test/*`
- **変更内容:** detail.md の関数。公開鍵の控えは `aws-jwt-verify` の組み込み（設計の決定 17）
- **満たす受け入れ条件:** 4・5

### Task 11: API の起点と骨組みの移し

- **対象ファイル:** `apps/api/package.json`・`src/entries/api-fn.ts`・`src/users-handler.ts`・`src/user-store.ts`・`test/*`
- **変更内容:** 詳細設計の「API の起点と骨組みの移し」。`PUT /v1/users` の振る舞いは変えない（設計の決定 11）
- **満たす受け入れ条件:** 2・5

### Task 12: 表の行の形と表の仕様と行の版

- **対象ファイル:** `packages/contracts/src/rows/*.ts`・`tables.ts`・`row-codec.ts`・`test/rows.test.ts`・`test/row-codec.test.ts`
- **変更内容:** 詳細設計の「サービスの表」と「表の移し」の読み手と書き手
- **満たす受け入れ条件:** 8・9（読み手）

### Task 13: 表と経路の部品と表の移し

- **対象ファイル:** `infra/lib/service-table.ts`・`infra/lib/api-routes.ts`・`infra/test/service-table.test.ts`・`infra/test/api-routes.test.ts`・`apps/api/src/entries/migrate.ts`・`apps/api/test/migrate.test.ts`
- **変更内容:** 詳細設計の「サービスの表」の部品と「表の移し」の `migrateTable`。アプリのスタックには入れない（設計の決定 8・9）
- **満たす受け入れ条件:** 8・9

### Task 14: 行の書き手の直し

- **対象ファイル:** `packages/contracts/src/row-codec.ts`・`rows/*.ts`・`tables.ts`・`test/row-codec.test.ts`・`test/rows.test.ts`・`generated/*`・`packages/core/src/conditional-write.ts`・`idempotency.ts`・`usage-limit.ts`・`auth/authenticate.ts`・`dispatch/*.ts`・`test/*`
- **変更内容:** 行の書き手の設計（[issue-2-design-row-writers.md](./issue-2-design-row-writers.md)、PR #122）の「既にマージした実装への影響と直す単位」の U3b の行。`rowUpdateOf` を `rowReplaceOf` に、`updateIfVersion` を `replaceIfVersion` に置き換え、`repair`・`readRow` の保存値・旧形式の補い `repairIdentity`・`putIfAbsent` の `incarnation`・`deleteIfVersion`・`ConflictRule` の `rebuild` を足す。書き換える行に `version` を、記録の表を除くどの行にも `incarnation` を持たせ、委任の使った時刻の行を足す。冪等の鍵・月の使った量の加算・委任の使った時刻・`dispatch` の確定と手放しと組み直し（3 回まで）を新しい書き込みへ移す。`narrow`・`replaceIfUnchanged`・`countRowVersions` は U5b2 で作る。#118 の `api-fn`・`user-store` は変えない
- **満たす受け入れ条件:** 4・8・9（書き手）

## レビューの単位

設計の決定 12 の 5 つの単位のうち、見込みが 1,000 行を超える U1 と U5 を依存の向きで分けた。U1a は実装の後に Task 1〜3 で 1,374 行と分かり、Task 3 を U1a2 へ分け直した。表の実際の行数は各単位をスプリントブランチへマージした時に数え、レビューの修正を含むため、分け直しの時の 1,374 行と和が合わない。どの単位も単独で `npm run check` が通る。順は表の上からで、前の単位をスプリントブランチへマージしてから次の単位をスプリントブランチから切る。行数は `git diff --shortstat <スプリントブランチ>...HEAD -- . ':(exclude)package-lock.json' ':(exclude)packages/contracts/generated'` で数える。

| 単位 | 含むタスク | 満たす受け入れ条件 | 見込みの差分の行数 | 実際の行数 |
| --- | --- | --- | --- | --- |
| U1a 値の形と操作の枠 | Task 1・2 | 2:6 | 約 800 | 1,111 |
| U1a2 データと NDF の契約 | Task 3 | 2:10 | 約 400 | 474 |
| U1b 操作の表の全行 | Task 4 | 2:1（印の側） | 約 700 | |
| U1c 生成と呼ぶ口 | Task 5・6 | 2:1・2:7 | 約 900 | |
| U2 基本の部品 | Task 7 | 2:2（一部） | 約 900 | |
| U3 書き込みと判定 | Task 8・9 | 2:3・2:4 | 約 900 | |
| U4 認証と振り分け | Task 10・11 | 2:2・2:4・2:5 | 約 1,000 | |
| U5a 表の行の形 | Task 12 | 2:8・2:9（読み手） | 約 900 | |
| U5b1 表と経路の部品 | Task 13（`ServiceTable`・`ApiRoutes`） | 2:8・2:9（部品） | 約 300 | |
| U3b 行の書き手の直し | Task 14（#122 の承認の後） | 2:4・2:8・2:9（書き手） | 約 1,000 | |
| U5b2 表の移し | Task 13（`migrateTable`。#122 の承認の後、U3b の後） | 2:8・2:9（移し） | 約 400 | |

U5b は 2026-11-22 の利用者の決定で U5b1 と U5b2 に分けた。表の移しの `migrateTable` は行の版の書き手の決まりに左右され、その決まりを #109 で設計として決めて設計承認ゲートを通すまで作らない。表と経路の部品はその決まりに左右されないため、先に U5b1 で作る。

U3b は、2026-11-22 の設計承認ゲートで利用者が #109 の設計 PR #122 を承認したことを受けて足した。#122 は既にマージした U3・U4・U5a・#79・#110 の書き手の直しを U3b に、表の移しを U5b2 に割り当て、U5b2 のテストが U3b の `replaceIfVersion` と `rowReplaceOf` を使うため、U3b を U5b2 より先に作る。

受け入れ条件 11（詳細設計）は設計 PR #51 で満たした。

## リファクタリングの時機

| 時機 | 対象 | 理由 |
| --- | --- | --- |
| 実装の前（準備のリファクタリング） | しない | 触る既存のファイルは `generate.ts`（132 行）・`users-handler.ts`（91 行）・`user-store.ts`（58 行）だけで、ほかは新設である |
| 実装の中 | 各タスクで行う | `tdd-cycle` のリファクタリングのステップ |
| スプリントの終わり（cross-refactoring） | `packages/contracts/src/rows/*` と `operations/*` の行の形の重なり、`apps/api` の骨組みと `entries/api-fn.ts` の依存の組み立ての重なり | 複数の単位が同じ形の処理を書く |

## リスクと対処

| リスク | 対処 |
| --- | --- |
| `zod-schema-faker` が作り物の値の生成器の上書きを受けない | U1 で確かめ、受けなかった（`custom` は `z.custom` だけ、メールは内部の randexp）。生成の前に形の木を写してメール・アカウント ID・接頭辞の形を作り物の値の literal へ置き換える（詳細設計の `fakeExamples`）。`examples` の経路は残す |
| #13 の `db-prep-api.ts` と `packages/contracts/package.json` の `exports` が重なる | 後からマージする側が食い違いを解く |
| 単位が見込みの 1,000 行を超える | 実装の途中で単位を分け直す |

## 完了の定義

- [ ] 受け入れ条件 1〜10 をすべて満たし、条件ごとに検証手段（CI の `check`・`synth` のテスト名）と結果が対応している
- [ ] すべての単位の PR を `cross-review` で収束させ、スプリントブランチへマージした
- [ ] `apps/` の実行の時のコードに `new Date()`・`console.log`・`fetch`・`new DynamoDBClient` が残らないことを `grep` で確かめた（受け入れ条件 2）
