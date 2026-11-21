# #41: NDF との契約: 配布された NDF 11.0（v11.0.12）の契約を固定の点と全体の設計へ入れる

正は課題の本文（#41）で、この文書は設計を承認したときの写しである。今の要求は #41 の本文が正で、この写しは作り直さない。手で直さない。

## 何が起きたか

NDF 11.0 が配布された（ndf v11.0.0 が 2026-11-18、最新の v11.0.12 が 2026-11-20）。nd-factory の固定の点（`ndf-pin.json` の `ndf_ref`）は NDF 11 の前の開発の枝の点（`f37ea4c`。ndf v10.27.75 の配布の点）を指したままで、全体の設計の「NDF との契約」はその点の契約（版 4）を前提に書かれている。#1（契約の照合の検査）と #2（形の正本）の詳細設計はどちらもこの節を読むため、古い契約のまま詳細設計が始まると、ランナーと検査が古い契約の置き場・名前で作られる。

## 種類

機能追加（全体の設計が受ける NDF の契約の組と置き場を、新しい配布の契約へ変える。今の設計の約束を戻すのでなく、受ける契約そのものを差し替える）

## 今の姿

- nd-factory は NDF の契約のファイルに載るものだけで NDF とやり取りし、受ける契約の版と sha256 の組をランナーが起動の時に照らす（[実行の文書の NDF との契約](https://github.com/devbasex/nd-factory/blob/main/docs/design/execution.md#ndf-との契約)）
- 使う NDF のコミットは `ndf-pin.json` のキー `ndf_ref` の 1 か所だけに置く。今の値は `f37ea4c230cc716c61feb75fd912dc62a324e36f`
- 全体の設計は、契約の置き場を `plugins/ndf-next/contracts/`、契約の版を 4 として書いている。NDF 11 の名前（`ask-journal`・`file-journals`・`request_changes`）は既に設計に入っているが、「今の点は旧い名前を持つ」と断り書きがある

## 何を足すか・変えるか

調べ方: devbasex/ai-plugins の固定の点（`f37ea4c`）と `ndf--v11.0.12` のタグのコミット（`752a9cf48a6d36c00ffb3197c8668d1c898c32e2`）を取り、契約のディレクトリを突き合わせた（2026-11-21）。全体の設計が引く行だけを置く。

| 変わる点 | 今（固定の点 `f37ea4c`） | 変えた後（ndf v11.0.12） |
| --- | --- | --- |
| プラグインと契約の置き場 | `ndf-next` プラグイン・`plugins/ndf-next/contracts/` | `ndf` プラグイン・`plugins/ndf/contracts/` |
| 契約の版（`version.json` の `history` の最後の行） | 版 4・sha256 `e80d8578…` | 版 8・sha256 `ed8b036584bec284dfc93a2bb5b988e2385b4f8f297d659399f5d3cb91b520c4`（v11.0.0 は版 6） |
| 記録の口と ID・答えの語（#23 の改名） | `file-ledgers`・`ask-ledger`・`revise` | `file-journals`・`ask-journal`・`request_changes`（設計は既に新しい名前） |
| 設定のスキーマの口 | `spec-declarations` | `spec-ndf_settings` |
| `ndf answer` と `ndf progress` の位置引数 | `table_id`（進行表の ID） | `machine_id`（ステートマシンの ID） |
| `ndf answer` と `ndf progress` の結果の ID（`schemas/io/answer.result.schema.json`・`progress.result.schema.json`） | `metrics.table_id` | `metrics.machine_id` |
| 区間の報告の決まり（最後の `- 結果:` の行で読む規則・項目・値ごとに要る項目） | 契約のファイルに無い（NDF の手順の文書 `asking.md` だけ） | `hooks/unattended-report.json` が新しく入った（`report-unattended` の行の `source` は無い置き場 `forms/unattended-report.json` を指したまま） |
| `ask-journal` の `fields` | 無い | 無いまま |
| NDF を開発する枝 | `develop`（先端が固定の点と同じ `f37ea4c` のまま止まった） | 配布は `main` の上のタグ `ndf--v*` |

## なぜ困るか

#1 と #2 の担当者が今の全体の設計を読むと、無い置き場（`plugins/ndf-next/contracts/`）・無い口（`spec-declarations`）・無い引数（`table_id`）で照合の検査と形の正本のデータを作る。契約の照合の定期の検査（F23）は、止まった `develop` の先端を読み続け、次の配布の食い違いを予告できない。

## 目的

| MVV の項目 | この課題で受けること |
| --- | --- |
| Vision（人が差分を見て承認した範囲だけが反映される） | 配布された NDF 11.0 の契約を固定の点と全体の設計へ入れ、ランナーと検査が古い契約を前提に作られないようにする |

達成したい状態: #1 と #2 の担当者が、全体の設計の「NDF との契約」から、v11.0.12 の契約の置き場・受ける契約の組・口と引数の名前を 1 つの答えで読める。

## 対象範囲

含む:

- 全体の設計（`docs/design/execution.md`・`docs/design/overview.md`）の NDF の契約の置き場・版・名前を v11.0.12 の契約に合わせる
- `ndf-pin.json` の `ndf_ref` を ndf v11.0.12 の配布のコミットへ付け替える（版の数字は比べない）
- 受ける契約の組を `{版 8, v11.0.12 の sha256}` に直す（全体の設計の記述。形の正本のデータは #2 が作る）
- #1 から移す: NDF 11 の改名（#23）と `spec-declarations` の改名の確かめ
- 契約の照合の定期の検査（F23）が読む「NDF の先の契約」の置き場を、止まった `develop` から配布のタグを切る枝（ai-plugins の既定の枝）へ直す（全体の設計の記述。検査そのものは #1）
- `ask-journal` の `fields` が無いことへの扱いを決めて全体の設計に書く

含まない:

- 契約の照合の検査そのもの（#1）
- 受ける契約の組を形の正本のデータに置くこと（#2）
- ランナーの起動の組み立て（#6）
- 全体の設計の「進行表」の語を NDF 11 の「ステートマシン」へ言い換えること（語の揃えは #34 の範囲）
- NDF 11 の用語集の描画の形の変化（`ndf records glossary render` が文書を文脈ごとのファイルに分けて作る）への追随

## 受け入れ条件

- [ ] 1. `ndf-pin.json` の `ndf_ref` が ndf v11.0.12 の配布のコミット（`752a9cf48a6d36c00ffb3197c8668d1c898c32e2`）を指し、`ndf_ref` のキーはこのファイルの 1 か所だけにある
- [ ] 2. 全体の設計（`docs/design/` の 8 本）に `plugins/ndf-next/contracts/`・`spec-declarations`・`table_id` が残らない
- [ ] 3. 全体の設計が書く契約の版と sha256 が、v11.0.12 の `plugins/ndf/contracts/version.json` の `history` の最後の行（版 8・`ed8b0365…`）と一致する
- [ ] 4. 全体の設計の調査の行（STD62・STD63）が新しい置き場（`plugins/ndf/contracts/`）と調べた日（2026-11-21）を持つ
- [ ] 5. `ask-journal` の `fields` が無いことへの扱い（残すか起票するか）が全体の設計の「未確認のまま残ること」に書かれている
- [ ] 6. 契約の照合の定期の検査（F23）が読む先の契約が、`develop` の先端でなく配布のタグを切る枝（ai-plugins の既定の枝）の先端として全体の設計に書かれている
- [ ] 7. `npm run check` が通る（CI の `check`。参照の検査 `ref-check` も通る）

## 影響

| 対象 | 影響 |
| --- | --- |
| 公開インタフェース | 変わらない（nd-factory の API・画面・設定のファイルの形は変えない。設計が受ける NDF の契約の記述だけを変える） |
| データ | 無し（形の正本のデータは #2 が作る） |
| 既存の振る舞い | 動くコードは無い。`ndf-pin.json` を読むのは参照の検査（`tools/ref-check`）だけで、キーの数と置き場だけを見る |

## 検証手段

| 項目 | 手段 |
| --- | --- |
| テスト・静的解析・型検査 | Pull Request の CI の `check`（`npm run check`）と `ref-check`。このリポジトリはテストを CI に寄せる（`.ndf/project.json` の `test.ci.only`） |
| 手動確認（マージ前） | `git grep -nF -e 'plugins/ndf-next/contracts' -e 'spec-declarations' -e 'table_id' -- docs/design` が 0 件。`gh api -H 'Accept: application/vnd.github.raw+json' 'repos/devbasex/ai-plugins/contents/plugins/ndf/contracts/version.json?ref=752a9cf48a6d36c00ffb3197c8668d1c898c32e2' \| jq -c '.history[-1]'` が出す版と sha256 が、全体の設計の版と sha256（64 桁）と一致する（raw の形で取らないと、応答は Base64 の `content` を持つメタデータになる） |

## 前提とする取り決め

| 項目 | 参照先 / 決めたこと |
| --- | --- |
| プロジェクト構造 | `AGENTS.md` の「リポジトリの形」。`ndf_ref` は `ndf-pin.json` の 1 か所だけに置く |
| コーディング規約 | NDF の版の数字を読んで比べない（参照の検査が落とす）。インフラの実際の値と秘密を書かない |

## 起票者の推定

| # | 条件 | 推した出所 | この要求での扱い |
| --- | --- | --- | --- |
| 1 | 付け替える先は配布の最新の v11.0.12 にする | 利用者の答え（2026-11-21） | 受け入れ条件 1・3（利用者が答え済み） |
| 2 | #1 から NDF 11 の行を外してこの課題で先に流す | 利用者の答え（2026-11-21） | 対象範囲の「#1 から移す」（利用者が答え済み） |
| 3 | F23 が読む先を `develop` から配布のタグを切る枝へ直す | 要求を書くときの調べ（`develop` の先端が 2026-11-17 の `f37ea4c` のまま止まり、v11 のタグは `main` にある） | 受け入れ条件 6 |
| 4 | 「進行表」の語の言い換えと用語集の描画の形はこの課題に含めない | 要求を書くときの判断（契約の照合に要るのは `machine_id` の引数の名前だけ） | 含まない |

## リクエスト（原文）

> ai-plugins 11.0 に対応させるよう、並行開発計画を修正または新設

（書き手: 利用者、日付: 2026-11-21。出所は実行計画 `issues/execution-plan-issue-1.md` の見直しの記録）

> 利用者の答え（2026-11-21。推しのとおり v11.0.12）
>
> 利用者の答え（2026-11-21。推しのとおり）。#41 を起票し、#1 の本文から NDF 11 の行を外した

（書き手: 起票者、日付: 2026-11-21。実行計画の判断 1・2 の「答え」の欄。利用者の答えの原文はこの記録に無い）

