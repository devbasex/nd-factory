# インフラの課題（#13）の経緯

このディレクトリは、アプリのスタックへ自前の VPC・Aurora・ECS のクラスタ・費用の見張り・DB の用意の関数を足し、設置のコマンドに足りない設定の一覧を足したときの設計の記録の置き場である。常駐する計算と NAT を持たずに安く立てる既定の値と設定のキーを、どう決めたかと、その理由（設計の決定 1〜13）を残す。DB の用意を ECS のタスクから Data API を使う Lambda へ移した理由と、進行表の DB へ接続して確かめる実測を #44 へ分けた理由も、ここの設計書にある。

記録の時点は、実装を終えて確定仕様にする直前のコミット `98fafb0`（Pull Request #103 の最後から 2 つ目のコミット）である。設計を承認したときのものは、設計の Pull Request #45 にある。承認の後に、実装の単位の Pull Request で設計書と詳細設計書を直し、実装計画を足した。

課題を終えた後の設計そのものはここに無い。正は [`docs/design/`](../../design/overview.md) と、確定仕様の [app-stack-infrastructure.md](../../specifications/app-stack-infrastructure.md)・[db-prep-function.md](../../specifications/db-prep-function.md) である。ここの文書と食い違えば、`docs/design/` と確定仕様が勝つ。ここの文書は記録の時点のまま残し、後から追わない。

## 文書の一覧

| 文書 | 元のファイル（`98fafb0`） | 中身 |
| --- | --- | --- |
| [design.md](design.md) | `issues/issue-13-design.md` | 設計: 今の姿・ドメインモデル・構成要素・入出力のコントラクト・DB の用意の関数の処理の流れ・決定 1〜13（決定 11 は欠番）・影響と危険 |
| [design-detail.md](design-detail.md) | `issues/issue-13-design-detail.md` | 詳細設計: 地図と、形の正本・ネットワーク・進行表の DB・ECS のクラスタ・費用の見張り・スタックの決まりの検査・DB の用意の関数と資源・設置のコマンドの関数の仕様と単体テストの観点 |
| [survey.md](survey.md) | `issues/issue-13-design-survey.md` | 外部の調査: 調べたライブラリとサービス、確かめられなかったこと |
| [plan.md](plan.md) | `issues/issue-13-plan.md` | 実装計画: タスク分解、レビューの単位 U1〜U8 と実際の行数、リスクと対処、切り戻し手順 |
| [requirements.md](requirements.md) | `issues/issue-13-requirements.md` | 実装を終えたときの #13 の要求と受け入れ条件の写し。今の要求は #13 の本文が正で、この写しは追わない |

移した後に直したのは、移した先から辿れるようにしたリンクの飛び先と、ファイルの名前だけである。リンクの飛び先は、`../docs/design/` を `../../design/` に、`../docs/operations/` を `../../operations/` に、`./issue-13-<名前>.md` を同じディレクトリの名前に置き換えた。ファイルの名前は `issue-13-` を外し、`issue-13-design-survey.md` は `survey.md` にした。リンクの文字・見出しへの飛び先（`#…`）・中身の文は直していない。

## 関わる Pull Request

| Pull Request | 中身 |
| --- | --- |
| #45 | 設計（設計・詳細設計・外部の調査・要求の写し）。設計承認ゲートで承認した |
| #70 | U1: 形の正本にインフラの設定のキーと DB の用意の関数の形を足す |
| #72 | U2: DB の用意の関数の SQL を打つ口と CI の PostgreSQL を足す |
| #74 | U6: `app` のスタックにネットワーク・進行表の DB・ECS のクラスタ・費用の見張りを足す |
| #77 | U8: `diff` の出力の最後に足りない設定の一覧を出す |
| #81 | U3: DB の用意の手順と I10 の守りを足す |
| #83 | U4: DB の用意の関数の差し替えと古い接続の切りを足す |
| #90 | U5: DB の用意の関数の本体と秘密の版の読みと昇格を足す |
| #97 | U7: `app` のスタックに DB の用意の関数を足す |
| #103 | スプリントの main への取り込み（確定仕様への書き直しを含む） |
