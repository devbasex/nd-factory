# #96 #101: 実際の値の規則での Pull Request の探しを非公開のリポジトリへ移す（導入の 1 本目の実装）

## 関連リンク

- 要求仕様: [issue-96-requirements.md](./issue-96-requirements.md)（正は #96 の本文）・[issue-101-requirements.md](./issue-101-requirements.md)（正は #101 の本文）。受け入れ条件は `96:1` のように「課題の番号:条件の番号」で指す
- 設計書: [issue-96-101-design.md](./issue-96-101-design.md)。詳細設計書: [issue-96-101-design-detail.md](./issue-96-101-design-detail.md)
- モード: `standard`（CI の定義とスクリプトの変更で、公開インタフェースは変わらない。課題が 2 つで触るファイルが 10 あるので、設計書と実装計画を省く条件に当たらない）

この計画が扱うのは、設計書の決定 10 の手順 3 にある実装の Pull Request（1 本目）だけである。2 本目の Pull Request（`.ndf/project.json` の変更）と、NDF（devbasex/ai-plugins）への依頼の起票は含めない（詳細設計書の「NDF への依頼と 2 本目の Pull Request」）。#101 は設計書の「設計の結果」で #96 に統合したので、計画も 1 つにまとめる。

## 修正対象

詳細設計書の「地図」の表から引き写す。

| ファイル | 変える中身 |
| --- | --- |
| `.github/workflows/leak-check-secret.yml`（新設） | 渡された Pull Request のマージコミットの木と、分岐点から head までのパッチと履歴の項目を、秘密を重ねた設定で探す（`workflow_call`） |
| `.github/workflows/ci.yml` | Pull Request の探し（`leak-check`）から秘密を外し、main への push の探しを環境 `leak-scan` のジョブ `leak-check-push` へ分ける。gitleaks を置く手順を `install-gitleaks.sh` の呼び出しに替える |
| `tools/checks/leak-scan-secret.sh`（新設） | 秘密の正規表現から重ねた設定を組み、規則ごとに `leak-scan.sh` を打ち、`nd-real-value` の件数を出す（`usage`・`parse_args`・`build_overlay`・`run_scan`・`report_counts`） |
| `tools/checks/install-gitleaks.sh`（新設） | gitleaks の版と要約値を 1 か所に持ち、固定の版を確かめて置く |
| `tools/checks/export-tree.sh`（新設） | コミットの木か、範囲の履歴の項目を、Git に保存された内容のまま取り出して照らす（`usage`・`check_path`・`write_entries`・`verify_tree`・`write_history`・`verify_history`） |
| `tools/test/ci-definition.test.ts` | 起動の許可・`leak-check-secret.yml` と見本の形・漏れの検査のジョブの分け方を定義から読んで落とす（新設 9 関数、変更 3 関数。詳細は詳細設計書の該当節） |
| `tools/test/leak-scan.integration.test.ts` | 2 本の新しいスクリプトを作り物の正規表現と作り物のリポジトリで動かす（`secretScan`・`exportTree`・`mergeRepo`） |
| `docs/operations/leak-check-caller.yml`（新設） | 持ち主が非公開リポジトリへ写す、呼び出しのワークフローの正本 |
| `docs/operations/ci-checks.md`（新設） | 持ち主が GitHub の設定で行う操作と、検査ごとの秘密の受け方と結果の見え方 |
| `AGENTS.md` | 「秘密とインフラの値を置かない」の行を、秘密を使う探しが動く場所に合わせて直し、運用の文書へリンクする |

`tools/checks/leak-scan.sh` は変えない（呼ばれる側）。

## タスク分解

各タスクの中身（関数の仕様・異常系・テストの観点）は、詳細設計書の対応する節にある。ここでは順序と分け方だけを書く。

### Task 1: 今の漏れの検査の振る舞いを縛る退行テストを確かめる

- **対象ファイル:** `tools/test/leak-scan.integration.test.ts`
- **変更内容:** 主の種類が機能追加（#96）なので、今の振る舞いを先に縛る。`leak-scan.sh` が、既定の規則と `.gitleaks.toml` で、今の木（`dir`）と分岐点から head までの範囲（`git --range`）と範囲なしの履歴のすべて（`git`）を探す今のテストがあるかを確かめ、欠けている組だけを足す。今の結合のテストは消さない（設計書のテスト設計の `96:8` の行）
- **満たす受け入れ条件:** 96:8・96:9（退行しない）
- **進め方:** テストは今のコードで通る退行テストなので、先に落ちるテストは書かない。足したテストが通ることと、`leak-scan.sh` の範囲の指定を外すと落ちることを手元で確かめる

### Task 2: コミットの木を Git に保存された内容のまま取り出す

