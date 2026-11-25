# #98 の詳細設計: 漏れの検査の探し直しと、探し終えたことの確かめ

[設計書](./issue-98-design.md)の解き方を、ファイルと関数の粒度へ下ろした文書である。決定の番号は[決定の記録](./issue-98-design-decisions.md)、受け入れ条件の番号は[要求仕様](./issue-98-requirements.md)を指す。記録の文言・失敗の条件の表・目印の形・バイナリの判定の条件・アーカイブの扱いは設計書と決定の記録が持つので、ここでは写さずに指す。

## 地図

パッケージ・モジュール構成（`*` は新設）:

```text
tools/checks/
├── leak-scan.sh            引数の確かめと本体の起動
├── leak_scan/*             検査の本体（Python。標準ライブラリだけ）
│   ├── main.py*            dir と git の流れ、出力と終了コード
│   ├── model.py*           モジュールの間で受け渡す型
│   ├── gitleaks.py*        gitleaks の起動、記録と報告の読み取り、設定の生成
│   ├── tree.py*            今の木の探し直しの対象
│   ├── history.py*         履歴の対象の一覧、照らし合わせ、帰属
│   ├── relay.py*           git の中継
│   ├── copyrepo.py*        写しのリポジトリと 2 回目の探し
│   └── archive.py*         アーカイブと圧縮ファイルの展開
├── leak-scan-secret.sh
└── install-gitleaks.sh
.gitleaks.toml
```

依存の向きは一方向で、循環は無い。`leak-scan.sh` → `main.py` → `history.py` → `tree.py` → `archive.py`・`copyrepo.py` → `gitleaks.py` → `model.py` の順で、左のモジュールは右のモジュールだけを読み込む（`archive.py` は `model.py` だけを読み込む）。`relay.py` は gitleaks が起こす別のプロセスで、ほかのモジュールを読み込まず、読み込まれもしない。本体との受け渡しは、状態のファイルと一覧のファイルだけである。設計書が「`leak-scan.sh` が行う」と書く処理は、`leak-scan.sh` から起動する本体の全体が行う。

本体を Python にするのは、対象の対応表・照らし合わせ・当たりの合わせ方が構造を持つデータの処理で、展開（決定 8）に `python3` が要るためである。起動は `python3 -I -B` とする。`-B` を外すと `__pycache__` が探す木の中にできる。`-I` はスクリプトのディレクトリを読み込みの対象に入れないので、`main.py` が自分のディレクトリだけを `sys.path` に足す。

| パス | 種類 | 役割 1 文 | 依存する先 | クラスまたはモジュール | メソッドと最上位の関数 |
| --- | --- | --- | --- | --- | --- |
| `tools/checks/leak-scan.sh` | 変更 | 引数と前提を確かめて本体へ渡す | `main.py` | シェルスクリプト | `usage`（変えない）。`log_has_skipped`・`note_hidden`・`finish` は本体へ移して削除 |
| `tools/checks/leak_scan/main.py` | 新設 | 探しの流れを組み、出力と終了コードを決める | 下のモジュール | `main` | `main`・`run_dir`・`run_git`・`conclude` |
| `tools/checks/leak_scan/model.py` | 新設 | 受け渡す型と固定の行を持つ | 無し | `model` | 型と定数だけ |
| `tools/checks/leak_scan/gitleaks.py` | 新設 | gitleaks の入出力を閉じ込める | `model.py` | `gitleaks` | `run_gitleaks`・`parse_log_line`・`classify_skip`・`read_report`・`write_marker_config`・`write_rescan_config` |
| `tools/checks/leak_scan/tree.py` | 新設 | 今の木で探し直す対象を集めて写しに足す | `archive.py`・`copyrepo.py`・`gitleaks.py` | `tree` | `is_excluded`・`collect_tree_targets` |
| `tools/checks/leak_scan/history.py` | 新設 | 履歴の対象を決め、読み終えたかを確かめる | `tree.py`・`gitleaks.py`・`model.py` | `history` | `list_entries`・`check_markers`・`is_binary`・`added_lines`・`attribute`・`merge_findings` |
| `tools/checks/leak_scan/relay.py` | 新設 | `git log -p` の出力に目印を足し、コミットの行を書き換える | 無し | `relay` | `main`・`rewrite_log` |
| `tools/checks/leak_scan/copyrepo.py` | 新設 | 対象を親の無いコミットにして探す | `gitleaks.py` | `CopyRepo` | `install_relay`・`add`・`scan` |
| `tools/checks/leak_scan/archive.py` | 新設 | 先頭のバイトで見分けて、上限つきで展開する | `model.py` | `archive`・`BudgetedReader` | `detect`・`expand`・`normalize_name` |
| `tools/checks/leak-scan-secret.sh` | 変更 | 新しい失敗の行を見分ける | `leak-scan.sh` | シェルスクリプト | `count_failed`（変更） |
| `tools/checks/install-gitleaks.sh` | 変更 | 既定の設定のファイルも置く | 無し | シェルスクリプト | 関数は無い |
| `.gitleaks.toml` | 変更 | token の規則と絞った許可 | 無し | 設定 | — |
| `tools/test/leak-scan.integration.test.ts` | 変更 | 設計書の「テスト設計」を縛る | `tools/checks/` | テスト | テストの補助の関数 |
| `docs/design/detail.md`・`docs/specifications/leak-check.md`・`docs/operations/ci-checks.md`・`AGENTS.md` | 変更 | 記述を実装に合わせる | 無し | 文書 | — |
| `docs/specifications/ndf-contract-use.md`・`packages/contracts/test/ndf-contract-use.test.ts`・`packages/contracts/src/web-config.ts` | 変更 | `acme` の置き場と端点の例を書き換える | 無し | 文書・テスト・コメント | — |
| `infra/test/app-stack-login.test.ts`・`infra/test/app-stack.test.ts`・`infra/test/nd-setup.test.ts` | 変更 | Cognito の端点をテストの中で組み立てる | 無し | テスト | — |

