# #13 の実装計画: ネットワーク・進行表の DB・ECS のクラスタ・費用の見張り・DB の用意の関数・足りない設定の一覧

設計は [issue-13-design.md](./issue-13-design.md)、ファイルと関数の粒度は [issue-13-design-detail.md](./issue-13-design-detail.md) にある。この計画は、それをどの順でどの単位に分けて入れるかだけを決める。値と理由は設計文書を正にし、ここでは写さない。

## 前提

- スプリントブランチ `sprint/issue-13` から単位ごとにブランチ `feat/issue-13-u<番号>` を切り、単位の PR をスプリントブランチへ出す。単位の PR は `cross-review` を収束まで回してからマージする
- 設定のキーは読む構成要素と同じ変更で足す（[settings.md](../docs/operations/settings.md#キー)）。利用者へ公開する変更はスプリントの PR（`sprint/issue-13` → `main`）で、U1 の 5 つのキーと `infraValues` の読み手は U6（スタック）と U8（設置のコマンド）が同じスプリントの中で入れる。単位の PR はスプリントブランチへだけマージし、スプリントの PR は U1〜U8 がそろってから出すため、`main` ではキーと読み手が同じ変更で入る
- このリポジトリはテストを CI に寄せる（`.ndf/project.json` の `test.ci.only`）。手元では lint・型検査・生成物の作り直しだけを打ち、テストの合否は PR の CI の `check` と `synth` で読む
- 横断の部品（`packages/core`）は #2 がまだ main へ入れていない。DB の用意の関数は `pino`・`p-retry` を直に使い、そろえ方は #56 が受ける（設計文書の決定 14）
- AWS へは反映しない（`synth` と単体テストまで）。戻しの予行と実測（受け入れ条件 6・7）は、反映の承認の後に詳細設計の「実測と戻しの予行の手順」で行う

## タスク分解

| タスク | 中身 | 触るファイル（詳細設計の地図の行） |
| --- | --- | --- |
| Task 1 | 形の正本: 設定のファイルの 5 つのキーと `infraValues`、DB の用意の関数の呼び出しと終わりの形と `DB_PREP_TIMING`、生成物、`settings.md` | `packages/contracts/src/settings.ts`・`src/db-prep.ts`・`test/`・`schema/settings.schema.json`・`infra/settings.example.json`・`docs/operations/settings.md` |
| Task 2 | SQL を打つ口: `SqlExecutor` と Data API の実装（`p-retry` の再開の待ち）、テストの `pg` の実装、`scramVerifier`、`claimPrepRun`、CI の PostgreSQL 16 のサービスコンテナ | `apps/api/src/db-prep/sql-executor.ts`・`scram.ts`・`prep-run.ts`・`apps/api/test/db-prep/pg-executor.ts` と各テスト・`apps/api/package.json`・`.github/workflows/ci.yml`・`package-lock.json` |
| Task 3 | 用意の手順と I10 の守り: `claimBinding`・`checkIsolationGuard`・`provisionProject` | `apps/api/src/db-prep/provision.ts`・`apps/api/test/db-prep/provision.test.ts` |
| Task 4 | 差し替え: `rotateRole`・`terminateRoleConnections` | `apps/api/src/db-prep/rotate.ts`・`apps/api/test/db-prep/rotate.test.ts` |
| Task 5 | 関数の本体: `createDbPrepHandler`・`PrepCompletionPort`・ロガー・`readVersionPassword`・`promoteVersion`・起点の `handler` | `apps/api/src/db-prep/handler.ts`・`secret-version.ts`・`apps/api/src/entries/db-prep.ts` と各テスト |
| Task 6 | インフラの資源: `Network`・`ProgressDb`・`TaskPlatform`・`CostWatch`・`AppStack` の組み立てと AZ・利用者の表の PITR・スタックの決まりの検査と Aurora の許し | `infra/lib/network.ts`・`progress-db.ts`・`tasks.ts`・`cost-watch.ts`・`app-stack.ts`・`naming.ts`・`infra/test/support.ts`・`app-stack.test.ts`・`stack-rules.test.ts`・`naming.test.ts` |
| Task 7 | DB の用意の関数の資源: `DbPrepFunction` と `grantCompletionAccess`、`AppStack` への組み込み | `infra/lib/db-prep-function.ts`・`app-stack.ts`・`infra/test/db-prep-function.test.ts` |
| Task 8 | 足りない設定の一覧: `MISSING_CHECKS`・`collectMissingSettings`・`printMissingSettings`、AWS の読み手 3 つ、`runDiff` の足し | `infra/setup/missing-settings.ts`・`aws-reader.ts`・`nd-setup.ts`・`infra/test/missing-settings.test.ts`・`aws-reader.test.ts`・`nd-setup.test.ts`・`infra/package.json` |

依存の向き: Task 1 がほかのすべての前にある。Task 2 → 3 → 4 → 5 は SQL の口と手順の順で積む。Task 6 と Task 8 は Task 1 だけに依る。Task 7 は Task 5（起点のファイル）と Task 6（`ProgressDb`）の後に置く。`NodejsFunction` は合成のときに起点を束ねるため、起点の無いまま資源を足すと `synth` が落ちるからである。

## レビューの単位

行数は追加と削除の和で、`git diff --shortstat sprint/issue-13...HEAD -- . ':(exclude)package-lock.json' ':(exclude)packages/contracts/schema' ':(exclude)infra/settings.example.json'` で数える。

| 単位 | 含むタスク | 満たす受け入れ条件 | 見込みの差分の行数 | 実際の行数 |
| --- | --- | --- | --- | --- |
| U1 形の正本（準備） | Task 1 | 13:4・13:5 の前提（キーの形） | 約 350 | 524（#70） |
| U2 SQL を打つ口 | Task 2 | 13:9 の一部（Data API の実装と時間の関係） | 約 700 | 1,250。本体は約 250 行で、残りはテストとテストの `pg` の実装。テストどうしが `pg-executor.ts` と `claimPrepRun` を共有し、分けると単位が単独で読めないため分けなかった |
| U3 用意の手順と I10 | Task 3 | 13:1 | 約 700 | |
| U4 差し替え | Task 4 | 13:9 の一部（差し替え） | 約 600 | |
| U5 関数の本体 | Task 5 | 13:9 の一部（関数の分かれ） | 約 700 | |
| U6 インフラの資源 | Task 6 | 13:2・13:3・13:4 | 約 900 | |
| U7 DB の用意の関数の資源 | Task 7 | 13:9 の一部（資源）・13:4 | 約 300 | |
| U8 足りない設定の一覧 | Task 8 | 13:5 | 約 600 | |

流す順: U1 をスプリントブランチへマージしてから、U2 → U3 → U4 → U5 と U6・U8 を進め、U5 と U6 のマージの後に U7 を流す。受け入れ条件 6・7 は反映の後の手動確認で、どの単位にも入れない。8・10 は設計 PR #45 で満たした。

## リファクタリングの時機

| 時機 | 対象 | 理由 |
| --- | --- | --- |
| 実装の前（準備のリファクタリング） | しない | 触る既存のファイルは `app-stack.ts`（175 行）・`support.ts`（126 行）・`nd-setup.ts`（430 行）・`aws-reader.ts`（71 行）・`settings.ts`（69 行）で、どれも足す箇所が局所に収まる。新設のファイルが大半である |
| 実装の中 | 各タスクで行う | `tdd-cycle` のリファクタリングのステップ |
| スプリントの終わり（cross-refactoring） | `provision.ts` と `rotate.ts` の排他の鎖と識別子の組み立て、`app-stack.ts` の 5 つの部品の組み立て | 同じ形の SQL の組み立てと、単位をまたいで `app-stack.ts` を触るため |

## リスクと対処

| リスク | 対処 |
| --- | --- |
| PostgreSQL のテストを手元で走らせないため、CI でだけ落ちる | 単位の PR を最初のコミットの後に Draft で出し、CI の `check` を監視して直す |
| `NodejsFunction` の束ねで `pg` などの依存が合成に入る | 本番は `pg` の `escapeIdentifier`・`escapeLiteral` だけを使うため `pg` を dependencies に置き（`@types/pg` は devDependencies）、接続の部品はテストの `pg-executor.ts` だけが使う。束ねの大きさは U7 の `synth` で読む |
| #2 が後から横断の部品を入れ、ログと再試行が 2 か所に分かれる | #56 が寄せる。この課題は `db-prep/` の中で閉じる |

## 切り戻し手順

- どの単位も AWS へ反映しないため、戻しはスプリントブランチのコミットの取り消しで済む。データの移行は無い

## 完了の定義

- [ ] 受け入れ条件 1〜5・9 を CI の `check` と `synth` で照らし、6・7 は反映の後の手順を承認資料に挙げた
- [ ] すべての単位の PR を `cross-review` で収束させてスプリントブランチへマージした
- [ ] スプリントの Pull Request（`sprint/issue-13` → `main`）のレビューが収束した
