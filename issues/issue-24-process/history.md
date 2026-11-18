# 経緯: 全体の設計を MVV から書き直すことになった理由と、そのときの nd-factory

全体の設計（[issue-24-design.md](../issue-24-design.md) ほか 6 本）を書いたときの nd-factory の状態、利用者の指示、作り直しに至った理由を置く。設計そのものは設計文書にある。設計文書は、ここに置いた比べや状態を理由にせず、MVV の項目・利用者と場面・外部の一次情報・費用や性能で決定を書く。

## 設計を書いたときの nd-factory

nd-factory は、全体の設計・詳細設計・実装計画が無いまま機能を足してきた。画面は機能ごとに増えた。

| 項目 | 数・状態 |
| --- | --- |
| 旧い側の画面の HTTP の経路（画面ごとの URL の道筋） | 34 本と予定の 1 本 |
| 旧い側の機能の対応表 | 133 行 |
| 骨組み（main） | ログイン → API の 1 つの HTTP の経路 → 表 → 画面 1 枚の縦の切れ端と、設置のコマンド・反映のパイプライン・検査。運用する環境で動いている |
| 旧い側のリポジトリ | 凍結していて、読むだけ |

機能の数と画面の数が、承認を待つものを読む手数を増やした。旧い側の機能を MVV に照らして 1 行ずつ採否を決めた表は [legacy.md](legacy.md) にある。

### 今と、全体の設計で成り立つこと

| 今 | 全体の設計で成り立つこと |
| --- | --- |
| 承認を待つものが何かを 1 か所で読めない | ホーム（いま）1 枚で、人を待つもの（承認・問い）が先頭に読める（S2） |
| スマートフォンでは使えない | スマートフォンとタブレットで使え、つながらなくても読める（Value 3） |
| 画面にしか無い操作がある | 画面の操作はすべて API と MCP にもある。承認の確定は人だけ（Value 4・I14） |
| 認可はアカウント（チーム）の単位で、プロジェクトの単位でない | 認可はプロジェクトの単位でサーバーの側で判定し、割り当てたチームにだけ見せる（Value 9・I2） |

## 利用者の指示