- **対象ファイル:** `tools/checks/export-tree.sh`・`tools/test/leak-scan.integration.test.ts`
- **変更内容:** `export-tree.sh <コミット> <出力先>` と `--verify` を作る（`usage`・`check_path`・`write_entries`・`verify_tree`）。結合のテストに `exportTree` と `describe("木の取り出し（export-tree.sh）")` を足す。`.gitattributes` の `export-ignore`・`export-subst`・`text eol=crlf`・`ident`、シンボリックリンク、`..` と `.git` の部分を持つ項目、壊した出力先の照らし、診断に作り物の値が出ないことを観点にする（詳細設計書の「木の取り出しのスクリプト」の単体テストの観点）
- **満たす受け入れ条件:** 96:6・96:7
- **進め方:** 失敗するテスト → 通す最小実装 → 整理

### Task 3: 範囲の履歴の項目を取り出して照らす

- **対象ファイル:** `tools/checks/export-tree.sh`・`tools/test/leak-scan.integration.test.ts`
- **変更内容:** `--history <分岐点> <head> <出力先>` と `--verify-history` を作る（`write_history`・`verify_history`）。途中のコミットで足して後で消したパスの名前と、NUL を含むファイルの中身が `paths/`・`binary-text/`・`layers/` に入ること、出力先を 1 つずつ壊すと照らしが 1 で終えることをテストする
- **満たす受け入れ条件:** 96:6・96:7
- **進め方:** 失敗するテスト → 通す最小実装 → 整理

### Task 4: gitleaks を固定の版で置くスクリプトを作る

- **対象ファイル:** `tools/checks/install-gitleaks.sh`
- **変更内容:** 今の `ci.yml` の手順「gitleaks を固定の版と要約値で置く」の中身を移し、版と要約値をこのスクリプトだけに持たせる。この単位では `ci.yml` を変えない（呼び出しに替えるのは Task 7）
- **満たす受け入れ条件:** 無し（Task 7・9 が `ci.yml` と `leak-check-secret.yml` から呼ぶ準備）
- **進め方:** テスト駆動を適用しない。配布の資産を取りに行く処理なので単体テストで外の通信をしない。Task 7 の CI の定義のテスト（3 つのジョブが呼び、どのワークフローも版と要約値を持たない）と、CI の `leak-check` の実行で確かめる

### Task 5: 秘密の規則を重ねて今の木と範囲を探す

- **対象ファイル:** `tools/checks/leak-scan-secret.sh`・`tools/test/leak-scan.integration.test.ts`
- **変更内容:** `leak-scan-secret.sh` の `dir` と `git`（`--range` あり・なし）を作る（`usage`・`parse_args`・`build_overlay`・`run_scan`・`report_counts`）。重ねた設定を組むシェルを `ci.yml` の手順から移す。結合のテストに `secretScan` と `describe("秘密を使う探し（leak-scan-secret.sh）")` を足し、秘密が空・必須の組で 1 になること、出力に作り物の正規表現と当たった値が出ないことを確かめる
- **満たす受け入れ条件:** 96:6・96:7・101:2
- **進め方:** 失敗するテスト → 通す最小実装 → 整理

### Task 6: 取り出した履歴とマージコミットの木を探し、件数だけを出す

- **対象ファイル:** `tools/checks/leak-scan-secret.sh`・`tools/test/leak-scan.integration.test.ts`
- **変更内容:** `history` の探し、`--count-only` と `--details` を足す。結合のテストに `mergeRepo` を足し、base と head を合わせた後の木でだけ当たる値がマージコミットの木の探しで 1 になること、Task 3 の取り出しと組み合わせて途中のコミットにだけ在った値が 1 になること、`--count-only` の出力が当たった場所によって変わらないことを確かめる（設計書のテスト設計の決定 5・決定 8 の行）
- **満たす受け入れ条件:** 96:1・96:2（このリポジトリの側の探し）・96:7・96:9
- **進め方:** 失敗するテスト → 通す最小実装 → 整理

### Task 7: Pull Request の探しから秘密を外し、main への push の探しを分ける

- **対象ファイル:** `.github/workflows/ci.yml`・`tools/test/ci-definition.test.ts`
- **変更内容:** 最初に #101 の再現のテストを書く。`leakJobViolations`・`patternSecretReaders`・`actorConditions` と `NOT_REQUIRED_JOBS` を足し、今の `ci.yml` で `leak-check` が秘密と必須の変数を受けていることが印として出る（今は落ちる）ことを確かめる。その後に `ci.yml` の `leak-check` を Pull Request だけにして秘密を外し、`leak-check-push`（`environment: leak-scan`・`leak-scan-secret.sh dir --count-only` と範囲なしの `git --count-only`）を足し、両方のジョブの gitleaks を置く手順を `install-gitleaks.sh` の 1 行に替える。`pullRequestChecks` は `NOT_REQUIRED_JOBS` を除いて数え、必須のチェックの宣言（7 つ）は変えない
- **満たす受け入れ条件:** 101:1・101:2・101:3・101:4・101:7・96:8・96:9・96:10
- **進め方:** 失敗するテスト（#101 の再現）→ 通す最小実装 → 整理