## 起動と流れ（leak-scan.sh・main.py・model.py）

満たす決定: 決定 4・7、受け入れ条件 4

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `main` | `main.py` | 新設 | `(argv: list[str]) -> int` | 引数を `Context` にし、一時ディレクトリを作り、`run_dir` か `run_git` の結果を `conclude` に渡す |
| `run_dir` | `main.py` | 新設 | `(ctx: Context) -> Outcome` | 設計書の「今の木の探し」の図の順に進める |
| `run_git` | `main.py` | 新設 | `(ctx: Context) -> Outcome` | 履歴の 1 回目、照らし合わせ、写しの探し、合わせる処理の順に進める |
| `conclude` | `main.py` | 新設 | `(ctx: Context, outcome: Outcome) -> int` | 目印を除いた当たりと失敗の印を出し、終了コードを返す |

- `leak-scan.sh`
  - 事前条件: 引数の形は今のまま
  - 事後条件: 引数の誤り・設定のファイルの欠け・`.gitleaksignore`・読めない範囲は、今と同じ行と終了コード 2 で終える。通れば `exec python3 -I -B <このスクリプトのディレクトリ>/leak_scan/main.py <mode> <config> <range> <report> <paths>` に替わる
  - 副作用: `python3` が PATH に無ければ、`dir` では「飛ばした」の固定の行、`git` では履歴の固定の行を出して 1。gitleaks は打たない
- `main`
  - 事後条件: 一時ディレクトリは、例外とシグナル（`SIGINT`・`SIGTERM`・`SIGHUP`）で終えるときも消える。シグナルは `SystemExit` に変える
  - 副作用: 一時ディレクトリの作成と削除
- `run_dir`・`run_git`
  - 事前条件: 今のディレクトリが探す木の根である
  - 事後条件: 失敗の条件に当たっても例外で抜けず、`Outcome` に印を立てて次へ進み、取れた当たりを残す
- `conclude`
  - 事後条件: 終了コードは、目印を除いた当たりが 1 件以上か印があれば 1、ほかは 0。`--report` は、生の報告を 1 つでも読めたときだけ書く。項目は今の 5 つ（`Email`・`Match` を出さない）
  - 副作用: 標準出力に当たりの行、標準エラーに失敗の行、`--report` のファイル

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `leak-scan.sh` | 本体を起こせない | `python3` が無い | `command -v python3` | 止める | 探しの固定の行、1 | 何も作らない。入れて打ち直せる |
| `main` | 想定外の例外 | 実装の誤り、ディスクの不足など | 最上位の `except` | 止める | 探しの固定の行と例外の型名、1。例外の文面と traceback は `--paths` のときだけ | 一時ディレクトリを消す。打ち直せる |
| `run_dir`・`run_git` | 途中の段の失敗 | `GitError`・`CopyError`・`ArchiveError`・設定を作れない | 各段の呼び出し | 既定値で続ける（印を立てる） | 下の固定の行、1 | 残りの対象を探す |
| `conclude` | `--report` を書けない | 保存先が無いなど | 書き込み | 止める | `main` の想定外の例外と同じ | 当たりの行は先に出ている |

### 処理の手順

`conclude` は次の順に出す。今の結合テストが縛る並び（警告の行 → 伏せた知らせ → 件数の行 → 名前を伏せた知らせ）は変えない。

| 順 | 条件 | 出すもの |
| --- | --- | --- |
| 1 | 常に | 当たりの行（今の形。`--paths` が無ければ `file-<番号>`） |
| 2 | 1 回目の報告を読めない | `leak-scan: gitleaks の報告を読めない（終了コード <n>）`。`--paths` が無ければ続けて伏せた知らせ |
| 3 | 印 `WARNING` | 今の「警告か誤り」の行。`--paths` が無ければ続けて伏せた知らせ |
| 4 | 印 `SKIPPED` | 「飛ばしたファイルを探せない」の行 |
| 5 | 印 `HISTORY` | 「履歴を最後まで探し終えたことを確かめられない」の行 |
| 6 | 当たりが 1 件以上 | `leak-scan: 当たり <n> 件` |
| 7 | `--paths` が無く、4・5・6 のどれかを出した | 名前を伏せた知らせを 1 回 |

