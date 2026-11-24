## 何が起きたか

2026-11-21、インフラの課題（自前の VPC・Aurora・ECS をアプリのスタックへ足す。 https://github.com/devbasex/nd-factory/issues/13 ）の仕上げの振り返りで、その課題の設計の記録（要求のコピー・設計書・詳細設計書・外部の調査・実装計画）が main のどこにも無いと分かった。記録は作業中は `issues/` に置いていたが、確定仕様にする Pull Request（ https://github.com/devbasex/nd-factory/pull/103 ）が `issues/` から消し、main へは squash でマージした。そのため記録はスプリントのブランチのコミットにだけ残り、そのブランチ（`sprint/issue-13`）は削除済みである。

2026-11-24 の main（`fa6aa1b`）でも、`git ls-tree origin/main docs/design-process/` は `issue-1`・`issue-24`・`issue-32`・`issue-41` だけを返し、`git ls-tree -r origin/main | grep issue-13` は 0 件である。

## 種類

機能追加（設計の経緯を残すディレクトリ（`docs/design-process/`）は既にあり、ほかの 4 つの課題の記録が並ぶ。そこへ #13 の記録を足す）

## 今の姿

`docs/design-process/` は、設計を作った経緯を課題ごとに残すディレクトリである（[AGENTS.md の「リポジトリの形」](https://github.com/devbasex/nd-factory/blob/main/AGENTS.md) ）。課題ごとのディレクトリに、要求のコピー・設計書などの記録と README を置く。README は、何の記録か、記録を後から追わないこと、今の設計の正の保存先を書く（例: [docs/design-process/issue-1/README.md](https://github.com/devbasex/nd-factory/blob/main/docs/design-process/issue-1/README.md) 。CI の検査を足した課題 https://github.com/devbasex/nd-factory/issues/1 の記録で、実装計画も含む）。

#13 の今の設計の正は、全体の設計（`docs/design/`）と、2 本の確定仕様（[docs/specifications/app-stack-infrastructure.md](https://github.com/devbasex/nd-factory/blob/main/docs/specifications/app-stack-infrastructure.md) ・ [docs/specifications/db-prep-function.md](https://github.com/devbasex/nd-factory/blob/main/docs/specifications/db-prep-function.md) ）にある。

#13 の記録は、次の 2 つのコミットにだけある。どちらも GitHub の Pull Request #103 の参照（`refs/pull/103/head`）から取れる。

| 時点 | コミット | 入っている記録 |
| --- | --- | --- |
| 設計を承認したとき（設計の Pull Request https://github.com/devbasex/nd-factory/pull/45 をスプリントのブランチへマージした） | `166b2f2` | 要求のコピー・設計書・詳細設計書・外部の調査の 4 本 |
| 実装を終え、確定仕様にする直前（Pull Request #103 の最後から 2 つ目のコミット） | `98fafb0` | 上の 4 本と実装計画の 5 本。設計書（41 行）と詳細設計書（69 行）は、承認の後に実装の単位の Pull Request で直したもの |

## 何を足すか・変えるか

| | 今 | 足した後 |
| --- | --- | --- |
| #13 の設計の記録 | main に無い。削除したブランチのコミットにだけある | `docs/design-process/issue-13/` に 5 本ある |
| README | 無い | 記録の時点・今の正の保存先・文書の一覧・関わる Pull Request を書く |
| 記録の中のリンク | `issues/` に置いていたときの場所を前提にした相対リンク | 移した先から開ける |

## なぜ困るか

#13 の判断を引き継ぐ課題の設計を書く人と AI が、判断の経緯を読めない。引き継ぐ課題は、進行テーブルの DB へ接続する実測（ https://github.com/devbasex/nd-factory/issues/44 ）と、ランナー（ https://github.com/devbasex/nd-factory/issues/6 ）である。読めない経緯には、DB の用意を ECS のタスクから Data API を使う Lambda へ移した理由と、接続する実測を #44 へ分けた理由がある。git のコミットと Pull Request の参照を知らない読み手は、記録へ辿り着けない。

## 目的

#13 の設計の経緯を、ほかの課題と同じディレクトリで、main から読めるようにする。根拠: MVV の Value 10（同じ事実を 2 か所に持たない。履歴を残す事実は追記だけで持つ。MVV バージョン 3）。

## 対象範囲

含む:

- `98fafb0` の 5 本を、`docs/design-process/issue-13/` へ次の名前でコピーする

  | 元（`98fafb0`） | 移した先 |
  | --- | --- |
  | `issues/issue-13-requirements.md` | `requirements.md` |
  | `issues/issue-13-design.md` | `design.md` |
  | `issues/issue-13-design-detail.md` | `design-detail.md` |
  | `issues/issue-13-design-survey.md` | `survey.md` |
  | `issues/issue-13-plan.md` | `plan.md` |

- `docs/design-process/issue-1/README.md` と同じ形の README（何の記録か・今の正の保存先・文書の一覧・移した後に直したこと・関わる Pull Request）
- 移した先から開けるように、記録の中の相対リンクを直す（`../docs/design/…` を `../../design/…` に、`./issue-13-design.md` を `design.md` に、など）

含まない:

- 記録の中身を、今の設計に合わせて書き直すこと（直すのはリンクだけ）
- リンクの見出しへの飛び先（`#…`）を、今の設計書の見出しに合わせ直すこと。飛び先は記録の時点のものとして残す
- 記録の中の、用語集で使わないと決めた語の言い換え（`docs/design-process/` は用語集の禁止語の検査から外してある。`.ndf/glossary.json` の `check.banned.exclude`）
- 全体の設計（`docs/design/`）と確定仕様（`docs/specifications/`）の変更
- 承認したときのもの（`166b2f2`）の設計書と詳細設計書を別のファイルとして残すこと。README から設計の Pull Request #45 で辿れるようにする

## 前提

- 前提 1: `166b2f2` と `98fafb0` は、GitHub の Pull Request #103 の参照（`refs/pull/103/head`）から取れる（2026-11-24 に `git fetch origin refs/pull/103/head` で取り、`166b2f2` がその祖先であることを `git merge-base --is-ancestor` で確認した）

## 受け入れ条件

- [ ] 1. `docs/design-process/issue-13/` に、`requirements.md`・`design.md`・`design-detail.md`・`survey.md`・`plan.md`・`README.md` の 6 本がある
- [ ] 2. 5 本の記録は、`98fafb0` の元のファイルと比べて、違う行がリンクを含む行だけである
- [ ] 3. 移した 5 本と README の相対リンクは、どれも指す先のファイルが在る（見出しへの飛び先は問わない）
- [ ] 4. README が、記録の時点（実装を終えて確定仕様にする直前のコミット `98fafb0`）と、承認したときのものが設計の Pull Request #45 にあることを書く
- [ ] 5. README が、この記録を後から追わないことと、今の正の保存先（`docs/design/` と、確定仕様の `app-stack-infrastructure.md`・`db-prep-function.md`）と、食い違えば正の側が勝つことを書く
- [ ] 6. README が、5 本の記録それぞれの中身と、関わる Pull Request（設計の #45、実装の単位の Pull Request、main へ取り込んだ #103）を表で書く
- [ ] 7. CI の `check`・`ref-check`・`leak-check` のジョブが通る
- [ ] 8. 変更が `docs/design-process/issue-13/` の中だけにあり、`docs/design/` と `docs/specifications/` は変わらない（退行しない）

## 影響

| 対象 | 影響 |
| --- | --- |
| 公開インタフェース | 変わらない |
| データ | 無い（文書のファイルを足すだけ） |
| 既存の振る舞い | 変わらない。全体の設計と確定仕様の中身は変えない |

## 検証手段

| 項目 | 手段 |
| --- | --- |
| テスト | CI の `check`（`npm run check`: lint・型検査・生成物の差・単体テスト）・`ref-check`・`leak-check`。このリポジトリはテストを CI に寄せる（`.ndf/project.json` の `test.ci.only`） |
| 記録の中身（受け入れ条件 2） | `git show 98fafb0:issues/issue-13-design.md \| diff - docs/design-process/issue-13/design.md` を 5 本で打ち、違う行がリンクを含む行だけであることを読む |
| リンク（受け入れ条件 3） | 6 本から `](` で始まる相対リンクを抜き出し、`#` より前のパスを各ファイルのディレクトリから `test -e` で引く。在らないものが 0 件 |
| 変更の範囲（受け入れ条件 8） | `git diff --name-only origin/main...HEAD` が `docs/design-process/issue-13/` の 6 本だけを返す |
| 手動確認（マージ前） | 設計承認ゲートで、承認する人が README を読み、記録の時点と今の正の保存先が分かることを見る |

## 前提とする取り決め

| 項目 | 参照先 / 決めたこと |
| --- | --- |
| プロジェクト構造 | `AGENTS.md` の「リポジトリの形」。設計の経緯は `docs/design-process/` に置き、設計そのものは持たない |
| コーディング規約 | ディレクトリとファイル名は、ほかの課題の記録（`docs/design-process/issue-1/`・`issue-41/`）と同じ形にする |

## 起票者の推定

| # | 条件 | 推した出所 | この要求での扱い |
| --- | --- | --- | --- |
| S1 | ディレクトリとファイル名を #41 の形（`docs/design-process/issue-41/`）に揃える | コミット `32e2739` と #39 | 受け入れ条件 1。実装計画を含む直近の #1 の形（`docs/design-process/issue-1/`）にも揃える |
| S2 | 外部の調査（survey）を記録に含める | Pull Request #45 の変更したファイルの一覧 | 受け入れ条件 1 |
| S3 | 移す元を `166b2f2`（設計を承認したとき）の 4 本にする | 起票の本文の「対象範囲」 | 採らない。`98fafb0` の 5 本にする（設計者の判断。設計承認ゲートで確認する）。理由: `166b2f2` の後に設計書 41 行と詳細設計書 69 行を直し、実装計画を足した（`git diff --stat 166b2f2 98fafb0 -- 'issues/issue-13-*'`）。承認したときのものだけを移すと、実装で決め直した点が main から辿れないまま残る。直近の #1 の記録は実装計画を含む。承認したときのものは、README から設計の Pull Request #45 で辿れる（受け入れ条件 4） |
| S4 | README は「承認した時点のコピー」と書く | 起票の本文の受け入れ条件 2 | 受け入れ条件 4・5。移す元を S3 のとおりにしたため、記録の時点は「実装を終えて確定仕様にする直前」と書く |
| S5 | 課題の種類を「運用」にする | 起票の本文の「種類」 | 採らない。課題のラベルは `enhancement`（機能）で、既にあるディレクトリへ記録を足すため、変更の種類は機能追加にする |
| S6 | CI の `check` と `ref-check` で、リンク切れと作り物でない値を見つける | 起票の本文の受け入れ条件 3 | 受け入れ条件 3・7。CI にリンクを調べるジョブは無く（`.github/workflows/ci.yml` のジョブは `check`・`synth`・`ref-check`・`leak-check`・`workflow-audit`）、値の漏れは `leak-check` が見る。そのため、リンクは検証手段の手で、値は `leak-check` で見る |

## リクエスト（原文）

利用者が会話で書いた指示の原文は無い。起票者（#13 の仕上げの振り返りを書いた AI）が 2026-11-21 に書いた本文を引用する。

<details>
<summary>起票の本文</summary>

> ## 種類
>
> 運用（設計の記録の置き場の整理）
>
> ## 目的
>
> #13 の設計の記録（要求・設計・詳細設計・調査）が main から辿れない。#24・#32・#41 の記録は `docs/design-process/issue-<番号>/` に移してあり、設計の判断の経緯を後から読める。#13 だけは、PR #103 の確定仕様化で `issues/` から消え、残っているのは PR #45 のマージのコミット `166b2f2`（`sprint/issue-13` へのマージ）の中だけである。`sprint/issue-13` は片付け済みのため、git の履歴を知らない読み手は辿れない。
>
> 移すと、#44（接続する実測）と #6（ランナー）が #13 の判断（DB の用意を Data API の関数へ移した理由・接続の実測を分けた理由など）を、他の課題と同じ置き場で読める。
>
> ## 影響
>
> #13 の設計の経緯を読みたい人と AI（#44・#6 の設計を書く側）。確定仕様（`docs/specifications/app-stack-infrastructure.md`・`db-prep-function.md`）と全体の設計（`docs/design/`）の中身は変わらない。
>
> ## 対象範囲
>
> 含む:
>
> - `166b2f2` の `issues/issue-13-requirements.md`・`issue-13-design.md`・`issue-13-design-detail.md`・`issue-13-design-survey.md` を `docs/design-process/issue-13/` の `requirements.md`・`design.md`・`design-detail.md`・`survey.md` へ写す
> - `docs/design-process/issue-41/README.md` と同じ形の README（付け替えた後の設計の正は `docs/design/` と `docs/specifications/` で、この記録は追わない）
> - 移した先から辿れるようにリンクを直す
>
> 含まない:
>
> - 記録の中身を今の設計に合わせて書き直すこと
>
> ## 受け入れ条件
>
> - [ ] 1. `docs/design-process/issue-13/` に 4 本の記録と README がある
> - [ ] 2. README が、この記録は承認した時点の写しで追わないこと、今の正の置き場（`docs/design/`・`docs/specifications/` の 2 本）を書く
> - [ ] 3. CI の `check` と `ref-check` が通る（リンクが切れていない・作り物でない値が無い）
>
> ## 起票者の推定
>
> - 置き場とファイル名を #41 の形（`docs/design-process/issue-41/`）に揃える（推した出所: コミット `32e2739` と #39）
> - survey を記録に含める（推した出所: PR #45 の変更したファイルの一覧）
>
> ## 由来
>
> issue #13 / PR #103。#13 の仕上げのフェーズの振り返りで、`git ls-tree origin/main docs/design-process/` が `issue-24`・`issue-32`・`issue-41` だけを返し、`issue-13` の記録が main のどこにも無いと分かった（`git ls-tree -r origin/main | grep issue-13` が 0 件）。#13 の受け入れ条件 1〜10 と対象範囲は設計の記録の置き場を含まず、PR #103 はマージ済みのため範囲外とした。根拠: MVV の Value 10（同じ事実を 2 か所に持たない。履歴を残す事実を追記で持つ）。MVV バージョン 3。

</details>

（書き手: 起票者、日付: 2026-11-21）
