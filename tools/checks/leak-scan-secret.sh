#!/usr/bin/env bash
# 秘密の正規表現を重ねた設定を組み、規則ごとに leak-scan.sh を打つ
# （#96 #101 の決定 3・5・8。仕様は docs/specifications/leak-check.md の「秘密を使う探しのスクリプト（leak-scan-secret.sh）」）。
# 重ねた規則 nd-real-value の名前と、重ねた設定を組む処理を持つのは、このスクリプトだけである。
# 受けた対象を、既定の規則（tools/checks/gitleaks-default.toml）と、秘密を重ねた設定（.gitleaks.toml を [extend] path で読み、
# 規則 nd-real-value を足したもの。秘密が無く必須でなければ .gitleaks.toml）で 1 回ずつ探す。
# --count-only では、既定の規則・.gitleaks.toml・nd-real-value だけの設定で 1 回ずつ探し、nd-real-value の探しの出力をすべて捨てる
# （公開の記録に、秘密の正規表現に当たった場所の手がかりを出さない。出すのは件数の行・失敗の固定の行・終了コードだけ）。
# nd-real-value の探しが当たりのほかの理由で 0 以外を返したとき（読めずに飛ばした対象がある・gitleaks の失敗など）は、
# 件数の行とは別に、失敗の固定の行を出す。leak-scan.sh は当たりと読み飛ばしが同時に起きても 1 を返すので、件数と終了コードだけでは見分けられないため。
# 設定は、このスクリプトの在るチェックアウトの根から組む。探す木の中の設定は読まない。
# 秘密の値は leak-scan.sh へ渡す前に環境から消し、gitleaks に渡さない。
#
# 使い方: leak-scan-secret.sh <dir|history|git> [<木>] [--range <範囲>] [--count-only] [--details]
#   dir: <木>（省けば今のディレクトリ）を探す。history: export-tree.sh --history の出力先 <木> の paths/ と各層を、
#   1 つずつ探す木の根として探す。git: 今のディレクトリの git のリポジトリの履歴を探す（--range を渡せばその範囲）
#   --count-only: nd-real-value の当たりを件数だけで出し、その探しが失敗したときは失敗の固定の行も出す（main への push の探し）
#   --details: leak-scan.sh に --paths を渡し、実際のファイルの名前を出す。手元で当たりのファイルを特定するときだけ使う
#   環境変数 LEAK_CHECK_PATTERN: 秘密の正規表現。LEAK_CHECK_REQUIRE_PATTERN: 1 なら秘密を必須にする
# 終了コード: すべての探しのうち悪い方。0 当たり無し、1 当たりがある・探しの失敗・秘密の誤りか欠け・件数を読めない、2 引数の誤り
set -euo pipefail

RULE_ID="nd-real-value"
FAILED_LINE="leak-scan-secret: ${RULE_ID} の探しが失敗した。読めずに飛ばした対象があり得るので、件数は探せた範囲だけのものである"
# leak-scan.sh が、当たりのほかに失敗を知らせる固定の文言（読み飛ばし・報告を読めない）
SKIP_TEXT="leak-scan: gitleaks が警告か誤りを出した"
UNREADABLE_TEXT="leak-scan: gitleaks の報告を読めない"
EMPTY_LINE="leak-scan-secret: 秘密 LEAK_CHECK_PATTERN が空なので .gitleaks.toml だけで探す"

# 秘密は読んだら環境から消す（子のプロセスに渡さない）
pattern="${LEAK_CHECK_PATTERN:-}"
require="${LEAK_CHECK_REQUIRE_PATTERN:-}"
unset LEAK_CHECK_PATTERN

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
checkout_root="$(cd "$script_dir/../.." && pwd -P)"
LEAK_SCAN="$script_dir/leak-scan.sh"
DEFAULT_CONFIG="$checkout_root/tools/checks/gitleaks-default.toml"
ND_CONFIG="$checkout_root/.gitleaks.toml"