gitleaks の終了コードが 0・1 のほかのときの印は、次のとおりとする。

| 探し | 条件 | 立てる印 |
| --- | --- | --- |
| 今の木の 1 回目 | 報告を読める | `WARNING`（新しい固定の行を増やさない） |
| 今の木の 1 回目 | 報告を読めない | 立てない（順 2 の行が失敗を表す） |
| 今の木の 2 回目 | 常に | `SKIPPED` |
| 履歴の 1 回目と写しの探し | 常に | `HISTORY` |

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `Context` | 型（`mode`・`config`（絶対パス）・`range`・`report`・`paths`・`root`・`work`） | `model.py` | — |
| `Finding` | 型（`rule_id`・`file`・`start_line`・`end_line`・`commit`・`email`・`match`） | `model.py` | — |
| `Outcome` | 型（`findings`・`marks`・`unreadable_status`・`report_read`） | `model.py` | — |
| `Mark` | 列挙（`WARNING`・`SKIPPED`・`HISTORY`） | `model.py` | — |
| 固定の行 | 定数 | `model.py` | 設計書の文言。`leak-scan-secret.sh` が見分ける 4 つの文言と同じにする |

### ログと記録の出力

| 関数 | 出すもの | レベルまたは書き先 | 出さないもの |
| --- | --- | --- | --- |
| `conclude` | 当たりの規則・ファイル・行・コミット、固定の行 | 標準出力・標準エラー・`--report` | 当たった値、`Email`、`Match`、`--paths` が無いときのファイル名 |
| `main` | 例外の型名 | 標準エラー | `--paths` が無いときの例外の文面（パスを含みうる） |

## gitleaks の入出力（gitleaks.py）

満たす決定: 決定 2・3・4・6、受け入れ条件 2・3・4

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `run_gitleaks` | `gitleaks.py` | 新設 | `(ctx, subcommand: Literal["dir","git"], source: Path, config: Path, tag: str, log_opts: str \| None, env: Mapping[str,str]) -> Run` | 今の引数に `--log-level trace` を足して打ち、報告と記録を `tag` ごとのファイルに受ける |
| `parse_log_line` | `gitleaks.py` | 新設 | `(line: bytes) -> LogLine \| None` | ANSI の並びを外し、段・文言・`key=value` の項目に分ける |
| `classify_skip` | `gitleaks.py` | 新設 | `(line: LogLine) -> SkipKind` | 設計書の「飛ばした行の分け方」の表を 1 か所で持つ |
| `read_report` | `gitleaks.py` | 新設 | `(path: Path) -> list[Finding] \| None` | JSON の配列を読む。無い・空・配列でない・項目が欠けるときは `None` |
| `write_marker_config` | `gitleaks.py` | 新設 | `(base: Path, marker_prefix: str, dest: Path) -> Path` | `[extend] path = <base の絶対パス>` と目印の規則を書く |
| `write_rescan_config` | `gitleaks.py` | 新設 | `(config: Path, default_config: Path, marker_prefix: str, work: Path) -> Path` | 全体の許可のパス条件を外した 2 回目の設定を作る（決定 6） |

- `run_gitleaks`
  - 事後条件: `Run` は終了コード・報告（`None` を含む）・解析した行の並びを持つ。打つ前に `tag` の報告のファイルが無いことを確かめる（`report-1.json`・`report-2.json` を共用しない）
  - 副作用: gitleaks の起動。`--paths` のときは、INF・WRN・ERR・FTL の段の行（件数の行を除く）だけを標準エラーへ写す
- `parse_log_line`
  - 事後条件: 段は 2 つ目の語で決める。段の形でない行は `None`。引用された値は Go の引用の形を戻し、`\xNN` はバイトとして扱う