### Task 8: ワークフローごとの起動の許可を縛る

- **対象ファイル:** `tools/test/ci-definition.test.ts`
- **変更内容:** `loadWorkflows` の読む処理を `loadWorkflowFile` に、`triggersPullRequest` の読み方を `triggerNames` に切り出す（振る舞いは変えない）。`triggerViolations` と `ALLOWED_TRIGGERS`・`CALLER_PATH` を足す
- **満たす受け入れ条件:** 96:3
- **進め方:** 切り出しは今のテストが通ったままであることで確かめる → `triggerViolations` は失敗するテスト → 通す最小実装 → 整理

### Task 9: 秘密を受ける再利用できるワークフローを作る

- **対象ファイル:** `.github/workflows/leak-check-secret.yml`・`tools/test/ci-definition.test.ts`
- **変更内容:** `runCommandWords`・`secretWorkflowViolations`・`SECRET_WORKFLOW_COMMANDS` を足し、決定 4 の箇条を 1 つずつ壊した作り物で印が 1 つだけ出るテストを先に書く。その後に `leak-check-secret.yml` を作る（入力の形の確認・チェックアウト・gitleaks を置く・Pull Request の参照の取り込みと確かめ・マージコミットの木と履歴の項目の取り出し・探す）。`permissions` が `contents: read` だけの今の検査が新しいワークフローにも掛かることを確かめる
- **満たす受け入れ条件:** 96:1・96:2・96:3・96:4・96:5（このリポジトリの側。ジョブの表示名に 6 つの入力が入ること）・96:6・96:10
- **進め方:** 失敗するテスト → 通す最小実装 → 整理

### Task 10: 呼び出しのワークフローの見本を作る

- **対象ファイル:** `docs/operations/leak-check-caller.yml`・`tools/test/ci-definition.test.ts`
- **変更内容:** `callerViolations` を足し、`secrets: inherit`・`@` の後を SHA にする・世代の確かめを外す作り物で当たるテストを先に書く。その後に見本（ジョブ `generation` と `scan`）を作る。見本も `permissions`・`actorConditions`・`triggerViolations` の検査に入れる
- **満たす受け入れ条件:** 96:3・96:4・96:5（世代が `0` か入力と違うときに呼ぶ前に失敗する）・101:4
- **進め方:** 失敗するテスト → 通す最小実装 → 整理

### Task 11: 持ち主の操作の手順を書き、指示書を直す

- **対象ファイル:** `docs/operations/ci-checks.md`・`AGENTS.md`
- **変更内容:** 詳細設計書の「運用の文書と指示書」の「書く節」の表のとおりに `ci-checks.md` を書く。`AGENTS.md` の「`leak-check` のジョブが `.gitleaks.toml` に重ねて探す」の文を直し、`ci-checks.md` へリンクする
- **満たす受け入れ条件:** 101:5（設計書の決定 2 で満たし、運用の文書から引く）・101:6
- **進め方:** テスト駆動を適用しない。文書の検査は持たず、レビューで見る（設計書のテスト設計の `101:6` の行）。参照の検査と漏れの検査が通ることだけを CI で確かめる

## レビューの単位

1 本目の見込みの差分は合わせて約 2,600 行で 1,000 行を超えるので、依存の向き（取り出し → 探し → ジョブの分け方 → 秘密を受けるワークフロー → 文書）で 5 つに分ける。どの単位も、それより前の単位だけに依存し、単独でテストが通る。行数は `git diff --shortstat <ベース>...HEAD -- . ':(exclude)issues/issue-*'` で数える（工程が書く `issues/` の文書は数えない）。

| 単位 | 含むタスク | 満たす受け入れ条件 | 見込みの差分の行数 | 実際の行数 |
| --- | --- | --- | --- | --- |
| 退行テストと木の取り出し | Task 1・2・3 | 96:6・96:7・96:8・96:9 | 約 650 | 664（`96cafea`） |
| 秘密を使う探しのスクリプト | Task 4・5・6 | 96:1・96:2・96:6・96:7・96:9・101:2 | 約 600 | 584（`22be6f4`） |
| CI の漏れの検査のジョブの分け方 | Task 7 | 96:8・96:9・96:10・101:1・101:2・101:3・101:4・101:7 | 約 400 | 321（`a953554`） |
| 秘密を受けるワークフローと見本 | Task 8・9・10 | 96:1・96:2・96:3・96:4・96:5・96:6・96:10・101:4 | 約 700 | 553（`2bdf72a`・`074aa55`。`074aa55` は単位 1 の `export-tree.sh` に実行の権限を付け、権限をテストで縛る直し） |
| 運用の文書と指示書 | Task 11 | 101:5・101:6 | 約 250 | 134（`8a99f4d`） |

