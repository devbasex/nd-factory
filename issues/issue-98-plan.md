# 98: 漏れの検査で、サービスの token・バイナリと圧縮の中の秘密・作り物に見せた端点を止める

## 関連リンク

- 要求仕様: [issue-98-requirements.md](./issue-98-requirements.md)（正は [#98](https://github.com/devbasex/nd-factory/issues/98) の本文）。受け入れ条件は番号で指す
- 設計書: [issue-98-design.md](./issue-98-design.md)。詳細設計: [issue-98-design-detail.md](./issue-98-design-detail.md)。決定の記録: [issue-98-design-decisions.md](./issue-98-design-decisions.md)
- モード: `standard`（スプリントに渡されたモード）

## 修正対象

詳細設計の「地図」から引き写す。関数の仕様は詳細設計を引く。

| ファイル | 変える中身 |
| --- | --- |
| `.gitleaks.toml` | token の 2 規則を足し、許可を絞る（決定 1・5） |
| `tools/checks/leak-scan.sh` | 引数と前提を確かめて本体へ渡すだけにする |
| `tools/checks/leak_scan/`（新設。`main.py`・`model.py`・`gitleaks.py`・`tree.py`・`history.py`・`relay.py`・`copyrepo.py`・`archive.py`） | 検査の本体 |
| `tools/checks/leak-scan-secret.sh` | 新しい失敗の行を見分ける（決定 7） |
| `tools/checks/install-gitleaks.sh` | gitleaks の既定の設定のファイルも置く（決定 6） |
| `tools/test/leak-scan.integration.test.ts` | 設計書の「テスト設計」の結合テストを足し、前提の変わるテストと補助を直す |
| `docs/design/detail.md`・`AGENTS.md` | 「秘密の形のデータ」の行と、許可と食い違う例の行を直す |
| `docs/specifications/leak-check.md`・`docs/operations/ci-checks.md` | 記述を実装に合わせる |
| `docs/specifications/ndf-contract-use.md`・`packages/contracts/test/ndf-contract-use.test.ts`・`packages/contracts/src/web-config.ts` | `acme` の置き場と端点の例を書き換える |
| `infra/test/app-stack-login.test.ts`・`infra/test/app-stack.test.ts`・`infra/test/nd-setup.test.ts` | Cognito の端点をテストの中で組み立てる |

## タスク分解

進め方はどのタスクも次のとおりで、タスクごとには違う点だけを書く。

- 設計書の「テスト設計」の行のうち、そのタスクが扱う分を先に `leak-scan.integration.test.ts` に書いて落ちることを見てから、通す最小の実装を書く。Python の単体テストの基盤は足さない（詳細設計の「テストの組み方」）
- 当てる値は実行中に乱数から作り、ファイルに書かない
- 手元の確かめは `tools/checks/install-gitleaks.sh <木の外のディレクトリ>` で置いた gitleaks を `PATH` に足し、`npm run test:integration -- leak-scan` を打つ

不具合の再現のテストは Task 2 から置く。Task 1 は、設計書の「導入の順序」が許可だけを先に main へ入れると決めているため、テストを持たずに先に置く。

### Task 1: 作り物の S3 の置き場の例を許す許可を、先に足す

- **対象ファイル:** `.gitleaks.toml`
- **変更内容:** `nd-aws-arn-s3` と `nd-aws-endpoint` に決定 5 の許可 1 を足す。今の許可は消さず、例・テスト・文書は入れない
- **満たす受け入れ条件:** 98:6 の前提
- **進め方:** テスト駆動を適用しない（設計書の「導入の順序」の 1 本目はテストを入れない）。今の結合テストが通ることを確かめる

### Task 2: サービスの token を当て、許可を名前の全体に絞る

- **対象ファイル:** `.gitleaks.toml`、`leak-scan.integration.test.ts`、`AGENTS.md`、`docs/specifications/ndf-contract-use.md`、`packages/contracts/test/ndf-contract-use.test.ts`、`packages/contracts/src/web-config.ts`、`infra/test/` の 3 本
- **変更内容:** token の再現のテストと端点の再現のテストを置いてから、決定 1 の 2 規則と決定 5 の許可を書く。`acme` の例を書き換え、infra のテストは端点の文字列をソースに持たない形にする。「作り物の値だけの木では当たらない」の 2 つのテストの値を差し替える
- **満たす受け入れ条件:** 98:1、98:5、98:6
- **進め方:** テスト設計の 1・5・6 の行。infra と contracts は変えたテストのファイルだけを打つ

### Task 3: 詳細設計の「秘密の形のデータ」の行を直す

- **対象ファイル:** `docs/design/detail.md`
- **変更内容:** データを読む処理として、実行時の `redact` と生成時のダミーデータの検査の 2 つを書き、gitleaks の設定がこのデータを読まず生成もしない記述を残す
- **満たす受け入れ条件:** 98:8
- **進め方:** 文書の直しのためテスト駆動を適用しない

### Task 4: 検査の本体を、振る舞いを変えずに Python へ移す

- **対象ファイル:** `leak-scan.sh`、`leak_scan/main.py`・`model.py`・`gitleaks.py`、`leak-scan.integration.test.ts`
- **変更内容:** 詳細設計の「起動と流れ」のとおり `leak-scan.sh` から本体を起こす。今の `finish`・`log_has_skipped`・`note_hidden` の出力と終了コードを `conclude`・`run_gitleaks`・`parse_log_line`・`read_report` へ移す。この時点では記録の段も gitleaks の引数も変えない。足すのは `python3` が無いときと想定外の例外の扱いである
- **満たす受け入れ条件:** 98:7 の前提
- **進め方:** 今の結合テストが振る舞いを縛る。テストの期待は変えず、足すのは `python3` が無いときに 1 で終えるテストだけである

### Task 5: 今の木で、gitleaks が飛ばしたファイルを写しで探し直す

- **対象ファイル:** `leak_scan/relay.py`・`copyrepo.py`・`tree.py`（新設）、`gitleaks.py`・`main.py`・`model.py`、`leak-scan-secret.sh`、`leak-scan.integration.test.ts`
- **変更内容:** 記録の段を trace にし、飛ばした行を分ける（`classify_skip`）。目印の中継と写しのリポジトリで 2 回目を打ち、決定 4 の条件を確かめる。終了コードと件数を、目印を除いた当たりと失敗の印だけから決める。`count_failed` に「飛ばしたファイルを探せない」の行を足す。`--paths` のときに出す記録の段が変わるので、偽の gitleaks の診断の行を INF の段にする
- **満たす受け入れ条件:** 98:3、98:4（今の木の分）
- **進め方:** テスト設計の 3、「3・4」、「4」の行のうち `dir` の分と、段を上げても当たった値を出さない行。決定 7 の行の今の木の分

### Task 6: 今の木で、全体の許可が名前で外したファイルを探し直す

- **対象ファイル:** `leak_scan/gitleaks.py`・`tree.py`、`install-gitleaks.sh`、`leak-scan.integration.test.ts`
- **変更内容:** 全体の許可のパス条件を外した設定を作る（`write_rescan_config`）。対象外のパスを `is_excluded` に置き、外れたディレクトリの下を列挙する。`install-gitleaks.sh` が既定の設定のファイルを固定の要約値で置く。偽の gitleaks を使うテストには、隣に既定の設定のファイルを写す。「既定の全体の許可がパスで外すファイルの値は当てず…」のテストを書き換える
- **満たす受け入れ条件:** 98:3、98:4（今の木の分）
- **進め方:** テスト設計の「2・6」「3・6」「4・6」「6」の行のうち今の木の分

### Task 7: 履歴で、読み終えたことを目印で確かめる

- **対象ファイル:** `leak_scan/history.py`（新設）、`main.py`・`relay.py`・`copyrepo.py`・`model.py`、`leak-scan-secret.sh`、`leak-scan.integration.test.ts`
- **変更内容:** `list_entries` で探す対象を決め、1 回目に `--text` などと中継を足し、`check_markers` で確かめる。全体の許可が外した対象は変更前と変更後の blob を写しで探し、`added_lines` と `attribute` で当たりを絞る。写しの探しでは中継が `commit` の行を元のコミットに書き換える。`count_failed` に履歴の行を足す。偽の gitleaks を使う `git` のテストと、報告を読めない `git` のテストの期待を直す
- **満たす受け入れ条件:** 98:2、98:4（履歴の分）
- **進め方:** 最初に、途中のコミットの NUL を含むファイルの再現のテストを置く。テスト設計の「2」「2・4」「2・6」の行のうち、足した行の探しと、全体の許可が外したファイルの分。決定 7 の行の履歴の分

### Task 8: 履歴で、バイナリの blob の全体を探す

- **対象ファイル:** `leak_scan/history.py`・`main.py`、`leak-scan.integration.test.ts`
- **変更内容:** `is_binary` の 3 条件に当たる対象の blob 全体を写しで探し、`merge_findings` で足した行の探しの当たりと合わせる
- **満たす受け入れ条件:** 98:2
- **進め方:** テスト設計の「2」「2・3」「2・6」の行のうち、バイナリの分（複数行の秘密、`-diff` 属性、当たりの件数、行の削除で成立する秘密、途中の版）

### Task 9: アーカイブと圧縮ファイルを展開して探す

- **対象ファイル:** `leak_scan/archive.py`（新設）、`model.py`・`tree.py`・`history.py`・`main.py`、`leak-scan.integration.test.ts`
- **変更内容:** `detect`・`expand`・`normalize_name` と展開の上限を書き、今の木と履歴の写しに葉のファイルを足す
- **満たす受け入れ条件:** 98:4
- **進め方:** テスト設計の「3・4」「4」の行のうち展開の分と、同じ写しのパスになる 2 つの項目を持つ zip の分

### Task 10: 仕様と手順の記述を合わせ、マージの前の確認をする

- **対象ファイル:** `docs/specifications/leak-check.md`、`docs/operations/ci-checks.md`
- **変更内容:** 探しの流れ・失敗の行・終了コード・部品の表を実装に合わせる。`ci-checks.md` で秘密を渡す前に読むファイルの並び（「6 つのファイル」）と、検査のコードを別のディレクトリへ写す手順に `leak_scan/` を足す。写すのが 2 つのスクリプトだけでは、`leak-scan.sh` が本体を起こせない
- **満たす受け入れ条件:** 98:7
- **進め方:** 文書の直しのためテスト駆動を適用しない。テスト設計の「7（マージの前の確認）」の行のとおり、最終のマージの候補の木と全履歴を探す

## レビューの単位

差分は `git diff --shortstat <ベース>...HEAD -- . ':(exclude)issues/'` で数える。見込みの合計が 1,000 行を超えるので、タスクの依存の向きで分ける。どの単位も、終えた時点で結合テストが通り、このリポジトリの `leak-check` が動く。単位は表の順に流す。

| 単位 | 含むタスク | 満たす受け入れ条件 | 見込みの差分の行数 | 実際の行数 |
| --- | --- | --- | --- | --- |
| #98 の 1: 先に入れる許可 | Task 1 | 98:6 の前提 | 約 10 | |
| #98 の 2: 規則と許可 | Task 2・3 | 98:1・98:5・98:6・98:8 | 約 400 | |
| #98 の 3: 本体の移し替え | Task 4 | 98:7 の前提 | 約 450 | |
| #98 の 4: 今の木の探し直し | Task 5 | 98:3 | 約 900 | |
| #98 の 5: 今の木の名前で外したファイル | Task 6 | 98:3 | 約 450 | |
| #98 の 6: 履歴の確かめ | Task 7 | 98:2 | 約 950 | |
| #98 の 7: 履歴のバイナリ | Task 8 | 98:2 | 約 450 | |
| #98 の 8: 展開と文書 | Task 9・10 | 98:4・98:7 | 約 900 | |

Task 6 を Task 7 より先に置くのは、履歴の確かめが対象外のパスの判定と、パス条件を外した設定を使うためである。Task 7 は目印の確かめと、全体の許可が外したファイルの探し直しを分けない。分けると、`package-lock.json` を変える範囲の探しが失敗する状態で単位が終わる。

## リファクタリングの時機

| 時機 | 対象 | 理由 |
| --- | --- | --- |
| 実装の前（準備のリファクタリング） | しない | `leak-scan.sh`（168 行）の処理は Task 4 で Python へ移すので、先に整える対象が残らない。`leak-scan.integration.test.ts` は 1503 行で `it` の宣言が 79 件あり、10 タスクのうち 7 つが足すが、足すのは独立したテストで、既存の補助を使える |
| 実装の中 | 各タスクで行う | `tdd-cycle` のリファクタリングのステップ |
| スプリントの終わり（cross-refactoring） | `leak_scan/` の `main.py`・`tree.py`・`history.py`・`copyrepo.py` と、結合テストの補助の関数 | 今の木と履歴の写しの探しが単位 4〜8 にまたがり、対象を写しに足す処理と失敗の印の扱いが重なりうる。テストのファイルは 7 つの単位が足す |

## リスクと対処

| リスク | 対処 |
| --- | --- |
| 単位 1 の許可は main に入るまで非公開の検査に効かない | 単位 1 の Pull Request は main へ出す（設計書の「導入の順序」の 1 本目）。マージの後に main をスプリントブランチへ取り込んでから、単位 2 を始める。単位 2〜8 は 2 本目としてまとめて main へ入れる |
| `acme` の許可を外すことと、受け入れ条件 5・6 の書き直しの、起票者の承認が未確認（設計書の「未確認のまま残ること」） | 単位 2 の前に承認を確かめる。残すと決まったら、同じ節の「`acme` の許可を残すと決めたとき」のとおり Task 2 を変える |
| NDF がマージの直前に変更の有無を見るファイルの並び（`leak-check.md` の「次の 7 つのファイル」）に、新しい `leak_scan/` が無い。設計書はこの並びの扱いを書いていない | cross-review の指摘を受けて、`leak-check.md` に「秘密を受けて動くコードと設定の一覧」を置き、`tools/checks/leak_scan/` を接頭辞で含めた。持ち主の事前の確認は取っていないので、Pull Request の承認で確かめる。NDF の側の実装はこの一覧に合わせる |
| 探し直しと展開で、`leak-check` の時間が延びる（ジョブの上限は 15 分） | 2 本目の Pull Request の `leak-check` の実行時間を見る |
| 名前で外していたファイルを探すので、今の木か履歴に誤検知が出る | 当てた規則の許可を足す。Task 10 のマージの前の確認で、全履歴を探す |

## 切り戻し手順

- 2 本目の Pull Request のマージコミットを戻せば、検査は今の振る舞いに戻る。データの移行は無い
- 1 本目の許可は、作れない名前の例を通すだけなので、残してよい

## 完了の定義

- [ ] 受け入れ条件 98:1〜98:8 をすべて満たし、条件ごとに設計書の「テスト設計」の行と結果が対応している
- [ ] `npm run check`、`npm run test:integration -- leak-scan`、CI の `check`・`ref-check`・`leak-check` が通る
- [ ] 設計書の「テスト設計」の「7（マージの前の確認）」の行を満たしている
