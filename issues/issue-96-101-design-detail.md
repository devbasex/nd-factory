# #96 #101 の詳細設計: 実際の値の規則での Pull Request の探しを非公開のリポジトリへ移す

設計文書 [issue-96-101-design.md](./issue-96-101-design.md) の構成要素と構造を、ファイルと関数の粒度へ下ろした文書である。別ファイルにしたのは、新設する関数が 2 つ以上あるためである（新設するシェルスクリプト 2 本の関数と、CI の定義のテストの検査の関数）。既存の関数のシグネチャは変えない。

全体の流れは設計文書の「処理の流れ」にある。NDF（このリポジトリの Pull Request をマージするツール）は、マージの直前に非公開リポジトリの呼び出しのワークフローを起動する。呼び出しのワークフローは `leak-check-secret.yml` を秘密つきで呼び、NDF はその実行の結果を読んで、成功を確かめられなければマージしない。この結果は公開のリポジトリのチェックにならず、必須のチェックの宣言にも足さない（#96-1 は NDF がマージしないことで満たす。設計文書の「受け入れ条件の読み方」）。

各節の頭の「満たす決定」の「決定 N」は設計文書の決定 N を、`#96-1` のような番号は要求仕様（[issue-96-requirements.md](./issue-96-requirements.md)・[issue-101-requirements.md](./issue-101-requirements.md)）の受け入れ条件（課題の番号と条件の番号）を指す。

この文書が扱うのは、導入の 1 本目（実装の Pull Request）で触るファイルである。2 本目の Pull Request で変える `.ndf/project.json` と、NDF（devbasex/ai-plugins）の側の機能は、NDF への依頼で形が決まるので、関数の粒度へは下ろさない（末尾の「NDF への依頼と 2 本目の Pull Request」）。

## 地図

パッケージ・モジュール構成（触るファイルだけ。`*` は新設）:

```text
.github/workflows/
  ci.yml                      leak-check を Pull Request だけにし、leak-check-push を分ける
  leak-check-secret.yml *     非公開リポジトリから呼ばれる、秘密を使う探し（workflow_call）
tools/checks/
  export-tree.sh *            コミットの木を Git に保存された内容のまま取り出す
  leak-scan-secret.sh *       秘密の正規表現を重ねた設定を組み、leak-scan.sh を 2 回打つ
  leak-scan.sh                変えない（呼ばれる側）
tools/test/
  ci-definition.test.ts       起動の許可・秘密を受けるワークフローの形・漏れの検査のジョブの分け方を縛る
  leak-scan.integration.test.ts  2 本の新しいスクリプトを作り物のリポジトリで動かす
docs/operations/
  ci-checks.md *              持ち主の操作の手順
  leak-check-caller.yml *     非公開リポジトリに置く呼び出しのワークフローの見本
docs/design/platform.md       設計の決まりを縛る検査の「漏れの検査」の行
AGENTS.md                     秘密とインフラの値を置かない、の行
```

依存の向き: ワークフロー → `leak-scan-secret.sh` → `leak-scan.sh` → gitleaks と設定のファイル、の一方向である。`leak-check-secret.yml` だけが `export-tree.sh` を呼び、`export-tree.sh` はほかのスクリプトを呼ばない。`leak-scan-secret.sh` は `export-tree.sh` を呼ばない（木を取り出すのはワークフローの手順で、スクリプトは渡された木を探すだけ）。テストからの依存は 2 本ある。結合のテストは、スクリプトを子のプロセスで動かす。CI の定義のテストは、ワークフローと見本を YAML として読むだけである。スクリプトとワークフローからテストへの依存は無い。循環は無い。要素の関係は設計文書の「構成要素」の図にある。

| パス | 種類 | 役割 1 文 | 依存する先 | クラスまたはモジュール | メソッドと最上位の関数 |
| --- | --- | --- | --- | --- | --- |
| `.github/workflows/leak-check-secret.yml` | 新設 | 渡された Pull Request のマージコミットの木と分岐点から head までを、秘密を重ねた設定で探す | `actions/checkout`・`export-tree.sh`・`leak-scan-secret.sh` | ジョブ `leak-check-secret` | 手順: 入力の形を確かめる・チェックアウト・gitleaks を置く・Pull Request の参照を取り込んで確かめる・マージコミットの木を取り出す・探す（新設） |
| `.github/workflows/ci.yml` | 変更 | Pull Request の探しから秘密を外し、main への push の探しを環境 `leak-scan` のジョブへ分ける | `leak-scan.sh`・`leak-scan-secret.sh` | ジョブ `leak-check`（変更）・`leak-check-push`（新設） | `leak-check` の手順「今の木と履歴のコミットを探す」（変更）。`leak-check-push` の手順（新設） |
| `tools/checks/leak-scan-secret.sh` | 新設 | 秘密の正規表現から重ねた設定を組み、既定の規則と重ねた設定で 1 回ずつ探し、`nd-real-value` の件数を出す | `leak-scan.sh`・`.gitleaks.toml`・`tools/checks/gitleaks-default.toml` | シェルのモジュール | `usage`・`parse_args`・`build_overlay`・`run_scan`・`report_counts`（新設） |
| `tools/checks/export-tree.sh` | 新設 | コミットの木のすべてのファイルを、属性による加工なしで空のディレクトリへ書き、数と内容の値を確かめる | `git` | シェルのモジュール | `usage`・`check_path`・`write_entries`・`verify_tree`（新設） |
| `tools/test/ci-definition.test.ts` | 変更 | 起動の許可・`leak-check-secret.yml` と見本の形・漏れの検査のジョブの分け方を、定義から読んで落とす | `yaml`・`.ndf/project.json` | テストのモジュール | `loadWorkflowFile`・`triggerNames`・`triggerViolations`・`runCommandWords`・`secretWorkflowViolations`・`callerViolations`・`leakJobViolations`・`actorConditions`・`patternSecretReaders`（新設）。`pullRequestChecks`・`triggersPullRequest`・`loadWorkflows`（変更） |
| `tools/test/leak-scan.integration.test.ts` | 変更 | 2 本の新しいスクリプトを、作り物の正規表現と作り物のリポジトリで動かす | `leak-scan-secret.sh`・`export-tree.sh`・gitleaks | テストのモジュール | `secretScan`・`exportTree`・`mergeRepo`（新設） |
| `docs/operations/leak-check-caller.yml` | 新設 | 持ち主が非公開リポジトリへ写す、呼び出しのワークフローの正本 | `leak-check-secret.yml@main` | ジョブ `generation`・`scan` | — |
| `docs/operations/ci-checks.md` | 新設 | 持ち主が GitHub の設定で行う操作と、検査ごとの秘密の受け方・結果の見え方 | — | 文書 | — |
| `AGENTS.md` | 変更 | 秘密を使う探しが動く場所を直し、運用の文書へリンクする | — | 文書 | — |
| `docs/design/platform.md` | 変更 | 漏れの検査の行に、Pull Request の探しが NDF のマージの直前に非公開リポジトリで動くことを足す | — | 文書 | — |

## 秘密を使う探しのスクリプト（`tools/checks/leak-scan-secret.sh`）

