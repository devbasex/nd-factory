# AGENTS.md

このリポジトリで作業する AI と人の約束である。手順の詳しい中身は `docs/operations/` にある。

## リポジトリの形

| 置き場 | 中身 |
| --- | --- |
| `packages/contracts/` | 形の正本。設定のファイル・API の経路・画面の設定の値・設置のコマンドの終了コードの形を zod で持ち、JSON Schema と見本と文書の表を作る |
| `apps/api/` | API の経路（Lambda） |
| `apps/web/` | 画面（Vite と素の TypeScript）と e2e |
| `infra/` | AWS CDK のスタック（縦の切れ端・反映のパイプライン）と設置のコマンド |
| `tools/` | 参照の検査と CI の定義のテスト |
| `docs/operations/` | 設置・設定のファイル・反映の承認・IdP のクライアントと App の作り方 |
| `docs/design/` | nd-factory の承認済みの設計（全体・画面・API と MCP・実行・土台・決定の記録・詳細設計）。入口は `overview.md`。子の課題はここを引いて詳細設計を書く |
| `docs/design-process/` | 設計を作った経緯・作り方・開発の計画（設計そのものは持たない） |
| `ndf-pin.json` | NDF の固定の値（キー `ndf_ref`）。このキーはこのファイルの 1 か所だけに置く |

## コードの決まり

- TypeScript で書き、Node 24 の型の剥がしでそのまま打つ。enum・引数のプロパティ・namespace を使わない（`erasableSyntaxOnly`）
- 形を変えるときは `packages/contracts/` を直し、`npm run generate` で生成物を作り直してコミットする。CI の `check` が生成物の古さを落とす
- 振る舞いを足すときは、先に落ちるテストを書く
- NDF の版の数字を読んで大小を比べる処理を書かない。参照の検査が落とす
- 手元の確かめは `npm run check`（lint・型検査・生成物の差・単体テスト）と `npm run e2e`

## 反映の経路

| 環境 | 経路 |
| --- | --- |
| 運用する環境 | 縦の切れ端は反映のパイプライン（起点のブランチへの push → 準備 → 人の承認 → 反映）だけで反映する。パイプラインのスタック自身は設置のコマンドで反映する（`--stack pipeline`） |
| 自分で設置する人 | 設置のコマンドで反映する。`npm run nd-setup -- diff` で差分と確認の値を見てから、`npm run nd-setup -- deploy --confirm <確認の値>` を打つ |

`cdk deploy` を設置のコマンドの外で直に打たない。`deploy` は `diff` が保存した合成の結果だけを反映し、確認の値が違えば止まる。
手順は [docs/operations/setup.md](docs/operations/setup.md) と [docs/operations/pipeline-approval.md](docs/operations/pipeline-approval.md) にある。

## 秘密とインフラの値を置かない

- 秘密の値（client secret・token・鍵）をリポジトリ・合成の出力・CI の記録・課題に置かない。秘密は秘密の器（Secrets Manager）に置き、スタックは動的な参照で読む
- インフラの実際の値（アカウント ID・資源の ID・ARN・端点）・実在の profile の名前・運用する環境の名前をリポジトリに置かない。AWS のアカウントとリージョンは profile から、ほかの環境の値はリポジトリの外の設定のファイルから受ける（[docs/operations/settings.md](docs/operations/settings.md)）
- 例・テスト・見本には作り物の値だけを使う（アカウント `123456789012`・リージョン `us-west-2`・接頭辞 `acme`・メール `ops@example.com`）
- CI は AWS の資格情報を持たない。ワークフローに資格情報を足さない（`tools/test/ci-definition.test.ts` が落とす）
- 照合の語（参照の検査が探す旧い側の名前）はリポジトリに書かない。CI の秘密 `REF_CHECK_TERMS` から受ける