| 日付 | 指示（原文か要旨） | 設計への効き方 |
| --- | --- | --- |
| 2026-11-16 | 旧い側のデータを移さない（利用者の答え） | 移行を設計の前提にしない。移しの仕組みは、この後の形の変更のためだけに置く。移行と読み替えの機能は入れない |
| 2026-11-17 | プロジェクト MVV 版 1（`.ndf/mvv.md`）を承認 | 目指す姿と判断の基準。全体の設計の「MVV と設計の節の対応」の 13 行になった |
| 2026-11-17 | 「作り直しは手段で合って目的ではありません」 | 設計の主題は MVV が目指す姿で、旧い側との同等は判断の材料に留める（[how-designed.md の主題の置き方](how-designed.md#主題を-mvv-に置く)） |
| 2026-11-18 | 「この設計書を作ることになった経緯や作り方」と「設計書そのもの」が混在していませんか？欲しいのは後者ですので、経緯や作り方への言及は必要なら別のディレクトリ・ドキュメントにまとめてください | 設計文書から経緯・作り方・計画を外し、このディレクトリへ移した |

## 作り直しに至った理由

旧い設計（`docs/design/rebuild/`）は、旧い側との同等を網羅することを軸にした。そのため、旧い側が目指す姿から離れた点まで引き継いだ。

- 機能ごとに増えた画面
- チームの単位の認可
- 画面にしか無い操作

利用者は「作り直しは手段で目的ではない」と差し戻した。全体の設計は、MVV が目指す姿から書き直した。旧い設計の文書の扱い（確定仕様化のときに外す）は [legacy.md の旧い設計の文書の扱い](legacy.md#旧い設計の文書の扱い) にある。

## 旧い側・骨組みとの比べ

設計文書の決定は、下の比べを理由から外し、MVV の項目や一般の理由で書き直した。元の比べをここに残す。

### 全体の決定

| 決定 | 元の比べ | 設計文書での書き方 |
| --- | --- | --- |
| 決定 3（採らなかった案 1） | 旧い側の形（レーンを課題・ループ・リリースごとに分け、サービスのコードがリリースを 1 本にまとめる） | 形の中身だけを書く |
| 決定 4（理由） | 旧い側はホームを会話の一覧に置き、承認待ちは別の画面にあった | 承認待ちを先頭に読む理由だけを書く |
| 決定 5（採らなかった案） | 旧い側の機能をすべて最初の版に入れる。画面の数が旧い側と同じになり、Value 1 の手数の目標を満たせない | 後に回す機能もすべて最初の版に入れる。画面の数が増え、Value 1 の手数の目標を満たせない |

### 画面

| 箇所 | 元の比べ | 設計文書での書き方 |
| --- | --- | --- |
| 画面の地図のサインインの戻り | 今の骨組みの振る舞いをそのまま使う | 振る舞いだけを書く |
| 地図に無い HTTP の経路 | 旧い HTTP の経路を受け継がない | 地図に無い経路の扱いだけを書く |
| 決定 21 | 旧い側では HTTP の経路が 34 本と予定の 1 本まで増えた | HTTP の経路が機能の数だけ増える |
| 決定 24 | 旧い側のようにメニューのボタンで開く形は、どの行き先にも 2 手かかるので採らなかった | 「旧い側のように」を外した |
| 決定 27 | 旧い側のパレットとショートカットを引き継ぐ形は、画面の数を減らした後では得る手数が少ない | パレットとショートカットを入れる形は、行き先が 4 つの画面では得る手数が少ない |
| 決定 31 | 今の骨組みは token をタブの `sessionStorage` に置き、ホーム画面の Web アプリを知らせから開くたびに IdP へ移る。これでは S5 の 2 手が成り立たない。採らなかった形「`sessionStorage` のままにする」 | 一般の理由と「`sessionStorage` に置く」 |
| 決定 36 | 端末の時刻帯だけで出す今の形 | 「今の」を外した |

### API

| 箇所 | 元の比べ | 設計文書での書き方 |
| --- | --- | --- |
| 決定 41 | 今の骨組みの `{"status": "ok", "item"}` の形は、成功の判定と HTTP の状態の数が同じ名前になる。そのため `{"ok": true, "item"}` に直す | 成功の印は `ok` にし、失敗の要素が持つ HTTP の状態の数 `status` と名前を分ける |
| 決定 48 | API Gateway の JWT の前段（今の骨組みの `infra/lib/app-stack.ts`）を、利用者向けの HTTP の経路から外す | 利用者向けの HTTP の経路に JWT の前段を置かない |
| 決定 55 | 生成のスクリプトは既に設定のファイルの JSON Schema を作っている（`packages/contracts/scripts/generate.ts`）。差の検査は今の `check` の生成物の差がそのまま担う | 同じ生成のスクリプトが設定のファイルの JSON Schema も作り、差の検査は CI の `check` の生成物の差が担う |

### 土台

| 箇所 | 元の比べ | 設計文書での書き方 |
| --- | --- | --- |
| アーキテクチャの制約 | 旧い側のデータを移さない（利用者の指示、2026-11-16） | 行を外した |
| 解決の方針 | 反映の道筋は骨組みのものをそのまま使う。足す資源は縦の切れ端のスタックへ入れる | 反映の道筋は 2 つだけにする。資源は縦の切れ端のスタックへ入れる |
| 形の版と移し方 | 旧い側のデータは移さないため、移しの仕組みはこの後の形の変更のためだけに置く | 移しの仕組みは、形の変更のために置く |
| 環境の値の受け方 | 骨組みの決まり（settings.md）をそのまま使う | 環境の値は settings.md の決まりで受ける |
| 2 つの反映の道筋 | 骨組みの設置のコマンドと反映のパイプラインをそのまま使う。この設計で足す資源は縦の切れ端のスタック（`app`）へ入れる。手順の正本の文書を変えない | 反映は設置のコマンドと反映のパイプラインの 2 つの道筋で行う |
| 検査 | 見出し「今ある検査」。NDF の版の数字の比べと CI の資格情報は今ある検査のまま使う | 見出し「基本の検査」 |
| 非機能の移行の行 | 旧い側のデータは移さない | 外した |
| 決定 89 | 見出し「骨組みの反映の道筋と確認の値を変えずに使うため、足す資源を縦の切れ端のスタックへ入れる」。理由「Value 8 の反映の道筋は、骨組みにすでにある。反映のパイプラインが `app` だけを反映し、パイプライン自身は設置のコマンドで反映する形である。スタックを増やすと、確認の値・反映のアクション・承認の資料の作りを変えることになる。消しても残す設定で、1 つのスタックに状態を持つ資源を置いても、差分の誤りで消えない」 | 理由を MVV で書き直した |
| 未確認のまま残ること | 骨組みの環境で実測する。骨組みを反映した後の請求 | 反映した環境で実測する。反映した後の請求 |

## 骨組みの状態

設計を書いたときに main にあった骨組みの状態である。設計文書からは「（ある）」「骨組みと同じ」の注記を外した。骨組みから新しい設計への移り方は [plan.md の骨組みからの移り方](plan.md#骨組みからの移り方) にある。

### 構成要素と資源

| 要素・資源 | 状態 |
| --- | --- |
| 設置のコマンド・反映のパイプライン | ある |
| パイプラインの失敗の知らせ | ある |
| スタック | ある |
| 利用者プール・ドメイン・クライアント | ある。Google（と GitHub）の IdP からだけ入る |
| HTTP API・JWT の認可 | ある。JWT の認可は利用者向けの HTTP の経路から外し、token は API の関数の中で確かめる（[API の決定の記録](../issue-24-design-api.md#決定の記録)） |
| Lambda | 骨組みの `acme-test-users-api` がある。束ねは esbuild。`api-fn` へまとめる |
| サービスの表 | 骨組みの利用者の表 `acme-test-accounts` がある。「アカウント」を AWS のアカウントの意味だけで使うため `db-users` へ移す |
| CloudFront と画面の S3 | ある。価格の区分は 100 |
| 秘密の器 | `acme/test/google-oauth` がある。ほかは足す |
| VPC・SG・ECS のクラスタとタスクの定義・Aurora のクラスタ・予算 | 無い。足す |
| スタックのテストの「時間で費用が掛かる資源を作らない」 | ある |
| 検査（NDF の版の数字の比べ・CI の資格情報） | ある |

### コードの置き場

| 置き場 | 状態 |
| --- | --- |
| `packages/contracts/` | 形の正本がある。設定の形がある（広げる） |
| `apps/api/` | ある（広げる） |
| `apps/web/` | 画面がある |
| `infra/` | CDK のスタックと設置のコマンドがある。API Gateway の JWT の前段は `infra/lib/app-stack.ts` にある。`infra/setup/` の AWS SDK のクライアントの直の生成は今のまま使う |
| `tools/` | 検査がある（広げる）。`ref-check/` は参照の検査、`test/` は CI の定義のテスト |

API の関数の時間切れは 10 秒である（冪等の鍵の `IDEMPOTENCY_LEASE_MS` の既定はその 2 倍）。

### 画面の合わない所

`apps/web/src/` の形と、画面の設計との違いである。

| 今の形 | 直す先 | 決定 |
| --- | --- | --- |
| HTTP の経路を持たず、1 枚の画面で利用者の ID を出す | 14 本の HTTP の経路を path で持つ。CDN は地図の HTTP の経路に `index.html` を返す | 決定 21・38 |
| 文言を `view.ts` に日本語で直に書く | 翻訳のファイルのキーで引く | 決定 34 |
| `index.html` の `lang` が `ja` で固定 | 決まった言語を入れる | 決定 34 |
| ログインの控えをタブの `sessionStorage` に置き、タブを閉じると消える | 暗号化した IndexedDB の控えに移す（知らせから開いたときに 2 手を守る） | 決定 31 |
| 画面の設定の値を控えずに毎回読む（`no-store`） | つながっていれば毎回読み、読めなければ Service Worker の控えを使う | 決定 28 |
| Web App Manifest と Service Worker が無い | 足す（名前・`start_url: "/"`・`display: "standalone"`・`scope: "/"`・アイコン・`lang`） | 決定 28 |
| 誤りの理由のコードを `<code>` でそのまま出す | 理由のコードを翻訳した文で出す | 決定 35 |

設計に要る中身（Manifest の項目と画面の設定の値の読み方）は、画面の設計の「オフライン › 端末に控えるもの」にある。STD20 の「設計への反映」も、元はこの表を指していた。

### API の合わない所

骨組みの `PUT /v1/users`（`packages/contracts/src/users-api.ts`）は、本文が配列で要素ごとに答える形を既に持つ。設計では次の 4 つを直す（決定 41・47）。

| 項目 | 今 | 直す先 |
| --- | --- | --- |
| HTTP の経路 | `PUT /v1/users` | `POST /v1/sessions/create` |
| 要素の結果 | `{"status": "ok", "item"}` | `{"ok": true, "item"}` の形 |
| 要素の誤り | 要求全体の 400 | 要素の 400 `item_invalid` |
| 要素の上限 | 10 | 100 |

### 既存の部品の再利用

詳細設計の横断の部品ごとに、骨組みのコードと依存のライブラリに使える部品があるかを確かめた結果である。確かめ方は [how-designed.md の既存の部品の確かめ方](how-designed.md#既存の部品の確かめ方) にある。設計文書には、依存のライブラリと Node 24 の組み込みだけを候補にした表を残した。表の `<骨組みの範囲>` は、確かめた 8 つの置き場を指す。

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
| `authenticate` | API Gateway の JWT の前段（`infra/lib/app-stack.ts` の `HttpJwtAuthorizer`）・`jwt-decode`・`aws-jwt-verify`・`node:crypto` | `grep -rnE 'jwt\|jose\|verify\|authorizer' <骨組みの範囲>` → `app-stack.ts` と `users-handler.ts`。`jwt-decode` は `oidc-client-ts` の依存（画面だけ）。`grep -oE '"node_modules/(aws-jwt-verify\|jose)"' package-lock.json` → 0 件。`timingSafeEqual` → 0 件 | JWT の前段は使えない（委任の token を読めない。[認証と主体](../issue-24-design-api.md#認証と主体)）。`jwt-decode` は署名を確かめないため使えない。`node:crypto` の `createPublicKey`（JWK）・`verify`（RS256 と Ed25519）・`timingSafeEqual`・`createHash` を使う（`infra/lib/assembly-digest.ts` が `createHash` を既に使う） |
| `visibleProjectIds` | 席・割り当ての読み | `grep -rnE 'authorize\|permission\|role' apps/api/src` → JWT の前段の `sub` を読む 1 件だけ | 使えない（無い）。作る |
| `authorize` | `users-handler.ts` の `answerItems`（他人の ID に表を読まず `not_found` を返す） | `grep -n 'not_found' apps/api/src/users-handler.ts` | 使う（見えないものを無いものと同じに返す形を引き継ぐ）。判定の本体は作る |
| `judgeUsage` | 料金プラン・上限の比べ | `grep -rnE 'limit\|quota\|plan' <骨組みの範囲>` → 0 件 | 使えない（無い）。作る |
| `usageAddItem` | 同上 | 同上 | 使えない（無い）。`updateIfVersion` と同じ組み方で作る |
| `auditItem` | 操作の記録 | `grep -rni 'audit' <骨組みの範囲>` → 0 件 | 使えない（無い）。作る |
| `appendAudit` | 同上 | 同上 | 使えない（無い）。`writeAtomically` を通して作る |
| `readHttpCall` | `packages/contracts/src/users-api.ts` の `parseUsersRequest`（JSON でない・配列でない・空・数の上限の順の検査）と `users-handler.ts` の `decodeBody` | `grep -rn 'parseUsersRequest\|decodeBody' <骨組みの範囲>` → 3 件 | 使う（理由のコードの順と base64 の本文の読み方を引き継ぎ、操作の表の共通の検査へ広げる。要素の上限は 10 から 100、重なりの検査を足す） |
| `readMcpCall` | MCP の受け口・JSON-RPC のライブラリ | `grep -rnE 'jsonrpc\|tools/list\|mcp' <骨組みの範囲>` → 0 件。`grep -oE '"node_modules/@modelcontextprotocol[^"]*"' package-lock.json` → 0 件 | 使えない（無い）。セッションを持たない JSON の 1 応答だけを受けるため、SDK を足さず作る（[MCP](../issue-24-design-api.md#mcp)） |
| `dispatch` | `users-handler.ts` の `createHandler`（依存の注入・401・400・503 の扱い） | `grep -rnE 'dispatch\|route\|handler' <骨組みの範囲>` → `users-handler.ts` と `app-stack.ts` の起点の指定 | 使う（依存を注入して起点を作る形と、想定しない失敗を 503 にする扱いを引き継ぐ）。振り分けの本体は作る |
| `writeHttpResponse` | `users-handler.ts` の `json` | `grep -n 'function json' apps/api/src/users-handler.ts` → 1 件。`grep -rnE 'problem\+json\|about:blank' <骨組みの範囲>` → 0 件 | 使う（`content-type` と本文の組み立てを引き継ぐ）。problem の形と `no-store` を足す |
| `writeMcpResponse` | MCP の応答の組み立て | `grep -rnE 'structuredContent\|jsonrpc' <骨組みの範囲>` → 0 件 | 使えない（無い）。作る |