満たす決定: 決定 3・5・8・10（手順 4）、受け入れ条件 #96-1・#96-2・#96-6・#96-7・#96-9・#101-2

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| スクリプト全体 | `tools/checks/leak-scan-secret.sh` | 新設 | `leak-scan-secret.sh <dir\|git> [<木>] [--range <範囲>] [--count-only] [--details]`。環境変数 `LEAK_CHECK_PATTERN`・`LEAK_CHECK_REQUIRE_PATTERN` を読む。終了コード 0・1・2 | 受けた対象を、既定の規則と、秘密を重ねた設定（秘密が無く必須でなければ `.gitleaks.toml`）で 1 回ずつ探す |
| `usage` | 同上 | 新設 | `usage() -> 終了コード 2` | 使い方の 1 行を標準エラーに出して 2 で終える |
| `parse_args` | 同上 | 新設 | `parse_args "$@"` → 大域の `mode`・`tree`・`range`・`count_only`・`details` を決める | 引数を読み、組み合わせの誤りを 2 で落とす |
| `build_overlay` | 同上 | 新設 | `build_overlay <作業のディレクトリ> -> 標準出力に設定のファイルの絶対パス` | 秘密と必須の指定から、2 回目の探しに使う設定のファイルを決める。秘密があれば重ねた設定を作業のディレクトリに書く |
| `run_scan` | 同上 | 新設 | `run_scan <設定> <報告のファイル> <出力の扱い: pass\|filter> -> leak-scan.sh の終了コード` | `leak-scan.sh` を 1 回打ち、報告を木の外に受け、出力をそのまま出すか `nd-real-value` を除いて出す |
| `report_counts` | 同上 | 新設 | `report_counts <報告のファイル> -> 終了コード 0 か 1` | 重ねた設定の報告から `nd-real-value` の件数を数え、件数の行を出す |

- スクリプト全体
  - 事前条件: `dir` では、`<木>`（省けば今のディレクトリ）が在るディレクトリである。`git` では、今のディレクトリが git のリポジトリで、`--range` の両端のコミットを持つ。gitleaks が `PATH` にある
  - 事後条件: 終了コードは 2 回の探しのうち悪い方である（どちらかが 2 なら 2、どちらかが 1 なら 1、両方 0 なら 0）。秘密があり、2 回目の探しが報告を書けたときは、当たりの有無によらず `leak-scan-secret: nd-real-value: <件数> 件` の行が 1 つ出ている。秘密が空で必須でないときは、`leak-scan-secret: 秘密 LEAK_CHECK_PATTERN が空なので .gitleaks.toml だけで探す` の行が 1 つ出ている。作業のディレクトリは消えている
  - 副作用: `mktemp -d` の作業のディレクトリに、重ねた設定と 2 つの報告を書く。`leak-scan.sh` を子のプロセスで 2 回打つ。`leak-scan.sh` へ渡す前に `LEAK_CHECK_PATTERN` を `unset` し、gitleaks の環境に秘密を残さない
- `parse_args`
  - `--details` は `leak-scan.sh` に `--paths` を渡す指定で、手元で当たりのファイルを特定するときだけ使う。`--count-only` と同時には受けない（場所を出す指定と件数だけを出す指定が食い違うため）
  - `<木>` は `dir` でだけ受ける。`--range` は `git` でだけ受ける
- `build_overlay`
  - 重ねた設定の形は今の `ci.yml` の手順と同じである（`[extend] path` で `.gitleaks.toml` を読み、規則 `nd-real-value` を `'''` の文字列の正規表現で足す）。`[extend] path` と 1 回目の既定の規則の設定は、このスクリプトの在るチェックアウトの根（`$(dirname "$0")/../..` を `cd` と `pwd -P` で絶対パスにしたもの）から組む。探す木の中の設定は読まない
