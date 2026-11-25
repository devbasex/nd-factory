#!/usr/bin/env bash
# gitleaks の 1 回の探し（#1 の決定 3。中身は docs/design-process/issue-1/design-detail.md の「gitleaks の設定と leak-check のジョブ」）。
# gitleaks のすべての実行はこのスクリプトを通す（leak-check のジョブと tools/test/leak-scan.integration.test.ts）。
# gitleaks の除外（値の行の gitleaks:allow・.gitleaksignore・前の報告）を効かなくし、当たりを規則・ファイル・行・コミットだけで出す。
# 当たった行の残り・コミットの本文・作者は出さない（同じ行の別の秘密や、伏せた値の前後が記録に残るため）。
# ファイルの名前も秘密の値を含み得るので、--paths を渡さなければ file-<番号>（名前の順の通し番号）に替えて出す。
# gitleaks の標準出力と標準エラー（読めないファイルの診断などにファイルの名前が載る）は一時のファイルに受け、
# --paths を渡さなければ出さない（出すのは終了コードと整形した当たりだけ）。
# gitleaks は読めないファイルやディレクトリを警告だけで飛ばし、ほかに当たりが無ければ 0 で終えるので、
# 生の出力に警告か誤りの段（WRN・ERR・FTL）があれば、固定の文言で知らせて 1 で終える（探し漏れを通さない）。
# 今のディレクトリを探す木の根として打つ。
#
# 使い方: leak-scan.sh <dir|git> <設定> [--range <範囲>] [--report <報告のファイル>] [--paths]
#   dir: 今の木を探す。git: 履歴を探す（--range を渡せばその範囲。マージのコミットの差分を含める）
#   設定: 必ず渡す。省くと gitleaks は探す木の根の .gitleaks.toml を読み、既定の規則が抜けるため
#   --report: 当たりを JSON で書く先（探す木の外に置く）。項目は RuleID・File・StartLine・EndLine・Commit だけ
#   --paths: File に実際のファイルの名前を出し、gitleaks の生の出力も標準エラーへ出す。手元で当たりの場所を引くときだけ渡す（CI のジョブは渡さない）
# 終了コード: 0 当たり無し、1 当たりがある・gitleaks が失敗した・gitleaks が警告か誤りを出した（読めずに飛ばした対象がある）、2 引数の誤り・除外のファイルがある
set -euo pipefail

usage() {
  echo "leak-scan: 使い方: leak-scan.sh <dir|git> <設定> [--range <範囲>] [--report <報告のファイル>] [--paths]" >&2
  exit 2
}

mode="${1:-}"
config="${2:-}"
case "$mode" in
  dir | git) ;;
  *) usage ;;
esac
if [[ -z "$config" || "$config" == --* ]]; then
  echo "leak-scan: 設定のファイルを渡していない。既定の規則は tools/checks/gitleaks-default.toml、nd-factory の規則は .gitleaks.toml を渡す" >&2
  exit 2
fi
if [[ ! -f "$config" ]]; then
  echo "leak-scan: 設定のファイルが無い: $config" >&2
  exit 2
fi
shift 2

