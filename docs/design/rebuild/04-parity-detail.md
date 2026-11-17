# 対応表の詳細設計: 機能の対応表の検査・生成と、網羅の元の抜き出し

設計文書（[対応表の設計](03-parity.md)）の「構成要素」と「データ構造」「入出力の契約」「処理の流れ」を、ファイルと関数の粒度へ下ろした文書である。対応表・網羅の元のコピー・人が読む表の中身（133 行と 639 要素）は設計の段で置いてある。この文書は、それらを読み書きするスクリプトとテストだけを扱う。スクリプトとテストは旧い側に置く。この文書のパスは、断りの無い限り旧い側のリポジトリの根からの相対のパスである。

この文書の関数の名前は、置き場のモジュールを頭に付けて書く。2 つのスクリプトがどちらも `main` を持つため、名前だけでは置き場が決まらない。

| 書いた名前 | 置き場と関数 |
| --- | --- |
| `parity.check_shape` | 旧い側の `scripts/parity.py` の `check_shape` |
| `extract.main` | 旧い側の `scripts/parity-extract.py` の `main` |
| `test_parity.run_cli` | 旧い側の `tests/test_parity.py` の `run_cli` |

## 用語

| 語 | この文書での意味 |
| --- | --- |
| 置き場 | 対応表・網羅の元のコピー・人が読む表の 3 つのファイルを置くディレクトリ。既定は旧い側の対応表の置き場（`issues/` の下） |
| 違反 | 表の検査が見つけた不変条件の破れ 1 件。種類・対象・詳細の 3 つを持ち、1 行で出す |
| 漏れの値 | 環境の設定の漏れの検査が探す（項目の名前, 値）の組。`config.environments.public_leak_values()` が返す |
| 区分 | 網羅の元の要素の ID の `:` より前（`spec`・`route`・`screen`・`table`・`infra`・`env`・`config`） |

## ファイル配置

パッケージ・モジュール構成（旧い側。触るファイルだけ。`*` は新設。`<対応表の置き場>` は `issues/` の下の対応表のファイルのディレクトリ）:

```text
.
├── config/
│   └── environments.py              （読むだけ。public_leak_values）
├── issues/
│   └── <対応表の置き場>/
│       ├── parity.json              （承認の日と承認の時点の行を書く）
│       ├── coverage.json            （抜き出しが書き出す）
│       └── parity.md                （生成物）
├── scripts/
│   ├── parity.py                   *
│   └── parity-extract.py           *
└── tests/
    └── test_parity.py              *
```

依存は一方向である。

| ファイル | 使うもの | 使わないもの |
| --- | --- | --- |
| 旧い側の `tests/test_parity.py` | 2 つのスクリプト（サブプロセスで打つ） | — |
| `scripts/parity.py` | `config/environments.py` だけを import する | 網羅の元の文書（`docs/` と、全体設計の文書（`issues/` の下））を開かない（非機能の条件の移行性） |
| `scripts/parity-extract.py` | 標準のライブラリだけ | `scripts/parity.py` を import しない |

2 つのスクリプトの間で共有するのは置き場のファイルの形だけで、関数を共有しない。新しいリポジトリへ移すのは `scripts/parity.py` と `tests/test_parity.py` だけである。そこで import の 1 行を差し替える（設計の決定 3）。

| パス | 種類 | 役割 1 文 | 依存する先 |
| --- | --- | --- | --- |
| `scripts/parity.py` | 新設 | 置き場の 3 つのファイルを読み、不変条件 I1〜I10・I12 を確かめる `check` と、人が読む表を書き出す `render` を持つ | `config/environments.py` の `public_leak_values` |
| `scripts/parity-extract.py` | 新設 | 旧い側の網羅の元の文書から要素を抜き出し、網羅の元のコピーを書き出す `write` と、コピーと照らす `check`（I11）を持つ | 無し（標準のライブラリと `git`） |
| `tests/test_parity.py` | 新設 | 本物の置き場が 2 つの `check` を通ることと、規則ごとに壊した置き場で止まることを確かめる。CI のジョブ `test` が集める | `scripts/parity.py`・`scripts/parity-extract.py`（サブプロセス）・`config/environments.py` の `ENVIRONMENTS` |
| `<対応表の置き場>/parity.json` | 変更 | 設計承認の後に、承認の日（`approved_on`）と承認の時点の行の ID（`approved_rows`）を同じコミットで書く（設計の決定 9） | 無し |
| `<対応表の置き場>/coverage.json` | 変更 | `parity-extract.py write` が書き出す。今の中身と `write` の出力が一致しなければ、`write` の出力に置き換える | 無し |
| `<対応表の置き場>/parity.md` | 変更 | `parity.py render` が書き出す。今の中身と `render` の出力が一致しなければ、`render` の出力に置き換える | 無し |

旧い側の CI の定義（`.github/workflows/ci.yml`）は変えない。ジョブ `test` の `uv run pytest -q` が `tests/test_parity.py` を集める（設計の決定 4）。

## クラスと関数の構造

型の関係は設計文書の「データ構造」の節の ER 図を指し、ここでは描き直さない。クラスは作らず、モジュールと最上位の関数で書く。

| 置き場 | クラスまたはモジュール | メソッドと最上位の関数 |
| --- | --- | --- |
| `scripts/parity.py` | モジュール `parity` | 新設: `main`・`load_dir`・`run_checks`・`check_shape`・`check_duplicates`・`check_destination`・`check_not_built_kind`・`check_coverage`・`check_required_rows`・`check_added_reason`・`check_rendered`・`check_leaks`・`render`・`format_violation`・`_cell` |
| `scripts/parity.py` | 型 | 新設: `Violation`（`NamedTuple`）・`Loaded`（`NamedTuple`）・`ParityLoadError`（`Exception`） |
| `scripts/parity-extract.py` | モジュール `extract` | 新設: `main`・`extract_all`・`extract_spec_conditions`・`extract_routes`・`extract_screens`・`extract_tables`・`extract_infra_invariants`・`extract_env_vars`・`extract_config_fields`・`tables_under`・`title_of`・`build_copy`・`diff_elements`・`redact_lines`・`base_commit` |
| `scripts/parity-extract.py` | 型 | 新設: `Element`（`NamedTuple`）・`ExtractError`（`Exception`） |
| `tests/test_parity.py` | モジュール `test_parity` | 新設: 補助の `run_cli`・`copy_dir`・`edit_table`、フィクスチャ `parity_dir`、テストの関数（「単体テストの観点」の行ごと） |

## 関数の仕様

