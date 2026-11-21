# #1: このリポジトリの CI の検査の実装計画

## 関連リンク

- 要求仕様: [issue-1-requirements.md](./issue-1-requirements.md)（正は #1 の本文）。受け入れ条件は番号で指す
- 設計書: [issue-1-design.md](./issue-1-design.md)・詳細設計書 [issue-1-design-detail.md](./issue-1-design-detail.md)
- モード: `standard`（CI の必須のチェックを足し、全体の設計を引いて詳細設計を書いた。設計 PR #49 で承認済み）

## 承認で足したこと

設計 PR #49 の承認（2026-11-21）と一緒に決めた 2 点を、この計画の該当するタスクに入れる。設計文書の該当する節も、同じタスクで直す。

| # | 足したこと | 入れるタスク |
| --- | --- | --- |
| 1 | gitleaks の `gitleaks:allow` と除外のファイル（`.gitleaksignore`）を、起動の引数（`--ignore-gitleaks-allow` と、除外のファイルを読まない指定）で効かなくする | Task 5 |
| 2 | 合成した API Gateway の経路と操作の表（経路の登録）の照らしを、形の正本の往復のテストに含める | Task 7 |

## 修正対象

詳細設計書の「地図」のとおりである。地図に無いファイルを足すときは、タスクの変更内容に理由を書く。

## タスク分解

### Task 1: CI の定義のテストをすべてのワークフローを YAML で読む形にする

- **対象ファイル:** `tools/test/ci-definition.test.ts`・`tools/test/ref-check.test.ts`・`tools/package.json`（`yaml`）・`package.json`・`package-lock.json`・`vitest.config.ts`・`vitest.integration.config.ts`（新設。結合のテストを既定の実行から外す vitest の標準の書き方が設定のファイルを分けることのため）
- **変更内容:** 詳細設計書の「zizmor の設定と CI の定義のテスト」の関数の表（`loadWorkflows`・`jobNames`・`triggersPullRequest`・`permissionBlocks`）と照らすこと。`ref-check.test.ts` にワークフローの版の比べのテストを足す。`vitest.config.ts` で `*.integration.test.ts` を単体のテストから外し、`vitest.integration.config.ts` を打つスクリプト `test:integration` を足す（後のタスクの結合のテストの置き場）
- **満たす受け入れ条件:** 8・10
- **進め方:** 失敗するテスト（2 つ目のワークフローにだけ資格情報の語・`id-token: write` を足した作り物）→ 実装 → 整理

### Task 2: ESLint の置き場ごとの塊と、骨組みのコードの除外の注釈

- **対象ファイル:** `eslint.config.js`・`tools/test/lint-config.test.ts`・`apps/api/src/users-handler.ts`・`apps/api/src/user-store.ts`・`apps/web/src/main.ts`・`apps/web/src/users-client.ts`・`infra/lib/app-stack.ts`
- **変更内容:** 詳細設計書の「ESLint の設定」の表の塊・`reportUnusedDisableDirectives: "error"`・`PLAN_EXPORT_REQUIRED`。当たる行に `// eslint-disable-next-line <規則> -- #2 が横断の部品へ移す`（`#4` の行は「#4 が置き換える」）
- **満たす受け入れ条件:** 1・4（画面の料金プランの名前）・5（経路の直書き）・6・14
- **進め方:** 塊ごとに違反の文字列で落ちるテスト → 設定 → 注釈

### Task 3: dependency-cruiser の依存の向き

- **対象ファイル:** `.dependency-cruiser.cjs`・`tools/test/deps-config.test.ts`・`package.json`（`deps-check`・`dependency-cruiser`）・`.github/workflows/ci.yml`（`check` に手順）
- **変更内容:** 詳細設計書の「dependency-cruiser の設定」の規則の表
- **満たす受け入れ条件:** 1・4（料金プランの値の import）・7
- **進め方:** 規則ごとに違反を 1 つ置いた一時の木で落ちるテスト → 設定

### Task 4: knip の使っていないものの検出