- `run_scan`
  - `dir` では、`<木>` へ `cd` してから `leak-scan.sh dir` を打つ。`leak-scan.sh` は今のディレクトリを探す木の根とし、根の `.gitleaksignore` を 2 で落とす
  - `filter` は `--count-only` のときの 2 回目だけに使う。`leak-scan.sh` の標準出力は捨て、報告の JSON から `RuleID` が `nd-real-value` でない当たりを、`leak-scan.sh` と同じ `leak-scan: 当たり <規則> <ファイル>:<行> [<コミット>]` の形で出す。標準エラーはそのまま通す（`leak-scan.sh` はファイルの名前を `--paths` なしでは出さない）

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `parse_args` | 引数の誤り | 対象が `dir`・`git` でない、`git` に `<木>` を渡した、`dir` に `--range` を渡した、`--count-only` と `--details` を同時に渡した、知らない引数 | `parse_args` | 止める | 使い方の 1 行、2 | 作業のディレクトリを作る前なので後始末は無い。引数を直して打ち直せる |
| `parse_args` | 探す木が無い | `<木>` が在るディレクトリでない | `parse_args` | 止める | `leak-scan-secret: 探す木のディレクトリが無い`（パスを出さない）、2 | 同上 |
| `build_overlay` | 秘密の形の誤り | 秘密に `'''` か改行を含む（TOML の文字列を閉じるか、複数行の正規表現になるため） | `build_overlay` | 止める | `leak-scan-secret: 秘密 LEAK_CHECK_PATTERN に ''' と改行を含めない`（値を出さない）、1 | `trap` で作業のディレクトリを消す。秘密を直して打ち直せる |
| `build_overlay` | 必須なのに秘密が空 | `LEAK_CHECK_REQUIRE_PATTERN` が `1` で `LEAK_CHECK_PATTERN` が空 | `build_overlay` | 止める | `leak-scan-secret: 秘密 LEAK_CHECK_PATTERN が無い（必須にしている）`、1 | 同上 |
| `build_overlay` | チェックアウトの根を設定に書けない | 根の絶対パスが `"` か `\` か改行を含む | `build_overlay` | 止める | `leak-scan-secret: チェックアウトのパスを設定に書けない`、2 | 同上。別の場所へチェックアウトして打ち直す |
| `run_scan` | 探しの失敗か当たり | `leak-scan.sh` が 1 か 2 を返した | `run_scan` の戻り値 | 2 回目まで打ってから、悪い方の終了コードで終える | `leak-scan.sh` の出力（`filter` のときは `nd-real-value` を除いた当たり）と、`leak-scan.sh` の終了コード | 同上 |
| `report_counts` | 件数を読めない | 2 回目の `leak-scan.sh` が報告を書かずに終えた（範囲を読めない・gitleaks の報告を読めない・`.gitleaksignore` がある） | `report_counts` | 呼び出し元へ返す | `leak-scan-secret: nd-real-value の件数を読めない`、1（`run_scan` が 2 なら 2 のまま） | 同上。決定 10 の手順 4 の確かめは、この行が出た実行を「確かめられない」とする |

### 処理の手順

| 関数 | 条件の組み合わせ | 結果 |
| --- | --- | --- |
| `build_overlay` | 秘密あり（形が正しい） | 重ねた設定のパスを返す。2 回目は重ねた設定で探し、件数の行を出す |
| `build_overlay` | 秘密が空・必須（`LEAK_CHECK_REQUIRE_PATTERN` が `1`） | 1 で止める（探さない） |
| `build_overlay` | 秘密が空・必須でない | 空のときの行を出し、`.gitleaks.toml` の絶対パスを返す。件数の行は出さない |
| スクリプト全体 | `--count-only` なし | 2 回とも `pass`。非公開リポジトリの実行と手元の確かめで使う |
| スクリプト全体 | `--count-only` あり | 1 回目は `pass`、2 回目は `filter`。main への push の `leak-check-push` で使う |
| スクリプト全体 | `--details` あり | 2 回とも `leak-scan.sh` に `--paths` を渡し、`pass` で出す。手元でだけ使う |

- 計算量の注意: gitleaks を 2 回打つ。非公開リポジトリの実行は、このスクリプトを `dir` と `git` で 1 回ずつ呼ぶので、gitleaks を合わせて 4 回打つ（設計文書の決定 5 の代償）

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| 重ねた規則の名前 `nd-real-value` | 定数 | `tools/checks/leak-scan-secret.sh`（`ci.yml` の手順から移す。移した後の保存先はこのスクリプトだけ） | `nd-real-value` |
| 件数の行の形 | 定数 | 同上 | `leak-scan-secret: nd-real-value: <件数> 件` |
| 秘密が空のときの行 | 定数 | 同上 | `leak-scan-secret: 秘密 LEAK_CHECK_PATTERN が空なので .gitleaks.toml だけで探す` |

### ログと記録の出力

| 関数 | 出すもの | レベルまたは書き先 | 出さないもの |
| --- | --- | --- | --- |
| `report_counts` | `nd-real-value` の件数の行 | 標準出力（CI の記録） | 正規表現・当たった値・当たりのファイルと行とコミット |
| `run_scan` | 既定の規則と nd-factory の規則の当たり（規則・`file-<番号>`・行・コミット） | 標準出力 | `--details` なしでは実際のファイルの名前と gitleaks の生の出力 |
| `build_overlay` | 秘密が空のときの行・誤りの行 | 標準出力・標準エラー | 秘密の値と重ねた設定の中身 |

### 既存の部品の再利用

| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `build_overlay` | `ci.yml` の手順「今の木と履歴のコミットを探す」の重ねた設定を組むシェル | `grep -n "nd-real-value" -r .github tools` | 移す。手順のシェルは消し、このスクリプトだけに置く（Value 13） |
| `run_scan` | `tools/checks/leak-scan.sh` の `--report` と `--paths` | `leak-scan.sh` の頭の注を読んだ | 使う。報告の JSON の項目（`RuleID`・`File`・`StartLine`・`Commit`）を読み、`leak-scan.sh` は変えない |
| `report_counts` | `jq` | `leak-scan.sh` が既に使っている | 使う |
| `usage`・`parse_args` | `leak-scan.sh` の `usage` と引数の読み方 | 同上 | 形だけ倣う。スクリプトをまたいで関数を共有する仕組みはこのリポジトリに無い（`grep -rn "source " tools/checks` で 0 件）ので、読み込みの部品は作らない |

### 単体テストの観点

`tools/test/leak-scan.integration.test.ts` で、作り物の正規表現（実行の時に生成した `nd` と小文字 10 字）を環境変数で渡して動かす。

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| スクリプト全体 | 途中のコミットで足して後で消した値を、`git --range <分岐点>..<head>` が 1 で当てる。分岐点より前から在るファイルの、範囲で変えていない行の値を、`dir <木>` が 1 で当てる | 当たりが 0 件のとき、0 で終え、`nd-real-value: 0 件` の行が出る。既定の規則だけに当たる値で、1 回目が 1 を返しても 2 回目も打たれ、件数の行が出る | 範囲を読めないと 0 以外で終える。出力と報告に、作り物の正規表現と当たった値が現れない |
| `parse_args` | `dir` に木を渡すと、そのディレクトリを探す | 木を省くと今のディレクトリを探す | 誤りの組み合わせ（異常系の表の 1 行目）がそれぞれ 2 で終える。無い木は、パスを出さずに 2 で終える |
| `build_overlay` | 秘密ありで、`nd-real-value` の当たりが規則の名前つきで報告に入る | 秘密が空・必須でないとき、空のときの行が出て、件数の行が出ない | 秘密が空・必須で 1。`'''` か改行を含む秘密で 1。どちらの出力にも秘密の値が現れない |
| `run_scan` | `--count-only` で、`nd-real-value` の当たりは件数だけが出て、ファイル・行・コミットが出ない。既定の規則の当たりは今の形で出る | — | 木の根に `.gitleaksignore` があると 2 |
| `report_counts` | 当たり 2 件で `nd-real-value: 2 件` | 0 件で `nd-real-value: 0 件` | 2 回目の報告が無いと、件数を読めない行を出して 0 以外 |
| `--details` | 実際のファイルの名前が出る | — | `--details` なしでは、作り物の値を名前に含むファイルが `file-<番号>` で出て、名前が出力に現れない |

## 木の取り出しのスクリプト（`tools/checks/export-tree.sh`）

満たす決定: 決定 5・8、受け入れ条件 #96-1・#96-6・#96-7

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| スクリプト全体 | `tools/checks/export-tree.sh` | 新設 | `export-tree.sh <コミット> <出力先>`。今のディレクトリの git のリポジトリを読む。終了コード 0・1・2 | コミットの木のすべてのファイルを、Git に保存された内容のまま出力先へ書き、書いたものが木と一致することを確かめる |
| `usage` | 同上 | 新設 | `usage() -> 終了コード 2` | 使い方の 1 行を標準エラーに出して 2 で終える |
| `check_path` | 同上 | 新設 | `check_path <通し番号> <パス> -> 終了コード 0 か 1` | 項目のパスが、出力先の外や `.git` を指さないことを確かめる |
| `write_entries` | 同上 | 新設 | `write_entries <コミット> <出力先> -> 標準出力に書いたファイルの数` | `git ls-tree -r -z --full-tree` の項目ごとに、ファイルの項目の blob を `git cat-file blob` で書く |
| `verify_tree` | 同上 | 新設 | `verify_tree <コミット> <出力先> <書いた数> -> 終了コード 0 か 1` | 出力先のファイルの数と各ファイルの `git hash-object --no-filters` の値が、木の項目と一致することを確かめる |

- スクリプト全体
  - 事前条件: 今のディレクトリが git のリポジトリで、`<コミット>` を持つ。`<出力先>` は無いか、空のディレクトリである（無ければこのスクリプトが作る。ワークフローの `run:` で `mkdir` を打たずに済ませるため）
  - 事後条件: 0 で終えたとき、出力先には、木のファイルの項目（モード `100644`・`100755`・`120000`）と同じ数の普通のファイルと、それを入れるディレクトリだけがある。各ファイルの中身は、項目の blob のバイト列と同じである。シンボリックリンク・サブモジュール・ほかの種類のファイルは無い。書いたファイルは実行の権限を持たない（モード `0644`）
  - 副作用: 出力先にディレクトリとファイルを書く。`git ls-tree`・`git cat-file`・`git hash-object` を子のプロセスで打つ。`.gitattributes` を読まず、`git archive`・`git checkout`・`--filters`・`--textconv` を使わない
- `check_path`
  - 失敗とするのは、パスが空、`/` で始まる、`/` で区切った部分に空・`.`・`..` がある、部分のどれかが大文字と小文字を区別せずに `.git` と同じ、のどれかである
  - 知らせにはパスを出さず、`ls-tree` の何番目の項目かだけを出す
- `write_entries`
  - モード `100644`・`100755` の項目は、そのまま中身を書く。`120000`（シンボリックリンク）は、リンク先の文字列（blob の中身）を中身とする普通のファイルとして書く。`160000`（サブモジュール）は中身を持たないので書かず、数えない。ほかのモードは失敗とする
  - 書く先が既に在れば失敗とする（壊れた木が同じパスを 2 回持つ場合）。親のディレクトリの部分が既にファイルとして在るときも、`mkdir -p` の失敗で止まる
- `verify_tree`
  - 出力先の `find -type f` の数が書いた数と同じで、`find ! -type f ! -type d` が 0 件で、項目ごとの `git hash-object --no-filters -- <ファイル>` が項目の値と同じことを確かめる

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| スクリプト全体 | 引数の誤り | 引数が 2 つでない、出力先が空でないディレクトリかファイル | 頭の確かめ | 止める | 使い方の 1 行か `export-tree: 出力先が空のディレクトリでない`、2 | 書く前なので後始末は無い。打ち直せる |
| スクリプト全体 | コミットを読めない | `git rev-parse --verify "<コミット>^{commit}"` が失敗した | 頭の確かめ | 止める | `export-tree: コミットを読めない`、2 | 同上 |
| `check_path` | 取り出せないパス | 絶対パス・`.`・`..`・`.git` の部分を持つ項目 | `check_path` | 止める | `export-tree: 木に取り出せない項目がある（<通し番号> 番目）`、1 | 出力先は途中まで書かれたまま残る。呼ぶ側（ワークフロー）はジョブごと失敗させ、手元では出力先を消して打ち直す |
| `write_entries` | 扱えない種類の項目 | 既知でないモード、同じパスの重なり | `write_entries` | 止める | `export-tree: 木に取り出せない項目がある（<通し番号> 番目）`、1 | 同上 |
| `write_entries` | 書けない | `git cat-file` の失敗・ディスクの不足・`mkdir -p` の失敗 | 各コマンドの終了コード（`set -euo pipefail`） | 止める | `export-tree: 木を書き出せない（<通し番号> 番目）`、1。git の標準エラーはパスを含み得るので一時のファイルに受けて捨てる | 同上 |
| `verify_tree` | 木と食い違う | 書いた数か内容の値が項目と違う、ファイルでもディレクトリでもない物がある | `verify_tree` | 止める | `export-tree: 取り出した木が元の木と一致しない`、1 | 同上 |

### 処理の手順

- ループの終了条件: `ls-tree -z` の出力を `read -r -d ''` で読み、読み終えたら終える。1 項目ずつ `check_path` を先に通してから書く
- 計算量の注意: ファイルの項目ごとに `git cat-file` と `git hash-object` を 1 回ずつ打つ。2026-11-24 の main の追跡するファイルは 284 本なので、子のプロセスは 600 前後で済む。数が 1 万を超えたら `git cat-file --batch` に替える

### 既存の部品の再利用

| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `write_entries` | `git archive`・`git checkout-index`・`git worktree add` | [Git の属性の仕様](https://git-scm.com/docs/gitattributes.html) を読んだ | 使えない。どれも対象のコミットの `.gitattributes`（`export-ignore`・`export-subst`・改行の変換・`ident`・フィルタ）に従って中身を変えうる（設計文書の決定 5） |
| `verify_tree` | `git hash-object --no-filters` | `git hash-object -h` | 使う。属性を読まずに blob の値を求める |
| `check_path` | このリポジトリの既存のパスの確かめ | `grep -rn "\.\." tools/checks` | 無い。新しく書く |

### 単体テストの観点

`tools/test/leak-scan.integration.test.ts` で、作り物のリポジトリを作って動かす。

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| スクリプト全体 | `.gitattributes` に `* export-ignore`・`export-subst`・`text eol=crlf`・`ident` を書いたコミットを取り出すと、ファイルの数が `git ls-tree` のファイルの項目の数と同じで、各ファイルの中身が blob と同じバイト列になる | 出力先が無いときは作る。空のディレクトリを渡しても通る | 空でない出力先・ファイルの出力先・読めないコミットで 2 |
| `write_entries` | `export-ignore` を付けたファイルにだけ作り物の値を置き、取り出した木を `leak-scan-secret.sh dir` で探すと 1 | シンボリックリンク（`../../outside` を指す）が、リンク先の文字列を中身とする普通のファイルになり、出力先の外を指すリンクが無い。サブモジュールの項目は書かれない | — |
| `check_path` | — | — | `git mktree` で作った、`..` か `.git` か `.GIT` の部分を持つ項目の木で 1。出力に項目のパスが現れない |
| `verify_tree` | — | — | 数か値の確かめを外すと上の「正常」の行が落ちる（壊し方の確かめは設計文書のテスト設計の決定 5 の行） |

## 再利用できる漏れの検査のワークフロー（`.github/workflows/leak-check-secret.yml`）

満たす決定: 決定 1・3・4・5・7・8、受け入れ条件 #96-1・#96-2・#96-3・#96-4・#96-5・#96-6

### 関数の仕様

ワークフローの手順を関数として書く。ジョブは `leak-check-secret` の 1 つだけである。

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| 起動 `on.workflow_call` | `.github/workflows/leak-check-secret.yml` | 新設 | 入力 `pr_number`・`head_sha`・`base_sha`・`merge_sha`・`code_sha`・`generation`（どれも `type: string`・`required: true`）。秘密 `LEAK_CHECK_PATTERN`（`required: true`） | 非公開リポジトリの呼び出しのワークフローからだけ起動される |
| ジョブ `leak-check-secret` | 同上 | 新設 | `name: leak-check-secret (#${{ inputs.pr_number }} head ${{ inputs.head_sha }} / base ${{ inputs.base_sha }} / merge ${{ inputs.merge_sha }} / code ${{ inputs.code_sha }} / gen ${{ inputs.generation }})`。`runs-on: ubuntu-24.04`・`timeout-minutes: 20`。`if:`・`continue-on-error`・`environment`・`permissions` を持たない | 下の 6 つの手順を順に動かし、どれかが 0 以外で終えれば失敗する |
| 手順「入力の形を確かめる」 | 同上 | 新設 | 環境変数で 6 つの入力を受ける | 番号が `^[1-9][0-9]*$`、5 つの SHA が `^[0-9a-f]{40}$`、世代が `^[1-9][0-9]*$` に合わなければ 1 で終える |
| 手順「チェックアウト」 | 同上 | 新設 | `actions/checkout@<SHA> # v7.0.1`。`repository: devbasex/nd-factory`・`ref: ${{ inputs.code_sha }}`・`fetch-depth: 0`・`persist-credentials: false` | 検査のコードのコミットのスクリプトと設定を作業のディレクトリに置く |
| 手順「gitleaks を固定の版と要約値で置く」 | 同上 | 新設 | `ci.yml` の同じ名前の手順と、手順の `run:` とジョブの `GITLEAKS_VERSION`・`GITLEAKS_SHA256` が同じ | gitleaks を置き、`GITHUB_PATH` に足す |
| 手順「Pull Request の参照を取り込んで確かめる」 | 同上 | 新設 | 環境変数 `PR_NUMBER`・`HEAD_SHA`・`BASE_SHA`・`MERGE_SHA` | `git fetch --no-tags --no-recurse-submodules origin +refs/pull/<番号>/head:refs/ndf-scan/head +refs/pull/<番号>/merge:refs/ndf-scan/merge` で取り込み、2 つの参照が入力の SHA と同じこと、マージコミットの親がちょうど 2 つで順に base と head であること、`git merge-base` で分岐点を求められることを確かめる |
| 手順「マージコミットの木を取り出す」 | 同上 | 新設 | 環境変数 `MERGE_SHA` | `tools/checks/export-tree.sh "$MERGE_SHA" "$RUNNER_TEMP/merge-tree"` を打つ |
| 手順「秘密の規則を重ねて探す」 | 同上 | 新設 | 環境変数 `LEAK_CHECK_PATTERN: ${{ secrets.LEAK_CHECK_PATTERN }}`・`LEAK_CHECK_REQUIRE_PATTERN: "1"`・`BASE_SHA`・`HEAD_SHA` | 分岐点を求め直し、`leak-scan-secret.sh dir "$RUNNER_TEMP/merge-tree"` と `leak-scan-secret.sh git --range "<分岐点>..$HEAD_SHA"` を打ち、どちらかが 0 以外なら 1 で終える |

- ワークフローの最上位: `permissions: contents: read`。`defaults.run.shell: bash`（GitHub は `bash --noprofile --norc -eo pipefail` で打つ）。`concurrency` は置かない。NDF は自分が起動した実行だけを読むので、同じ Pull Request の実行を打ち消し合わせる理由が無い
- 手順「秘密の規則を重ねて探す」
  - 事前条件: 前の 5 つの手順が成功している。作業のディレクトリは検査のコードのコミットのチェックアウトで、`refs/ndf-scan/head` と `refs/ndf-scan/merge` を持つ
  - 事後条件: 2 回の呼び出しの両方を打ち終えている（1 回目が失敗しても 2 回目を打つ。持ち主が非公開の記録で両方の当たりを読めるようにするため）
  - 副作用: 秘密を受けるのはこの手順だけである。手順の間で値を渡すのに `GITHUB_ENV`・`GITHUB_OUTPUT` を使わず、分岐点は同じ入力から求め直し、取り出した木は固定のパス `$RUNNER_TEMP/merge-tree` に置く
- 入力は、すべての手順で `env:` を通して受け、`run:` の中に `${{ inputs.* }}` を書かない。ジョブの `name:` と `checkout` の `ref:` の式は `run:` の外なので、書いてよい
- `checkout` の `ref:` に入力をそのまま渡すのは、前の手順で形を確かめた後である。形の確かめが失敗すれば、ジョブはそこで止まり、`checkout` は動かない

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| 手順「入力の形を確かめる」 | 入力の形の誤り | 呼び出しのワークフローか NDF が誤った値を渡した | `[[ =~ ]]` の比べ | 止める | `::error::入力 <名前> の形が違う`、1 | 後始末は無い。NDF は探しの失敗として人へ戻す（設計文書の決定 7 の手順 4 の分類 4） |
| 手順「チェックアウト」 | 検査のコードのコミットを取れない | main に無い SHA、通信の失敗 | `actions/checkout` | 止める | 動作の誤りの行、1 | 同上 |
| 手順「Pull Request の参照を取り込んで確かめる」 | 参照を取れない | Pull Request が無い・閉じてマージの参照が無い・通信の失敗 | `git fetch` の終了コード | 止める | `::error::Pull Request の参照を取り込めない`、1 | 同上 |
| 同上 | SHA の食い違い | 起動の後に作者が push した、base が進んでマージの参照が作り直された | `git rev-parse` の比べ | 止める | `::error::refs/pull/<番号>/head が入力の head の SHA と違う`（か merge の同じ行）、1 | 同上。NDF は次のマージの試みで今の値で起動し直す |
| 同上 | 親の食い違い | 親が 2 つでない、順が違う、入力の base と違う | `git rev-list --parents -n 1` の比べ | 止める | `::error::マージコミットの親が入力の base と head でない`、1 | 同上 |
| 同上 | 分岐点を求められない | base と head が共通の祖先を持たない | `git merge-base` の終了コード | 止める | `::error::base と head の分岐点を求められない`、1 | 同上 |
| 手順「マージコミットの木を取り出す」 | 取り出しの失敗 | `export-tree.sh` の異常系の表のどれか | `export-tree.sh` の終了コード | 止める | `export-tree.sh` の行（パスを出さない）、1 か 2 | 同上 |
| 手順「秘密の規則を重ねて探す」 | 当たりか探しの失敗 | `leak-scan-secret.sh` の異常系の表のどれか | 2 回の終了コード | 2 回とも打ってから止める | `leak-scan-secret.sh` と `leak-scan.sh` の行、1 | 同上 |

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `GITLEAKS_VERSION`・`GITLEAKS_SHA256` | 定数 | 正は `.github/workflows/ci.yml` の `leak-check`。`leak-check-secret.yml` と `leak-check-push` は写しで、CI の定義のテストが 3 か所の値と手順の `run:` が同じことを確かめる（手順を共有する仕組み（複合の動作）は、`leak-check-secret.yml` の `uses:` を `actions/checkout` だけに限る決定 4 と両立しないため） | `8.30.1`・今の要約値 |
| 取り出した木の置き場所 | 定数 | `.github/workflows/leak-check-secret.yml` | `$RUNNER_TEMP/merge-tree` |
| 取り込む参照の名前 | 定数 | 同上 | `refs/ndf-scan/head`・`refs/ndf-scan/merge` |

### ログと記録の出力

| 関数 | 出すもの | レベルまたは書き先 | 出さないもの |
| --- | --- | --- | --- |
| ジョブ `leak-check-secret` | 表示名の 6 つの値 | 非公開リポジトリの実行の記録とジョブの一覧の API | — |
| 手順「秘密の規則を重ねて探す」 | 当たりの規則・`file-<番号>`・行・コミットと `nd-real-value` の件数 | 非公開リポジトリの実行の記録 | 正規表現・当たった値・実際のファイルの名前（`--details` を渡さない） |

### 単体テストの観点

ワークフローは CI の定義のテスト（下の「CI の定義のテスト」の `secretWorkflowViolations`）で形を縛り、動く振る舞いは決定 10 の手順 1 の検証用のリポジトリで確かめる。

## 呼び出しのワークフローの見本（`docs/operations/leak-check-caller.yml`）

満たす決定: 決定 1・4・7、受け入れ条件 #96-3・#96-5

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| 起動 `on.workflow_dispatch` | `docs/operations/leak-check-caller.yml` | 新設 | 入力は `leak-check-secret.yml` と同じ 6 つ（どれも `type: string`・`required: true`） | NDF か持ち主の手の起動だけを受ける |
| ジョブ `generation` | 同上 | 新設 | 環境変数 `VAR_GENERATION: ${{ vars.LEAK_CHECK_GENERATION }}`・`INPUT_GENERATION: ${{ inputs.generation }}`。`runs-on: ubuntu-24.04`・`timeout-minutes: 5` | 変数の世代が `^[1-9][0-9]*$` に合い、入力の世代と同じでなければ 1 で終える |
| ジョブ `scan` | 同上 | 新設 | `needs: generation`・`uses: devbasex/nd-factory/.github/workflows/leak-check-secret.yml@main`・`with:` に 6 つの入力をそのまま・`secrets: LEAK_CHECK_PATTERN: ${{ secrets.LEAK_CHECK_PATTERN }}` | 公開のリポジトリの再利用できるワークフローを、秘密を名前で渡して呼ぶ |

- 最上位は `permissions: contents: read` だけにする。`secrets: inherit` を使わない
- 世代の確かめに失敗すると、`scan` は `needs` で飛ばされ、実行は失敗で終える。このとき探しのジョブも `referenced_workflows` の項目も無いので、NDF は探しの失敗（設計文書の決定 7 の分類 4）とする
- 見本は公開のリポジトリの `.github/workflows/` の外に置くので、公開のリポジトリでは動かない。ワークフローの点検（zizmor）の対象にも入らない。形は CI の定義のテストが縛る

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| ジョブ `generation` | 世代の不一致 | 持ち主が切り替え中（`0`）か、変数が空か、NDF が読んだ後に変わった | `[[ ]]` の比べ | 止める | `::error::設定の世代が入力と違うか、切り替え中`、1 | `scan` は動かない。NDF は人へ戻し、次のマージの試みで世代を読み直す |
| ジョブ `scan` | 呼べない | 公開の再利用できるワークフローを許さない Actions の設定、`@main` を解決できない | GitHub がジョブを作る時 | 止める | 実行の誤り（ジョブを作る前の失敗になりうる） | 持ち主が設定を直して起動し直す（設計文書の「未確認のまま残ること」の表の 2 行目。非公開リポジトリから公開のリポジトリの再利用できるワークフローを呼べるか） |

## CI の `leak-check` と `leak-check-push` のジョブ（`.github/workflows/ci.yml`）

満たす決定: 決定 3・8・9・10、受け入れ条件 #96-8・#96-9・#101-1・#101-2・#101-3

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| ジョブ `leak-check` | `.github/workflows/ci.yml` | 変更 | `if: github.event_name == 'pull_request'` を足す。`environment` と秘密を持たない | 既定の規則と `.gitleaks.toml` だけで、今の木と分岐点から head までを探す |
| 手順「今の木と履歴のコミットを探す」（`leak-check`） | 同上 | 変更 | 環境変数は `BASE_SHA`・`HEAD_SHA` だけ（`LEAK_CHECK_PATTERN`・`LEAK_CHECK_REQUIRE_PATTERN`・`EVENT_NAME` を消す） | `leak-scan.sh` を `dir` と `git --range <分岐点>..<head>` で、それぞれ `tools/checks/gitleaks-default.toml` と `.gitleaks.toml` の 2 回、合わせて 4 回打つ |
| ジョブ `leak-check-push` | 同上 | 新設 | `if: github.event_name == 'push'`・`environment: leak-scan`・`timeout-minutes: 15`。gitleaks の 2 つの定数をジョブの `env` に持つ。チェックアウト（`fetch-depth: 0`・`persist-credentials: false`）と gitleaks を置く手順は `leak-check` と同じ | main への push で、今の木と到達できるすべてのコミットを、既定の規則と秘密を重ねた設定で探す |
| 手順「今の木と履歴のコミットを探す」（`leak-check-push`） | 同上 | 新設 | 環境変数 `LEAK_CHECK_PATTERN: ${{ secrets.LEAK_CHECK_PATTERN }}`・`LEAK_CHECK_REQUIRE_PATTERN: ${{ vars.LEAK_CHECK_REQUIRE_PATTERN == '1' && '1' \|\| '' }}` | `leak-scan-secret.sh dir --count-only` と `leak-scan-secret.sh git --count-only` を打ち、どちらかが 0 以外なら 1 で終える |

- `leak-check` の手順「gitleaks の設定の結合のテスト」（`setup-node`・`npm ci`・`npm run test:integration -- leak-scan`）は `leak-check` に残す。新しい結合のテストも、ファイルの名前で同じ呼び出しに入る
- `leak-check-push` は `setup-node` と `npm ci` を持たない。環境 `leak-scan` を持つジョブで、依存の導入の処理を動かさないためである。結合のテストは、main に入る前の Pull Request の `leak-check` で同じ中身に対して通っている。今の `leak-check` は main への push でも結合のテストを打っているので、main への push で打たなくなることは振る舞いの変化として運用の文書に書く
- 今の式の `github.event.pull_request.head.repo.full_name == github.repository` の条件は、2 つのジョブのどこにも残さない
- `leak-check-push` の 2 回の呼び出しは、`leak-check-secret.yml` と同じく 1 回目が失敗しても 2 回目を打つ

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| 手順（`leak-check`） | 当たりか探しの失敗 | `leak-scan.sh` の異常系 | 終了コード（`bash -e`） | 止める | `leak-scan.sh` の行、1 か 2 | 今と同じ。Pull Request を直して push し直す |
| 手順（`leak-check-push`） | 必須なのに秘密が空 | 環境 `leak-scan` の秘密が無い（変数が `1`） | `leak-scan-secret.sh` の `build_overlay` | 止める | `leak-scan-secret: 秘密 LEAK_CHECK_PATTERN が無い（必須にしている）`、1 | 持ち主が環境の秘密を登録し、実行を再実行する |
| 手順（`leak-check-push`） | 秘密が空で必須でない | 決定 10 の手順 4 の前 | 同上 | 既定値で続ける（`.gitleaks.toml` だけで探す） | 空のときの行、当たりが無ければ 0 | 持ち主が決定 10 の手順 4 でこの行が出ていないことを確かめる |
| ジョブ `leak-check-push` | 環境を使えない | 環境 `leak-scan` の使えるブランチに main が無い | GitHub がジョブを始める時 | 止める | 実行の誤り | 持ち主が環境の設定を直して再実行する |

## CI の定義のテスト（`tools/test/ci-definition.test.ts`）

満たす決定: 決定 2・3・4・7・8・9・10、受け入れ条件 #96-3・#96-4・#96-5・#96-6・#96-8・#96-9・#101-1・#101-2・#101-3・#101-4・#101-7

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `Workflow`（型） | `tools/test/ci-definition.test.ts` | 変更 | ジョブに `if`・`environment`・`needs`・`uses`・`with`・`secrets`・`steps`・`env`・`"continue-on-error"` を足し、手順の型 `Step`（`name`・`uses`・`with`・`run`・`env`・`if`・`"continue-on-error"`）を足す | テストが読む鍵を型で持つ |
| `loadWorkflowFile` | 同上 | 新設 | `loadWorkflowFile(root: string, path: string): LoadedWorkflow` | 1 つの YAML を読んで解き、鍵と値の組でなければ例外にする |
| `loadWorkflows` | 同上 | 変更 | 変えない（`(root: string) => LoadedWorkflow[]`） | 読む処理を `loadWorkflowFile` に移し、`.github/workflows/` の一覧を回すだけにする |
| `triggerNames` | 同上 | 新設 | `triggerNames(doc: Workflow): string[]` | `on` の 3 つの書き方（文字列・配列・鍵）から起動の名前を返す |
| `triggersPullRequest` | 同上 | 変更 | 変えない | `triggerNames` を使って書き直す。振る舞いは変えない |
| `triggerViolations` | 同上 | 新設 | `triggerViolations(workflows: LoadedWorkflow[], caller: LoadedWorkflow): string[]` | `ALLOWED_TRIGGERS` に無い起動を `<パス>#on.<起動>` の形で返す |
| `pullRequestChecks` | 同上 | 変更 | 変えない | `NOT_REQUIRED_JOBS`（`leak-check-push`）の鍵のジョブを除いて数える |
| `runCommandWords` | 同上 | 新設 | `runCommandWords(run: string): string[]` | `run:` の文字列を行と `;`・`&&`・`\|\|`・`\|`・`$(` で区切り、各コマンドの最初の語を返す（変数の代入と `if`・`then`・`else`・`fi`・`!` は読み飛ばす） |
| `secretWorkflowViolations` | 同上 | 新設 | `secretWorkflowViolations(workflow: LoadedWorkflow, ci: LoadedWorkflow): string[]` | `leak-check-secret.yml` が設計文書の決定 4 の形のどれかを外れた所を返す |
| `callerViolations` | 同上 | 新設 | `callerViolations(caller: LoadedWorkflow): string[]` | 呼び出しのワークフローの見本が決定 4 の形を外れた所を返す |
| `leakJobViolations` | 同上 | 新設 | `leakJobViolations(ci: LoadedWorkflow): string[]` | `ci.yml` の `leak-check` と `leak-check-push` の分け方（決定 3・9）を外れた所を返す |
| `actorConditions` | 同上 | 新設 | `actorConditions(workflows: LoadedWorkflow[]): string[]` | 漏れの検査のワークフローと見本の文字列に、`github.actor`・`github.triggering_actor`・`dependabot` がある所を返す |
| `patternSecretReaders` | 同上 | 新設 | `patternSecretReaders(workflows: LoadedWorkflow[]): string[]` | `secrets.LEAK_CHECK_PATTERN` を読むジョブを `<パス>#jobs.<鍵>` の形で返す |

- `secretWorkflowViolations` が返す所（設計文書の決定 4 の箇条を、この順に 1 つの印ずつ）
  - `on` が `workflow_call` だけでない（`triggerViolations` と重ねて見る）
  - `uses:` が、SHA で固定した `actions/checkout` でない
  - `actions/checkout` の `with` が、`repository: devbasex/nd-factory`・`ref: ${{ inputs.code_sha }}`・`persist-credentials: false` でないか、`allow-unsafe-pr-checkout` を持つ
  - 「gitleaks を固定の版と要約値で置く」の手順を除く `run:` の `runCommandWords` に、`git`・`tools/checks/export-tree.sh`・`tools/checks/leak-scan-secret.sh`・`echo`・`exit`・`[[` のほかがある。`git archive`・`tar`・`--details`・`setup-node`・`npm`・`npx` の語がある
  - 「gitleaks を固定の版と要約値で置く」の手順の `run:` と、ジョブの 2 つの定数が、`ci.yml` の `leak-check` のものと違う
  - どの `run:` にも `GITHUB_ENV`・`GITHUB_OUTPUT` があるか、gitleaks の手順のほかに `GITHUB_PATH` がある
  - `run:` の中に `${{ inputs.` がある
  - ジョブか手順に `if` か `continue-on-error` がある
  - 最上位の `permissions` が `{ contents: read }` だけでないか、ジョブが `permissions` を持つ
  - `secrets.LEAK_CHECK_PATTERN` を `env` に持つ手順が「秘密の規則を重ねて探す」のほかにある
  - ジョブの `name` に、6 つの入力の式（`${{ inputs.pr_number }}` など）のどれかが無い
  - 分岐点を求める `git merge-base` に、`$BASE_SHA` と `$HEAD_SHA` 以外を渡す。マージコミットの親を確かめる `git rev-list --parents` が無い
  - `export-tree.sh` の呼び出しが無いか、`leak-scan-secret.sh` の `dir` と `git --range` の呼び出しのどちらかが無い
- `callerViolations` が返す所: `on` が `workflow_dispatch` だけでない。`uses:` が `devbasex/nd-factory/.github/workflows/leak-check-secret.yml@main` でない。`secrets: inherit` を使う。`scan` が `needs: generation` を持たない。`generation` の手順が `vars.LEAK_CHECK_GENERATION` と `inputs.generation` を読まない。最上位の `permissions` が `{ contents: read }` だけでない
- `leakJobViolations` が返す所
  - `leak-check`: `if` が `github.event_name == 'pull_request'` でない。`environment` か `secrets.` か `LEAK_CHECK_REQUIRE_PATTERN` を持つ。`leak-scan.sh` の `dir` か `git --range` の呼び出しが無い
  - `leak-check-push`: `if` が `github.event_name == 'push'` でない。`environment` が `leak-scan` でない。`leak-scan-secret.sh dir --count-only` か `leak-scan-secret.sh git --count-only` の呼び出しが無い。`--range` を渡す。`LEAK_CHECK_REQUIRE_PATTERN` を受けない
- `patternSecretReaders` の期待は、公開のリポジトリの `.github/workflows/` のうち `ci.yml#jobs.leak-check-push` と `leak-check-secret.yml#jobs.leak-check-secret` の 2 つだけである。`leak-check-secret.yml` は秘密を `on.workflow_call.secrets` で受ける

### 異常系の処理

テストの関数は、読めない YAML と鍵と値の組でない YAML で例外を投げる（`loadWorkflowFile`。今の `loadWorkflows` と同じ）。ほかの関数は、外れた所を印の配列で返し、テストが空の配列と比べる。外れた所の印にファイルの中身を入れない。

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `ALLOWED_TRIGGERS` | 定数 | `tools/test/ci-definition.test.ts` | `leak-check-secret.yml` は `workflow_call`、見本は `workflow_dispatch`、ほかのワークフローは `push`・`pull_request`・`schedule`・`workflow_dispatch` |
| `NOT_REQUIRED_JOBS` | 定数 | 同上 | `["leak-check-push"]` |
| `SECRET_WORKFLOW_COMMANDS` | 定数 | 同上 | `git`・`tools/checks/export-tree.sh`・`tools/checks/leak-scan-secret.sh`・`echo`・`exit`・`[[` |
| `CALLER_PATH` | 定数 | 同上 | `docs/operations/leak-check-caller.yml` |

### 既存の部品の再利用

| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `loadWorkflowFile` | `loadWorkflows` の中の読み方 | ファイルを読んだ | 読む処理を切り出し、`loadWorkflows` もこれを使う |
| `triggerNames` | `triggersPullRequest` | 同上 | 3 つの書き方の読み方を切り出し、`triggersPullRequest` もこれを使う |
| `secretWorkflowViolations`・`leakJobViolations` | `permissionBlocks`・`isReadOnly` | 同上 | 使う |
| `runCommandWords` | シェルの構文を解くライブラリ | `package.json` の依存を読んだ | このリポジトリに無い。依存を足さず、決まった形の `run:` だけを読む簡単な区切りにする。区切りで読めない書き方（ヒアドキュメント・関数の定義）は、`leak-check-secret.yml` で使わないことを `secretWorkflowViolations` の印で落とす |
| `actorConditions`・`patternSecretReaders` | `credentialWords` | 同上 | 文字列で探す形だけ倣う |

### 単体テストの観点

今のテストと同じく、作り物のワークフローを一時の木に置いて関数を打つ（`makeTree`・`docOf`）。最後の `describe("CI の定義")` で、実際のワークフローと見本に対して空の配列を期待する。

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `triggerNames` | 3 つの書き方で同じ名前の一覧 | `on` が無いと空 | — |
| `triggerViolations` | 実際のワークフローで空 | — | `leak-check-secret.yml` に `pull_request_target` か `workflow_run` を足す・`ci.yml` に `pull_request_target` を足すと当たる |
| `pullRequestChecks` | 実際の `ci.yml` で、必須のチェックの宣言の 7 つと等しい | — | 必須の宣言に無い Pull Request のジョブを足すと当たる |
| `runCommandWords` | `a && b \| c`・`x="$(git rev-parse y)"` で `a`・`b`・`c`・`git` | `if [[ ... ]]; then` で `[[` | — |
| `secretWorkflowViolations` | 実際の `leak-check-secret.yml` で空 | — | 決定 4 の箇条ごとに 1 つずつ壊した作り物で、その印が 1 つだけ出る（`ref` を head にする・`npm ci` を足す・`actions/setup-node` を足す・`run:` に `${{ inputs.head_sha }}` を書く・`continue-on-error: true` を足す・表示名から head の SHA を外す・親の確かめを外す・`git archive` を使う・`--details` を足す・`pull-requests: write` を足す） |
| `callerViolations` | 実際の見本で空 | — | `secrets: inherit`・`@` の後を SHA にする・世代の確かめを外すと当たる |
| `leakJobViolations` | 実際の `ci.yml` で空 | — | `leak-check` に秘密か `environment` を戻す・`leak-check-push` から `environment` か `dir` の呼び出しを外す・`--range` を渡すと当たる |
| `actorConditions` | 実際のワークフローで空 | — | `if: github.actor != 'dependabot[bot]'` を足すと当たる |
| `patternSecretReaders` | 実際のワークフローで 2 つ | — | `leak-check` で秘密を読むと 3 つになる |

## 漏れの検査の結合のテスト（`tools/test/leak-scan.integration.test.ts`）

満たす決定: 決定 5・8、受け入れ条件 #96-1・#96-2・#96-6・#96-7・#96-9・#101-2

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `secretScan` | `tools/test/leak-scan.integration.test.ts` | 新設 | `secretScan(cwd: string, args: string[], env: { pattern?: string; require?: boolean }): { status: number \| null; output: string }` | `leak-scan-secret.sh` を子のプロセスで打ち、標準出力と標準エラーを合わせて返す。`LEAK_CHECK_PATTERN` と `LEAK_CHECK_REQUIRE_PATTERN` は引数からだけ渡し、テストを打つ人の環境の値を引き継がない |
| `exportTree` | 同上 | 新設 | `exportTree(cwd: string, commit: string, out: string): { status: number \| null; output: string }` | `export-tree.sh` を子のプロセスで打つ |
| `mergeRepo` | 同上 | 新設 | `mergeRepo(base: Record<string, string>, head: Record<string, string>): { root: string; baseSha: string; headSha: string; mergeSha: string }` | 共通のコミットから base と head を分け、`git merge --no-ff` で 2 つの親のマージコミットを作る |

- 新しい `describe` は 2 つにする。「秘密を使う探し（leak-scan-secret.sh）」と「木の取り出し（export-tree.sh）」である。中身の観点は、上の 2 つのスクリプトの「単体テストの観点」の表にある
- 合わせた後の木でだけ当たる値は、正規表現を `(?s)<語 1>.{0,40}<語 2>` にし、base が同じファイルの 1 行目に語 1 を、head が 3 行目に語 2 を足すマージで作る。base の木と head の木を別々に `dir` で探すと 0、マージコミットの木を取り出して探すと 1 になる
- 子のプロセスの起動は今の `scan` と同じく `spawnSync` で、実時間の待ちを置かない

### 異常系の処理

`secretScan` と `exportTree` は投げずに結果を返し、テストが終了コードと出力を確かめる。`mergeRepo` は、作り物のリポジトリを作れなければ今の `git` と同じく例外を投げる。

### 既存の部品の再利用

| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `secretScan`・`exportTree` | `scan` | ファイルを読んだ | 使えない。`scan` は `leak-scan.sh` に `--report` と `--paths` を必ず足す。起動の形（`spawnSync` で `bash` を打つ）だけ倣う |
| `mergeRepo` | `makeRepo`・`commitAll`・`git` | 同上 | 使う |
| 作り物の値 | `fakeWord`・`fake` | 同上 | 使う |

## NDF への依頼と 2 本目の Pull Request

満たす決定: 決定 7・10

このリポジトリでは関数を作らない。設計の承認の後、人の承認を得て devbasex/ai-plugins へ出す依頼（他のリポジトリへの公開なので、設計文書の「人へ残す判断」のレッドライン C5 に当たる）には、設計文書の決定 7 に挙げた手順 1〜9・外れ方の 4 つの分類・記録の 3 つの状態と、決定 10 の手順 6 の読み取り元の決まりを、そのまま要求として載せる。依頼の起票はこの実装の Pull Request の作業に含めない。

2 本目の Pull Request で `.ndf/project.json` に足す項目の名前と形は、NDF の依頼で決まる。1 本目では `.ndf/project.json` を変えない。CI の定義のテストの「必須のチェックの宣言」の比べは、1 本目の後も今の 7 つのままで通る。

## 運用の文書と指示書（`docs/operations/ci-checks.md`・`AGENTS.md`・`docs/design/platform.md`）

満たす決定: 決定 6・7・8・9・10、受け入れ条件 #101-5・#101-6

### 書く節

| 文書 | 節 | 中身 |
| --- | --- | --- |
| `docs/operations/ci-checks.md` | 検査ごとの秘密の受け方と結果の見え方 | `ref-check`・`leak-check`・`leak-check-push`・非公開の検査の 4 つについて、どの実行が秘密を受け、誰に結果が見えるかの表。残る経路（main に直に push できる人・`main` という名前のタグを作れる人・非公開リポジトリに書き込める人）と、持ち主が見張る点 |
| 同上 | 秘密と変数の登録 | 非公開リポジトリの作成と見本の写し・秘密 `LEAK_CHECK_PATTERN`・変数 `LEAK_CHECK_GENERATION`。環境 `leak-scan`（使えるブランチは main だけ）とその秘密・変数 `LEAK_CHECK_REQUIRE_PATTERN`。`REF_CHECK_TERMS` の 2 か所。Dependabot の Pull Request では操作が要らず、Dependabot の秘密に `LEAK_CHECK_PATTERN` を登録しないこと |
| 同上 | NDF の認証の権限 | 非公開リポジトリの変数の読み取り・ワークフローの起動・実行とジョブの読み取りの権限と、読み取りの権限を持つ人を最小にすること |
| 同上 | 秘密を変える手順 | 設計文書の決定 7 の切り替えの手順 1〜4。今の世代の値を控え、非公開リポジトリの変数 `LEAK_CHECK_GENERATION`（世代）を `0` にする → NDF の時間の上限 T を待つ → NDF の記録に、結果不明と未検証の状態の記録が残っていないことを確かめる → 秘密を変える → 世代を、控えた値に 1 を足した値にする |
| 同上 | 導入の順序 | 設計文書の決定 10 の手順 2〜6。その手順 3 の中の、1 本目を手元で探す 6 つの手順と、1 本目のマージから、持ち主が非公開リポジトリで探しを手で起動して成功を確かめる（決定 10 の手順 5）まで、NDF にほかの Pull Request をマージさせないこと。2 本目へ進む条件 |
| 同上 | 当たりの場所を手元で引く | 非公開の記録の表示名の SHA で対象を取り、`export-tree.sh` と `leak-scan-secret.sh --details` を打つ手順（決定 8 の手順 1〜4）。main への push の当たりも同じく引くこと。当たりの理由を公開の Pull Request に書かないこと |
| 同上 | 見本の写し直し | `docs/operations/leak-check-caller.yml` を変えたら、世代を切り替えて非公開リポジトリへ写し直すこと |
| 同上 | 振る舞いの変化 | main への push で結合のテストを打たなくなったこと（上の `ci.yml` の節） |
| `AGENTS.md` | 秘密とインフラの値を置かない | 47 行目の「`leak-check` のジョブが `.gitleaks.toml` に重ねて探す」を、「Pull Request は NDF のマージの直前に検査用の非公開リポジトリで、main への push は環境 `leak-scan` を持つ `leak-check-push` で、`.gitleaks.toml` に重ねて探す」に直し、`docs/operations/ci-checks.md` へリンクする。gitleaks の当たりの外し方の文は変えない |
| `docs/design/platform.md` | 設計の決まりを縛る検査の「漏れの検査」の行 | 落とすものの列の最後に、「実際の値の当たりは、Pull Request では NDF のマージの直前に検査用の非公開リポジトリで、main への push では `leak-check-push` で探す」を足す |