| 関数 | 置き場 | 種類 | シグネチャ | 責務 1 文 | 事前条件 | 事後条件 | 副作用 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `parity.main` | `scripts/parity.py` | 新設 | `main(argv: list[str]) -> int` | 引数を読み、`check` か `render` を選んで終了コードを返す | 無し | `check` は違反が無ければ 0・あれば 1、`render` は書けば 0。読めない・引数の誤りは 2 | 標準出力・標準エラーへの書き出し。`render` は `parity.md` を書く |
| `parity.load_dir` | `scripts/parity.py` | 新設 | `load_dir(directory: Path, need_rendered: bool) -> Loaded` | 置き場のファイルを読み、JSON を解いた中身と元の文字列を返す | `directory` はディレクトリのパス | `Loaded.table` と `Loaded.coverage` が `dict`、`need_rendered` なら `Loaded.rendered` が文字列 | ファイルを読む |
| `parity.run_checks` | `scripts/parity.py` | 新設 | `run_checks(loaded: Loaded, leak_values: list[tuple[str, str]]) -> list[Violation]` | 規則の関数をすべて呼び、違反を並びの決まり（「処理の手順」）で並べて返す | `loaded` は `load_dir` の戻り値 | 戻り値は違反の種類の順・同じ種類の中は見つけた順。違反が無ければ空。どの種類の違反も、対象と詳細に含まれる漏れの値は `[伏せた値: <値の種類>]` に置き換わる（I9。`知らない要素` の参照や `行き先` の番号が値を写しても出さない） | 無し |
| `parity.check_shape` | `scripts/parity.py` | 新設 | `check_shape(table: dict) -> list[Violation]` | 頭と行の型・列挙・必須の列・条件つきの必須を確かめる（I2〜I4、`plans` の値、ID の形） | `table` は `dict` | 欠けた列は `欠けた列`、それ以外の型と値の違いは `形` として返す | 無し |
| `parity.check_duplicates` | `scripts/parity.py` | 新設 | `check_duplicates(rows: list) -> list[Violation]` | 行の ID の重なりを示す（I1） | 無し（`id` が文字列でない行は数えない） | 2 回目以降に現れた ID ごとに `重なり` を 1 件返す | 無し |
| `parity.check_destination` | `scripts/parity.py` | 新設 | `check_destination(table: dict) -> list[Violation]` | 各行が行き先の子か作らない理由の一方だけを持つことを確かめる（I5） | 無し | 違反の行ごとに `行き先` を 1 件返し、3 列目は `両方`・`無い`・`範囲の外 <番号>` のどれか | 無し |
| `parity.check_not_built_kind` | `scripts/parity.py` | 新設 | `check_not_built_kind(table: dict) -> list[Violation]` | 作らない行の理由の種類と、種類ごとの条件を確かめる（I12、[判定の規則](01-rules.md)の I2・I3） | 無し | 違反の行ごとに `作らない理由` を返し、3 列目は `not_built_kind`・`ndf_issue`・`今も動かない dev_state`・`NDF 待ち kind`・`回帰・境界 kind` のどれか。`to` と `not_built` の両方を持つ行は `check_destination` に任せて作る行として見る | 無し |
| `parity.check_coverage` | `scripts/parity.py` | 新設 | `check_coverage(rows: list, coverage: dict) -> list[Violation]` | 網羅の元のすべての要素が指され、行が指す要素が網羅の元にあることを確かめる（I6） | 無し | 指されない要素ごとに `漏れ`（コピーの順）、知らない参照ごとに `知らない要素`（行の順）を返す | 無し |
| `parity.check_required_rows` | `scripts/parity.py` | 新設 | `check_required_rows(rows: list) -> list[Violation]` | 必ず要る追う対象ごとに、その行の種類の行が 1 行以上あることを確かめる（I7） | 無し | 欠けた追う対象ごとに `必ず要る行` を返す。並びは `REQUIRED_TRACKS` の順 | 無し |
| `parity.check_added_reason` | `scripts/parity.py` | 新設 | `check_added_reason(table: dict) -> list[Violation]` | 承認の後に足した行が理由・承認した課題の番号・理由の種類を持つことを確かめる（I10、[判定の規則](01-rules.md)の R13） | 無し | `approved_on` が日付で、行の ID が `approved_rows` に無い行ごとに、`added_reason` が空でない文字列でなければ詳細が空の、`added_issue` が正の整数でなければ詳細 `added_issue` の、`added_kind` が `ADDED_KINDS` の外なら詳細 `added_kind` の `足した理由` を返す | 無し |
| `parity.check_rendered` | `scripts/parity.py` | 新設 | `check_rendered(loaded: Loaded) -> list[Violation]` | 人が読む表が今の対応表と網羅の元のコピーから作った中身と一致することを確かめる（I8） | `loaded.rendered` が文字列 | 一致しなければ `生成物の食い違い` を 1 件返し、3 列目に最初に違う行の番号を書く | 無し |
| `parity.check_leaks` | `scripts/parity.py` | 新設 | `check_leaks(loaded: Loaded, leak_values: list[tuple[str, str]]) -> list[Violation]` | 3 つのファイルの中身に漏れの値が含まれないことを確かめる（I9） | 無し | ファイルと値の種類の組ごとに `中身の漏れ` を 1 件返す。値そのものは戻り値に含まない | 無し |
| `parity.render` | `scripts/parity.py` | 新設 | `render(table: dict, coverage: dict) -> str` | 人が読む表の全文を作る（設計文書の「人が読む表の形」） | `check_shape` が違反を返さない表 | 同じ入力からは同じ文字列を返し、末尾は改行 1 つ | 無し |
| `parity.format_violation` | `scripts/parity.py` | 新設 | `format_violation(v: Violation) -> str` | 違反を `<種類>\t<対象>\t<詳細>` の 1 行にする | 無し | 戻り値はタブを 2 つだけ含み、改行を含まない | 無し |
| `parity._cell` | `scripts/parity.py` | 新設 | `_cell(text: object) -> str` | 値を Markdown の表のセルに置ける文字列にする | 無し | `\|` は `\\|` に、改行は空白に置き換わる | 無し |
| `extract.main` | `scripts/parity-extract.py` | 新設 | `main(argv: list[str]) -> int` | 引数を読み、`write` か `check` を選んで終了コードを返す | 無し | `write` は書けば 0、`check` は一致なら 0・違いがあれば 1。文書が読めない・引数の誤り・違いがあるときに漏れの値を読めないのは 2 | 標準出力・標準エラーへの書き出し。`write` は `coverage.json` を書き、`git` を打つ |
| `extract.extract_all` | `scripts/parity-extract.py` | 新設 | `extract_all(root: Path) -> list[Element]` | 7 つの区分の抜き出しを決まった順に呼び、要素の一覧を返す | `root` はリポジトリの根 | 区分の順は `spec`・`route`・`screen`・`table`・`infra`・`env`・`config`。ID は一意 | ファイルを読む |
| `extract.extract_spec_conditions` | `scripts/parity-extract.py` | 新設 | `extract_spec_conditions(root: Path) -> list[Element]` | 確定仕様の「常に成り立つ条件」の節の表の行を要素にし、節を持たない確定仕様を 1 要素にする | 無し | ファイル名の順に、確定仕様の中は出現の順に並ぶ。番号の無い表の行は `C01` から振る | ファイルを読む |
| `extract.extract_routes` | `scripts/parity-extract.py` | 新設 | `extract_routes(root: Path) -> list[Element]` | API の「経路の一覧」の表の行をメソッドごとの要素にする | 無し | 1 行に 2 つのメソッドがあれば 2 つの要素になる | ファイルを読む |
| `extract.extract_screens` | `scripts/parity-extract.py` | 新設 | `extract_screens(root: Path) -> list[Element]` | 画面の地図の表の行を要素にする | 無し | 経路の無い予定の行は `screen:<経路の欄>:<画面の名前>` になる | ファイルを読む |
| `extract.extract_tables` | `scripts/parity-extract.py` | 新設 | `extract_tables(root: Path) -> list[Element]` | 「7 表の一覧」の行と状態のバケットを要素にする | 無し | 7 表の後に `table:state-bucket` が 1 つ並ぶ | ファイルを読む |
| `extract.extract_infra_invariants` | `scripts/parity-extract.py` | 新設 | `extract_infra_invariants(root: Path) -> list[Element]` | 全体設計の「不変条件」の表の行を要素にする | 無し | ID は `infra:<番号>` | ファイルを読む |
| `extract.extract_env_vars` | `scripts/parity-extract.py` | 新設 | `extract_env_vars(root: Path) -> list[Element]` | 環境変数の仕様の表の 1 列目の名前を、「突き合わせ」の節より前だけ要素にする | 無し | 同じ名前は最初の 1 つだけ残る | ファイルを読む |
| `extract.extract_config_fields` | `scripts/parity-extract.py` | 新設 | `extract_config_fields(root: Path) -> list[Element]` | 環境の設定の「`EnvSettings` の項目」の表の行を要素にする | 無し | ID は `config:<項目>` | ファイルを読む |
| `extract.tables_under` | `scripts/parity-extract.py` | 新設 | `tables_under(text: str, heading: re.Pattern[str], stop: re.Pattern[str] \| None = None) -> list[tuple[list[str], list[list[str]], list[str]]]` | 見出しの深さを問わず `heading` に当たる節の中の表を、見出しの行・本体の行・その表の上の見出しの並びとともに返す | 無し | 節は同じか浅い見出しで終わる。`stop` に当たる見出しから後は読まない。区切りの行とコードブロックの中は含まない | 無し |
| `extract.title_of` | `scripts/parity-extract.py` | 新設 | `title_of(cell: str) -> str` | セルの文字列を要旨（90 字まで）にする | 無し | リンクはリンクの文字だけになり、連続する空白は 1 つになる。90 字を超えると先頭 89 字と `…` になる | 無し |
| `extract.build_copy` | `scripts/parity-extract.py` | 新設 | `build_copy(elements: list[Element], base: str, as_of: str) -> str` | 網羅の元のコピーの全文（JSON）を作る | 無し | 頭は `version`・`as_of`・`base`・`elements` の順。字下げ 2・`ensure_ascii=False`・末尾は改行 1 つ | 無し |
| `extract.diff_elements` | `scripts/parity-extract.py` | 新設 | `diff_elements(extracted: list[Element], copied: list[dict]) -> list[str]` | 抜き出した一覧とコピーの違いを 1 件 1 行にする | 無し | 抜き出しにだけある ID は `足された`、コピーにだけある ID は `消えた`、両方にあり出所か要旨が違う ID は `要旨の違い`。この順で、同じ種類の中は抜き出しかコピーの順 | 無し |
| `extract.base_commit` | `scripts/parity-extract.py` | 新設 | `base_commit(root: Path) -> str` | 抜き出した文書のコミットの短い名前を返す | `root` は git の作業の木 | 戻り値は `git rev-parse --short HEAD` の出力 | 外部コマンド `git` を打つ |
| `test_parity.run_cli` | `tests/test_parity.py` | 新設 | `run_cli(script: str, *args: str, cwd: Path = ROOT) -> subprocess.CompletedProcess[str]` | スクリプトを今の Python で打ち、出力を文字列で返す | 無し | 戻り値は終了コードと標準出力・標準エラーを持つ | 外部コマンド（Python のサブプロセス）を打つ |
| `test_parity.copy_dir` | `tests/test_parity.py` | 新設 | `copy_dir(tmp_path: Path) -> Path` | 本物の置き場の 3 つのファイルを一時のディレクトリへコピーする | 無し | 戻り値のディレクトリに 3 つのファイルがある | ファイルを書く |
| `test_parity.edit_table` | `tests/test_parity.py` | 新設 | `edit_table(directory: Path, change: Callable[[dict], None], rerender: bool = True) -> None` | 一時の置き場の対応表を書き換え、`rerender` なら人が読む表を作り直す | `directory` は `copy_dir` の戻り値 | 対応表が `change` を当てた中身になる | ファイルを書く。`rerender` なら `parity.py render` を打つ |