- **対象ファイル:** `knip.jsonc`・`tools/test/knip-config.test.ts`・`package.json`（`knip`）・`.github/workflows/ci.yml`（`check` に手順）・今の当たりのファイル
- **変更内容:** 詳細設計書の「knip の設定」。今の当たり（使われない開発の依存 1 件・書き出し 4 件）を直し、直せないものだけを理由と課題の番号つきで `ignoreDependencies` に置く
- **満たす受け入れ条件:** 1・5（使われない生成した呼び出し）・12
- **進め方:** 使われない書き出し・依存・ファイルを足した一時の木で当たるテスト → 設定 → 今の当たりを直す

### Task 5: gitleaks の `leak-check` のジョブ

- **対象ファイル:** `.gitleaks.toml`・`.github/workflows/ci.yml`（`leak-check`）・`tools/test/leak-scan.integration.test.ts`・`.ndf/project.json`（必須のチェック）・`AGENTS.md`（`LEAK_CHECK_PATTERN` の行）・`issues/issue-1-design.md`・`issues/issue-1-design-detail.md`（承認で足したこと 1）
- **変更内容:** 詳細設計書の「gitleaks の設定と `leak-check` のジョブ」。どの実行にも `--ignore-gitleaks-allow` と、除外のファイルを読まない指定を渡す
- **満たす受け入れ条件:** 1・2・3
- **進め方:** 作り物でない値を組み立てた一時の木で当たり、報告に値が出ないことを確かめる結合のテスト → 設定とジョブ

### Task 6: zizmor の `workflow-audit` のジョブ

- **対象ファイル:** `.github/zizmor.yml`・`.github/workflows/ci.yml`（`workflow-audit`）・`tools/test/workflow-audit.integration.test.ts`・`.ndf/project.json`（必須のチェック）
- **変更内容:** 詳細設計書の「zizmor の設定と CI の定義のテスト」。設計文書の「確かめられなかったこと」の zizmor の 2 行（`--offline` で効く点検・要約値）を確かめて設計文書に記す
- **満たす受け入れ条件:** 1・13
- **進め方:** 書き込みの権限などを足したワークフローで当たる結合のテスト → 設定とジョブ

### Task 7: 形の正本の往復のテストと、合成した API Gateway の経路の照らし

- **対象ファイル:** `tools/test/contracts-round-trip.test.ts`・`tools/package.json`（`ajv`・`ajv-formats`）・`issues/issue-1-design.md`・`issues/issue-1-design-detail.md`（承認で足したこと 2）
- **変更内容:** 詳細設計書の「形の正本の往復のテスト」の照らすこと 1〜7 に、照らすこと 8（合成した経路と経路の登録の比べ）を足し、「合成の打ち方」のとおりに合成する。照らすこと 8 と合成の打ち方は承認の後に詳細設計書へ書き足した（このタスクで設計文書の該当する節を変えるときも、ここと揃える）。要点は次のとおり
  - 比べる範囲: 合成したテンプレートの `AWS::ApiGatewayV2::Route` の経路（方法と経路）から除外の旧経路を引いた集まりが、経路の登録（#2 の `generated/routes.json`）から除外の受け口の経路を引いた集まり（反映済みの経路）と等しい
  - 期限付きの除外: テストの中の表に、行ごとに外すもの（旧経路 `PUT /v1/users`、または受け口 `user`・`runner`・`machine` の 1 つ）と、外すのを終える課題の番号（#4）を置く。除外が要らなくなった行で落ちる（旧経路が合成に無い・受け口の経路が合成に 1 本でもある・受け口が登録に無い）。#2 は `api-fn` と `ApiRoutes` をスタックへ入れないため、登録が入った時点の合成の経路は旧経路の 1 本だけで、3 つの受け口がすべて除外に入る
  - 全経路の完全一致に切り替える条件: 除外の表が空になったとき。#4 が `api-fn` を反映して `PUT /v1/users` を消す Pull Request で、当たる行（除外が要らなくなった行）を消す。表が空なら比べは合成の経路の集まりと登録の経路の集まりの完全一致になる
  - 経路の登録が無い間は、比べを「相手が無い」で飛ばし、合成したテンプレートから経路を 1 本以上取り出せることだけを確かめる
  - 合成は `infra` を子のプロセスで打ち、クリーンなチェックアウトの `check` のジョブ（画面をビルドしない）でも通るよう、画面のアセットを一時のディレクトリに作って `ND_WEB_DIST` で渡す。出力は一時のディレクトリへ出し、ファイルとして読む（`tools` は `infra` を import しない）
