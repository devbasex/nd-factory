# このリポジトリの CI の検査（#1）の経緯

このディレクトリは、nd-factory 自体の開発の CI に、値の漏れ・設計の決まりの破れ・NDF の契約の食い違いを止める検査を足したときの設計の記録の置き場である。検査ごとに使う道具（ESLint・dependency-cruiser・gitleaks・knip・zizmor）と 2 つの自前の照らし（形の正本の往復のテスト・NDF の契約の照合）を、どう決めたかと、その理由（設計の決定 1〜10）を残す。

検査を足した後の設計そのものはここに無い。正は [`docs/design/`](../../design/overview.md) で、検査の一覧は [土台の文書の基本の検査](../../design/platform.md#基本の検査)、NDF の契約の照合は [実行の文書の契約の照合の定期の検査](../../design/execution.md#契約の照合の定期の検査) にある。規則の値の正は各道具の設定のファイル（`eslint.config.js`・`.dependency-cruiser.cjs`・`.gitleaks.toml`・`knip.jsonc`・`.github/zizmor.yml`）と `.github/workflows/` である。ここの文書と食い違えば、`docs/design/` と設定のファイルが勝つ。ここの文書は検査を足した後に追わない。

## 文書の一覧

| 文書 | 中身 |
| --- | --- |
| [design.md](design.md) | 設計: 落とす決まりごとの道具の選び方（決定 1〜10）、#2 との境目と #29・#6 へ渡す欠け、影響と危険、外部の調査 |
| [design-detail.md](design-detail.md) | 詳細設計: 地図と、道具ごとの設定・ジョブの手順・自前の照らしの関数の仕様と単体テストの観点 |
| [plan.md](plan.md) | 実装計画: 承認で足した 2 点、タスク 1〜8、レビューの単位 U1〜U6、リスクと対処 |
| [requirements.md](requirements.md) | 設計を承認したときの #1 の要求と受け入れ条件の写し。今の要求は #1 の本文が正で、この写しは追わない |

移した後に直したのは、移した先から辿れるようにしたリンクと、詳細設計の「ワークフローと宣言」の表の `tools/package.json` の行（実装で足した依存 `zod`・`zod-schema-faker`・`@faker-js/faker` を足した。地図の行とは承認の後から揃っていた）だけである。実装が設計と違う点は、スプリントの Pull Request #102 の本文の「設計と違う点」にある。

## 関わる Pull Request

| Pull Request | 中身 |
| --- | --- |
| #49 | 設計（設計・詳細設計・要求の写し）。設計承認ゲートで承認した |
| #80 | U1: CI の定義のテストをすべてのワークフローを YAML で読む形にする |
| #85 | U2: ESLint の置き場ごとの塊と骨組みのコードの除外の注釈 |
| #89 | U3: dependency-cruiser の依存の向きと knip の使っていないものの検出 |
| #91 | U4: gitleaks の漏れの検査（`leak-check`）と zizmor のワークフローの点検（`workflow-audit`） |
| #95 | U5: 形の正本の往復のテストと、合成した API Gateway の経路の照らし |
| #100 | U6: NDF の契約の照合と `ndf-contract` のワークフロー |
| #102 | スプリントの main への取り込み（この記録の移しを含む） |