## 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `parity.main` | 引数の誤り | 副命令が無い・`check` と `render` 以外・`--dir` に値が無い | `argparse` の解析 | 止める | 標準エラーに使い方、終了コード 2 | 書いたものは無い。引数を直して打ち直せる |
| `parity.main` | 置き場が読めない | `load_dir` が `ParityLoadError` を投げた | `main` の `except ParityLoadError` | 止める | 標準エラーに `error: <理由>`、終了コード 2。違反の行は出さない | 書いたものは無い。ファイルを直して打ち直せる |
| `parity.main` | `render` の入力の形が違う | 対応表が `check_shape` の違反を持つ | `main` の `render` の分岐で `check_shape` を先に呼ぶ | 止める | 標準出力に `形`・`欠けた列` の違反の行、終了コード 1。人が読む表は書かない。違反の行は `check` と同じく漏れの値を `[伏せた値: <値の種類>]` に置き換えてから出す（I9。形に合わない行の ID や `children` のキーが値を写しても出さない） | 書いたものは無い。表を直して打ち直せる |
| `parity.main` | 人が読む表を書けない | 置き場に書く権限が無い・ディスクが一杯 | `Path.write_text` の `OSError` | 止める | 標準エラーに `error: <パス>: <理由>`、終了コード 2 | 一時のファイルへ書いてから `os.replace` で置き換えるため、途中で止まっても前の中身が残る。打ち直せる |
| `parity.main` | 漏れの値を読めない | `config.environments` の import か `public_leak_values()` が投げた（環境の設定の値が不正で `EnvSettings` の確かめが投げた） | `check` の分岐と、`render` で形の違反を出す分岐の中で import と呼び出しを `try` で囲む（モジュールの頭では import しない。形の違反が無い `render` は読まない） | 止める | 標準エラーに `error: 漏れの値を読めない: <例外の型>`、終了コード 2。違反ありの 1 と見分けられる | 書いたものは無い。環境の設定を直して打ち直せる |
| `parity.load_dir` | ファイルが無い | 3 つのファイルのどれかが置き場に無い（`render` では人が読む表を要らない） | `Path.read_text` の `FileNotFoundError` | 呼び出し元へ返す（`ParityLoadError`） | `main` が終了コード 2 にする。理由はファイルのパス | 無し |
| `parity.load_dir` | JSON として読めない | 対応表か網羅の元のコピーの構文の誤り・UTF-8 でない | `json.loads` の `JSONDecodeError`・`UnicodeDecodeError` | 呼び出し元へ返す（`ParityLoadError`） | `main` が終了コード 2 にする。理由はパスと行・桁 | 無し |
| `parity.load_dir` | 頭が `dict` でない | 対応表か網羅の元のコピーの最上位が配列などである | `isinstance` の判定 | 呼び出し元へ返す（`ParityLoadError`） | `main` が終了コード 2 にする | 無し |
| `extract.main` | 引数の誤り | 副命令が無い・`write` と `check` 以外 | `argparse` の解析 | 止める | 標準エラーに使い方、終了コード 2 | 書いたものは無い。打ち直せる |
| `extract.main` | 文書が読めない | 抜き出す文書が無い・節や表が見つからない | `extract_all` が投げた `ExtractError` | 止める | 標準エラーに `error: <パス>: <理由>`（重なった ID などが写す漏れの値は、ずれの行と同じく伏せる。漏れの値を読めないときは本文を出さない）、終了コード 2 | 書いたものは無い。文書を直して打ち直せる |
| `extract.main` | コピーが読めない | `check` で `coverage.json` が無い・JSON として読めない・`elements` が配列でない | `json.loads` の例外と `isinstance` の判定 | 止める | 標準エラーに `error: <パス>: <理由>`、終了コード 2 | 書いたものは無い。`write` で作り直せる |
| `extract.main` | コピーを書けない | 置き場に書く権限が無い | `Path.write_text` の `OSError` | 止める | 標準エラーに `error: <パス>: <理由>`、終了コード 2 | 一時のファイルから `os.replace` で置き換えるため前の中身が残る。打ち直せる |
| `extract.extract_all` | ID の重なり | 文書の中で同じ要素が 2 回現れた（環境変数を除く） | `extract_all` の最後の一意の確かめ | 呼び出し元へ返す（`ExtractError`） | `main` が終了コード 2 にし、重なった ID を示す | 無し。文書か抜き出しの規則を直す |
| `extract.extract_spec_conditions` | 確定仕様が 1 本も無い | 置き場の誤り・`root` の誤り | `glob` の結果が空 | 呼び出し元へ返す（`ExtractError`） | `main` が終了コード 2 | 無し |
| `extract.extract_routes` | 節か表が無い | 「経路の一覧」の見出しが変わった・表が無い | `tables_under` の戻り値が空 | 呼び出し元へ返す（`ExtractError`） | `main` が終了コード 2。見出しの名前を示す | 無し。文書の見出しに合わせて抜き出しの定数を直す |
| `extract.extract_screens` | 節か表が無い | 「画面の地図」の見出しが変わった | `tables_under` の戻り値が空 | 呼び出し元へ返す（`ExtractError`） | `main` が終了コード 2 | 無し |
| `extract.extract_tables` | 節か表が無い | 「7 表の一覧」の見出しが変わった | `tables_under` の戻り値が空 | 呼び出し元へ返す（`ExtractError`） | `main` が終了コード 2 | 無し |
| `extract.extract_infra_invariants` | 節か表が無い | 全体設計の「不変条件」の見出しが変わった | `tables_under` の戻り値が空 | 呼び出し元へ返す（`ExtractError`） | `main` が終了コード 2 | 無し |
| `extract.extract_env_vars` | 節か表が無い・「突き合わせ」の見出しが無い | 環境変数の仕様の見出しが変わった | `tables_under` の戻り値が空か `stop` に当たる見出しが無い | 呼び出し元へ返す（`ExtractError`） | `main` が終了コード 2 | 無し |
| `extract.extract_config_fields` | 節か表が無い | 「`EnvSettings` の項目」の見出しが変わった | `tables_under` の戻り値が空 | 呼び出し元へ返す（`ExtractError`） | `main` が終了コード 2 | 無し |
| `extract.base_commit` | git の作業の木でない・`git` が無い | `root` が git の作業の木の外・`git` の実行に失敗 | `subprocess.run` の終了コードと `FileNotFoundError` | 呼び出し元へ返す（`ExtractError`） | `main` が終了コード 2 | 無し。`write` だけが呼び、`check` は呼ばない |
| `test_parity.run_cli` | サブプロセスが時間内に終わらない | スクリプトの無限の繰り返し | `subprocess.run(timeout=60)` の `TimeoutExpired` | 止める（テストが落ちる） | pytest の失敗の表示 | 一時のディレクトリは pytest が消す。打ち直せる |
| `test_parity.copy_dir` | コピーできない | 本物の置き場にファイルが無い | `shutil.copy2` の `FileNotFoundError` | 止める（テストが落ちる） | pytest の失敗の表示 | 一時のディレクトリは pytest が消す |
| `test_parity.edit_table` | 作り直しが失敗した | `change` が表の形を壊した | `render` の終了コードが 0 でない | `rerender` が真のときだけ止める（テストが落ちる）。形を壊すテストは `rerender=False` で呼ぶ | pytest の失敗の表示 | 一時のディレクトリは pytest が消す |