- `write_rescan_config`
  - 事前条件: `default_config` は gitleaks の本体と同じディレクトリのファイル
  - 事後条件: `config` が `useDefault = true` なら、その行を「パス条件を外した既定の設定」の `path` に置き換えた写しを base にする。`useDefault` でなければ `config` をそのまま base にする。パス条件の除去は文字列の編集で行い、`tomllib` で読み直して `[allowlist]` の `paths` だけが消えたことを確かめる
  - 副作用: `work` の下にファイルを書く

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `run_gitleaks` | 終了コードが 0・1 のほか | gitleaks の失敗 | 戻り値 | 呼び出し元へ返す | 流れの表の印 | 同じ引数で打ち直せる |
| `run_gitleaks` | WRN・ERR・FTL の行（件数の行を除く）、`command aborted` | 読めない対象、内部の Git の失敗 | 解析した行 | 呼び出し元へ返す | 1 回目は `WARNING`（`command aborted` は `HISTORY`）、2 回目は探しの種類の印 | — |
| `write_rescan_config` | 設定を作れない | 既定の設定のファイルが無い、`[allowlist]` の `paths` がちょうど 1 つでない | 編集と読み直し | 呼び出し元へ返す（`ConfigError`） | 2 回目を打たず、探しの種類の印、1 | gitleaks を置き直して打ち直せる |
| `write_marker_config` | 設定を作れない | `base` のパスが TOML の文字列に書けない | 書く前の確かめ | 呼び出し元へ返す | 探しの種類の印、1 | — |

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `Run` | 型（`status`・`findings`・`lines`） | `model.py` | — |
| `SkipKind` | 列挙（`RESCAN`・`ALLOWLIST_FILE`・`ALLOWLIST_DIR`・`IGNORE`・`UNKNOWN`） | `model.py` | — |
| 目印の規則の id | 定数 | `model.py` | `leak-scan-marker` |
| 目印の接頭辞 | 実行ごとの値 | `main.py` が作る | `leak-scan-marker-<32 字の 16 進>` |
| 既定の設定のファイル名 | 定数 | `gitleaks.py` と `install-gitleaks.sh` | `gitleaks.default.toml`（`which gitleaks` の隣） |

## 今の木の対象（tree.py）

満たす決定: 決定 3・4・6・8、受け入れ条件 3・4

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `is_excluded` | `tree.py` | 新設 | `(path: str, config: Path, root: Path) -> bool` | 決定 6 の対象外の表を 1 か所で持つ（今の木と履歴で使う） |
| `collect_tree_targets` | `tree.py` | 新設 | `(ctx, run: Run, repo: CopyRepo, budget: Budget) -> set[Mark]` | 飛ばした行のファイル・外れたディレクトリの下のファイル・アーカイブの中のファイルを写しに足す |

- `is_excluded`
  - 事後条件: 途中のディレクトリの名前が `node_modules`・`bower_components` か、要素に `.git` を含むか、実体のパスが `config` と同じなら真
- `collect_tree_targets`
  - 事前条件: `run` は 1 回目の結果
  - 事後条件: 同じパスは 1 回だけ足す。大きさ 0 と確かめたファイルは足さない。展開のために、対象外でないすべての普通のファイルの先頭を読む（シンボリックリンクをたどらない）。アーカイブの中の葉のファイルは、評価のパスと報告のパス（決定 8）で足す
  - 副作用: 木のファイルの読み取り、写しのリポジトリへの書き込み

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `collect_tree_targets` | 分けられない `skipping` の行 | gitleaks の文言が増えた | `classify_skip` が `UNKNOWN` | 既定値で続ける | `SKIPPED`、1 | 残りを探す |
| `collect_tree_targets` | `path` を読めない、木の外、普通のファイルでない | 記録の形の違い、並行する変更 | 足す前の確かめ | 既定値で続ける（その対象を除く） | `SKIPPED`、1 | 打ち直せる |
| `collect_tree_targets` | ファイルかディレクトリを読めない | 権限 | `OSError` | 既定値で続ける | `SKIPPED`、1 | 権限を直して打ち直せる |
| `collect_tree_targets` | 展開の失敗 | 決定 8 の「失敗にするもの」 | `ArchiveError` | 既定値で続ける（確かめを通った葉は足す） | `SKIPPED`、1 | — |

## 履歴の対象と確かめ（history.py）

満たす決定: 決定 2・6・8、受け入れ条件 2・4

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `list_entries` | `history.py` | 新設 | `(root: Path, range: str \| None, config: Path) -> list[Entry]` | 設計書の「探す対象の一覧」の手順で（コミット、親、パス）と新しい blob を並べる |
| `check_markers` | `history.py` | 新設 | `(entries, relayed: set[Key], run: Run) -> tuple[list[Entry], set[Mark]]` | 確認 1・2 を行い、全体の許可が外した対象を返し、ほかの欠けに印を立てる |
| `is_binary` | `history.py` | 新設 | `(entry: Entry, blob: bytes, numstat_binary: set[Key], unset_diff: set[Key]) -> bool` | 設計書のバイナリの 3 条件を判定する |
| `added_lines` | `history.py` | 新設 | `(root: Path, entry: Entry) -> list[range]` | そのコミットがその親に対して足した行の番号を返す |
| `attribute` | `history.py` | 新設 | `(findings: list[Finding], added: list[range]) -> list[Finding]` | 足した行と重ならない当たりを除く（行の番号 0 は残す） |
| `merge_findings` | `history.py` | 新設 | `(added_pass: list[Finding], blob_pass: list[Finding]) -> list[Finding]` | （規則、コミット、パス、開始の行、終了の行）ごとに max(a, b) 件にする |

- `list_entries`
  - 事前条件: `range` は `leak-scan.sh` が `git rev-list` で確かめた 1 語
  - 事後条件: サブモジュールと `config` 自身は含まない。空の blob とモードだけの変更は `needs_marker` が偽。パスは `-z` の出力のまま持つ（UTF-8 でないバイトは `surrogateescape`）
  - 副作用: `git rev-list --parents`・`git diff-tree`
