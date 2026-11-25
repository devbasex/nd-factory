#!/usr/bin/env bash
# コミットの木か、範囲の履歴の項目を、Git に保存された内容のまま取り出して照らす
# （#96 #101 の決定 5・8。中身は issues/issue-96-101-design-detail.md の「木の取り出しのスクリプト」）。
# .gitattributes を読まず、git archive・git checkout・--filters・--textconv を使わない（export-ignore・export-subst・
# 改行の変換・ident・フィルタで、探す対象の中身が変わるため）。取り出したファイルは読むだけで、動かさない。
# 元のパスは実際の値を含み得るので、記録と端末には固定の知らせ（項目の通し番号を含む）と使い方の 1 行だけを出す。
# 頭の確かめの後は、コマンドとシェルの診断を作業のディレクトリの一時のファイルへ向け、読まずに消す。
# 今のディレクトリの git のリポジトリを読む。
#
# 使い方:
#   export-tree.sh <コミット> <出力先>                       木のすべてのファイルを書き、照らす
#   export-tree.sh --history <分岐点> <head> <出力先>         範囲の各コミットの差の項目を書き、照らす
#   export-tree.sh --verify <コミット> <出力先>              書いてある木を照らすだけ
#   export-tree.sh --verify-history <分岐点> <head> <出力先>  書いてある履歴を照らすだけ
#   書く使い方の出力先は、無いか空のディレクトリ（無ければ作る）。履歴は出力先に次の 3 つを書く
#     paths/<通し番号>               差の項目のパスのバイト列（足した・変えた・消した・種類を変えたのどれも）
#     layers/<層の番号>/<元のパス>      差の後の側の blob の中身（元のパスと blob の組ごとに 1 回）
#     binary-text/<層の番号>/<元のパス> layers/ の同じファイルが NUL を含むとき、印字できない文字を改行に替えた中身
# 終了コード: 0 書いて照らせた、1 取り出せない項目・書けない・照らしが合わない、2 引数の誤り・コミットか範囲を読めない
set -euo pipefail

usage() {
  echo "export-tree: 使い方: export-tree.sh <コミット> <出力先> | --history <分岐点> <head> <出力先> | --verify <コミット> <出力先> | --verify-history <分岐点> <head> <出力先>" >&2
  exit 2
}

action="write"
case "${1:-}" in
  --history) action=history; shift ;;
  --verify) action=verify; shift ;;
  --verify-history) action=verify-history; shift ;;