`96:1`・`96:2`・`96:5` は、NDF がマージの直前に非公開の検査を起動して結果を確かめる NDF の側の機能で満たす部分を含む（設計書の「受け入れ条件の読み方」）。この計画の単位が満たすのは、このリポジトリの側（探しのスクリプトとワークフローの形）だけである。

## リファクタリングの時機

| 時機 | 対象 | 理由 |
| --- | --- | --- |
| 実装の前（準備のリファクタリング） | しない | 触る既存のファイルは `ci.yml` 222 行・`ci-definition.test.ts` 333 行・`leak-scan.integration.test.ts` 553 行・`AGENTS.md` 47 行で、どれも小さい。同じファイルを触るタスクの割合は、`leak-scan.integration.test.ts` が 11 タスク中 5、`ci-definition.test.ts` が 11 タスク中 4。テストは 2 つのテストのファイルにそれぞれ 22 ある。`loadWorkflowFile` と `triggerNames` の切り出しは設計書が決めた小さな変更で、Task 8 の中で今のテストを保ったまま行う |
| 実装の中 | 各タスクで行う | `tdd-cycle` のリファクタリングのステップ |
| スプリントの終わり（cross-refactoring） | (1) `tools/test/ci-definition.test.ts` の `leakJobViolations`（単位 3）と `secretWorkflowViolations`（単位 4）の、gitleaks を置く手順と `GITLEAKS_` の名前の確かめ。(2) `tools/test/leak-scan.integration.test.ts` の、子のプロセスを打つ補助の `scan`（今）・`exportTree`（単位 1）・`secretScan`（単位 2） | (1) は別の単位で同じ形の確かめを 2 か所に書くことになる。(2) は `spawnSync` で打って終了コードと出力を返す同じ形の処理が 3 つになる |

## リスクと対処

| リスク | 対処 |
| --- | --- |
| 単位 3 の `ci.yml` の変更が main に入ると、Pull Request の側の `leak-check` が秘密を受けなくなり、非公開の検査が動くまでの間、実際の値の規則で Pull Request を探さない | スプリントブランチから main へのマージは、設計書の決定 10 の手順 2〜3（環境 `leak-scan` の設定と、持ち主が手元で 1 本目を探す手順）の後にする。その間、NDF にほかの Pull Request をマージさせない。この順序は単位 5 の `ci-checks.md` の「導入の順序」に書く |
| `leak-check-push` が環境 `leak-scan` の秘密を受けられず、main への push の探しが `.gitleaks.toml` だけで動く | 変数 `LEAK_CHECK_REQUIRE_PATTERN` を `1` にするのは決定 10 の手順 4 で、それまでは「秘密が空なので `.gitleaks.toml` だけで探す」の行が出る。持ち主がこの行が出ていないことを確かめる（`ci-checks.md` に書く） |
| `export-tree.sh` のテストが、ファイルの権限（`0555`）やシンボリックリンクに頼り、CI の実行環境と手元で振る舞いが違う | 結合のテストは CI の `leak-check` で打たれるので、単位の Pull Request の CI で確かめる。root で動かすと権限の失敗が起きない場合は、詳細設計書の観点を変えずにテストの前提を確かめてから進める |
| 実際の Dependabot の Pull Request での確かめ（`101:1`）と、検証用のリポジトリでの確かめ（決定 10 の手順 1）は、この計画の単位では行えない | CI の定義のテストで定義から縛り、実際の確かめはリリース後の確認の計画（要求仕様の「リリース後の確認の計画」）に残す |

## 切り戻し手順

- 単位ごとの Pull Request はスプリントブランチへ出すので、単位の Pull Request を revert すれば戻せる。データの移行は無い
- main へのマージの後に戻すときは、1 本目の Pull Request を revert すれば、`ci.yml` の `leak-check` が今と同じく Actions の秘密を受ける形に戻る。持ち主が足した環境 `leak-scan` と非公開リポジトリは、残しても動くジョブが無いので害は無い

## 完了の定義

- [ ] 受け入れ条件（96:1〜96:10・101:1〜101:7）のうち、このリポジトリの側で満たす部分をすべて満たし、条件ごとに検証手段と結果が対応している。NDF の側と実際の Dependabot の Pull Request で確かめる部分は、確かめる時点と方法が書いてある
- [ ] `npm run check` と、結合のテスト（`npm run test:integration -- leak-scan`）が通る
- [ ] CI の `workflow-audit` のジョブが当たり無しで通る（96:10）
- [x] 「レビューの単位」の表の実際の行数を書き足した（合わせて 2,248 行）