- `check_markers`
  - 事後条件: 目印は（コミット、パス、`Match` の親の欄）の 3 つで引く。除外の行は（コミット、パス）の組で引き、コミットを読めない行は根拠にしない。返す対象は `is_excluded` でないものだけ
- `is_binary`・`added_lines`
  - 副作用: 判定の入力は `git diff-tree --numstat`、`git check-attr --source=<コミット> -z --stdin diff`（コミットごとに 1 回）、`git cat-file --batch` で読む。`added_lines` は `git --literal-pathspecs diff-tree -p -U0 --text --no-renames --no-ext-diff --no-textconv` を打つ

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `list_entries` | 一覧を作れない | Git の失敗 | 終了コードと出力の形 | 呼び出し元へ返す（`GitError`） | `HISTORY`、1。1 回目の当たりは出す | 打ち直せる |
| `check_markers` | 中継の一覧に無い対象、目印の無い対象 | go-gitdiff が読むのをやめた、中継の失敗 | 照らし合わせ | 既定値で続ける | `HISTORY`、1 | — |
| `is_binary` | 属性を読めない | `check-attr --source` の失敗（Git 2.40 未満を含む） | 終了コード | 呼び出し元へ返す | `HISTORY`、1 | Git を上げて打ち直せる |
| `added_lines` | 足した行を読めない、blob を読めない | Git の失敗、浅い取得 | 終了コードと出力の形 | 呼び出し元へ返す | `HISTORY`。帰属できない当たりは除かずに出す、1 | 全履歴を取得して打ち直せる |

### 処理の手順

`run_git` が写しの探しに回す対象は、次の表で決める。1 回目の後に決めるので、全体の許可が外す対象に写しを 2 通り作らない。

| 全体の許可が外した（`check_markers` の返り） | バイナリ | アーカイブか圧縮 | 写しに足すもの | 当たりの扱い |
| --- | --- | --- | --- | --- |
| はい | どちらでも | いいえ | 変更後の blob 全体（元のパス） | `attribute` で帰属する |
| いいえ | はい | いいえ | 変更後の blob 全体（元のパス） | `attribute` で帰属し、`merge_findings` で合わせる |
| いいえ | いいえ | いいえ | 足さない | — |
| どちらでも | どちらでも | はい | blob 全体と、展開した葉のファイル | blob 全体は上の行のとおり。葉の当たりはすべて出す |

展開の対象は、一覧のすべての blob である（目印の確かめから除くモードだけの変更も、先頭のバイトを調べる）。

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `Entry` | 型（`commit`・`parent`（`none` を含む）・`path`・`blob`・`mode`・`needs_marker`） | `model.py` | — |
| `Key` | 型（`commit`・`parent`・`path`） | `model.py` | — |

## git の中継（relay.py）

満たす決定: 決定 2・3、受け入れ条件 2・4

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `main`（中継） | `relay.py` | 新設 | `(argv: list[str]) -> int` | `log` と `-p` を持たない呼び出しは本物の Git に置き換わり、持つ呼び出しは出力を `rewrite_log` に通す |
| `rewrite_log` | `relay.py` | 新設 | `(source: BinaryIO, sink: BinaryIO, state: RelayState) -> None` | 目印の hunk を足し、除くファイルを落とし、写しの探しでは `commit` の行を書き換える |

- `main`（中継）
  - 事前条件: 環境変数 `LEAK_SCAN_RELAY` が状態の JSON を指す
  - 事後条件: 本物の Git の終了コードを返す。`log -p` には `-c core.quotePath=true -c diff.noprefix=false -c diff.mnemonicPrefix=false` を `log` の前に足し、利用者の Git の設定で見出しの形が変わらないようにする
  - 副作用: 本物の Git の起動、一覧のファイルへの追記
- `rewrite_log`
  - 事後条件: hunk を持ち、新しい側が `/dev/null` でないファイルの末尾に、`@@ -<古い側の末尾>,0 +<新しい側の末尾の次>,1 @@` と `+<目印>-<親の欄>-end` を足し、（コミット、親、パス）を一覧に書く。1 行ずつ流し、出力の全体をメモリに持たない

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `main`（中継） | 本物の Git が 0 以外 | 読めない範囲など | 終了コード | 呼び出し元へ返す | gitleaks が `command aborted` を記録し、`HISTORY`、1 | — |
| `rewrite_log` | 読めない形の行 | hunk の行の数の不一致、途中で切れた出力、写しの番号を引けない `Author` の行 | 行ごとの確かめ | 止める（0 以外） | 同上 | 打ち直せる |

### 処理の手順