esac
case "$action" in
  write | verify) (($# == 2)) || usage; commit="$1"; out="$2" ;;
  history | verify-history) (($# == 3)) || usage; base="$1"; head="$2"; out="$3" ;;
esac
[[ -n "$out" ]] || usage

if [[ "$action" == write || "$action" == history ]]; then
  if [[ -e "$out" || -L "$out" ]]; then
    if [[ -L "$out" || ! -d "$out" ]] || [[ -n "$(find "$out" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
      echo "export-tree: 出力先が空のディレクトリでない" >&2
      exit 2
    fi
  fi
elif [[ -L "$out" || ! -d "$out" ]]; then
  usage
fi

if [[ "$action" == write || "$action" == verify ]]; then
  if ! git rev-parse --verify --quiet "${commit}^{commit}" >/dev/null 2>&1; then
    echo "export-tree: コミットを読めない" >&2
    exit 2
  fi
elif ! git rev-parse --verify --quiet "${base}^{commit}" >/dev/null 2>&1 ||
  ! git rev-parse --verify --quiet "${head}^{commit}" >/dev/null 2>&1; then
  echo "export-tree: 履歴の範囲を読めない" >&2
  exit 2
fi

# 頭の確かめの後: 出力先の外に作業のディレクトリを作り、診断（パスを含み得る）をその中へ向け直す。
# 固定の知らせは向け直す前の標準エラー（記述子 3）へ出す
work="$(mktemp -d)"
reported=false
cleanup() {
  local status=$?
  rm -rf "$work"
  if ((status != 0)) && [[ "$reported" == false ]]; then
    echo "export-tree: 途中で失敗した（診断はパスを含み得るので伏せた）" >&3
  fi
  exit "$status"
}
trap cleanup EXIT
exec 3>&2 2>"$work/diag"

# 固定の知らせを出して終える
die() {
  reported=true
  echo "export-tree: $2" >&3
  exit "$1"
}

# 項目のパスが出力先の外や .git を指さないか。空・絶対パス・空か . か .. の部分・大文字と小文字を区別せず .git の部分を拒む
check_path() {
  local path="$2" part rest
  [[ -n "$path" && "$path" != /* ]] || return 1
  # パスは改行を含み得るので、read で区切らずに / ごとに切り出す（末尾の / は空の部分として拒む）
  rest="$path/"
  while [[ -n "$rest" ]]; do
    part="${rest%%/*}"
    rest="${rest#*/}"
    [[ -n "$part" && "$part" != . && "$part" != .. ]] || return 1
    [[ "${part,,}" != .git ]] || return 1
  done
  return 0
}

# 木のファイルの項目ごとに blob を書く。シンボリックリンクはリンク先の文字列を中身とする普通のファイルにし、サブモジュールは書かない
write_entries() {
  local commit="$1" out="$2" n=0 entry meta path mode sha target
  git ls-tree -r -z --full-tree "$commit" >"$work/tree" || die 1 "木を書き出せない（0 番目）"
  mkdir -p -- "$out" || die 1 "木を書き出せない（0 番目）"
  while IFS= read -r -d '' entry; do
    n=$((n + 1))
    meta="${entry%%$'\t'*}"
    path="${entry#*$'\t'}"
    read -r mode _ sha <<<"$meta"
    check_path "$n" "$path" || die 1 "木に取り出せない項目がある（${n} 番目）"
    case "$mode" in
      100644 | 100755 | 120000) ;;
      160000) continue ;;
      *) die 1 "木に取り出せない項目がある（${n} 番目）" ;;
    esac
    target="$out/$path"
    if [[ -e "$target" || -L "$target" ]]; then
      die 1 "木に取り出せない項目がある（${n} 番目）"
    fi
    mkdir -p -- "$(dirname -- "$target")" || die 1 "木を書き出せない（${n} 番目）"
    git cat-file blob "$sha" >"$target" || die 1 "木を書き出せない（${n} 番目）"
    chmod 0644 -- "$target" || die 1 "木を書き出せない（${n} 番目）"
  done <"$work/tree"
}

# 数を数える（名前に改行を含み得るので、1 項目を 1 文字にして数える）
count_found() {
  find "$@" -printf '.' | wc -c
}

# 木を git ls-tree で求め直し、出力先のファイルの数と内容の値が項目と一致するかを照らす（書いた側の結果は使わない）
verify_tree() {
  local commit="$1" out="$2" entry meta path mode sha file hash expected=0
  local mismatch="取り出した木が元の木と一致しない"
  git ls-tree -r -z --full-tree "$commit" >"$work/expect" || die 1 "$mismatch"
  while IFS= read -r -d '' entry; do
    meta="${entry%%$'\t'*}"
    path="${entry#*$'\t'}"
    read -r mode _ sha <<<"$meta"
    case "$mode" in
      100644 | 100755 | 120000) ;;
      *) continue ;;
    esac
    check_path 0 "$path" || die 1 "$mismatch"
    expected=$((expected + 1))
    file="$out/$path"
    [[ -f "$file" && ! -L "$file" ]] || die 1 "$mismatch"
    hash="$(git hash-object --no-filters -- "$file")" || die 1 "$mismatch"
    [[ "$hash" == "$sha" ]] || die 1 "$mismatch"
  done <"$work/expect"
  [[ "$(count_found "$out" -type f)" == "$expected" ]] || die 1 "$mismatch"
  [[ "$(count_found "$out" ! -type f ! -type d)" == 0 ]] || die 1 "$mismatch"
}

# 範囲の各コミットの差の項目を読み、パスの並び（<dir>/paths）と、元のパスと blob の組の一覧（<dir>/pairs、重なりを除く）を
# NUL で区切って書く。組は <blob>TAB<元のパス> の形。書く側と照らす側が、それぞれ打ち直して使う
expected_history() {
  local base="$1" head="$2" dir="$3" rev meta path n=0 newmode newsha
  local -A seen=()
  mkdir -p -- "$dir"
  : >"$dir/paths"
  : >"$dir/pairs"
  git rev-list "${base}..${head}" >"$dir/revs" || die 2 "履歴の範囲を読めない"
  while IFS= read -r rev; do
    git diff-tree -r -z --raw --no-renames --root -m --no-commit-id "$rev" >"$dir/diff" || die 2 "履歴の範囲を読めない"
    while IFS= read -r -d '' meta && IFS= read -r -d '' path; do
      n=$((n + 1))
      # :<前のモード> <後のモード> <前の blob> <後の blob> <状態>
      read -r _ newmode _ newsha _ <<<"$meta"
      check_path "$n" "$path" || die 1 "履歴の項目を書き出せない（${n} 番目）"
      printf '%s\0' "$path" >>"$dir/paths"
      case "$newmode" in
        100644 | 100755 | 120000)
          if [[ "$newsha" =~ ^0+$ ]]; then
            continue
          fi
          if [[ -z "${seen["$newsha"$'\t'"$path"]:-}" ]]; then
            seen["$newsha"$'\t'"$path"]=1
            printf '%s\t%s\0' "$newsha" "$path" >>"$dir/pairs"
          fi
          ;;
        160000 | 000000) ;;
        *) die 1 "履歴の項目を書き出せない（${n} 番目）" ;;
      esac
    done <"$dir/diff"
  done <"$dir/revs"
}

