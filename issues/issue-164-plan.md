# 164: 反映のパイプラインを承認の段の無い流れにそろえ、反映の直前の検査を足す

## 関連リンク

- 要求仕様: [issue-164-requirements.md](./issue-164-requirements.md)（正は [#164](https://github.com/devbasex/nd-factory/issues/164) の本文）。受け入れ条件は番号で指す
- 設計書: [issue-164-design.md](./issue-164-design.md)
- 詳細設計書: [issue-164-design-detail.md](./issue-164-design-detail.md)。関数のシグネチャ・事後条件・異常系・単体テストの観点はここを引く
- モード: `standard`（#164 の本文の「進行」の欄の「モード」による）

## 修正対象

詳細設計書の「地図」から写す。テストのファイルも含む。`docs/design/`・MVV・開発の指針の Skill は設計の Pull Request で直してあるので、触らない。`infra/setup/` にも差分を出さない（受け入れ条件 11）。

| ファイル | 変える中身 |
| --- | --- |
| `infra/lib/pipeline-stack.ts` | 準備の手順に契約の照合と設定の版の出力を足す。起点のブランチに絞った push のトリガーにする。承認を拒む方針を消す。反映の手順の先頭で検査を打ち、反映のプロジェクトのロールと変数を直す |
| `infra/lib/naming.ts` | 方針の名前を返さない。アプリ専用の qualifier と、反映に使う資源の名前を足す |
| `infra/lib/confirmation-stage.ts`（新設） | 設定の値と宣言の記録から、段階と反映を拒むかを決める |
| `infra/lib/assembly-check.ts`（新設） | 合成の結果の形、段階の値、IAM のロールを調べる。型 `GuardConfig` を置く |
| `infra/lib/deploy-guard.ts`（新設） | `cdk deploy` の直前の検査を順に打つ |
| `infra/lib/app-bootstrap-template.ts`（新設） | CDK の標準の bootstrap のテンプレートに、設置ごとの制約を当てる |
| `infra/lib/bootstrap-collision.ts`（新設） | qualifier が別の設置と衝突しないかを判定する |
| `infra/bin/app-bootstrap.ts`（新設） | 衝突の確認と、テンプレートの書き出しのコマンド |
| `infra/bin/app.ts` | `pipeline` がある設置のアプリのスタックを、アプリ専用の qualifier と権限の境界で合成する |
| `infra/lib/app-stack.ts` | コメントだけを直す |
| `packages/contracts/src/settings.ts`・`packages/contracts/schema/settings.schema.json` | `pipeline.branch` の文字を限る。スキーマは `npm run generate` で作り直す |
| `packages/contracts/test/fixtures/confirmation-stage-cases.json`（新設） | 段階の判定の入力と期待する結果の表 |
| `packages/contracts/test/settings.test.ts` | ブランチ名の形のテスト |
| `infra/test/pipeline-stack.test.ts` | スタック、2 つの手順、反映の直前の検査のテスト |
| `infra/test/naming.test.ts`・`infra/test/app.test.ts` | 名前と、合成の qualifier と境界のテスト |
| `infra/test/app-bootstrap-template.test.ts`・`infra/test/bootstrap-collision.test.ts`（新設） | テンプレートの制約、衝突の判定、コマンドの引数と終了コードのテスト |
| `package.json`・`infra/package.json`・`package-lock.json`・`knip.jsonc` | スクリプト `app-bootstrap` と依存を足し、knip の設定を直す |
| `docs/operations/pipeline-approval.md`・`setup.md`・`settings.md`・`idp-and-apps.md`、`AGENTS.md` | 承認の段の無い流れに書き直す |

## タスク分解

変更の種類は機能追加なので、最初に今の振る舞いを縛る退行テストを置く。テストは偽の応答と作り物の値だけを使い、実際の AWS を呼ばない。各タスクで打つのは範囲のテストと型検査までにする。

### Task 1: 変えてはいけない振る舞いを退行テストで縛る

- **対象ファイル:** `infra/test/app.test.ts`、`infra/test/pipeline-stack.test.ts`
- **変更内容:** `pipeline` が無い設定のアプリのスタックと、パイプラインのスタックの合成が、既定の qualifier（`hnb659fds`）のままであることを確かめるテストを足す。段の並び、要約値の受け渡しと照合、失敗の通知は今のテストがあるので、通ることを確かめる
- **満たす受け入れ条件:** 1、2、3、11
- **進め方:** 今の振る舞いを縛るので、書いた時点で通る。qualifier を一時的に変えると落ちることを確かめてから戻す

### Task 2: 承認を拒む方針をスタックから消す

- **対象ファイル:** `infra/lib/pipeline-stack.ts`、`infra/lib/naming.ts`、`infra/test/pipeline-stack.test.ts`、`infra/test/naming.test.ts`
- **変更内容:** 方針の資源と `pipelineResourceNames` の `denyApprovalPolicy` を消す。方針があることを確かめる今のテストは、管理の方針が無いことのテストに置き換える。`naming.test.ts` で方針の名前を `resourceName` の例に使う行も別の用途名にする（`git grep -n -E "deny-approval|PutApprovalResult" -- infra docs/design` を 0 件にするため、テストの名前とコメントにもこの 2 語を残さない）
- **満たす受け入れ条件:** 4（スタックの側）
- **進め方:** 失敗するテスト → 消す → 整理

### Task 3: 準備のアクションで契約を照合し、設定の版を出力する

- **対象ファイル:** `infra/lib/pipeline-stack.ts`（`prepareBuildSpec`）、`infra/test/pipeline-stack.test.ts`
- **変更内容:** 詳細設計の「準備のアクション」の命令の並びにする。照合の行はパイプや `||` や `;` でつながない。出力の変数に `SETTINGS_VERSION` と `SETTINGS_SHA256` を足す
- **満たす受け入れ条件:** 8（決定 1 の実装）、12
- **進め方:** 失敗するテスト（設計書の「テスト設計」の決定 1 と決定 6 の設定の版の行）→ 通す最小実装 → 整理

### Task 4: 起点のブランチへの push だけで実行が始まるようにする

- **対象ファイル:** `packages/contracts/src/settings.ts`、`packages/contracts/schema/settings.schema.json`、`packages/contracts/test/settings.test.ts`、`infra/lib/pipeline-stack.ts`、`infra/test/pipeline-stack.test.ts`
- **変更内容:** `pipeline.branch` を詳細設計の「設定のスキーマ」の形に限り、`npm run generate` を打つ。ソースのアクションは `triggerOnPush: false` にし、起点のブランチだけを含む push のトリガーを `Pipeline` に足す
- **満たす受け入れ条件:** 1、12
- **進め方:** 失敗するテスト → 通す最小実装 → 整理

### Task 5: パイプラインを使う設置のアプリを、専用の qualifier と境界で合成する

- **対象ファイル:** `infra/lib/naming.ts`、`infra/bin/app.ts`、`infra/test/naming.test.ts`、`infra/test/app.test.ts`
- **変更内容:** `appQualifier`・`launchDeclaredParameterName`・`deployRoleName`・`appBootstrapNames`・`cdkRoleArn` を足し、`buildApp` を詳細設計の「アプリの合成」のとおりにする
- **満たす受け入れ条件:** 11、12
- **進め方:** 失敗するテスト（詳細設計の「資源の名前」と「アプリの合成」の単体テストの観点）→ 通す最小実装 → 整理

### Task 6: qualifier の衝突を判定する

- **対象ファイル:** `infra/lib/bootstrap-collision.ts`、`infra/test/bootstrap-collision.test.ts`
- **変更内容:** `checkQualifier` と、読み取りを差し替える型 `BootstrapReader` を作る
- **満たす受け入れ条件:** 12
- **進め方:** 失敗するテスト（衝突する 2 つの作り物の設置を含む）→ 通す最小実装 → 整理

### Task 7: bootstrap のテンプレートに設置ごとの制約を当てる

- **対象ファイル:** `infra/lib/app-bootstrap-template.ts`、`infra/test/app-bootstrap-template.test.ts`、`infra/package.json`、`package-lock.json`
- **変更内容:** `appExecutionPolicy`・`appPermissionsBoundary`・`restrictBootstrapTemplate` と、定数 `EXECUTION_ALLOW`・`APP_BOUNDARY` を作る。`yaml` を `tools` と同じ版で足す。操作の一覧は、今のアプリのスタックの合成の結果とアプリのロールから作る
- **満たす受け入れ条件:** 11、12
- **進め方:** 失敗するテスト（詳細設計の「アプリ専用の bootstrap」の単体テストの観点）→ 通す最小実装 → 整理

### Task 8: 衝突の確認とテンプレートの書き出しをコマンドにする

- **対象ファイル:** `infra/bin/app-bootstrap.ts`、`infra/test/bootstrap-collision.test.ts`、`package.json`、`infra/package.json`、`package-lock.json`
- **変更内容:** `parseArgs`・`bootstrapReader`・`mainAppBootstrap` を作り、スクリプト `app-bootstrap` と `@aws-sdk/client-cloudformation` を足す。`parseArgs` と `mainAppBootstrap` のテストは、地図にあるテストのファイルのうち、衝突の判定のテストと同じファイルに置く。`infra/setup/` は読むだけで変えない
- **満たす受け入れ条件:** 11、12
- **進め方:** 失敗するテスト → 通す最小実装 → 整理。`bootstrapReader` は単体では打たない

### Task 9: 段階の判定と、その契約の表を作る

- **対象ファイル:** `infra/lib/confirmation-stage.ts`、`packages/contracts/test/fixtures/confirmation-stage-cases.json`、`infra/test/pipeline-stack.test.ts`
- **変更内容:** `confirmationStage`・`refusalReason`・型 `RecordState` を作る。表の行は設計書の決定 6 の「段階の判定規則の正本と契約テスト」の一覧にする。2 つのキーのスキーマは足さない（[#181](https://github.com/devbasex/nd-factory/issues/181)）
- **満たす受け入れ条件:** 12
- **進め方:** 表と、表の全行を打つ失敗するテスト → 通す最小実装 → 整理

### Task 10: 合成の結果を調べる

- **対象ファイル:** `infra/lib/assembly-check.ts`、`infra/test/pipeline-stack.test.ts`
- **変更内容:** `checkAssembly`・`checkTemplateStage`・`checkTemplateRoles`・型 `GuardConfig` を作る。`node:` の組み込みだけを読み、`naming.ts` を読まない
- **満たす受け入れ条件:** 12
- **進め方:** 失敗するテスト → 通す最小実装 → 整理。実際のアプリのスタックの合成を受け入れるテストを最初に書く。条件が合成の結果と合わなければ、条件を緩めず設計へ戻す

### Task 11: 反映の直前の検査を順に打つ

- **対象ファイル:** `infra/lib/deploy-guard.ts`、`infra/test/pipeline-stack.test.ts`
- **変更内容:** 詳細設計の「反映のアクション」の `runDeployGuard` と各検査、`awsCli`・`main` を作る。検査の順は「処理の手順」の表にする
- **満たす受け入れ条件:** 12
- **進め方:** 失敗するテスト（`aws` は偽の関数）→ 通す最小実装 → 整理

### Task 12: 検査をパイプラインの反映の段につなぐ

- **対象ファイル:** `infra/lib/pipeline-stack.ts`、`infra/test/pipeline-stack.test.ts`、`knip.jsonc`
- **変更内容:** `bundleDeployGuard`・`guardConfig` を足し、`deployBuildSpec` に束ねた検査の引数を足す。反映のプロジェクトのロールの名前と権限、反映のアクションの環境変数、準備のプロジェクトの引き受け先を、詳細設計の「パイプラインのスタック」のとおりにする。`infra` の `ignoreDependencies` の `esbuild` を外す
- **満たす受け入れ条件:** 1、2、12
- **進め方:** 失敗するテスト（検査 → 要約値 → 反映の順、手順の長さが 25,600 文字未満、ロールの権限が一覧だけ）→ 通す最小実装 → 整理

### Task 13: 手順書 `pipeline-approval.md` を書き直す

- **対象ファイル:** `docs/operations/pipeline-approval.md`
- **変更内容:** パスを保ち、題と節の並びを詳細設計の「手順書」の表にする。設計書の「読んで確認する項目」のうち手順書に当たる項目をすべて書く。コマンド名と引数は、Task 8 で作ったものと合わせる。実際の値は書かない
- **満たす受け入れ条件:** 4、5、11、12
- **進め方:** 文書の直しのためテスト駆動を適用しない。「読んで確認する項目」を 1 つずつ本文と突き合わせる

### Task 14: ほかの運用の文書とコメントをそろえる

- **対象ファイル:** `docs/operations/setup.md`、`docs/operations/settings.md`、`docs/operations/idp-and-apps.md`、`AGENTS.md`、`infra/lib/app-stack.ts`
- **変更内容:** 詳細設計の「全体の設計・運用の手順書・開発の指針」の表と「アプリの合成」のコメントの直しを当てる。`setup.md` の差分は、受け入れ条件 11 の 2 か所だけにする
- **満たす受け入れ条件:** 6、11
- **進め方:** 文書とコメントの直しのためテスト駆動を適用しない。`git diff main -- infra/setup` が空であることと、`setup.md` の差分の位置を確かめる

## レビューの単位

#164 は見込みの差分が 1,000 行を超えるので、タスクの依存の向きで 6 つに分ける。単位の番号の順に流す。どの単位も単独でテストと型検査が通る。単位の Pull Request はスプリントブランチへ出し、main へ入れる実装の Pull Request は 1 つにする（設計書の決定 6 の「既設環境の切り替えの順序」の 0）。単位の途中の状態は反映しない。

| 単位 | 含むタスク | 満たす受け入れ条件 | 見込みの差分の行数 | 実際の行数 |
| --- | --- | --- | --- | --- |
| U1 段と準備とトリガー | Task 1〜4 | 164: 1、2、3、4、8、11、12 | 約 350 | 199 |
| U2 専用の qualifier と衝突の判定 | Task 5・6 | 164: 11、12 | 約 350 | 255 |
| U3 bootstrap のテンプレートとコマンド | Task 7・8 | 164: 11、12 | 約 900 | 1089 |
| U4 段階の判定と合成の結果の検査 | Task 9・10 | 164: 12 | 約 700 | 586 |
| U5 反映の直前の検査と接続 | Task 11・12 | 164: 1、2、12 | 約 900 | 969 |
| U6 運用の文書 | Task 13・14 | 164: 4、5、6、11、12 | 約 400 | 370 |

依存の向きは次のとおりである。U3 と U4 は U2 の名前と合成を使う。U5 は U1 の手順と U4 の検査を使う。U6 は U3 のコマンドと U5 の検査を書く。

行数は `git diff --shortstat <ベース>...HEAD -- . ':(exclude)package-lock.json' ':(exclude)packages/contracts/schema' ':(exclude)issues'` で数える。U3 か U5 が 1,000 行を超えそうなときは、タスクの境目で分ける。

## リファクタリングの時機

| 時機 | 対象 | 理由 |
| --- | --- | --- |
| 実装の前（準備のリファクタリング） | しない | 触る今のコードは小さい。`pipeline-stack.ts` は 249 行で、触るのは 14 タスク中 4 タスク（Task 2・3・4・12）。`naming.ts` は 102 行。`pipeline-stack.test.ts` は 224 行あり、段・手順・ロールを覆っている。大きい追加は新しいファイルに分かれる |
| 実装の中 | 各タスクで行う | `tdd-cycle` のリファクタリングのステップ |
| スプリントの終わり（cross-refactoring） | 資源の ARN の組み立て、AWS の読み取りの失敗の扱い、`infra/test/pipeline-stack.test.ts` の分割 | ARN の組み立ては `guardConfig`・実行の方針・境界の 3 か所に、読み取りの失敗の扱いは検査と衝突の確認に現れる（U3〜U5 をまたぐ）。テストのファイルには U1・U4・U5 が足す |

## リスクと対処

| リスク | 対処 |
| --- | --- |
| 束ねた検査を埋め込んだ反映の手順が、25,600 文字を超える | Task 12 の長さのテストで見つける。超えたら埋め込み方を変えず、設計へ戻す |
| 合成の結果の実際の形が、検査の条件と違う | Task 10 で実際の合成を受け入れるテストを先に書く。条件を緩めず設計へ戻す |
| アプリのスタックのロールの物理名が `<prefix>-<environment>-app-` で始まらない形になる | 条件を緩めず設計へ戻す。既設の環境では、切り替えの前の物理名の確認で止める（設計書の決定 6） |
| 実装の Pull Request を、切り替えの手順の前に main へマージする | PR の本文に、リリース承認ゲートの承認と、設計書の決定 6 の「既設環境の切り替えの順序」に従うことを書く。権限の差分（A1）と `AGENTS.md` の差分（A5）も承認の対象として挙げる |
| 実行の方針と境界の操作の一覧に、過不足がある | テストで合成の結果の資源の型とロールの操作を覆い、一覧の差分をリリース承認ゲートで人が見る |

## 切り戻し手順

- main へマージする前は、コミットを戻せば元になる。データの移行は無い
- パイプラインのスタックとアプリ専用の bootstrap を反映した後の戻しは、AWS の資源と権限を変えるので、人へ戻して持ち主が決める
- 権限の境界を初めて付けるアプリの反映が失敗すると、境界を外す操作が拒否され、巻き戻しも失敗しうる。反映の段への遷移を止めて人へ戻す（設計書の決定 6）

## 完了の定義

- [ ] 受け入れ条件 1〜12 のすべてに、検証手段と結果が対応している（手段は設計書の「テスト設計」）
- [ ] 受け入れ条件 7〜10 は設計の Pull Request で満たしてある。実装の後も保たれていることを、設計書の「テスト設計」の行の手段で確かめる
- [ ] 全体のテスト（`npm run check`・knip・依存の検査）が通る
- [ ] `git diff main -- infra/setup docs/design` が空である
- [ ] 受け入れ条件 1・3 の実際の環境での確認と、条件 12 の運用の確かめは、リリースの工程で行う（設計書の「リリースの後に確かめること」と「承認を受ける操作」）
