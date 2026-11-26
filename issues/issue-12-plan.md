# 12: 画面の基盤

## 関連リンク

- 要求仕様: [issue-12-requirements.md](./issue-12-requirements.md)（正は [#12](https://github.com/devbasex/nd-factory/issues/12) の本文）。受け入れ条件は番号で指す
- 設計書: [issue-12-design.md](./issue-12-design.md)。詳細設計書: [issue-12-design-detail.md](./issue-12-design-detail.md)。下の「詳細設計の『〜』」は、詳細設計書の同じ名前の節を指す
- モード: `standard`（#12 の本文の「進行」の欄の「モード」による）

この文書の「ログインの切り替え」は、`oidc-client-ts` の保存先（`userStore`）をタブの `sessionStorage` から端末のデータベースへ替える変更である。切り替える条件は、設計書の「文脈と制約」の「#12 と #4 の反映の順」にある。#4 は、サインインの処理を持つ別の課題（[利用者とチーム](https://github.com/devbasex/nd-factory/issues/4)）である。

ログインの切り替え（Task 22）と `Retry-After` の公開（Task 20 の一部）は、#12 では行わない。どちらも外の条件（#4 の呼び出しと、先に出す設計の Pull Request）を待つため、続きの課題（[画面の基盤の続き](https://github.com/devbasex/nd-factory/issues/196)）へ移した。`Date` の公開は承認済みのプラットフォームの文書が既に決めているため、#12 で行う。受け入れ条件 6・7 は、#12 の本文で #12 が満たす部分に絞ってある（6 はダミーで測る待ち時間の記録、7 はログインのキャッシュを暗号化して置く層）。下の Task 22 の節と、Task 20 の `Retry-After` の行は、#196 が使う手順として残す。

## 修正対象

ファイルごとの役割・依存の向き・関数は、詳細設計の「地図」が持つ。表は「地図」を置き場ごとにまとめて引き写した。

| ファイル | 変える中身 |
| --- | --- |
| `apps/web/src/main.tsx`・`app/`・`routes/`・`screens/`・`ui/`・`i18n/` | 新設。画面の組み立て・画面マップ・仮の画面・共通の部品・見た目の値・翻訳 |
| `apps/web/src/offline/`・`sw/`・`dummy/`、`public/manifest.webmanifest` | 新設。端末のデータ・そろえ方・Service Worker・ダミー |
| `apps/web/scripts/`、`apps/web/e2e/support/` | 新設。生成・ビルド・検査のスクリプトと、e2e の計測 |
| `apps/web/src/main.ts`・`view.ts` | 削除。`app/` と `screens/` へ移す |
| `apps/web/src/auth.ts` | 保存先を引数で受ける |
| `packages/core/src/ids.ts` | 冪等キーを作る関数を足す |
| `infra/lib/app-stack.ts` | `prune: false`。`exposeHeaders` に `date` を足す（`retry-after` は #196 の Task 20 で足す） |
| `package.json`・`apps/web/package.json`・`package-lock.json`・`vite.config.ts`・`tsconfig.json`・`index.html`・`playwright.config.ts`・`vitest.config.ts`・`knip.jsonc` | 依存・生成・ビルド・テストの設定 |
| `apps/web/test/`・`apps/web/e2e/`・`packages/core/test/`・`infra/test/` | テスト（設計書の「テスト設計」と、詳細設計の節ごとの「単体テストの観点」） |
| `docs/design/platform.md` | 「地図」に無い。`Retry-After` を公開するヘッダーに足す設計の Pull Request（#196 の Task 20）で直し、#12 では変えない。設計書の「`Retry-After` と `Date` の受け取り」が、実装より先に出すと決めている |

## タスク分解

変更の種類は機能追加なので、最初に今の振る舞いを縛る退行テストを置く。タスクは依存の順に並べる。

どのタスクにも当てはまる決まりは次の 4 つである。

- テストを足す先と観点は、詳細設計の節の「単体テストの観点」と、設計書の「テスト設計」の該当する行である。作り物の値だけを使う
- 新しいモジュールは、そのタスクの中で起動の組み立て（`app/compose.ts`）から参照が届くようにする。`npm run knip` は、画面の起点から届かないファイルと書き出しを落とすためである。#4 だけが呼ぶ関数も、`AppDeps` に組んで渡す。テストのためだけの書き出しには `@internal` を付ける
- 依存のパッケージは、最初に使うタスクで足す
- #12 では、利用者のデータを保存する IndexedDB（端末のデータベース）を本番の起動で開かず、写し・送る列・そろえ方も本番の起動で動かさない。本番で開くのは #196 のログインの切り替え（Task 22）からである（詳細設計の「起動の組み立て」）。Task 8〜16 の確認は単体テストと、テストが用意したデータベースで行う
- Service Worker は、Task 18 から設定を取った順の連番を、端末のデータベースとは別の IndexedDB（`nd-config-seq`）に記録する。この IndexedDB は利用者のデータを持たないので、上の決まりの対象ではない

### Task 1: 今の画面の振る舞いを縛る退行テストをそろえる

- **対象ファイル:** `apps/web/e2e/user-page.spec.ts`
- **変更内容:** `apps/web/test/main.test.ts` が縛る振る舞い（11 件）のうち、e2e（3 件）に無いものを足す。足すのは 401 の 1 回だけの送り直し、2 回目の 401 のエラー、設定が読めない・戻りの失敗のエラーと「もう一度」である。`main.ts` と `view.ts` を消しても残る場所で縛るためである
- **満たす受け入れ条件:** 無し（退行を防ぐ）
- **進め方:** 今の振る舞いを縛るので、書いた時点で通る

### Task 2: 画面を React へ移し、骨組みの表示を置き直す

- **対象ファイル:** `src/main.tsx`・`app/compose.ts`・`app/boot.ts`・`app/App.tsx`・`screens/signin.tsx`・`screens/me.tsx`・`auth.ts`、削除する `main.ts`・`view.ts` と対応するテスト、`index.html`・依存と設定のファイル
- **変更内容:** 詳細設計の「起動の組み立て」。`createAuth` に保存先を引数で渡し、中身は今の `sessionStorage` のままにする。401 の扱い（`nd.reauth`）と利用者の取得は `boot` と `MeScreen` へ移し、振る舞いを変えない
- **満たす受け入れ条件:** 無し（Task 5・6 の前提）
- **進め方:** `boot` の返り値のテストを先に書く → 移す → Task 1 の e2e が通る。`main.test.ts`・`view.test.ts` の観点は `boot`・`App`・`MeScreen` のテストへ移してから消す

### Task 3: 翻訳と見た目の値

- **対象ファイル:** `src/i18n/`・`ui/tokens.json`・`ui/tokens.dark.json`・`ui/tokens.generated.css`・`scripts/build-tokens.ts`、ルートの `package.json`
- **変更内容:** 詳細設計の「翻訳」「見た目の値」。Task 2 の画面の文言を翻訳のキーへ替える。`npm run generate` と `generate:check` に見た目の値の生成を足す
- **満たす受け入れ条件:** 無し（16 は Task 6 で満たす）
- **進め方:** 失敗するテスト → 最小実装 → 整理

### Task 4: 枠と、状態を出す部品

- **対象ファイル:** `ui/` の枠・上の帯・ボタン・空の状態・読み込み中・エラー・オフラインの帯・状態のバッジ・確認のダイアログ、`ui/catalog.ts`、`e2e/support/measure.ts`（`smallTargets`）、`playwright.config.ts`
- **変更内容:** 詳細設計の「枠と共通の部品」。幅の区切りは CSS だけに置く。e2e を 3 つの幅で打つ設定と、ナビゲーションの並びの確認（639・640・1023・1024 px）を足す
- **満たす受け入れ条件:** 11
- **進め方:** カタログの両方向の照合を最初に書き、部品ごとに失敗するテスト → 最小実装

### Task 5: 残りの共通の部品

- **対象ファイル:** `ui/` の残りの部品（一覧・詳細・畳む節・確定待ちのバッジ・操作の結果・時刻・金額・資料の本文・入力欄・選択の欄）、`ui/catalog.ts`
- **変更内容:** 詳細設計の「枠と共通の部品」の表の 19 件をそろえる。`DocumentBody` は許した節だけを要素にする
- **満たす受け入れ条件:** 4
- **進め方:** 失敗するテスト → 最小実装 → 整理

### Task 6: 画面マップの 16 本のルート

- **対象ファイル:** `routes/`・`scripts/build-route-operations.ts`・`screens/placeholder.tsx`、`vite.config.ts`、ルートの `package.json`
- **変更内容:** 詳細設計の「画面マップの表」「ルーター」。ルートと操作の対応を `generate` と `generate:check` に足す。戻り先の 3 つはルーターの前で振り分ける。16 本を直に開く e2e と、`smallTargets` の全ルートの確認を足す
- **満たす受け入れ条件:** 5・12・16。10 はこの e2e が `vite preview` で通るだけでは満たしたとしない（「リスクと対処」）
- **進め方:** 失敗するテスト → 最小実装 → 整理

### Task 7: ダミーと、手数・回線の計測

- **対象ファイル:** `dummy/dummy-client.ts`・`offline/connectivity.ts`・`scripts/module-list-plugin.ts`・`scripts/check-dummy-free.ts`・`e2e/support/measure.ts`、`app/compose.ts`、`playwright.config.ts`
- **変更内容:** 詳細設計の「ダミーのクライアント」「つながりの判定」「e2e の計測」。`build:web` が検査の失敗で止まるようにし、e2e のサーバーを本番とダミーの 2 組にする。`connection=pending` の確定待ちの表示は Task 17 でつなぐ
- **満たす受け入れ条件:** 3（17 は Task 17 で満たす）
- **進め方:** `findDummyLeaks` と手数の上限は、壊すと落ちるテストを先に書く

### Task 8: 暗号化と端末のデータベース

- **対象ファイル:** `offline/crypto.ts`・`db.ts`・`migrate.ts`
- **変更内容:** 詳細設計の「端末のデータベース」。版の上げの順は設計書の「版の上げの表」
- **満たす受け入れ条件:** 無し（13 の前提）
- **進め方:** 失敗するテスト → 最小実装。IndexedDB と Web Locks を単体テストで使う手段はこのタスクで選ぶ（設計書の「確認できなかったこと」が実装の段に残している）

### Task 9: 端末のキャッシュ

- **対象ファイル:** `offline/snapshot-kinds.ts`・`authz.ts`・`guarded-commit.ts`・`cache-store.ts`
- **変更内容:** 詳細設計の「端末のキャッシュの保存」
- **満たす受け入れ条件:** 無し（6・13・14 の前提）
- **進め方:** 記録との照合の表と、利用者の境界の照合を先にテストへ書く → 最小実装

### Task 10: 操作の区分と、送る列・保留の件

- **対象ファイル:** `offline/operation-classes.ts`・`outbox.ts`・`held-store.ts`、`packages/core/src/ids.ts`
- **変更内容:** 詳細設計の「操作の区分の表」「送る列の保存」「保留の一覧」の `createHeldStore`・`visibleFieldsOf`
- **満たす受け入れ条件:** 無し（2・14・15 の前提）
- **進め方:** 全操作に区分があることのテスト → 失敗するテスト → 最小実装

### Task 11: 隔離と、端末から消す処理

- **対象ファイル:** `offline/quarantine.ts`・`erase.ts`
- **変更内容:** 詳細設計の「隔離の保存」「端末から消す処理」
- **満たす受け入れ条件:** 無し（14 の前提）
- **進め方:** 中断と書き込みの失敗の場面を先にテストへ書く → 最小実装

### Task 12: ログインのキャッシュと途中の記録

- **対象ファイル:** `offline/login-store.ts`・`pending-store.ts`、`app/compose.ts`
- **変更内容:** 詳細設計の「ログインのキャッシュの保存」「途中の記録の保存」。#4 が呼ぶ関数を `AppDeps` に出す。`userStore` はまだ替えない
- **満たす受け入れ条件:** 7・14（期限と、サインアウトで消す・隔離する振る舞いを単体テストで通す）
- **進め方:** 失敗するテスト → 最小実装 → 整理

### Task 13: 送信の部品と失効の反映

- **対象ファイル:** `offline/send-wait.ts`・`api-transport.ts`・`revocation.ts`
- **変更内容:** 詳細設計の「そろえ方」の `createApiSender`・`retryUntilFrom`・`createSendWait`・`planRevocation`・`applyRevocation`・`holdDenied`
- **満たす受け入れ条件:** 無し（2・15 の前提）
- **進め方:** 送る直前の照合と、一覧の途中の失敗を先にテストへ書く → 最小実装

### Task 14: 送る列を送る（段 2）と取り下げ

- **対象ファイル:** `offline/send.ts`
- **変更内容:** 詳細設計の「そろえ方」の `classifyResult`・`checkDeadline`・`sendQueue`・`withdraw`。判定は設計書の「段 2 の結果ごとの扱い」
- **満たす受け入れ条件:** 無し（2・15 の前提）
- **進め方:** 判定表の行を先にテストの表へ書く → 最小実装

### Task 15: そろえ方の起動と段の順

- **対象ファイル:** `offline/sync.ts`、`app/compose.ts`
- **変更内容:** 詳細設計の「そろえ方」の `createSync`。本番の組み立てが渡す読み出し（`readers`）は一時の失敗にする
- **満たす受け入れ条件:** 無し（2・15 の前提）
- **進め方:** 作り物の操作の表で段の順を縛るテスト → 最小実装

### Task 16: 画面を端末のデータにつなぐ

- **対象ファイル:** `app/boot.ts`・`app/App.tsx`・`app/compose.ts`・`screens/held-list.tsx`・`screens/placeholder.tsx`・`dummy/dummy-client.ts`
- **変更内容:** `boot` を詳細設計の「処理の手順」の順にそろえる。帯の待ちの数と保留の数、保留の一覧、確定待ちのバッジ、表示の無効化（設計書の「段 1 の後の表示の無効化」）をつなぐ
- **満たす受け入れ条件:** 無し（Task 17 の前提）
- **進め方:** `boot` の順と保留の一覧のテストを先に書く → 最小実装

### Task 17: 確定待ちとオフラインの操作を画面で通す

- **対象ファイル:** `screens/placeholder.tsx`・`dummy/dummy-client.ts`・`apps/web/e2e/`・`apps/web/test/`
- **変更内容:** `connection=pending` で確定待ちが 1 件ある状態にする。設計書の「テスト設計」の 2・15・17 の行を画面から通す
- **満たす受け入れ条件:** 2・15・17
- **進め方:** 失敗する e2e → 不足を足す

Task 16 と 17 は 1 つのレビューの単位にする。

### Task 18: Service Worker と、配信の旧いファイルを残す設定

- **対象ファイル:** `sw/`・`scripts/build-sw.ts`・`public/manifest.webmanifest`・`index.html`・`apps/web/package.json`、`infra/lib/app-stack.ts`（`prune: false`）、`infra/test/app-stack.test.ts`
- **変更内容:** 詳細設計の「Service Worker」「反映の定義（インフラ）」。Service Worker のバンドルをダミーの検査の対象に足す。更新の場面の e2e（テスト設計の「決定 2」の行のうち、配信の切り替え以降）は次の単位に置く
- **満たす受け入れ条件:** 13
- **進め方:** `classifyRequest` と設定の値の番号のテストを先に書く → 最小実装。`prune: false` は同じ Pull Request に入れる

### Task 19: Service Worker の版の入れ替えを e2e で縛る

- **対象ファイル:** `apps/web/e2e/`
- **変更内容:** テスト設計の「決定 2」で始まる行のうち、版を 2 つ以上使う場面を足す
- **満たす受け入れ条件:** 無し（13 は Task 18 で満たす）
- **進め方:** 行の「どう壊したら落ちるべきか」で壊して落ちることを確かめてから戻す

### Task 20: `Date` と `Retry-After` を画面から読めるようにする（`Retry-After` は #196 へ移した）

画面と API はオリジンが違うため、CORS で公開しないヘッダーは画面から読めない。`Date` は #12 で公開し、設計の変更が要る `Retry-After` は #196 で公開する。

| 公開するヘッダー | 行う課題 | 変更内容 | 待つもの |
| --- | --- | --- | --- |
| `Date` | #12 | `infra/lib/app-stack.ts` の HTTP API の `corsPreflight` に `exposeHeaders: ["date"]` を足す。承認済みのプラットフォームの文書（`docs/design/platform.md` の HTTP API の行）が既に決めている | 無し |
| `Retry-After` | [#196](https://github.com/devbasex/nd-factory/issues/196) | 公開するヘッダーに `Retry-After` を足す設計の Pull Request を main へ出し、承認とマージの後に `exposeHeaders` に `retry-after` を足す | 設計の Pull Request のマージ |

- **対象ファイル:** `infra/lib/app-stack.ts`・`infra/test/app-stack.test.ts`。#196 では、先に出す設計の Pull Request で `docs/design/platform.md` も直す
- **満たす受け入れ条件:** 無し（テスト設計の「`Retry-After` と `Date` の公開」の行。#12 は `Date` の部分、#196 は `Retry-After` の部分を確かめる）
- **進め方:** スタックのテストを先に直す → 値を足す
- **#12 の間の扱い:** 画面は `Retry-After` が無いものとして扱い、既定の待ちを使う

### Task 21: 実装の大きさと量の値を詳細設計に記録する

- **対象ファイル:** `issues/issue-12-design-detail.md`（「実機の確認の記録」の表）
- **変更内容:** 手元で測れる値（画面の殻の初回の大きさ）と、ダミーで測れる待ち時間を書く。実機の値はリリース後テストで書く。端末のキャッシュからの表示の待ち時間は、Task 22 の後に #196 で書く
- **満たす受け入れ条件:** 6（8 はリリース後テストで満たす）
- **進め方:** 文書の記入のためテスト駆動を適用しない

### Task 22: ログインの切り替え（#196 へ移した）

- **対象ファイル:** `app/compose.ts`・`app/boot.ts`・`auth.ts` の呼び出し元、`apps/web/e2e/`・`apps/web/test/`
- **変更内容:** `userStore` を `createLoginStore` に替え、`sessionStorage` の骨組みのキャッシュの削除を同時に入れる。#4 の「サインインを確定する」呼び出しと同じ Pull Request か、同じリリースにする。本番の起動で端末のデータベース・写し・そろえ方を動かし、オフラインの起動と写しからの表示の計測を e2e で通す
- **満たす受け入れ条件:** #12 では無し
- **進め方:** #196 の受け入れ条件 2 の e2e とオフラインの起動の e2e を先に書く → 替える
- **行う課題:** [#196](https://github.com/devbasex/nd-factory/issues/196)（#196 の受け入れ条件 1・2。#12 の元の受け入れ条件 6・7 から移した部分）

## レビューの単位

1 単位は 1,000 行以下にする。400 行の目安を超える単位があるのは、1 つの保存先の関数とそのテストを分けると、片方だけでは読めないためである。差分の行数は次のコマンドで数え、生成物とロックファイルは含めない。

```bash
git diff --shortstat <ベース>...HEAD -- . ':(exclude)issues/issue-*' ':(exclude)package-lock.json' ':(exclude)apps/web/src/ui/tokens.generated.css' ':(exclude)apps/web/src/routes/route-operations.generated.ts'
```

| 単位 | 含むタスク | 満たす受け入れ条件 | 見込みの差分の行数 | 実際の行数 |
| --- | --- | --- | --- | --- |
| #12 の 1: React への移し | Task 1・2 | 無し | 約 900 | （実装の後に書き足す） |
| #12 の 2: 翻訳と見た目の値 | Task 3 | 無し | 約 600 | |
| #12 の 3: 枠と状態の部品 | Task 4 | 12:11 | 約 900 | |
| #12 の 4: 残りの部品 | Task 5 | 12:4 | 約 800 | |
| #12 の 5: 画面マップ | Task 6 | 12:5・12:12・12:16 | 約 700 | |
| #12 の 6: ダミーと計測 | Task 7 | 12:3 | 約 800 | |
| #12 の 7: 暗号化とデータベース | Task 8 | 無し | 約 800 | |
| #12 の 8: 端末のキャッシュ | Task 9 | 無し | 約 950 | |
| #12 の 9: 送る列と保留の件 | Task 10 | 無し | 約 800 | |
| #12 の 10: 隔離と消す処理 | Task 11 | 無し | 約 800 | |
| #12 の 11: ログインのキャッシュ | Task 12 | 12:7・12:14 | 約 700 | |
| #12 の 12: 送信の部品と失効 | Task 13 | 無し | 約 900 | |
| #12 の 13: 送る列を送る | Task 14 | 無し | 約 850 | |
| #12 の 14: そろえ方 | Task 15 | 無し | 約 600 | |
| #12 の 15: 画面と端末のデータ | Task 16・17 | 12:2・12:15・12:17 | 約 900 | |
| #12 の 16: Service Worker | Task 18・21、Task 20 の `Date` | 12:6・12:13 | 約 900 | |
| #12 の 17: 版の入れ替えの e2e | Task 19 | 無し | 約 500 | |

- 単位は表の順に依存する。見込みを超えて 1,000 行を超えそうな単位は、実装の途中で分け直す
- 設計の Pull Request のマージを待つ `Retry-After` の公開（Task 20 の `Retry-After` の行）と、#4 の呼び出しを待つログインの切り替え（Task 22）は、#196 の単位にする。#12 の単位はこの 2 つを待たない
- 受け入れ条件 1・9 は設計の段で作った成果物が対象で、8・10 は配信した環境で確認する。どの単位にも載せない
- 受け入れ条件 7（ログインのキャッシュを暗号化して置く層）は、Task 12 の #12 の 11 で満たす

## リファクタリングの時機

| 時機 | 対象 | 理由 |
| --- | --- | --- |
| 実装の前（準備のリファクタリング） | しない | 直す既存のコードは `auth.ts`（28 行、テスト 3 件）・`ids.ts`（51 行）・`app-stack.ts`（223 行、テスト 24 件）と小さい。`main.ts`（109 行、テスト 11 件）と `view.ts`（71 行）は置き換えて消すので、整えても残らない。複数のタスクが触る `app/compose.ts` は新設である |
| 実装の中 | 各タスクで行う | `tdd-cycle` のリファクタリングのステップ |
| スプリントの終わり（cross-refactoring） | `offline/` の保存どうしの重複と、`app/compose.ts` の組み立て | 「暗号化はトランザクションの外で済ませ、`iv` を確かめて書く」手順を、版の上げ・キャッシュ・送る列・隔離（#12 の 7〜10）がそれぞれ持つ。錠（Web Locks）の取り方も別々のファイルに分かれる。`compose.ts` は多くの単位が書き足す |

## リスクと対処

| リスク | 対処 |
| --- | --- |
| 大きさが 1 つのスプリントを超える（要求の前提 2）。見込みの合計は約 14,000 行、#12 のレビューの単位は 17 である | 超えると分かった時点で、子に分けて本文を直す判断を持ち主へ上げる。分けるなら、端末のデータを使わない #12 の 1〜6 が区切りになる |
| 画面の URL を直に開く受け入れ条件 10 は、配信の書き換え（[#177](https://github.com/devbasex/nd-factory/issues/177)、未完了）が要る | #177 を検証用の配信環境へ反映した後に、同じ e2e をその URL へ向けて打つまで、10 を満たしたとしない |
| main が作業ブランチより先に進み、`infra/lib/app-stack.ts`・`knip.jsonc`・`package.json` が変わっている（[#190](https://github.com/devbasex/nd-factory/pull/190)） | 実装を始める前に main を取り込む |
| 後の単位が使うまで、書き出しに参照が無く `npm run knip` が落ちる | 「タスク分解」の頭の決まりのとおり、各タスクで起動の組み立てから届くようにする |

## 切り戻し手順

- #12 の単位は、取り消しのコミットで戻せる。本番の起動は利用者のデータを保存する端末のデータベースを作らない
- Service Worker（#12 の 16）を反映した後は、利用者のブラウザーに Service Worker が残る。設計書と詳細設計書に取り外しの手順の記述は無いため、戻すときは直した版を出し直す。`prune: false` は戻さない（開いているタブが前の版のファイルを取るため）

## 完了の定義

- [ ] 受け入れ条件 1〜17 をすべて満たし（6・7 は #12 の本文で絞った範囲）、条件ごとに設計書の「テスト設計」の確かめと結果が対応している（8 は詳細設計の「実機の確認の記録」、10 は配信環境の確認を含む）
- [ ] `standard` の検証の段階（`npm run check`・`npm run deps-check`・`npm run knip`・`npm run build:web`・`npm run e2e` と、CI の `check`・`ref-check`・`leak-check`）を通す