# blob が NUL を含むか
has_nul() {
  [[ "$(LC_ALL=C tr -d '\000' <"$1" | wc -c)" != "$(wc -c <"$1")" ]]
}

# NUL を含む blob を読める文字にする（標準入力から読み、標準出力へ書く）。タブと印字できるバイトのほかは改行にする
to_binary_text() {
  LC_ALL=C tr -c '\11\40-\176\200-\377' '\n'
}

# 範囲の履歴の項目を出力先に書く。組は、読んだ順に、置ける最も小さい番号の層に置く
write_history() {
  local base="$1" head="$2" out="$3" path pair sha layer ancestor ok n=0 target
  local -A taken=()
  expected_history "$base" "$head" "$work/expected"
  mkdir -p -- "$out/paths" "$out/layers" "$out/binary-text" || die 1 "履歴の項目を書き出せない（0 番目）"
  while IFS= read -r -d '' path; do
    n=$((n + 1))
    printf '%s' "$path" >"$out/paths/$n" || die 1 "履歴の項目を書き出せない（${n} 番目）"
  done <"$work/expected/paths"
  n=0
  while IFS= read -r -d '' pair; do
    n=$((n + 1))
    sha="${pair%%$'\t'*}"
    path="${pair#*$'\t'}"
    layer=1
    for (( ; ; layer++)); do
      # 層が同じパス（ファイルかディレクトリ）を持たず、親のディレクトリに当たるパスをファイルとして持たないとき置ける
      ok=true
      [[ -z "${taken["$layer"$'\t'"$path"]:-}" ]] || ok=false
      ancestor="$path"
      while [[ "$ok" == true && "$ancestor" == */* ]]; do
        ancestor="${ancestor%/*}"
        [[ "${taken["$layer"$'\t'"$ancestor"]:-}" != f ]] || ok=false
      done
      [[ "$ok" == true ]] && break
    done
    taken["$layer"$'\t'"$path"]=f
    ancestor="$path"
    while [[ "$ancestor" == */* ]]; do
      ancestor="${ancestor%/*}"
      taken["$layer"$'\t'"$ancestor"]=d
    done
    target="$out/layers/$layer/$path"
    mkdir -p -- "$(dirname -- "$target")" || die 1 "履歴の項目を書き出せない（${n} 番目）"
    git cat-file blob "$sha" >"$target" || die 1 "履歴の項目を書き出せない（${n} 番目）"
    chmod 0644 -- "$target" || die 1 "履歴の項目を書き出せない（${n} 番目）"
    if has_nul "$target"; then
      target="$out/binary-text/$layer/$path"
      mkdir -p -- "$(dirname -- "$target")" || die 1 "履歴の項目を書き出せない（${n} 番目）"
      to_binary_text <"$out/layers/$layer/$path" >"$target" ||
        die 1 "履歴の項目を書き出せない（${n} 番目）"
    fi
  done <"$work/expected/pairs"
}