usage() {
  echo "leak-scan-secret: 使い方: leak-scan-secret.sh <dir|history|git> [<木>] [--range <範囲>] [--count-only] [--details]" >&2
  exit 2
}

mode=""
tree=""
range=""
count_only=false
details=false

# 引数を読み、組み合わせの誤りを 2 で落とす
parse_args() {
  mode="${1:-}"
  case "$mode" in
    dir | history | git) shift ;;
    *) usage ;;
  esac
  if (($# > 0)) && [[ "$1" != --* ]]; then
    [[ "$mode" != git ]] || usage
    tree="$1"
    shift
  fi
  while (($# > 0)); do
    case "$1" in
      --range) [[ "$mode" == git && $# -ge 2 ]] || usage; range="$2"; shift 2 ;;
      --count-only) count_only=true; shift ;;
      --details) details=true; shift ;;
      *) usage ;;
    esac
  done
  [[ "$count_only" == false || "$details" == false ]] || usage
  if [[ "$mode" == history && -z "$tree" ]]; then
    usage
  fi
  if [[ "$mode" == dir && -z "$tree" ]]; then
    tree="."
  fi
  if [[ -n "$tree" ]]; then
    if [[ ! -d "$tree" ]] || { [[ "$mode" == history ]] && [[ ! -d "$tree/paths" ]]; }; then
      echo "leak-scan-secret: 探す木のディレクトリが無い" >&2
      exit 2
    fi
    tree="$(cd "$tree" && pwd -P)"
  fi
}

# 秘密と必須の指定から、nd-real-value を探す設定のファイルを決めて大域の overlay に置く（秘密が空なら .gitleaks.toml）。
# 形 extend は .gitleaks.toml を読んで nd-real-value を足した設定、alone は nd-real-value だけの設定
overlay=""
has_secret=false
build_overlay() {
  local work="$1" shape="$2"
  if [[ -z "$pattern" ]]; then
    if [[ "$require" == 1 ]]; then
      echo "leak-scan-secret: 秘密 LEAK_CHECK_PATTERN が無い（必須にしている）" >&2
      exit 1
    fi
    echo "$EMPTY_LINE"
    overlay="$ND_CONFIG"
    return 0
  fi
  if [[ "$pattern" == *"'''"* || "$pattern" == *$'\n'* || "$pattern" == *$'\r'* ]]; then
    echo "leak-scan-secret: 秘密 LEAK_CHECK_PATTERN に ''' と改行を含めない" >&2
    exit 1
  fi
  has_secret=true
  overlay="$work/overlay-${shape}.toml"
  if [[ "$shape" == extend ]]; then
    if [[ "$ND_CONFIG" == *'"'* || "$ND_CONFIG" == *\\* || "$ND_CONFIG" == *$'\n'* ]]; then
      echo "leak-scan-secret: チェックアウトのパスを設定に書けない" >&2
      exit 2
    fi
    printf '[extend]\npath = "%s"\n\n' "$ND_CONFIG" >"$overlay"
  else
    : >"$overlay"
  fi
  printf '[[rules]]\nid = "%s"\ndescription = "秘密 LEAK_CHECK_PATTERN の実際の値"\nregex = '"'''%s'''"'\n' \
    "$RULE_ID" "$pattern" >>"$overlay"
}

# count の探しが、当たりだけでなく失敗も含んでいたか（0 なら失敗を含む）。
# 当たりだけなら、leak-scan.sh は 1 を返し、報告に 1 件以上を書き、失敗の固定の文言を出さない
nd_failed=false
count_failed() {
  local status="$1" report="$2" log="$3"
  ((status != 0)) || return 1
  ((status == 1)) || return 0
  if grep -F -e "$SKIP_TEXT" -e "$UNREADABLE_TEXT" "$log" >/dev/null; then
    return 0
  fi
  [[ -s "$report" ]] && jq -e 'type == "array" and length > 0' "$report" >/dev/null 2>&1 && return 1
  return 0
}

# leak-scan.sh を 1 回打ち、報告を木の外に受ける。pass は出力をそのまま出し、count はすべて捨てる
# （count では、捨てる前に失敗を含むかだけを見て nd_failed に残す）
run_scan() {
  local root="$1" config="$2" report="$3" output="$4" status=0
  local -a args=("$config")
  if [[ "$mode" == git ]]; then
    args=(git "${args[@]}")
    [[ -z "$range" ]] || args+=(--range "$range")
  else
    args=(dir "${args[@]}")
  fi
  [[ -z "$report" ]] || args+=(--report "$report")
  [[ "$details" == false ]] || args+=(--paths)
  if [[ "$output" == count ]]; then
    (cd "$root" && "$LEAK_SCAN" "${args[@]}") >"$work/count.log" 2>&1 || status=$?
    if count_failed "$status" "$report" "$work/count.log"; then
      nd_failed=true
    fi
    rm -f "$work/count.log"
  else
    (cd "$root" && "$LEAK_SCAN" "${args[@]}") || status=$?
  fi
  return "$status"
}

# nd-real-value を探した報告から nd-real-value の件数を合わせて数え、件数の行を 1 つ出す
report_counts() {
  local report total=0 count
  for report in "$@"; do
    if [[ ! -s "$report" ]] || ! count="$(jq -e --arg id "$RULE_ID" 'if type == "array" then [.[] | select(.RuleID == $id)] | length else error end' "$report" 2>/dev/null)"; then
      echo "leak-scan-secret: ${RULE_ID} の件数を読めない"
      return 1
    fi
    total=$((total + count))
  done
  echo "leak-scan-secret: ${RULE_ID}: ${total} 件"
  ((total == 0))
}

parse_args "$@"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [[ "$count_only" == true ]]; then
  build_overlay "$work" alone
else
  build_overlay "$work" extend
fi

# 探す木の根の並び。history は paths/ と、layers/ と binary-text/ の層を番号の順に
roots=()
labels=()
if [[ "$mode" == history ]]; then
  roots+=("$tree/paths")
  labels+=(paths)
  for kind in layers binary-text; do
    [[ -d "$tree/$kind" ]] || continue
    while IFS= read -r layer; do
      roots+=("$tree/$kind/$layer")
      labels+=("$kind/$layer")
    done < <(find "$tree/$kind" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep -E '^[1-9][0-9]*$' | sort -n)
  done
elif [[ "$mode" == git ]]; then
  roots+=("$PWD")
  labels+=("")
else
  roots+=("$tree")
  labels+=("")
fi

final=0
# 悪い方の終了コードを残す（2 が最も悪い）
worse() {
  local status="$1"
  if ((status == 2)); then
    final=2
  elif ((status != 0 && final == 0)); then
    final=1
  fi
}

# run_scan を 1 回打ち、その終了コードを worse で残す（引数は run_scan と同じ）
scan_merge() {
  local status=0
  run_scan "$@" || status=$?
  worse "$status"
}

reports=()
index=0
for i in "${!roots[@]}"; do
  root="${roots[$i]}"
  if [[ -n "${labels[$i]}" ]]; then
    echo "leak-scan-secret: 履歴 ${labels[$i]} を探す"
  fi
  scan_merge "$root" "$DEFAULT_CONFIG" "" pass
  index=$((index + 1))
  report=""
  if [[ "$has_secret" == true ]]; then
    report="$work/report-${index}.json"
    reports+=("$report")
  fi
  if [[ "$count_only" == true ]]; then
    scan_merge "$root" "$ND_CONFIG" "" pass
    if [[ "$has_secret" == true ]]; then
      scan_merge "$root" "$overlay" "$report" count
    fi
  else
    scan_merge "$root" "$overlay" "$report" pass
  fi
done

if [[ "$has_secret" == true ]]; then
  status=0
  report_counts "${reports[@]}" || status=$?
  worse "$status"
fi
if [[ "$nd_failed" == true ]]; then
  echo "$FAILED_LINE"
  worse 1
fi
exit "$final"