## 処理の手順

### 違反の並び

違反の並び（`parity.run_checks`）は、設計文書の「入出力の契約」の違反の種類の表の順（`VIOLATION_ORDER`）で並べる。同じ種類の中は見つけた順を保つ（安定な並べ替え）。各規則は行の順か網羅の元のコピーの順に見るため、同じ種類の中は行の順か要素の出所の順になる。

### 表の検査の判定

`parity.check_shape` は行ごとに次の判定を順に当て、当たったものをすべて返す。型の違う値は後の規則（`check_destination` など）が読み飛ばすため、同じ違反を 2 回出さない。

| 関数 | 条件の組み合わせ | 結果 |
| --- | --- | --- |
| `parity.check_shape` | 頭に `version`・`as_of`・`approved_on`・`approved_rows`・`children`・`areas`・`plan_values`・`rows` のどれかが無い | `欠けた列`・対象 `頭`・詳細に欠けたキー |
| `parity.check_shape` | `version` が 1 でない・`as_of` が `YYYY-MM-DD` でない・`rows` が配列でない | `形`・対象 `頭`・詳細にキー |
| `parity.check_shape` | `approved_on` が `null` で `approved_rows` が空でない、または `approved_on` が日付で `approved_rows` が空 | `形`・対象 `頭`・詳細 `approved_rows` |
| `parity.check_shape` | `approved_on` が `null` でも日付でもない | `形`・対象 `頭`・詳細 `approved_on` |
| `parity.check_shape` | `children` のキーに骨組みと #1〜#16 の番号の外がある | `形`・対象 `頭`・詳細 `children <番号>` |
| `parity.check_shape` | 行が `dict` でない | `形`・対象 `行 <1 始まりの位置>` |
| `parity.check_shape` | 行に `id`・`area`・`kind`・`behavior`・`source`・`now`・`verify`・`plans`・`trial`・`refs`・`added`・`dev_state`・`verify_new` のどれかが無い（`to`・`not_built` は `check_destination`、`not_built_kind`・`ndf_issue` は `check_not_built_kind` が見る） | `欠けた列`・対象は行の ID（無ければ `行 <位置>`）・詳細に欠けた列 |
| `parity.check_shape` | `kind` が `behavior`・`regression`・`boundary`・`ndf11` のどれでもない | `形`・詳細 `kind` |
| `parity.check_shape` | `area` が頭の `areas` のキーでない | `形`・詳細 `area` |
| `parity.check_shape` | `id` が行の種類の ID の形（`ID_PATTERNS`）に合わない。振る舞いの行は記号が `area` と違う | `形`・詳細 `id` |
| `parity.check_shape` | `behavior`・`source`・`now`・`verify` が空の文字列か文字列でない | `形`・詳細に列 |
| `parity.check_shape` | `trial` が `dict` でない・`result` が `passed`・`failed`・`not_run` のどれでもない | `形`・詳細 `trial.result` |
| `parity.check_shape` | `trial.result` が `failed` で `reason` が空でない文字列でない | `形`・詳細 `trial.reason` |
| `parity.check_shape` | `plans` が `未決` でも、`plan_values` の値だけからなる空でない配列でもない | `形`・詳細 `plans` |
| `parity.check_shape` | `refs` が文字列の配列でない | `形`・詳細 `refs` |
| `parity.check_shape` | `kind` が `behavior` で `tracks` を持つ | `形`・詳細 `tracks` |
| `parity.check_shape` | `kind` が `behavior` 以外で `tracks` が無いか空 | `形`・詳細 `tracks` |
| `parity.check_shape` | `added` が `YYYY-MM-DD` でない | `形`・詳細 `added` |
| `parity.check_shape` | `dev_state` が `DEV_STATES` の外 | `形`・詳細 `dev_state` |
| `parity.check_shape` | `verify_new` が空の文字列か文字列でない | `形`・詳細 `verify_new` |
| `parity.check_destination` | `to` と `not_built` の両方を持つ | `行き先`・詳細 `両方` |
| `parity.check_destination` | どちらも無い、または `not_built` が空の文字列（空白だけを含む） | `行き先`・詳細 `無い` |
| `parity.check_destination` | `to` だけを持ち、頭の `children` のキーでない | `行き先`・詳細 `範囲の外 <to の値>` |
| `parity.check_destination` | `to` だけを持ち `children` のキーである、または空でない `not_built` だけを持つ | 違反なし |
| `parity.check_not_built_kind` | `not_built` が無いか `to` も持つ行が `not_built_kind`・`ndf_issue` を持つ | `作らない理由`・詳細にキー |
| `parity.check_not_built_kind` | `not_built` だけを持つ行の `not_built_kind` が無いか `NOT_BUILT_KINDS` の外 | `作らない理由`・詳細 `not_built_kind`（その行のほかの条件は見ない） |
| `parity.check_not_built_kind` | `今も動かない` で `dev_state` が `済`・`済(残)` | `作らない理由`・詳細 `今も動かない dev_state` |
| `parity.check_not_built_kind` | `NDF 待ち` で `kind` が `ndf11` でない | `作らない理由`・詳細 `NDF 待ち kind` |
| `parity.check_not_built_kind` | `kind` が `regression`・`boundary` で作らないを持つ（理由の種類によらない） | `作らない理由`・詳細 `回帰・境界 kind`（判定の規則の I4） |
| `parity.check_not_built_kind` | `NDF 待ち` で `ndf_issue` が正の整数でない（真偽値を含む）、または `NDF 待ち` でないのに `ndf_issue` を持つ | `作らない理由`・詳細 `ndf_issue` |
| `parity.check_coverage` | 網羅の元の要素が、どの行の `refs` にも無い | `漏れ`・対象は要素の ID・詳細は区分 |
| `parity.check_coverage` | 行の `refs` の ID が網羅の元に無い | `知らない要素`・対象は行の ID・詳細は参照の ID |
| `parity.check_required_rows` | `REQUIRED_TRACKS` の（行の種類, 追う対象）に、`kind` と `tracks` が一致する行が無い | `必ず要る行`・対象は行の種類・詳細は追う対象 |
| `parity.check_added_reason` | `approved_on` が `null` | 違反なし（承認の前） |
| `parity.check_added_reason` | `approved_on` が日付・行の ID が `approved_rows` にある | 違反なし（`added` の日付に依らない） |
| `parity.check_added_reason` | `approved_on` が日付・行の ID が `approved_rows` に無い・`added_reason` が空でない文字列・`added_issue` が正の整数・`added_kind` が `ADDED_KINDS` の中 | 違反なし |
| `parity.check_added_reason` | 同上で `added_issue` が無いか正の整数でない | `足した理由`・対象は行の ID・詳細は `added_issue` |
| `parity.check_added_reason` | 同上で `added_kind` が無いか `ADDED_KINDS` の外 | `足した理由`・対象は行の ID・詳細は `added_kind` |
| `parity.check_added_reason` | `approved_on` が日付・行の ID が `approved_rows` に無い・`added_reason` が無いか空 | `足した理由`・対象は行の ID |
| `parity.check_rendered` | `check_shape` が違反を返した | 比べない（`render` の入力が壊れており、`形` の違反で止まる） |
| `parity.check_rendered` | `render` の出力と `parity.md` の中身がバイト単位で一致しない | `生成物の食い違い`・対象は `parity.md` のパス・詳細は最初に違う行の番号 |
| `parity.check_leaks` | ファイルの元の文字列か、JSON を解いた後のすべての文字列の値に、漏れの値が部分文字列として含まれる | `中身の漏れ`・対象はファイルのパス・詳細は値の種類。同じファイルと種類の組は 1 件にまとめる |