range=""
report=""
paths=false
while (($# > 0)); do
  case "$1" in
    --range) [[ $# -ge 2 ]] || usage; range="$2"; shift 2 ;;
    --report) [[ $# -ge 2 ]] || usage; report="$2"; shift 2 ;;
    --paths) paths=true; shift ;;
    *) usage ;;
  esac
done
if [[ "$mode" == dir && -n "$range" ]]; then
  echo "leak-scan: --range は git の探しでだけ渡す" >&2
  exit 2
fi

# gitleaks は引数によらず、探す木の根の .gitleaksignore を読む（v8.30.1 の cmd/root.go）。在れば探さない
if [[ -e .gitleaksignore ]] || git ls-files --error-unmatch .gitleaksignore >/dev/null 2>&1; then
  echo "leak-scan: 探す木の根に .gitleaksignore がある。除外のファイルでは当たりを外せない。消して、正当な当たりは当てた規則の [[rules.allowlists]] に理由を添えて足す" >&2
  exit 2
fi

# --gitleaks-ignore-path の既定（.）の .gitleaksignore を読ませないため、空の一時のディレクトリを渡す。
# gitleaks の報告（当たった行の一部・コミットの本文を含む）は探す木の外の一時のファイルに受け、項目を絞ってから出す
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
ignore_dir="$work_dir/ignore"
raw_report="$work_dir/report.json"
raw_log="$work_dir/gitleaks.log"
mkdir "$ignore_dir"

# --verbose を渡さない: gitleaks の詳しい出力は当たった行の残りとコミットの本文を出す
args=(
  --redact=100
  --no-banner
  --exit-code 1
  --ignore-gitleaks-allow
  --gitleaks-ignore-path "$ignore_dir"
  --config "$config"
  --report-path "$raw_report"
  --report-format json
)

# 警告と誤りの段を見る。色の制御の列を外してから、段の語を 1 語として照らす（名前は出さない）。
# gitleaks は当たりがあると WRN の段で件数の行（leaks found: <件数>）を出す。これは飛ばした対象の知らせではないので外す
# （外さないと、当たりがあるだけで警告か誤りと見なし、当たりの有無で出力の行が変わる）。
# 外すのは、行の全体が「時刻（3:04PM の形） WRN leaks found: <件数>」の行だけ。行の末尾だけで照らすと、
# ファイルの名前などを含む本当の警告か誤りの末尾がたまたま件数の行と同じとき、それも捨ててしまう。
# grep -q は当たった所で読むのをやめ、続きを書く sed が SIGPIPE で落ちて pipefail が当たりを打ち消すので、
# -q を使わずに末尾まで読ませ、当たった行は捨てる
# 引数: gitleaks の生の出力のファイル。飛ばした対象の知らせがあれば 0、無ければ（ファイルが空か無いときも）0 以外で返す
log_has_skipped() {
  local log="$1"
  [[ -s "$log" ]] && sed $'s/\x1b\\[[0-9;]*m//g' "$log" | grep -Ev '^[0-9]{1,2}:[0-9]{2}[AP]M WRN leaks found: [0-9]+$' | grep -E '(^| )(WRN|ERR|FTL)( |$)' >/dev/null
}

# --paths が無ければ、gitleaks の生の出力を伏せたことを標準エラーへ知らせる
note_hidden() {
  if [[ "$paths" == false ]]; then
    echo "leak-scan: gitleaks の出力はファイルの名前を含み得るので伏せた。手元で同じ引数に --paths を足して打つと出る" >&2
  fi
}

# 報告から規則・ファイル・行・コミットだけを取り出し、記録へ出し、--report があればそこへ書く。
# --paths が無ければ、ファイルの名前を名前の順の file-<番号> に替える（名前に入った秘密の値を記録と報告に残さない）。
# gitleaks の終了コードを受け、報告を読めなければ 1 で終える
finish() {
  local status="$1"
  if [[ "$paths" == true && -s "$raw_log" ]]; then
    cat "$raw_log" >&2
  fi
  if [[ ! -s "$raw_report" ]] || ! jq -e 'type == "array"' "$raw_report" >/dev/null 2>&1; then
    echo "leak-scan: gitleaks の報告を読めない（終了コード ${status}）" >&2
    note_hidden
    exit 1
  fi
  local skipped=false
  if log_has_skipped "$raw_log"; then
    skipped=true
  fi
  local findings
  findings="$(jq --argjson paths "$paths" '
    ([.[].File] | unique) as $files
    | [.[] | {RuleID, File, StartLine, EndLine, Commit}]
    | if $paths then . else map(.File as $f | .File = "file-\(($files | index($f)) + 1)") end' "$raw_report")"
  jq -r '.[] | "leak-scan: 当たり \(.RuleID) \(.File):\(.StartLine)" + (if .Commit == "" then "" else " \(.Commit)" end)' <<<"$findings"
  if [[ -n "$report" ]]; then
    printf '%s\n' "$findings" >"$report"
  fi
  if [[ "$skipped" == true ]]; then
    echo "leak-scan: gitleaks が警告か誤りを出した。読めずに飛ばした対象があり得るので、当たり無しとして通さない" >&2
    note_hidden
  fi
  local count
  count="$(jq 'length' <<<"$findings")"
  if ((count > 0)); then
    echo "leak-scan: 当たり ${count} 件" >&2
    if [[ "$paths" == false ]]; then
      echo "leak-scan: ファイルの名前は伏せた。手元で同じ引数に --paths を足して打つと出る" >&2
    fi
    exit 1
  fi
  if [[ "$skipped" == true ]]; then
    exit 1
  fi
  exit "$status"
}

if [[ "$mode" == dir ]]; then
  status=0
  gitleaks dir . "${args[@]}" >"$raw_log" 2>&1 || status=$?
  finish "$status"
fi

# gitleaks は git log の失敗（無い範囲など）を当たり無しの 0 で終えるので、範囲を先に git で確かめる
if ! git rev-list --quiet "${range:-HEAD}" -- >/dev/null 2>&1; then
  echo "leak-scan: 履歴の範囲を git で読めない: ${range:-HEAD}" >&2
  exit 2
fi
# -m: gitleaks は範囲を git log -p に渡すだけで、そのままではマージのコミットの差分を出さない（v8.30.1 の sources/git.go）
log_opts="-m"
if [[ -n "$range" ]]; then
  log_opts="-m ${range}"
fi
status=0
gitleaks git . --log-opts="$log_opts" "${args[@]}" >"$raw_log" 2>&1 || status=$?
finish "$status"
