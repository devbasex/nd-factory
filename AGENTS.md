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
| `docs/design/rebuild/` | 作り直しの承認済みの設計（判定の規則・機能の対応表・全体の設計）。子の課題はここを引いて詳細設計を書く |
| `ndf-pin.json` | NDF の固定の値（キー `ndf_ref`）。このキーはこのファイルの 1 か所だけに置く |

## コードの決まり

- TypeScript で書き、Node 24 の型の剥がしでそのまま打つ。enum・引数のプロパティ・namespace を使わない（`erasableSyntaxOnly`）
- 形を変えるときは `packages/contracts/` を直し、`npm run generate` で生成物を作り直してコミットする。CI の `check` が生成物の古さを落とす
- 振る舞いを足すときは、先に落ちるテストを書く
- NDF の版の数字を読んで大小を比べる処理を書かない。参照の検査が落とす
- 手元の確かめは `npm run check`（lint・型検査・生成物の差・単体テスト）と `npm run e2e`

## 承認ゲート

人が行うのは、NDF の 2 つの承認ゲートでの承認だけである。承認の後の実行は AI が行う。AI は承認を自分で送らない。

| 承認ゲート | 何を承認するか | 承認の受け方 |
| --- | --- | --- |
| 設計承認 | 設計の PR の中身（この設計で実装へ進んでよいか） | AI が `AskUserQuestion` で問い、承認の後に AI が設計の PR をマージする |
| リリース承認 | 運用する環境へ届く変更の差分 | 下の表のとおり |

リリース承認の対象と、承認の後に AI が行うこと:

| 対象 | 承認の受け方と実行 |
| --- | --- |
| 設置のコマンドの `deploy`（パイプラインのスタック・共有の CDK の bootstrap を上げる操作を含む） | AI が `diff` の差分を示して問い、承認の後に AI が `deploy --confirm <確認の値>` を打つ |
| 縦の切れ端の反映 | 反映のパイプラインの承認のアクションで人が承認する。これがリリース承認そのものである。AI の主体は承認を送れない（承認を拒む方針を付ける）。パイプラインの開始は AI が行う |
| 承認を拒む方針を AI の主体へ付ける・ブランチ保護とルールセットの変更・秘密の器への値の投入 | AI が変更の中身を示して問い、承認の後に AI が API で行う。秘密の値は AI が読まずに器へ渡す |

人の手が残るのは、API が無く AI が実行できない操作だけである。今は次の 2 つがこれに当たる。Google の OAuth クライアントの作成（Google Auth Platform のコンソールでだけ作れる）と、GitHub との接続の有効化（`PENDING` の接続を使える状態にし、AWS の接続の App を組織へ入れる操作は、AWS のコンソールと GitHub の画面でだけ行える）。人の手を頼むときは、その理由を書く。AI の主体の権限が足りずに実行できないときは、人に打たせず、権限を足すことをリリース承認の対象にする。

## 反映の経路

| 環境 | 経路 |
| --- | --- |
| 運用する環境 | 縦の切れ端は反映のパイプライン（起点のブランチへの push → 準備 → 人の承認 → 反映）だけで反映する。パイプラインのスタック自身は設置のコマンドで反映する（`--stack pipeline`） |
| 自分で設置する人 | 設置のコマンドで反映する。`npm run nd-setup -- diff` で差分と確認の値を見てから、`npm run nd-setup -- deploy --confirm <確認の値>` を打つ |

`cdk deploy` を設置のコマンドの外で直に打たない。`deploy` は `diff` が保存した合成の結果だけを反映し、確認の値が違えば止まる。
手順は [docs/operations/setup.md](docs/operations/setup.md) と [docs/operations/pipeline-approval.md](docs/operations/pipeline-approval.md) にある。

## 秘密とインフラの値を置かない

- 秘密の値（client secret・token・鍵）をリポジトリ・合成の出力・CI の記録・課題に置かない。秘密は秘密の器（Secrets Manager）へリリース承認の後に AI が入れ（値は AI が読まずに渡す）、スタックは動的な参照で読む
- インフラの実際の値（アカウント ID・資源の ID・ARN・端点）・実在の profile の名前・運用する環境の名前をリポジトリに置かない。AWS のアカウントとリージョンは profile から、ほかの環境の値はリポジトリの外の設定のファイルから受ける（[docs/operations/settings.md](docs/operations/settings.md)）
- 例・テスト・見本には作り物の値だけを使う（アカウント `123456789012`・リージョン `us-west-2`・接頭辞 `acme`・メール `ops@example.com`）
- CI は AWS の資格情報を持たない。ワークフローに資格情報を足さない（`tools/test/ci-definition.test.ts` が落とす）
- 照合の語（参照の検査が探す旧い側の名前）はリポジトリに書かない。CI の秘密 `REF_CHECK_TERMS` から受ける