`parity.check_leaks` が JSON を解いた後の文字列も見るのは、`\u` の形で書いた文字が元の文字列では値に一致しないためである。

### 人が読む表の並び

`parity.render` は今の `parity.md` と同じ並びを作る。並びの決まりは次のとおり。

| 関数 | 条件の組み合わせ | 結果 |
| --- | --- | --- |
| `parity.render` | `approved_on` が `null` | 設計承認の日を `未承認` と書く |
| `parity.render` | 行き先ごとの行の数で、行の数が 0 の子 | その子の行を出さない。`作らない` の行は最後に置く |
| `parity.render` | 領域の節の中の行の並び | `rows` の並びのまま。回帰・境界・NDF 11 の行も `area` の節に並ぶ |
| `parity.render` | 行の種類の欄 | 振る舞いは `振る舞い`、ほかは `<行の種類の名前>（<tracks>）` |
| `parity.render` | 行き先の欄 | `to` は `<番号> <子の名前>`、`not_built` は `作らない: <理由>` |
| `parity.render` | 試走の欄 | `passed` は `通った`、`failed` は `通らない: <reason>`、`not_run` は `まだ流していない` |
| `parity.render` | 逆引きの節の並び | 区分は `CATEGORY_TITLES` の順、区分の中は網羅の元のコピーの順。指す行は `rows` の順で `、` でつなぐ |
| `parity.render` | 行の数が 0 の領域 | その領域の節を出さない |

### 網羅の元のずれの判定

`extract.diff_elements` の判定は次のとおり。

| 関数 | 条件の組み合わせ | 結果 |
| --- | --- | --- |
| `extract.diff_elements` | ID が抜き出しにあり、コピーに無い | `網羅の元のずれ\t足された\t<ID>` |
| `extract.diff_elements` | ID がコピーにあり、抜き出しに無い | `網羅の元のずれ\t消えた\t<ID>` |
| `extract.diff_elements` | ID が両方にあり、`source` か `title` が違う | `網羅の元のずれ\t要旨の違い\t<ID>` |
| `extract.diff_elements` | すべての ID が両方にあり、中身も同じ（並びの違いは問わない） | 空（一致） |

### 確定仕様の条件の抜き出しの判定

`extract.extract_spec_conditions` の判定は次のとおり。

| 関数 | 条件の組み合わせ | 結果 |
| --- | --- | --- |
| `extract.extract_spec_conditions` | 「常に成り立つ条件」で始まる見出しが無い | `spec:<確定仕様の名前>` の 1 要素。要旨は `（常に成り立つ条件の節を持たない確定仕様）` |
| `extract.extract_spec_conditions` | 節の表の 1 列目が `#` で、行の 1 列目が番号（`I12` など） | `spec:<名前>:<番号>`。要旨は「条件」の列 |
| `extract.extract_spec_conditions` | 節の表の 1 列目が番号でない（番号の無い表） | 出現の順に `spec:<名前>:C01`〜。要旨は最初の列 |
| `extract.extract_spec_conditions` | 節の中に表が 2 つ以上ある | すべての表の行を出現の順に並べる。番号の無い表の `C` の番号は確定仕様の中で通しで振る |

### 終わる条件と計算量

- 繰り返しの終わる条件: どの関数も、入力の配列（行・要素・文書の行・漏れの値）を 1 回ずつなめて終わる。再試行と待ちは無い
- 計算量の注意: `check_leaks` は漏れの値（環境ごとに十数個）× 3 ファイル（合わせて約 200 KB）の部分文字列の探索である。1 秒に収まる。`check_coverage` は網羅の元の ID を集合にしてから行の参照を引く（639 要素 × 133 行を総当たりしない）

## 内部のデータと定数

同じ事実を 2 か所に持たないよう、行の種類・領域・子・違反の種類の名前の置き場を 1 つに決める。領域の名前と子の名前は対応表の頭（`areas`・`children`）だけが持ち、スクリプトは定数に写さない。