| 読んでいる所 | 行 | すること |
| --- | --- | --- |
| hunk の中（残りの行の数がある） | ` `・`+`・`-` | 古い側と新しい側の残りを減らして流す。残りが負になれば失敗 |
| hunk の中 | `\` | 流す |
| hunk の中 | ほかの行、EOF | 失敗 |
| hunk の外 | `@@ ` | 行の数を読み、hunk に入る |
| hunk の外 | `diff --git `・`commit `・空の行・EOF | 前のファイルに目印の hunk を足してから流す |
| hunk の外 | `+++ ` | パスを読み、Git の引用の形を戻す |
| `commit ` の直後（写しの探し） | `Author:` の行 | メールアドレスの番号から元のコミットを引き、保持した `commit` の行を書き換えて流す。元のコミットが無い対象は書き換えない |

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `RelayState` | JSON（`real_git`・`marker_prefix`・`exclude`（リポジトリの根からのパス）・`listed`（一覧のファイル）・`rewrite`（番号 → 元のコミット）） | `copyrepo.py` の `install_relay` が書き、`relay.py` が読む | `exclude`・`rewrite` は空 |

## 写しのリポジトリ（copyrepo.py）

満たす決定: 決定 3・4・6・8、受け入れ条件 2・3・4

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `install_relay` | `copyrepo.py` | 新設 | `(work: Path, state: RelayState, env: Mapping[str,str]) -> dict[str,str]` | `git` の名前の起動スクリプトを置き、`PATH` の先頭に足した環境を返す（1 回目と 2 回目で使う） |
| `CopyRepo.add` | `copyrepo.py` | 新設 | `(self, target: Target, data: bytes) -> int` | 対象に番号を振り、そのファイルだけを持つ親の無いコミットを `refs/leak-scan/<番号>` に作る |
| `CopyRepo.scan` | `copyrepo.py` | 新設 | `(self, ctx, mark: Mark) -> tuple[list[Finding], set[Mark]]` | 2 回目を打ち、決定 4 の条件 4〜8 を確かめ、当たりを報告のパスとコミットに戻す |

- `install_relay`
  - 事後条件: 本物の Git は `PATH` を変える前の `which git`。起動スクリプトは `python3 -I -B relay.py` を呼ぶ（パスはシェルの引用をする）
  - 副作用: `work` の下の起動スクリプトと状態のファイル
- `CopyRepo.add`
  - 事後条件: 最初の呼び出しでリポジトリを作る（`git init -q --template=`）。環境は決定 3 の (1)〜(3)。作業ツリーに書かない。番号は 1 から
  - 副作用: 写しのリポジトリへの `hash-object -w`・`read-tree`・`update-index`・`write-tree`・`commit-tree`・`update-ref`
- `CopyRepo.scan`
  - 事前条件: 対象が 1 件以上（0 件なら gitleaks を打たずに空を返す）
  - 事後条件: `--log-opts` は `-m --all --text --no-textconv --no-ext-diff --no-renames`。渡した `mark` は、今の木が `SKIPPED`、履歴が `HISTORY`。目印の当たりは返さない。今の木の対象は `commit` が空
  - 副作用: gitleaks の起動

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `install_relay` | 本物の Git が無い、書けない | 環境 | `which`・`OSError` | 呼び出し元へ返す | 探しの種類の印、1 | — |
| `CopyRepo.add` | 写しを作れない | Git の失敗、`.git` の要素を持つメンバー名 | 終了コード | 呼び出し元へ返す（`CopyError`。その対象を除く） | 探しの種類の印、1。残りは探す | 一時ディレクトリごと消える |
| `CopyRepo.scan` | 決定 4 の条件 4〜8 を満たさない | 終了コード、報告、飛ばした行、番号・`File`・`Commit` の不一致、目印の欠け | `Run` と対応表 | 既定値で続ける（取れた当たりは返す） | `mark`、1 | 打ち直せる |

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `Target` | 型（`commit`（元。今の木は空）・`parent`・`path`・`copy_path`・`report_path`・`added`（帰属しないときは `None`）） | `model.py` | — |
| 作者とコミッターの固定の値 | 定数 | `copyrepo.py` | 名前 `leak-scan`、日時は固定。作者のメールは `<番号>@leak-scan.invalid` |

## アーカイブの展開（archive.py）

満たす決定: 決定 8、受け入れ条件 4

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `detect` | `archive.py` | 新設 | `(head: bytes, name: str, data: Callable[[], bytes]) -> Kind \| None` | 先頭の 512 バイトで形式を返す。展開できない形式は `UNSUPPORTED`。`.br` のときだけ中身の全体を読む |
| `expand` | `archive.py` | 新設 | `(path: str, data: bytes, budget: Budget) -> Iterator[Leaf \| ArchiveError]` | 入れ子をたどり、葉のファイルを評価のパス・報告のパス・中身で返す |
| `normalize_name` | `archive.py` | 新設 | `(name: str) -> str \| None` | 決定 8 のメンバー名の形にそろえる。使えない名前は `None` |

- `expand`
  - 事前条件: `detect` がアーカイブか圧縮と判定した中身
  - 事後条件: 葉は空でない非アーカイブのメンバーだけ。1 つの失敗は値として返して残りのメンバーを続け、ファイルの全体が読めないときはそれで終える。展開で得るバイトは `budget` に足し、読む量は 1 MiB 以下かつ「残り + 1」以下。上限を超えたら以後の展開をすべてやめる
  - 副作用: 無し（ファイルに書かない。中身はメモリに持ち、合計は上限で抑える）

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `expand` | 壊れ・途中で切れ・暗号化 | `BadZipFile`・`zlib.error`・`EOFError`・`TarError`・`LZMAError`・`OSError`、zip の暗号化のビット、tar の終端の目印の欠け、メンバーの長さの不足 | 読み取りと読んだ後の確かめ | 呼び出し元へ返す（`ArchiveError`） | 呼び出し元の印、1 | — |
| `expand` | 展開できない形式、入れ子が 5 段を超える、上限の超過、使えないメンバー名 | 決定 8 | `detect`・段の数・`Budget`・`normalize_name` | 呼び出し元へ返す | 同上 | — |

### 処理の手順

| 形式 | 読み方 | 中のパス |
| --- | --- | --- |
| zip | `zipfile.ZipFile`。ディレクトリを除き、メンバーを固定の大きさで読む。同じ名前の項目は別々の葉にする | メンバー名 |
| tar | 圧縮を解かないモード（`r:`）で、`BudgetedReader` に包んで渡す。通常のファイルだけを読む。終わった位置の 512 バイトがすべて 0 であることを確かめる | メンバー名 |
| gzip・bzip2・xz | `gzip`・`bz2`・`lzma` を固定の大きさで読む | 名前から末尾の `.gz`・`.bz2`・`.xz` を除いた名前 |

- 繰り返しの終わる条件: 入れ子の段が 5 以下で、展開の合計が上限以下である
- 段の数え方: 展開 1 回を 1 段とする（`tar.gz` は 2 段）
- 評価のパスと報告のパス: 決定 8 の「2 つのパス」の表

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `Leaf` | 型（`eval_path`・`report_path`・`data`） | `model.py` | — |
| `Budget` | 型（残りのバイト。1 回の実行で 1 つ） | `model.py` | 1 GiB |
| `LEAK_SCAN_EXPAND_LIMIT` | 環境変数（正の整数。小さくする向きだけ効く。形の違う値は無視する） | `archive.py` | 未設定 |
| 入れ子の上限 | 定数 | `archive.py` | 5 |

## 非公開の検査と gitleaks の設置（leak-scan-secret.sh・install-gitleaks.sh）

満たす決定: 決定 6・7、受け入れ条件 4

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `count_failed` | `leak-scan-secret.sh` | 変更 | `count_failed <status> <report> <log>`（引数は変えない） | 失敗の文言に「飛ばした」と「履歴」の 2 つを足して見分ける |

`install-gitleaks.sh` は、定数 `GITLEAKS_CONFIG_SHA256` を足し、`v<版>` のタグの `config/gitleaks.toml` を取って要約値を確かめ、`<置く先>/gitleaks.default.toml` に置く。取得か要約値の確かめに失敗すれば今と同じく 1 で終える。引数と終了コードは変えない。`ci-definition.test.ts` が縛る呼び方（1 行）は変わらない。

## 規則と許可（.gitleaks.toml）

満たす決定: 決定 1・5、受け入れ条件 1・5・6

関数は無い。足す規則と許可の形は決定 1・5 のとおりで、置き方だけを次に定める。

| 項目 | 置き方 |
| --- | --- |
| `nd-delegation-token`・`nd-machine-token` | 規則の全体を秘密にする（`secretGroup` を持たない） |
| 名前の全体に当てる許可（許可 2 と S3 の許可 1） | `regexes` を `^…$` で書き、`secretGroup` が取り出した名前に当てる |
| 許可 1・3・4 の端点の側、ARN の 2 つの許可 | `regexTarget = "match"` で `^…$` にする |
| 許可 5 | 値を当てた規則に `condition = "AND"`・`commits`・`regexes` を置く |
| PR の分け方 | 設計書の「導入の順序」。1 本目は許可 1 を足すだけにする |

## テストの組み方

満たす決定: 決定 1〜8、受け入れ条件 1〜7

縛る振る舞いと壊し方は設計書の「テスト設計」にある。Python のテストの基盤は足さず、すべて `leak-scan.integration.test.ts` から実物の gitleaks で打つ。今のテストと補助のうち、次は本体の変更で前提が崩れるので直す。

| 今のテスト・補助 | 崩れる理由 | 直し方 |
| --- | --- | --- |
| `fakeGitleaksPath` を `git` の探しに使うテスト（「gitleaks の生の出力」「読めずに飛ばした対象」） | 偽の gitleaks は `git log` を打たないので、目印の確かめで失敗する | 本物の gitleaks を打った後に診断の行を足す偽の gitleaks にする |
| 同じテストの、段の語の無い標準エラーの行 | `--paths` でも INF・WRN・ERR・FTL の行だけを出す | 診断の行を INF の段の形にする |
| `git` で報告を読めないテスト | 目印を確かめられないので、履歴の固定の行と名前を伏せた知らせも出る | 期待する行に足す |
| 偽の gitleaks を使い、全体の許可が外すファイルを置くテスト | 既定の設定のファイルを gitleaks の隣に探す | 本物の `gitleaks.default.toml` を偽の実行ファイルの隣に写す |
| 「既定の全体の許可がパスで外すファイルの値は当てず…」と「作り物の値だけの木では当たらない」 | 決定 5・6 で期待が変わる | 設計書の「テスト設計」の 6 の行のとおり |

偽の gitleaks で目印の当たりや行を落とすテストは、本物を呼んで報告か記録を加工する共通の補助 1 つで作る。手元で打つときは、`install-gitleaks.sh` で本体と既定の設定のファイルを同じディレクトリに置く。

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `conclude` | 当たりと印の行の並び | 当たり 0 件で gitleaks が 1 | 報告を読めない、印が複数 |
| `parse_log_line`・`classify_skip` | 表の各文言 | 空白を含む引用の `path`、本文に `WRN` を含む DBG の行 | 知らない `skipping` の行 |
| `write_rescan_config` | `useDefault` の設定、重ねた設定 | `useDefault` の無い設定 | 既定の設定のファイルが無い |
| `collect_tree_targets`・`is_excluded` | ELF の頭、`.br` を含む名前、外れたディレクトリ | 空のファイル、`node_modules` という名前のファイル | 読めないファイル、展開の失敗 |
| `list_entries`・`check_markers` | 親ごとの目印 | 空のファイル、モードだけの変更、親の無いコミット、日本語の名前 | 目印の欠け、別のコミットの除外の行 |
| `is_binary`・`added_lines`・`attribute`・`merge_findings` | 3 条件の各 1 件 | 行の番号 0、前後の行にまたがる秘密、同じ行の 2 つの秘密 | 属性を読めない |
| `rewrite_log`・中継の `main` | 目印と `commit` の行の書き換え | `\ No newline at end of file`、引用されたパス | 行の数の不一致、Git の失敗 |
| `install_relay`・`CopyRepo` | 元のパスの当たり | 同じ写しのパスの 2 対象、元のリポジトリの `GIT_DIR` を設定した呼び出し | 決定 4 の条件 4〜8 の各 1 件 |
| `detect`・`expand`・`normalize_name` | zip・tar（v7 を含む）・gzip・bzip2・xz | `./` のディレクトリ、空のメンバー、入れ子 5 段、上限ちょうど | 切れた・暗号化・7z・長い名前の上限超過・`..` |
| `run_dir`・`run_git`・`main`・`read_report`・`run_gitleaks`・`write_marker_config` | 当たりの無い範囲が 0 | 探し直しの対象が 0 件 | 内部の `git log` の失敗、JSON でない報告 |
| `count_failed` | 当たりだけ | — | 新しい 2 つの行と当たりの同時 |

## 既存の部品の再利用

| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `main`・`run_dir`・`run_git`・`conclude` | `leak-scan.sh` の `finish`・`log_has_skipped`・`note_hidden` | ファイルを読んだ | 出力の形と文言を移す。報告と記録を 1 つの変数で持つ作りは使わない（設計書の「記録・報告・終了コード」） |
| `list_entries`・`is_binary`・`added_lines`・`check_markers`・`attribute`・`merge_findings` | `export-tree.sh` の `--history`（`diff-tree --raw` と `cat-file blob`） | `grep -rn "cat-file\|diff-tree\|ls-tree\|hash-object" tools/checks/*.sh` | 使えない。層のディレクトリへ書き出すシェルの処理で、親ごとの組を返さない。`diff-tree` の打ち方だけ合わせる |
| `run_gitleaks`・`read_report` | `leak-scan.sh` の引数の配列と `jq` の整形 | ファイルを読んだ | 引数の並びを移す。整形は Python の `json` で行う |
| `parse_log_line`・`classify_skip`・`write_marker_config`・`write_rescan_config` | `log_has_skipped`、`leak-scan-secret.sh` の `build_overlay` | ファイルを読んだ | 件数の行の除き方を移す。`build_overlay` は秘密の規則を組むシェルの関数で使えない |
| `is_excluded`・`collect_tree_targets` | gitleaks の全体の許可 | 決定 6 | 使えない。依存のディレクトリより広い名前を外すためである |
| `rewrite_log`・`main`（中継）・`install_relay`・`CopyRepo.add`・`CopyRepo.scan` | gitleaks の `--log-opts`、Git の配管コマンド | 設計書の「外部の調査」と決定 2・3 | 目印を足す仕組みは無い。写しは Git の配管コマンドを使う |
| `detect`・`expand`・`normalize_name` | `zipfile`・`tarfile`・`gzip`・`bz2`・`lzma` | 決定 8 | 使う。見分け方・上限・名前の確かめだけを書く。`tarfile` の展開のフィルターはファイルに書かないので使わない |