# 範囲の履歴を求め直し、出力先の 3 つのディレクトリを照らす（書いた側の結果は使わない）
verify_history() {
  local base="$1" head="$2" out="$3" path pair sha layer name hash matched n=0 pairs=0 nul=0
  local mismatch="取り出した履歴が元の履歴と一致しない"
  expected_history "$base" "$head" "$work/check"
  # 3 つのディレクトリのほかに項目が無く、普通のファイルとディレクトリのほかの物が無い
  [[ "$(count_found "$out" ! -type f ! -type d)" == 0 ]] || die 1 "$mismatch"
  for name in paths layers binary-text; do
    [[ -d "$out/$name" && ! -L "$out/$name" ]] || die 1 "$mismatch"
  done
  [[ "$(count_found "$out" -mindepth 1 -maxdepth 1)" == 3 ]] || die 1 "$mismatch"
  # 層のディレクトリの名前は 1 からの番号だけ
  while IFS= read -r -d '' name; do
    [[ -d "$name" && "${name##*/}" =~ ^[1-9][0-9]*$ ]] || die 1 "$mismatch"
  done < <(find "$out/layers" "$out/binary-text" -mindepth 1 -maxdepth 1 -print0)
  # paths/ は 1 から数までの通し番号だけで、中身がパスのバイト列と同じ
  while IFS= read -r -d '' path; do
    n=$((n + 1))
    [[ -f "$out/paths/$n" ]] || die 1 "$mismatch"
    printf '%s' "$path" >"$work/path"
    cmp -s -- "$work/path" "$out/paths/$n" || die 1 "$mismatch"
  done <"$work/check/paths"
  [[ "$(count_found "$out/paths" -mindepth 1)" == "$n" ]] || die 1 "$mismatch"
  # 組ごとに、その元のパスに置いたファイルの値が blob と同じ層がちょうど 1 つある
  while IFS= read -r -d '' pair; do
    pairs=$((pairs + 1))
    sha="${pair%%$'\t'*}"
    path="${pair#*$'\t'}"
    matched=""
    while IFS= read -r -d '' layer; do
      [[ -f "$layer/$path" ]] || continue
      hash="$(git hash-object --no-filters -- "$layer/$path")" || die 1 "$mismatch"
      if [[ "$hash" == "$sha" ]]; then
        [[ -z "$matched" ]] || die 1 "$mismatch"
        matched="${layer##*/}"
      fi
    done < <(find "$out/layers" -mindepth 1 -maxdepth 1 -print0)
    [[ -n "$matched" ]] || die 1 "$mismatch"
    if has_nul "$out/layers/$matched/$path"; then
      nul=$((nul + 1))
      [[ -f "$out/binary-text/$matched/$path" ]] || die 1 "$mismatch"
      git cat-file blob "$sha" | to_binary_text >"$work/text" || die 1 "$mismatch"
      cmp -s -- "$work/text" "$out/binary-text/$matched/$path" || die 1 "$mismatch"
    fi
  done <"$work/check/pairs"
  [[ "$(count_found "$out/layers" -type f)" == "$pairs" ]] || die 1 "$mismatch"
  [[ "$(count_found "$out/binary-text" -type f)" == "$nul" ]] || die 1 "$mismatch"
}

case "$action" in
  write)
    write_entries "$commit" "$out"
    verify_tree "$commit" "$out"
    ;;
  verify) verify_tree "$commit" "$out" ;;
  history)
    write_history "$base" "$head" "$out"
    verify_history "$base" "$head" "$out"
    ;;
  verify-history) verify_history "$base" "$head" "$out" ;;
esac