| 名前 | 種類 | 置き場 | 既定値 |
| --- | --- | --- | --- |
| `Violation` | 型 | `scripts/parity.py` | `NamedTuple(kind: str, target: str, detail: str)` |
| `Loaded` | 型 | `scripts/parity.py` | `NamedTuple(directory: Path, table: dict, coverage: dict, rendered: str \| None, texts: dict[str, str])`。`texts` は置き場からの相対のパス → 元の文字列 |
| `ParityLoadError` | 型 | `scripts/parity.py` | `Exception` の子。文はパスと理由 |
| `DEFAULT_DIR` | 定数 | `scripts/parity.py` | 旧い側の対応表の置き場（`issues/` の下）の `Path`（リポジトリの根からの相対） |
| `TABLE_FILE`・`COVERAGE_FILE`・`RENDERED_FILE` | 定数 | `scripts/parity.py` | `parity.json`・`coverage.json`・`parity.md` |
| `VIOLATION_ORDER` | 定数 | `scripts/parity.py` | `("形", "重なり", "欠けた列", "行き先", "作らない理由", "漏れ", "知らない要素", "必ず要る行", "足した理由", "生成物の食い違い", "中身の漏れ")`（設計文書の違反の種類の表の順） |
| `HEAD_KEYS` | 定数 | `scripts/parity.py` | 頭の 8 つのキー（設計文書の「対応表の頭」の順） |
| `ROW_KEYS` | 定数 | `scripts/parity.py` | 行が必ず持つ 13 のキー（`id`・`area`・`kind`・`behavior`・`source`・`now`・`verify`・`plans`・`trial`・`refs`・`added`・`dev_state`・`verify_new`） |
| `DEV_STATES` | 定数 | `scripts/parity.py` | `("済", "済(残)", "届かず", "未", "未調査")`（判定の規則の今の dev での状態と、子が埋める印。設計の決定 13） |
| `NOT_BUILT_KINDS` | 定数 | `scripts/parity.py` | `("捨てる", "今も動かない", "NDF 待ち")`（判定の規則の I2 の作らない理由の種類） |
| `VERIFY_NEW_UNDECIDED` | 定数 | `scripts/parity.py` | `"未決"`。新しいリポジトリでの確かめ方が決まっていない印で、人が読む表の数の表が数える |
| `KIND_TITLES` | 定数 | `scripts/parity.py` | `{"behavior": "振る舞い", "regression": "既知の不具合の回帰", "boundary": "権限の境界", "ndf11": "NDF 11 で確かめる"}`。行の種類の値の集合もこのキーが持つ |
| `TRIAL_TITLES` | 定数 | `scripts/parity.py` | `{"passed": "通った", "failed": "通らない", "not_run": "まだ流していない"}`。試走の結果の値の集合もこのキーが持つ |
| `ID_PATTERNS` | 定数 | `scripts/parity.py` | `behavior`: `^[A-N]-\d{2}$`・`regression`: `^REG-\d{2}$`・`boundary`: `^BND-\d{2}$`・`ndf11`: `^N11-[0-9A-Z-]+$`（設計の決定 7） |
| `CHILD_RANGE` | 定数 | `scripts/parity.py` | 骨組みと #1〜#16 の 17 個の課題の番号の範囲（旧い側の番号）。頭の `children` のキーの許す範囲 |
| `PLANS_UNDECIDED` | 定数 | `scripts/parity.py` | `"未決"` |
| `REQUIRED_TRACKS` | 定数 | `scripts/parity.py` | `regression`: 旧い側の 4 つの既知の不具合の課題の番号（ECS のレーンの秘密の器・契約の応答の 409 と 503・環境変数の食い違い・確定仕様のデータの行の表の食い違い）。`boundary`: `human-only`・`delegation-scope`・`account-isolation`・`seat-role`・`lane-token-scope`・`job-role-scope`。`ndf11`: 旧い側の課題の番号と確認の番号の組（承認ゲートの通知の通しの G1〜G5・レーンの通しの実環境の A5〜A11・手元のマシンが承認を待つレーンを受け取る確認の 13・同じリポジトリで 2 本の開発ループを回す確認）（設計の決定 8。表の頭には持たない） |
| `CATEGORY_TITLES` | 定数 | `scripts/parity.py` | `spec`: 確定仕様の常に成り立つ条件・`route`: API の経路・`screen`: 画面・`table`: 表と状態のバケット・`infra`: 全体設計の不変条件・`env`: 環境変数・`config`: 環境の設定の項目（この順で逆引きの節を並べる） |
| `DATE` | 定数 | `scripts/parity.py` | `re.compile(r"^\d{4}-\d{2}-\d{2}$")` |
| `ADDED_KINDS` | 定数 | `scripts/parity.py` | `("同等に要る", "セキュリティ", "公開に要る")`（判定の規則の I6 の範囲の追加の理由の種類） |
| `Element` | 型 | `scripts/parity-extract.py` | `NamedTuple(id: str, source: str, title: str)` |
| `ExtractError` | 型 | `scripts/parity-extract.py` | `Exception` の子。文はパスと理由 |
| `SOURCES` | 定数 | `scripts/parity-extract.py` | 区分ごとの文書のパスと見出しの正規表現（設計の決定 6 の「抜き出す範囲」の列。`spec` は `docs/specifications/ndf-factory-*.md` と `^常に成り立つ条件`、`env` は `stop` に `^突き合わせ` など） |
| `TITLE_LIMIT` | 定数 | `scripts/parity-extract.py` | `90` |
| `NO_SECTION_TITLE` | 定数 | `scripts/parity-extract.py` | `"（常に成り立つ条件の節を持たない確定仕様）"` |
| `STATE_BUCKET` | 定数 | `scripts/parity-extract.py` | `Element("table:state-bucket", "docs/design/database.md", <要旨>)`。要旨は今の `coverage.json` の値に合わせる |
| `ROOT`・`PARITY_DIR` | 定数 | `tests/test_parity.py` | リポジトリの根と、その下の対応表の置き場（`issues/` の下） |

要旨の作り方（`title_of` と区分ごとの列の選び方）は、今の `coverage.json` を設計の段で作った規則に合わせる。`write` が今の `coverage.json` と同じ要素を書き出すことは、`extract.main check` の 0 で確かめる。確かめるのは `tests/test_parity.py` の本物の置き場のテストである。合わない区分があれば、抜き出しの規則を今の要旨に寄せて直す。今の要旨は設計承認ゲートで人が読む中身であり、抜き出しの都合で変えない。

## 並行と排他

| 同時に走りうる処理 | 共有する資源 | 排他の取り方 | 冪等性と中断からの再開 |
| --- | --- | --- | --- |
| `parity.py check` と `parity-extract.py check`（手元と CI で並んで走る） | 置き場の 3 つのファイル（読むだけ） | 取らない。読むだけで書かない | 何度打っても同じ結果。途中で止めても何も残らない |
| `parity.py render` と、同じ置き場への `check` | `parity.md` | 取らない。`render` は一時のファイルに書いてから `os.replace` で置き換えるため、`check` は前の中身か後の中身のどちらかを読む | 同じ入力からは同じ中身を書く。止まったら打ち直す |
| `parity-extract.py write` と `parity.py check` | `coverage.json` | 取らない。`render` と同じく `os.replace` で置き換える | `write` は文書が同じなら要素が同じ中身を書く（`as_of` と `base` は打った日とコミットで変わる）。止まったら打ち直す |
| pytest の並列の実行（`pytest-xdist` を使うとき） | 本物の置き場 | テストは本物の置き場を読むだけにし、書き換えるテストは `copy_dir` で一時のディレクトリへコピーしてから書く | テストの間で状態を共有しない |
| 2 つの PR が同時に対応表を変える | `parity.json`・`parity.md` | git のマージで衝突として現れる。衝突を解いた後に `render` を打ち直し、`check` が `生成物の食い違い` を出さないことを CI が確かめる | 解いた後の `render` で揃う |

## ログと記録の出力

ログの仕組みは使わず、標準出力と標準エラーへ書く。どちらのスクリプトも結果の JSON と進捗記録へは書かない。

| 関数 | 出すもの | レベルまたは書き先 | 出さないもの |
| --- | --- | --- | --- |
| `parity.main` | `check` の違反が無いとき `ok: 行 <数>・網羅の元の要素 <数>` の 1 行 | 標準出力 | 漏れの値 |
| `parity.main` | `check` の違反（`format_violation` の行）と、最後に `違反 <数> 件` の 1 行 | 標準出力 | 漏れの値。`中身の漏れ` の行は値の種類とファイルのパスだけを持つ |
| `parity.main` | `render` が書いた人が読む表のパス | 標準出力 | 無し |
| `parity.main` | 読めない・引数の誤りの理由（`error: <理由>`） | 標準エラー | 漏れの値。JSON の構文の誤りでも、その行の中身を写さない（パスと行・桁だけ） |
| `extract.main` | `write` が書いたパスと要素の数。`check` の一致は `ok: 網羅の元の要素 <数>` | 標準出力 | 無し |
| `extract.main` | `check` の違い（`diff_elements` の行の漏れの値を `[伏せた値: <値の種類>]` へ置き換えたもの）と、最後に `ずれ <数> 件` の 1 行 | 標準出力 | 無し |
| `extract.main` | 読めない・引数の誤りの理由 | 標準エラー | 無し |
| `test_parity.run_cli` | 失敗したテストで、サブプロセスの標準出力と標準エラー | pytest の失敗の表示 | 漏れの値を植えるテストは、出力に値が無いことを確かめる。値はテストの引数に出るが、pytest の `ids` に値を使わず値の種類を使う |

## 既存の部品の再利用

| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `parity.main` | 旧い側の `scripts/check-public-leak.py` の `main` | `grep -n "^def " scripts/check-public-leak.py` で読んだ | 使えない理由: git の作業の木を `git grep` で探す作りで、置き場の 3 ファイルの中身と JSON を解いた後の文字列を探せない。`sys.path` に根を足して `config.environments` を import する形だけを倣う |
| `parity.load_dir` | 旧い側の `tests/helpers.py`・旧い側の `scripts/migration/receipt.py` の読み書き | `grep -rn "json.loads\|read_text" scripts tests` | 使えない理由: どちらもその課題の記録の形に固い。標準の `json` と `Path.read_text` で足りる |
| `parity.run_checks` | jsonschema（設計の外部の調査の LIB1） | 設計文書の決定 5 | 使えない理由: 形の 1 種類だけを満たし、行の ID で 1 件 1 行に出せない |
| `parity.check_shape` | 旧い側の `config/environments.py` の `_Check` と `_raise_if_any` | `grep -n "_Check\|_raise_if_any" config/environments.py` | 使えない理由: 1 つの設定の値を確かめて例外を投げる作りで、違反を集めて種類と対象つきで返せない |
| `parity.check_duplicates` | 旧い側の `config/environments.py` の `_unique` | 同上 | 使えない理由: 真偽だけを返し、重なった ID を返さない |
| `parity.check_destination` | 無し | `grep -rn "not_built\|children" scripts tests` で当たり無し | 新設する |
| `parity.check_not_built_kind` | `parity.check_added_reason` の正の整数の判定 | `grep -n "isinstance(issue, bool)" scripts/parity.py` | 判定を `_is_positive_int` に寄せて両方から使う考えもあるが、`check_added_reason` は今の形のまま残し、新しい関数だけが使う |
| `parity.check_coverage` | 無し | `grep -rn "coverage" scripts tests` で当たり無し | 新設する |
| `parity.check_required_rows` | 無し | `grep -rn "tracks" scripts tests` で当たり無し | 新設する |
| `parity.check_added_reason` | 無し | `grep -rn "approved_rows\|added_reason" scripts tests` で当たり無し | 新設する |
| `parity.check_rendered` | 旧い側の `tests/test_documents.py` の用語集の生成物の比べ方 | `grep -n "render\|glossary" tests/test_documents.py` | 使えない理由: テストの中の比べ方で、スクリプトから呼べない。バイト単位で比べる考え方を倣う |
| `parity.check_leaks` | 旧い側の `config/environments.py` の `public_leak_values` | `grep -n "def public_leak_values" config/environments.py` | 使う。漏れの値の唯一の出所で、空の値を除いてある |
| `parity.check_leaks` | 旧い側の `scripts/check-public-leak.py` の `find_hits` | 同上 | 使えない理由: `git grep` を打つ作りで、置き場が git に入る前（手元の書き換えの直後）の中身と JSON を解いた後の文字列を見られない |
| `parity.render` | 旧い側の `scripts/migration/receipt.py` の `replace_rows` | `grep -n "def " scripts/migration/receipt.py` | 使えない理由: 既存の文書の表の行を差し替える作りで、文書の全体を作らない |
| `parity.format_violation` | 無し | `grep -rn "\\\\t" scripts` で 1 件 1 行のタブ区切りの出力を探し、当たり無し | 新設する |
| `parity._cell` | 旧い側の `scripts/migration/receipt.py` の `_outside_inline` | `grep -n "def _outside_inline" -A10 scripts/migration/receipt.py` | 使えない理由: インラインのコードの外だけを変える別の用途で、`\|` と改行の置き換えを持たない |
| `extract.main` | 旧い側の `scripts/migration/import-documents.py` の `main` | `grep -n "^def " scripts/migration/import-documents.py` | 使えない理由: devbasex/ai-plugins から文書を取り込む作りで、網羅の元の要素を作らない |
| `extract.extract_all` | 無し | `grep -rn "常に成り立つ条件" scripts tests` で、確定仕様の節を数える既存の関数が無いことを確かめた | 新設する |
| `extract.extract_spec_conditions` | 無し | 同上 | 新設する |
| `extract.extract_routes` | 旧い側の `tests/test_api.py` の経路の読み方 | `grep -rn "経路の一覧" scripts tests` | 使えない理由: 当たったのは確定仕様の文書だけで、経路の一覧の表を読む既存の関数は無い |
| `extract.extract_screens` | 無し | `grep -rn "画面の地図" scripts tests` で当たり無し | 新設する |
| `extract.extract_tables` | 旧い側の `tests/test_data.py` の表の名前 | `grep -rn "7 表の一覧" scripts tests` で当たり無し | 新設する。表の名前の部分はスタックの定義の側と照らさず、文書だけを読む |
| `extract.extract_infra_invariants` | 無し | `grep -rn "<全体設計の文書の名前>" scripts tests` で、不変条件の表を読む関数が無いことを確かめた | 新設する |
| `extract.extract_env_vars` | 旧い側の `tests/test_env_names.py` の環境変数の名前の集め方 | `grep -n "environment-variables" tests/test_env_names.py` | 使えない理由: テストの中の関数で、スクリプトから import しない（テストのモジュールをスクリプトが読むと依存の向きが逆になる）。名前の正規表現（大文字・数字・`_`）を倣う |
| `extract.extract_config_fields` | 旧い側の `config/environments.py` の `LEAK_FIELDS`・`NOT_LEAK_FIELDS` | `grep -n "LEAK_FIELDS" config/environments.py` | 使えない理由: 網羅の元は文書の項目の表で、コードの項目の一覧ではない。両者の食い違いは `tests/test_environments.py` が見る |
| `extract.tables_under` | 旧い側の `scripts/migration/receipt.py` の `table_rows`・`_table_span` | `grep -n "def _table_span" -A8 scripts/migration/receipt.py` | 使えない理由: `## <節>` の 2 段目の見出しに固く、節の中の最初の表だけを読む。深さを問わない見出しと、節の中の複数の表と、上の見出しの並びが要る。セルを `\|` で割る考え方を倣う |
| `extract.title_of` | 無し | `grep -rn "…" scripts` で要旨を切り詰める関数が無いことを確かめた | 新設する |
| `extract.build_copy` | 無し | `grep -rn "ensure_ascii=False" scripts` | 新設する。`json.dumps` を直に使う |
| `extract.diff_elements` | 無し | `grep -rn "足された\|消えた" scripts` で当たり無し | 新設する |
| `extract.base_commit` | 旧い側の `scripts/migration/receipt.py` の `git rev-parse` の呼び方 | `grep -n "rev-parse" scripts/migration/receipt.py` | 使えない理由: `--show-toplevel` を返す関数で、短いコミットの名前を返さない。`subprocess.run` を直に使う |
| `test_parity.run_cli` | 旧い側の `tests/test_public_leak.py` の `run_check` | `grep -n "def run_check" -A8 tests/test_public_leak.py` | 使えない理由: `check-public-leak.py` に固い。`sys.executable` で打つ形を倣う |
| `test_parity.copy_dir` | 無し | `grep -rn "copytree\|copy2" tests` | 新設する |
| `test_parity.edit_table` | 無し | `grep -rn "def edit_" tests` で当たり無し | 新設する |

## 単体テストの観点

