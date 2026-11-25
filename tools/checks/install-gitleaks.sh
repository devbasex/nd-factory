#!/usr/bin/env bash
# gitleaks を固定の版と要約値で置く（#96 #101 の決定 4。中身は issues/issue-96-101-design-detail.md の「gitleaks を置くスクリプト」）。
# gitleaks の版と要約値を持つのは、このリポジトリでこのスクリプトだけである。ci.yml の leak-check・leak-check-push と
# leak-check-secret.yml は、それぞれのチェックアウトにあるこのスクリプトを 1 行で呼ぶ。gitleaks を上げるときは下の 2 つの定数だけを直す。
#
# 使い方: install-gitleaks.sh <置く先>
#   置く先: 配布の資産を取り、gitleaks の実行ファイルを置くディレクトリ（無ければ作る）
#   環境変数 GITHUB_PATH が空でなければ、置く先の絶対パスをそのファイルに足す（後の手順の PATH に入る）。
#   手元で使うときは GITHUB_PATH を空にして打ち、置いた先のパスを自分で使う
# 終了コード: 0 置いた、1 取得・要約値の確かめ・取り出しの失敗（要約値が合わなければ取り出す前に止まる）、2 引数の誤り
set -euo pipefail

# 版と要約値は手で上げる。要約値は配布の資産を取って sha256sum で求めた値（配布元のチェックサムのファイルと比べない）
GITLEAKS_VERSION=8.30.1
GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb

if (($# != 1)) || [[ -z "$1" ]]; then
  echo "install-gitleaks: 使い方: install-gitleaks.sh <置く先>" >&2
  exit 2
fi

mkdir -p "$1"
dir="$(cd "$1" && pwd -P)"
archive="$dir/gitleaks.tar.gz"
curl -fsSL -o "$archive" \
  "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
echo "${GITLEAKS_SHA256}  ${archive}" | sha256sum --check --strict -
tar -xzf "$archive" -C "$dir" gitleaks
rm -f "$archive"
if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$dir" >>"$GITHUB_PATH"
fi
