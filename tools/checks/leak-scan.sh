#!/usr/bin/env bash
# gitleaks の 1 回の探し（#1 の決定 3。中身は issues/issue-1-design-detail.md の「gitleaks の設定と leak-check のジョブ」）。
# gitleaks のすべての実行はこのスクリプトを通す（leak-check のジョブと tools/test/leak-scan.integration.test.ts）。
# gitleaks の除外（値の行の gitleaks:allow・.gitleaksignore・前の報告）を効かなくし、当たりを規則・ファイル・行・コミットだけで出す。
# 当たった行の残り・コミットの本文・作者は出さない（同じ行の別の秘密や、伏せた値の前後が記録に残るため）。
# 今のディレクトリを探す木の根として打つ。
#
# 使い方: leak-scan.sh <dir|git> <設定> [--range <範囲>] [--report <報告のファイル>]
#   dir: 今の木を探す。git: 履歴を探す（--range を渡せばその範囲。マージのコミットの差分を含める）
#   設定: 必ず渡す。省くと gitleaks は探す木の根の .gitleaks.toml を読み、既定の規則が抜けるため
#   --report: 当たりを JSON で書く先（探す木の外に置く）。項目は RuleID・File・StartLine・EndLine・Commit だけ
# 終了コード: 0 当たり無し、1 当たりがある・gitleaks が失敗した、2 引数の誤り・除外のファイルがある
set -euo pipefail

usage() {
  echo "leak-scan: 使い方: leak-scan.sh <dir|git> <設定> [--range <範囲>] [--report <報告のファイル>]" >&2
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
while (($# > 0)); do
  case "$1" in
    --range) [[ $# -ge 2 ]] || usage; range="$2"; shift 2 ;;
    --report) [[ $# -ge 2 ]] || usage; report="$2"; shift 2 ;;
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

# 報告から規則・ファイル・行・コミットだけを取り出し、記録へ出し、--report があればそこへ書く。
# gitleaks の終了コードを受け、報告を読めなければ 1 で終える
finish() {
  local status="$1"
  if [[ ! -s "$raw_report" ]] || ! jq -e 'type == "array"' "$raw_report" >/dev/null 2>&1; then
    echo "leak-scan: gitleaks の報告を読めない（終了コード ${status}）" >&2
    exit 1
  fi
  local findings
  findings="$(jq '[.[] | {RuleID, File, StartLine, EndLine, Commit}]' "$raw_report")"
  jq -r '.[] | "leak-scan: 当たり \(.RuleID) \(.File):\(.StartLine)" + (if .Commit == "" then "" else " \(.Commit)" end)' <<<"$findings"
  if [[ -n "$report" ]]; then
    printf '%s\n' "$findings" >"$report"
  fi
  local count
  count="$(jq 'length' <<<"$findings")"
  if ((count > 0)); then
    echo "leak-scan: 当たり ${count} 件" >&2
    exit 1
  fi
  exit "$status"
}

if [[ "$mode" == dir ]]; then
  status=0
  gitleaks dir . "${args[@]}" || status=$?
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
gitleaks git . --log-opts="$log_opts" "${args[@]}" || status=$?
finish "$status"