テストはすべて旧い側の `tests/test_parity.py` に置き、スクリプトをサブプロセスで打つ。CLI の終了コードと出力の行が、受け入れ条件の約束であるためである。壊すテストは `copy_dir` で一時の置き場を作ってから書き換える。各行は設計文書の「テスト設計」の行を関数の粒度へ下ろしたもので、受け入れ条件の対応はそちらにある。

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `parity.main` | 本物の置き場で `check` が 0 と `ok:` の 1 行を返す。`render` が 0 を返し、`parity.md` が変わらない | 違反 1 件で終了コード 1 と、違反の行 1 行と `違反 1 件` | 引数なし・未知の副命令で 2 と使い方。置き場に `parity.json` が無いと 2 と違反の行が出ないこと。`render` で形の違反があると 1 で `parity.md` が書かれないこと |
| `parity.load_dir` | 本物の置き場を読める | `render` では `parity.md` が無くても読める | `parity.json` が JSON として壊れていると 2・`coverage.json` の最上位が配列だと 2。標準エラーにパスが出る |
| `parity.run_checks` | 本物の置き場で違反なし | 2 つの規則（`重なり` と `行き先`）を同時に破ると 2 行が `VIOLATION_ORDER` の順で出て、どちらも 3 列 | 形の違反がある行で、後の規則が例外を投げずに終わる（`refs` を文字列にした行で `check_coverage` が落ちない） |
| `parity.check_shape` | 本物の表で違反なし | `plans` が `plan_values` の値の配列で通る（`plan_values` を足した一時の表）。`trial.result` が `failed` で `reason` があれば通る | 13 の列と `added` のそれぞれを消すと `欠けた列` に行の ID と列。`dev_state` を `動く`・空、`verify_new` を空白だけにすると `形`。`kind` を `other`・`trial.result` を `skipped`・`failed` で理由なし・振る舞いの行に `tracks`・回帰の行の `tracks` を消す・`plans` を空の配列・ID を `A-1` にする・`area` を `Z` にする、のそれぞれで `形`。`approved_on` を書いて `approved_rows` を空にすると `形`・対象 `頭` |
| `parity.check_duplicates` | 本物の表で違反なし | 同じ ID が 3 回現れると `重なり` が 2 件 | 2 つの行に同じ ID を付けると `重なり` にその ID |
| `parity.check_not_built_kind` | 本物の表で違反なし | 「今も動かない」の行の状態が `届かず`・`未`・`未調査` なら通る。NDF 11 で確かめる行を `NDF 待ち` にして課題番号を付けると通り、人が読む表に `作らない（NDF 待ち devbasex/ai-plugins#<番号>）` が出る | 作らない行の種類を消す・3 つの外にする・「今も動かない」の行を `済`・`済(残)` にする・作る行に種類か課題番号を付ける・`NDF 待ち` で課題番号が無い（`0`・文字列・真偽値）・振る舞いの行を `NDF 待ち` にする、のそれぞれで `作らない理由`。今動いている振る舞いの行を作らないとき `捨てる` だけが通る（判定の規則の I3） |
| `parity.check_destination` | 本物の表で違反なし | `not_built` が空白だけで `無い` | 両方で `両方`・どちらも無いで `無い`・`to` を範囲の外の番号にすると `範囲の外 <その番号>` |
| `parity.check_coverage` | 本物の表で違反なし | 同じ要素を 2 行が指しても違反なし | 行の `refs` から要素を 1 つ消し、ほかに指す行が無ければ `漏れ` に要素の ID と区分。網羅の元に無い ID を参照すると `知らない要素` に行の ID と参照 |
| `parity.check_required_rows` | 本物の表で違反なし | 2 つ目のアカウントの GitHub App の認可の回帰の行（REG-05）を消しても違反なし（必ず要る対象でない） | 既知の不具合の回帰（ECS のレーンの秘密の器）・`job-role-scope`・レーンの通しの実環境の A7 の行をそれぞれ消すと `必ず要る行` に欠けた追う対象 |
| `parity.check_added_reason` | 承認の前（`approved_on` が `null`）は理由なしで通る | `added` が `approved_on` と同じ日でも、`approved_rows` に無い行は理由が要る | `approved_on` を書き、`approved_rows` に無い行を足して理由なしにすると `足した理由` に行の ID |
| `parity.check_rendered` | 本物の置き場で違反なし | 行の `behavior` を変えて `render` を打ち直すと違反なし | 行の `behavior` を変えて作り直さないと `生成物の食い違い` と最初に違う行の番号 |
| `parity.check_leaks` | 本物の置き場で違反なし | 値を全角の文字と前後に続けて行の文の途中に植えても見つかる | `ENVIRONMENTS` の漏れの値を項目ごとに植えると `中身の漏れ` で 1、出力に値そのものが無い。`\u` の形で書いた値も見つかる |
| `parity.render` | 本物の表から今の `parity.md` とバイト単位で同じ中身を作る | 行の数が 0 の子は行き先の数の表に出ない。`\|` と改行を含む `behavior` がセルの中で `\|` と空白になる | 形の違反がある表では `main` が `render` を呼ばない（`parity.main` の行） |
| `parity.format_violation` | 3 列のタブ区切りの 1 行 | 詳細が空でも 3 列（末尾にタブ） | 無し（失敗しない関数） |
| `parity._cell` | 文字列をそのまま返す | `\|`・改行・`None` | 無し（失敗しない関数） |
| `extract.main` | 本物の文書で `check` が 0。`write` を一時の置き場に打つと、今の `coverage.json` と要素が一致する | 一時の置き場の `coverage.json` の並びを入れ替えても `check` が 0 | コピーから 1 要素を消すと `足された` で 1、文書に無い要素を足すと `消えた` で 1、要旨を変えると `要旨の違い` で 1。`coverage.json` が無いと 2 |
| `extract.extract_all` | 本物の文書で 639 要素、区分ごとの数が設計の決定 6 の表と一致する | 区分の並びが `spec` から `config` の順 | 一時の根に同じ ID を 2 回持つ文書を置くと 2 |
| `extract.extract_spec_conditions` | 本物の文書で 342 要素。節を持たない 4 本が `spec:<名前>` の 1 要素ずつ | 2 段目の見出しの節（design-keyboard）が `C01` から振られる。I19〜I24 が 2 本の確定仕様で別の ID になる | 一時の根で `docs/specifications/` が空だと 2 |
| `extract.extract_routes` | 本物の文書で 94 要素 | 1 行に 2 つのメソッドがある行が 2 要素になる | 一時の根で「経路の一覧」の見出しを消すと 2 |
| `extract.extract_screens` | 本物の文書で 35 要素 | 経路の無い予定の行が `screen:<経路の欄>:<画面の名前>` になる | 一時の根で「画面の地図」の見出しを消すと 2 |
| `extract.extract_tables` | 本物の文書で 8 要素で、最後が `table:state-bucket` | 論理名のリンクが文字だけになる | 一時の根で「7 表の一覧」の見出しを消すと 2 |
| `extract.extract_infra_invariants` | 本物の文書で 7 要素 | 無し（表の行の数は文書が決める） | 一時の根で「不変条件」の見出しを消すと 2 |
| `extract.extract_env_vars` | 本物の文書で 120 要素 | 「突き合わせ」の節の `PARENT_ONLY` が要素にならない。同じ名前が 2 つの節にあっても 1 要素 | 一時の根で「突き合わせ」の見出しを消すと 2 |
| `extract.extract_config_fields` | 本物の文書で 33 要素 | 無し（表の行の数は文書が決める） | 一時の根で「`EnvSettings` の項目」の見出しを消すと 2 |
| `extract.tables_under` | 見出しの深さが 2 段目でも 3 段目でも節の表を返す | 節の中に表が 2 つあれば両方。コードブロックの中の表の形の行を含まない。同じか浅い見出しで節が終わる | 当たる見出しが無ければ空の配列 |
| `extract.title_of` | 90 字以下はそのまま（リンクは文字だけ） | ちょうど 90 字はそのまま、91 字は先頭 89 字と `…` | 無し（失敗しない関数） |
| `extract.build_copy` | 頭の 4 つのキーと要素の 3 つのキーを持つ JSON | 要素が 0 でも JSON として読める | 無し（失敗しない関数） |
| `extract.diff_elements` | 同じ一覧で空 | 並びだけが違う一覧で空 | `足された`・`消えた`・`要旨の違い` の 3 種類が、この順で出る |
| `extract.base_commit` | リポジトリの中で短いコミットの名前を返す | 無し | git の作業の木でない一時のディレクトリを根にすると `write` が 2 |
| `test_parity.run_cli` | 無し（補助の関数。ほかのテストが使う） | 無し | 時間の上限 60 秒を超えるとテストが落ちる |
| `test_parity.copy_dir` | 無し（補助の関数） | 無し | 本物の置き場が無ければテストが落ちる |
| `test_parity.edit_table` | 無し（補助の関数） | 無し | `rerender` が真で `render` が 0 でなければテストが落ちる |

本物の置き場を見るテストには、ほかに次の 3 つを置く（設計文書の「テスト設計」の受け入れ条件 5・14 と移行性の行）。

- 対応表の `approved_on` が `null` の間は、全行の `trial.result` が `not_run` である。`approved_on` が日付なら確かめない（設計の決定 3 で、移すときに外す）
- 本物の対応表の 1 行から行き先を消した一時の置き場で、`parity.py check` が 1 を返す。ジョブ `test` と同じ `uv run pytest -q` で集まるテストの中で確かめる
- 置き場の 3 つのファイルだけを、リポジトリの外の一時のディレクトリへコピーする。`--dir` にそのディレクトリを渡して、`parity.py check` が 0 を返す（網羅の元の文書を開かない）