- **満たす受け入れ条件:** 1・5
- **進め方:** 1 か所を壊した作り物の表とテンプレートで落ちるテスト → 実装

### Task 8: NDF の契約の照合と `ndf-contract` のワークフロー

- **対象ファイル:** `tools/checks/src/ndf-contract-check.ts`・`tools/test/ndf-contract-check.test.ts`・`tools/tsconfig.json`・`package.json`（`ndf-contract`）・`.github/workflows/ndf-contract.yml`・`.ndf/project.json`（必須のチェックと `ci.workflows`）
- **変更内容:** 詳細設計書の「NDF の契約の照合」
- **満たす受け入れ条件:** 1・9
- **進め方:** テストの中で作った git のリポジトリを NDF のリポジトリの代わりに渡し、1〜6 のそれぞれを壊した契約で落ちるテスト → 実装

## レビューの単位

単位はすべてスプリントブランチ `sprint/issue-1` から切り、前の単位をマージしてから次を始める（`package.json`・`ci.yml`・`.ndf/project.json` を多くの単位が触るため）。行数は `package-lock.json` を数えない。

| 単位 | 含むタスク | 満たす受け入れ条件 | 見込みの差分の行数 | 実際の行数 |
| --- | --- | --- | --- | --- |
| U1 CI の定義のテスト（準備） | Task 1 | 1:8・1:10 | 約 300 | （実装の後に書き足す） |
| U2 ESLint | Task 2 | 1:1・1:4・1:5・1:6・1:14 | 約 400 | |
| U3 依存の向きと使っていないもの | Task 3・4 | 1:1・1:4・1:7・1:12 | 約 450 | |
| U4 漏れとワークフローの点検 | Task 5・6 | 1:1・1:2・1:3・1:13 | 約 500 | |
| U5 形の正本の往復 | Task 7 | 1:1・1:5 | 約 450 | |
| U6 NDF の契約の照合 | Task 8 | 1:1・1:9 | 約 600 | |

受け入れ条件 11（詳細設計）は設計 PR #49 で満たした。

## リファクタリングの時機

| 時機 | 対象 | 理由 |
| --- | --- | --- |
| 実装の前（準備のリファクタリング） | しない | 触る既存のコードは `tools/test/ci-definition.test.ts`（63 行）と骨組みの 5 ファイルの注釈だけで、ほかは新設 |
| 実装の中 | 各タスクで行う | `tdd-cycle` のリファクタリングのステップ |
| スプリントの終わり（cross-refactoring） | 結合のテストの実行ファイルの取得と一時の木の組み立て（U4 の 2 つのテスト）、一時の木を作るテストの道具（U3・U4・U6） | 同じ形の処理が単位をまたいで書かれる見込み |

## リスクと対処

| リスク | 対処 |
| --- | --- |
| #2 が `sprint/issue-2` で横断の部品と操作の表を作っている。#2 が先に main へ入れば除外の注釈が使われなくなり、ESLint が落ちる | #2 のマージの後に main を取り込み、使われなくなった注釈を消す（`reportUnusedDisableDirectives` が場所を示す） |
| #2 の経路の登録が入ると、骨組みの `PUT /v1/users` が合成したテンプレートにだけ残り、#4 が反映するまで登録の経路は合成に無い | 照らすこと 8 の除外の表（旧経路と未反映の受け口。#4 の印つき）を U5 が置き、登録が入った時点から反映済みの経路だけを比べる。#2 の設計の「骨組みの経路」の行（#4 の印つきで外す）は、この表の旧経路の行が受け持つ。#2 と U5 のうち後に main へ入る側の CI で、この比べが通ることと、除外を 1 行消すと落ちることを確かめる。#4 が除外の行を消して完全一致に切り替える |
| 必須のチェックを宣言に足しても、main の保護に足さないと必須にならない | 承認資料に保護への追加の手順を挙げる（リポジトリの設定は変えない） |

## 完了の定義

- [ ] 受け入れ条件 1〜10・12〜14 をすべて満たし、条件ごとに CI のジョブとテストの名前が対応している
- [ ] 各単位の PR の CI がすべて通り、cross-review が収束している
- [ ] スプリントの Pull Request の CI がすべて通っている
