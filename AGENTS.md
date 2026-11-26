# AGENTS.md

このリポジトリで作業する AI と人の約束である。手順の詳しい中身は `docs/operations/` にある。

## リポジトリの形

| 置き場 | 中身 |
| --- | --- |
| `packages/contracts/` | 形の正本。設定のファイル・API の経路・画面の設定の値・設置のコマンドの終了コードの形を zod で持ち、JSON Schema と見本と文書の表を作る |
| `packages/core/` | 横断の部品（時計・ID・伏せ字・ログなど）。`packages/contracts/` だけに依存し、`apps/*` が使う。画面が使うモジュールは `node:` の組み込みを読まない。中身は [詳細設計](docs/design/detail.md) |
| `apps/api/` | API の経路（Lambda） |
| `apps/web/` | 画面（React と TypeScript、Vite で束ねる）と e2e |
| `infra/` | AWS CDK のスタック（アプリのスタック・反映のパイプライン）と設置のコマンド |
| `tools/` | 参照の検査と CI の定義のテスト |
| `docs/operations/` | 設置・設定のファイル・反映の承認・IdP のクライアントと App の作り方 |
| `docs/design/` | nd-factory の承認済みの設計（全体・画面・API と MCP・実行・プラットフォーム・決定の記録・詳細設計）。入口は `overview.md`。子の課題はここを引いて詳細設計を書く |
| `docs/design-process/` | 設計を作った経緯・作り方・開発の計画（設計そのものは持たない） |
| `docs/specifications/` | 実装した機能の確定仕様（今のコードと一致する仕様。課題の設計と実装計画を、実装の後にここへ書き直す） |
| `ndf-pin.json` | NDF の固定の値（キー `ndf_ref`）。このキーはこのファイルの 1 か所だけに置く |

## 開発の指針

進め方・判断の基準・書き方の指針は、プロジェクト Skill [`nd-factory-dev-guidelines`](.claude/skills/nd-factory-dev-guidelines/SKILL.md) にある。設計・レビュー・承認を求めるとき・文書を書くときに読む。AI のメモリと引継ぎ文書には指針を書かず、この Skill か設計書か `.ndf/` に書く。

## コードの決まり

- 言語・画面の組み方・TypeScript の書き方・テストの置き方・NDF の版の扱いの細則は、[プラットフォームの文書の言語と書き方の決まり](docs/design/platform.md#言語と書き方の決まり) に従う
- 形を変えるときは `packages/contracts/` を直し、`npm run generate` で生成物を作り直してコミットする。CI の `check` が生成物の古さを落とす
- 手元の確かめは `npm run check`（lint・型検査・生成物の差・単体テスト）と `npm run e2e`

## 反映の経路

| 環境 | 経路 |
| --- | --- |
| 運用する環境 | アプリのスタックは反映のパイプライン（起点のブランチへの push → 準備 → 反映。人の承認の段は持たない）だけで反映する。パイプラインのスタック自身は設置のコマンドで反映する（`--stack pipeline`） |
| 自分で設置する人 | 設置のコマンドで反映する。`npm run nd-setup -- diff` で差分と確認の値を見てから、`npm run nd-setup -- deploy --confirm <確認の値>` を打つ |

`cdk deploy` を設置のコマンドの外で直に打たない。`deploy` は `diff` が保存した合成の結果だけを反映し、確認の値が違えば止まる。
手順は [docs/operations/setup.md](docs/operations/setup.md) と [docs/operations/pipeline-approval.md](docs/operations/pipeline-approval.md) にある。

## 秘密とインフラの値を置かない

- 秘密の値（client secret・token・鍵）をリポジトリ・合成の出力・CI の記録・課題に置かない。秘密は秘密の器（Secrets Manager）に置き、スタックは動的な参照で読む
- インフラの実際の値（アカウント ID・資源の ID・ARN・端点）・実在の profile の名前・運用する環境の名前をリポジトリに置かない。AWS のアカウントとリージョンは profile から、ほかの環境の値はリポジトリの外の設定のファイルから受ける（[docs/operations/settings.md](docs/operations/settings.md)）
- 例・テスト・見本には作り物の値だけを使う（アカウント `123456789012`・リージョン `us-west-2`・接頭辞 `acme`・メール `ops@example.com`）
- S3 の置き場の名前と端点の例には `acme` を使わず（実在の名前になり得る）、`amzn-s3-demo-bucket` の形か置き換え記号（`<名前>`・`${名前}`）を使う。ARN の例は、資源の欄を置き換え記号にするか、`.gitleaks.toml` の一覧にあるものを使う。理由と許す形は [漏れの検査の仕様](docs/specifications/leak-check.md) にある
- CI は AWS の資格情報を持たない。ワークフローに資格情報を足さない（`tools/test/ci-definition.test.ts` が落とす）
- 照合の語（参照の検査が探す旧い側の名前）はリポジトリに書かない。CI の秘密 `REF_CHECK_TERMS` から受ける
- 実際の値（アカウント・profile・環境の名前）を探す正規表現はリポジトリに書かない。秘密 `LEAK_CHECK_PATTERN` から受け、Pull Request は NDF のマージの直前に検査用の非公開リポジトリで、main への push は環境 `leak-scan` を持つ `leak-check-push` で、`.gitleaks.toml` に重ねて探す（[docs/operations/ci-checks.md](docs/operations/ci-checks.md)）。gitleaks の当たりは値の行の `gitleaks:allow` と `.gitleaksignore` では外せない。正当な当たりは当てた規則の `[[rules.allowlists]]`（`.gitleaks.toml` か `tools/checks/gitleaks-default.toml`）に理由を添えて足す。許可は、対象を含む Pull Request より先に、許可の変更だけの Pull Request で main へ入れる（[docs/operations/ci-checks.md](docs/operations/ci-checks.md) の「正当な当たりを規則単位で外す」）
