#!/usr/bin/env bash
# gitleaks の 1 回の探し（#1 の決定 3。中身は docs/design-process/issue-1/design-detail.md の「gitleaks の設定と leak-check のジョブ」）。
# gitleaks のすべての実行はこのスクリプトを通す（leak-check のジョブと tools/test/leak-scan.integration.test.ts）。
# 引数と前提を確かめて、本体（leak_scan/main.py。Python の標準ライブラリだけ）へ渡す（#98）。
# gitleaks の除外（値の行の gitleaks:allow・.gitleaksignore・前の報告）を効かなくし、当たりを規則・ファイル・行・コミットだけで出す。
# 当たった行の残り・コミットの本文・作者は出さない（同じ行の別の秘密や、伏せた値の前後が記録に残るため）。
# ファイルの名前も秘密の値を含み得るので、--paths を渡さなければ file-<番号>（名前の順の通し番号）に替えて出す。
# gitleaks が中身を読まずに飛ばすファイル・名前で外すファイル・アーカイブと圧縮ファイルの中は、一時の写しで探し直し、
# 探し終えたことを確かめられなければ、当たりが無くても 1 で終える（仕様は docs/specifications/leak-check.md）。
# 今のディレクトリを探す木の根として打つ。
#
# 使い方: leak-scan.sh <dir|git> <設定> [--range <範囲>] [--report <報告のファイル>] [--paths]
#   dir: 今の木を探す。git: 履歴を探す（--range を渡せばその範囲。マージのコミットの差分を含める）
#   設定: 必ず渡す。省くと gitleaks は探す木の根の .gitleaks.toml を読み、既定の規則が抜けるため
#   --report: 当たりを JSON で書く先（探す木の外に置く）。項目は RuleID・File・StartLine・EndLine・Commit だけ
#   --paths: File に実際のファイルの名前を出し、gitleaks の生の出力も標準エラーへ出す。手元で当たりの場所を引くときだけ渡す（CI のジョブは渡さない）
# 終了コード: 0 当たり無し、1 当たりがある・gitleaks が失敗した・読めずに飛ばした対象か探し終えたことを確かめられない対象がある・python3 か git が無いか版が古い、2 引数の誤り・除外のファイルがある
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

# 本体を起こせないか道具の版が足りなければ、gitleaks を打たずに、探しの種類の固定の行で失敗にする
cannot_scan() {
  if [[ "$mode" == dir ]]; then
    echo "leak-scan: gitleaks が中身を読まずに飛ばしたファイルを探せなかった" >&2
  else
    echo "leak-scan: 履歴を最後まで探し終えたことを確かめられなかった" >&2
  fi
  echo "leak-scan: $1" >&2
  exit 1
}

command -v python3 >/dev/null 2>&1 || cannot_scan "python3 が無い"
# 本体は tomllib（Python 3.11 以降）を読み込む
python3 -I -c 'import sys; sys.exit(sys.version_info < (3, 11))' >/dev/null 2>&1 || cannot_scan "python3 が 3.11 より古い"
# 履歴の探しは git check-attr --source（Git 2.40 以降）を使う
if [[ "$mode" == git ]]; then
  if [[ ! "$(git --version 2>/dev/null)" =~ ^git\ version\ ([0-9]+)\.([0-9]+) ]] ||
    ((BASH_REMATCH[1] < 2 || (BASH_REMATCH[1] == 2 && BASH_REMATCH[2] < 40))); then
    cannot_scan "git が 2.40 より古い"
  fi
fi

# gitleaks は git log の失敗（無い範囲など）を当たり無しの 0 で終えるので、範囲を先に git で確かめる
if [[ "$mode" == git ]] && ! git rev-list --quiet "${range:-HEAD}" -- >/dev/null 2>&1; then
  echo "leak-scan: 履歴の範囲を git で読めない: ${range:-HEAD}" >&2
  exit 2
fi

# -B: 探す木の中に __pycache__ を作らない
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec python3 -I -B "$script_dir/leak_scan/main.py" "$mode" "$config" "$range" "$report" "$paths"
