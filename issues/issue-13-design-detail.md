# #13 の詳細設計: ネットワーク・進行表の DB・ECS のクラスタ・費用の見張り・DB の用意の関数・設置のコマンドの足し

設計文書 [issue-13-design.md](./issue-13-design.md) の構成要素を、ファイルと関数の粒度へ下ろした文書である。新設する関数が 2 つ以上あるため別のファイルにした。値の理由は設計文書の決定にあり、ここでは繰り返さない。ソースのコメントや型で読める情報は写さない。

## 地図

触るファイル（`*` は新設）:

```text
packages/contracts/
├── src/settings.ts
├── src/db-prep.ts              *
├── test/settings.test.ts
├── test/db-prep.test.ts        *
└── schema/settings.schema.json （生成物）
infra/
├── settings.example.json       （生成物）
├── lib/app-stack.ts
├── lib/naming.ts
├── lib/network.ts              *
├── lib/progress-db.ts          *
├── lib/tasks.ts                *
├── lib/db-prep-function.ts     *
├── lib/cost-watch.ts           *
├── setup/nd-setup.ts
├── setup/aws-reader.ts
├── setup/missing-settings.ts   *
└── test/（support.ts・app-stack・stack-rules*・db-prep-function*・naming・nd-setup・missing-settings*）
apps/api/
├── package.json
├── src/entries/db-prep.ts      *
├── src/db-prep/                *
│   └── handler.ts・sql-executor.ts・secret-version.ts・prep-run.ts・scram.ts・provision.ts・rotate.ts
└── test/db-prep/               *
    └── pg-executor.ts・sql-executor.test.ts・secret-version.test.ts・prep-run.test.ts・scram.test.ts・handler.test.ts・provision.test.ts・rotate.test.ts
docs/operations/settings.md
.github/workflows/ci.yml
package-lock.json
```

依存の向き: `packages/contracts` ← `infra`・`apps/api` の一方向で、`infra` と `apps/api` は互いを import しない。`infra/lib/db-prep-function.ts` は `apps/api/src/entries/db-prep.ts` を `NodejsFunction` の起点のパスとして指すだけで、コードを import しない（今の API の関数と同じ形。[全体の詳細設計の依存の表](../docs/design/detail.md#クラスと関数の構造) の `infra` から `apps/*` への import の禁止に合う）。置き場は [全体の詳細設計の受け持つ子の課題](../docs/design/detail.md#受け持つ子の課題) の「`apps/api/src/entries/db-prep.ts`・`apps/api/src/db-prep/`」に合わせる。`db-prep/` は `packages/contracts` だけに依り、`modules/` を import しない。`db-prep/` を import するのは `entries/db-prep.ts` だけで、境界の検査（全体の設計の決定 91）の対象に入る（直に使う AWS SDK のクライアント・`pino`・`p-retry` は、検査を CI に載せる前に #56 が横断の部品へ寄せる）。

| パス | 種類 | 役割 1 文 | 依存する先 | クラスまたはモジュール | メソッドと最上位の関数 |
| --- | --- | --- | --- | --- | --- |
| `packages/contracts/src/settings.ts` | 変更 | 設定のファイルの形に 5 つのキーを足し、既定を解く | zod | モジュール | `settingsSchema`（変更）・`infraValues`（新設） |
| `packages/contracts/src/db-prep.ts` | 新設 | DB の用意の関数の呼び出しの値と終わりの結果の形 | zod | モジュール | `dbPrepInvocation`・`dbPrepOutcome`・`PROGRESS_DB_IDENT_SHAPE`・`DB_PREP_FAILURE_REASONS`・`DB_PREP_TIMING` |
| `infra/lib/naming.ts` | 変更 | 足す資源の名前（DB の用意の関数 `<prefix>-<environment>-db-prep` を含む） | — | モジュール | `appResourceNames`（変更） |
| `infra/lib/network.ts` | 新設 | VPC・サブネット・エンドポイント・SG | aws-cdk-lib | `Network` | `constructor`・`subnetMask` |
| `infra/lib/progress-db.ts` | 新設 | Aurora のクラスタ（Data API を有効）と管理の役割の秘密の器 | aws-cdk-lib・`Network` | `ProgressDb` | `constructor` |
| `infra/lib/tasks.ts` | 新設 | ECS のクラスタ・実行の役割・文を持たないタスクの役割・ログの群 | aws-cdk-lib・`Network` | `TaskPlatform` | `constructor`・`RUNNER_TASK_SIZE`・`RUN_TASK_PROPAGATE_TAGS` |
| `infra/lib/db-prep-function.ts` | 新設 | DB の用意の関数の Lambda と、その役割の権限 | aws-cdk-lib・`ProgressDb` | `DbPrepFunction` | `constructor`・`DB_PREP_ENTRY` |
| `infra/lib/cost-watch.ts` | 新設 | 運用の知らせのトピックと月の予算 | aws-cdk-lib | `CostWatch` | `constructor` |
| `infra/lib/app-stack.ts` | 変更 | 5 つの部品を組み、AZ を `Fn::GetAZs` から返し、利用者の表に PITR を付ける | 上の 5 つ | `AppStack` | `availabilityZones`（新設の getter）・`constructor`（変更） |
| `infra/setup/missing-settings.ts` | 新設 | 足りない設定の一覧を集めて出す | `aws-reader` | モジュール | `MISSING_CHECKS`・`collectMissingSettings`・`printMissingSettings` |
| `infra/setup/aws-reader.ts` | 変更 | コスト配分タグ・組織・AZ を読む | AWS SDK（Cost Explorer・Organizations・EC2） | モジュール | `readCostAllocationTags`・`readOrganizationManager`・`readGetAzsCount`（新設） |
| `infra/setup/nd-setup.ts` | 変更 | `diff` の最後に足りない設定の一覧を出す | 上の 2 つ | モジュール | `runDiff`・`defaultDeps`（変更） |
| `infra/test/support.ts` | 変更 | スタックの決まりの検査 | — | モジュール | `stackRuleViolations`（新設）・`hourlyCostResources`（変更） |
| `apps/api/package.json` | 変更 | DB の用意の関数の依存を足す（`@aws-sdk/client-rds-data`・`@aws-sdk/client-secrets-manager`・`p-retry`・`pino`・`pg`） | — | — | — |
| `apps/api/src/entries/db-prep.ts` | 新設 | DB の用意の関数の起点。本番の依存を組んで `handler` を出す | 下の 3 つ・AWS SDK | モジュール | `handler` |
| `apps/api/src/db-prep/handler.ts` | 新設 | 呼び出しを照らし、用意の ID を読み直し、用意か差し替えを打って結果を終わりの記録の口へ渡す | contracts・`provision`・`rotate`・`pino` | モジュール | `createDbPrepHandler`・`PrepCompletionPort`（型）・`createPrepLogger` |
| `apps/api/src/db-prep/sql-executor.ts` | 新設 | SQL を打つ口と、その Data API の実装 | `@aws-sdk/client-rds-data`・`p-retry` | モジュール | `SqlExecutor`（型）・`createDataApiExecutor`・`RESUME_WAIT_ERRORS`・`DataApiUnavailableError` |
| `apps/api/src/db-prep/secret-version.ts` | 新設 | プロジェクトの秘密の器の、行に結んだ版からパスワードを読み、SQL を終えた版へ `AWSCURRENT` を移して確かめる | `@aws-sdk/client-secrets-manager` | モジュール | `readVersionPassword`・`promoteVersion` |
| `apps/api/src/db-prep/prep-run.ts` | 新設 | 同じ用意の ID の重複の配信のうち 1 つだけに SQL と終わりの記録を許す | `SqlExecutor` | モジュール | `claimPrepRun` |
| `apps/api/src/db-prep/scram.ts` | 新設 | パスワードを SQL に載せる前に SCRAM-SHA-256 の検証子へ変える | `node:crypto` | モジュール | `scramVerifier` |
| `apps/api/src/db-prep/provision.ts` | 新設 | I10 の守り・用意の手順の 1〜6 | `SqlExecutor`・`pg`（`escapeIdentifier`・`escapeLiteral`） | モジュール | `claimBinding`・`checkIsolationGuard`・`provisionProject` |
| `apps/api/src/db-prep/rotate.ts` | 新設 | 差し替えと古い接続の切り | `SqlExecutor`・`pg`（`escapeIdentifier`・`escapeLiteral`） | モジュール | `rotateRole`・`terminateRoleConnections` |
| `apps/api/test/db-prep/pg-executor.ts` | 新設 | テストで使う `SqlExecutor` の `pg` の実装 | `pg` | モジュール | `createPgExecutor` |
| `.github/workflows/ci.yml` | 変更 | `check` のジョブに PostgreSQL 16 のサービスコンテナと接続の値を足す | — | — | — |

## 形の正本

満たす決定: 決定 7、受け入れ条件 4・5

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `settingsSchema` | `packages/contracts/src/settings.ts` | 変更 | — | `network`・`progress_db`・`budget`（額と `scope`）・`ops` の任意のキーを足す（形は設計文書の「設定のファイル」の表） |
| `infraValues` | 同上 | 新設 | `(s: Settings) => InfraValues` | キーが無ければ既定を入れた値を返す |
| 2 つの zod の定義 | `packages/contracts/src/db-prep.ts` | 新設 | `dbPrepInvocation`・`dbPrepOutcome` | 設計文書の「DB の用意の関数の呼び出しと終わり」の表の形 |

- `infraValues`
  - 事後条件: `vpcCidr`・`maxAcu`・`budgetUsd`・`budgetScope`・`opsEmails` がどれも値を持つ。既定は `INFRA_DEFAULTS`（`10.80.0.0/16`・2・30・`tags`・空の配列）
- `dbPrepInvocation`
  - 項目は `prep_id`・`project_id`・`kind`・`rotation_seq` だけで、ほかの項目を持てば誤りにする（パスワードや管理の値を載せない）。`kind` が `rotate` のときだけ `rotation_seq`（1 以上の整数）を必須にし、`create` で持てば誤りにする。`project_id` はプロジェクトの ID（データの文書のプロジェクトの集約の ID と同じ形）
- `dbPrepOutcome`
  - `result` ごとに要る項目を判別共用体で縛る（`rotation_superseded` は `recorded_seq`、`failed` は `reason`）
- `PROGRESS_DB_IDENT_SHAPE`
  - データベースと役割の名前の形（`^[a-z][a-z0-9_]{7,62}$`）。関数が口から読んだ名前を照らす

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `INFRA_DEFAULTS` | 定数 | `packages/contracts/src/settings.ts` | 上の 5 つの既定 |
| `DB_PREP_TIMING` | 定数 | `packages/contracts/src/db-prep.ts` | `{ maxEventAgeSeconds: 60, functionTimeoutSeconds: 300, dataApiCallSeconds: 45, dataApiTxIdleSeconds: 180, prepDeadlineSeconds: 900, patrolIntervalSeconds: 300 }`。`DbPrepFunction` が最初の 2 つを、#6 の見回りと API が `prepDeadlineSeconds` と `patrolIntervalSeconds`（見回りのスケジュール）を読む。読み手は値を写さずこの定数を参照し、合成のテストで一致を照らす。`dataApiCallSeconds` と `dataApiTxIdleSeconds` は Data API が決める値（全体の設計の LIB91）で、関数は変えない |
| `DB_PREP_FAILURE_REASONS` | 定数 | `packages/contracts/src/db-prep.ts` | `data_api_unavailable`・`guard_conflict`・`connections_remain`・`sql_failed` |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `settingsSchema` | 5 つのキーを持つ・持たない設定のファイル | CIDR の接頭辞 16 と 20 は通り 15 と 21 は落ちる。ACU の 1・16 は通り 0.5・16.5・1.25 は落ちる。予算の 1 は通り 0 は落ちる。範囲は `tags`・`account` が通り `tag` は落ちる | 未知のキー・メールでない宛先 |
| `infraValues` | キーの無い設定で既定 | — | — |
| `dbPrepInvocation` | `create` と `rotate` | — | `create` で `rotation_seq` がある・`rotate` で無い・ほかの項目（`password` など）を持つ |
| `DB_PREP_TIMING` | `maxEventAgeSeconds + functionTimeoutSeconds + max(dataApiCallSeconds, dataApiTxIdleSeconds) < prepDeadlineSeconds`（540 < 900） | `maxEventAgeSeconds` が 60（`MaximumEventAgeInSeconds` の最小）。和と期限の差が見回りの間隔 `patrolIntervalSeconds`（300 秒）以上 | 期限を 540 以下に、または関数の時間切れを 541 秒以上に変えると落ちる |
| `dbPrepOutcome` | 3 つの `result` | — | `rotation_superseded` で `recorded_seq` が無い・`failed` で `reason` が無い・一覧に無い理由 |

## ネットワーク

満たす決定: 決定 3、受け入れ条件 3・4

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `Network` の `constructor` | `infra/lib/network.ts` | 新設 | `(scope, id, props: { cidr: string; names: AppResourceNames })` | VPC（2 つの AZ・公開 2・出口の無い 2・NAT 0）・S3 の Gateway のエンドポイント・タスクの SG（受け入れなし、行きは 443 の任意と 5432 の Aurora の SG）・Aurora の SG（タスクの SG からの 5432 だけ） |
| `subnetMask` | 同上 | 新設 | `(cidr: string) => number` | 接頭辞の長さ +2 を返す |
| `AppStack.availabilityZones` | `infra/lib/app-stack.ts` | 新設 | `get availabilityZones(): string[]` | `Fn::Select(0)`・`Fn::Select(1)` の `Fn::GetAZs("")` を返し、AZ の lookup を止める |

- `Network` の `constructor`
  - 事後条件: タスクの SG は `allowAllOutbound: false` で、受け入れの規則を持たない。VPC は `natGateways: 0`

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `subnetMask` | `/16` → 18 | `/20` → 22 | — |
| `AppStack.availabilityZones` | 合成の出力のサブネットの AZ が `Fn::GetAZs` を引く | — | 合成が context の lookup を求めない（`cdk.context.json` が作られない） |

`Fn::GetAZs` が 2 つ以上の AZ を返すことは合成では確かめられないため、設置の前提として `diff` の足りない設定の一覧で照らす（設計文書の決定 3・12。下の「設置のコマンド」の `readGetAzsCount`）。

## 進行表の DB

満たす決定: 決定 4、受け入れ条件 3・4

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `ProgressDb` の `constructor` | `infra/lib/progress-db.ts` | 新設 | `(scope, id, props: { network: Network; maxAcu: number; names: AppResourceNames })` | Aurora PostgreSQL 16.13・出口の無いサブネット・`ClusterInstance.serverlessV2` の書き手 1 台・最小 0・最大 `maxAcu`・自動の一時停止 300 秒・削除の保護・`RemovalPolicy.RETAIN`・管理の役割 `nd_admin` の生成した秘密の器 `<prefix>/<environment>/progress-db-admin`・保存の暗号化・Data API を有効（`enableDataApi: true`）・クラスタのパラメータの群（`rds.force_ssl: 1`。Aurora PostgreSQL 16 は既定が 0 で、TLS でない接続を受けてしまう。LIB18） |

- 接続する側の TLS は #6 のランナーが持つ。DB の用意の関数は Data API の HTTPS の端点で打ち、Aurora へ接続しない。`ProgressDb` はクラスタと管理の役割の秘密の器を公開の値に持ち、`DbPrepFunction` へ渡す

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `ProgressDb` | 合成の出力に最小 0・最大 2・一時停止 300 秒・書き手 1 台・クラスタのパラメータの群の `rds.force_ssl` が `1`・`EnableHttpEndpoint` が真 | `maxAcu` 16 | パラメータの群を外す・`rds.force_ssl` を `0` にする・Data API を外すと落ちる |

## ECS のクラスタ

満たす決定: 決定 5、受け入れ条件 2・3・4

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `TaskPlatform` の `constructor` | `infra/lib/tasks.ts` | 新設 | `(scope, id, props: { network: Network; names: AppResourceNames })` | ECS のクラスタ（Container Insights なし）・タスクの実行の役割（ECR の取得とログの書き込みだけ）・タスクの役割（文なし）・ログの群（30 日） |
| `RUNNER_TASK_SIZE` | 同上 | 新設 | `{ cpu: 1024, memoryMiB: 2048 }` | ランナーの既定の大きさ。#6 がタスクの定義で使う |
| `TaskPlatform` の公開の値 | 同上 | 新設 | `cluster`・`executionRole`・`taskRole`・`logGroup`・`publicSubnets`・`taskSecurityGroup` | #6 がランナーのタスクの定義と、API の関数の `RunTask` の値に使う |
| `RUN_TASK_PROPAGATE_TAGS` | 同上 | 新設 | 定数 `"TASK_DEFINITION"` | #6 が `RunTask` の `propagateTags` に必ず渡す値。`RunTask` は既定でタスクの定義のタグを実行するタスクへ写さないため、渡さなければ Fargate の実行の費用がタグ `app-prefix`・`app-env` を持たず、既定の `budget.scope: tags` の予算に数えられない（LIB19） |

- #6 が作るタスクの定義はスタックのタグ（`app-prefix`・`app-env`）を持つ。#6 は `RunTask` に `propagateTags: RUN_TASK_PROPAGATE_TAGS` を渡し、API の関数の役割に `ecs:TagResource`（`ecs:CreateAction` が `RunTask` の条件つき）を許す。#6 の API の関数のテストは、`RunTask` の入力に `propagateTags: "TASK_DEFINITION"` があることを照らす

- 事後条件: `AWS::ECS::Service`・`AWS::ECS::TaskSet` を作らない。タスクの役割に `Policies` も `ManagedPolicyArns` も無い

## 費用の見張り

満たす決定: 決定 6、受け入れ条件 4

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `CostWatch` の `constructor` | `infra/lib/cost-watch.ts` | 新設 | `(scope, id, props: { budgetUsd: number; budgetScope: "tags" \| "account"; emails: string[]; tags: { prefix: string; env: string }; names: AppResourceNames })` | SNS のトピック `<prefix>-<environment>-ops`（予算のサービスに発行を許す方針つき）・宛先ごとのメールの購読（空なら作らない）・予算 `<prefix>-<environment>-budget`（月・費用・USD。`budgetScope` が `tags` ならタグ `user:app-prefix$<prefix>` と `user:app-env$<environment>` で絞り、`account` なら絞らない）・実績 80%・100%・見込み 100% の 3 つの知らせをトピックへ |

- トピックの方針は `sns.TopicPolicy` の別の資源で作り、`budgets.amazonaws.com` に `SNS:Publish` を許す（条件は `aws:SourceAccount` がこのアカウント、`aws:SourceArn` がこのアカウントの予算の ARN。`Stack.formatArn` でサービス `budgets`・リージョンなし・資源 `*` を組む）。予算はトピックの ARN を参照するだけでは方針への依存を CloudFormation に伝えず、方針より先に作られうる。AWS Budgets は発行を許されていないトピックを無効と扱うため（LIB20）、`CfnBudget` に `budget.node.addDependency(topicPolicy)` を付け、初回の反映でも方針の後に予算を作る。トピックは KMS で暗号化しない（暗号化すると予算のサービスに鍵の許しが別に要る。LIB20）

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `CostWatch` | 予算の額・3 つの知らせ・タグの絞り。合成の出力の `AWS::Budgets::Budget` の `DependsOn` に `AWS::SNS::TopicPolicy` の論理 ID があり、方針が `budgets.amazonaws.com` の `SNS:Publish` を許す | 宛先 0 件で購読が 0 件。`account` で `CostFilters` も `FilterExpression` も無い | 依存を外す・トピックに `KmsMasterKeyId` を付けると落ちる |

## スタックの決まりの検査

満たす決定: 決定 4、受け入れ条件 2・3

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `stackRuleViolations` | `infra/test/support.ts` | 新設 | `(template: Template) => { rule: StackRule; id: string }[]` | 全体の設計の「スタックのテストに足す行」の 8 つの決まりを合成の出力に照らし、破れた資源を返す |
| `hourlyCostResources` | 同上 | 変更 | 変えない | `AWS::RDS::DBCluster` と `AWS::RDS::DBInstance` は、許しの条件（最小 0・一時停止 300 秒・Serverless v2 の書き手 1 台・読み手なし）を満たすときだけ外す |

### 処理の手順

| 決まり（`StackRule`） | 破れとして返すもの |
| --- | --- |
| `nat` | `AWS::EC2::NatGateway` |
| `task_ingress` | タスクの SG の `SecurityGroupIngress`、またはタスクの SG を指す `AWS::EC2::SecurityGroupIngress` |
| `lambda_in_vpc` | `VpcConfig` を持つ `AWS::Lambda::Function` |
| `ecs_service` | `AWS::ECS::Service`・`AWS::ECS::TaskSet` |
| `task_role_statement` | `TaskPlatform` のタスクの役割と、タスクの定義の `TaskRoleArn` が指す役割の `Policies`・`ManagedPolicyArns`、またはその役割へ付く `AWS::IAM::Policy` |
| `aurora_min` | `ServerlessV2ScalingConfiguration.MinCapacity` が 0 でない `AWS::RDS::DBCluster` |
| `deletable` | `DeletionPolicy` が `Retain` でない表・バケット・クラスタ（画面の配信のバケットは残す設定で同じに照らす） |
| `pitr` | `PointInTimeRecoverySpecification` が有効でない表 |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `stackRuleViolations` | 今の `AppStack` で 0 件 | — | 決まりごとに違反を 1 つ足した合成の出力で、その決まりの 1 件だけを返す（8 通り） |
| `hourlyCostResources` | 許しの条件を満たす Aurora を返さない | — | 最小 0.5・一時停止なし・読み手 1 台で返す |

## DB の用意の関数の資源

満たす決定: 決定 9・15、受け入れ条件 3・4

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `DbPrepFunction` の `constructor` | `infra/lib/db-prep-function.ts` | 新設 | `(scope, id, props: { db: ProgressDb; names: AppResourceNames; secretPrefix: string })` | `NodejsFunction`（起点 `DB_PREP_ENTRY`・名前 `<prefix>-<environment>-db-prep`・Node 24・ARM64・VPC の外・時間切れ `DB_PREP_TIMING.functionTimeoutSeconds`・非同期の呼び出しの `retryAttempts: 0` と `maxEventAge` `DB_PREP_TIMING.maxEventAgeSeconds`・ログの群）。役割は、クラスタへの `rds-data:ExecuteStatement`・`BeginTransaction`・`CommitTransaction`・`RollbackTransaction` と、管理の役割の秘密の器と `<prefix>/<environment>/progress-db/*` への `secretsmanager:GetSecretValue`、`<prefix>/<environment>/progress-db/*` への `secretsmanager:DescribeSecret`・`secretsmanager:UpdateSecretVersionStage`（[データの文書のパスワードの版](../docs/design/data.md#パスワードの版) の 4）だけ。クラスタと管理の秘密の器の ARN と秘密の器の頭は環境変数で渡す（合成の出力では参照） |
| `DB_PREP_ENTRY` | 同上 | 新設 | 定数（`apps/api/src/entries/db-prep.ts` のパス） | 起点のパス。コードは import しない |
| `DbPrepFunction` の公開の値 | 同上 | 新設 | `fn` | #6 が API の関数と見回りの関数に呼ぶ権限（`lambda:InvokeFunction`）を許す |
| `DbPrepFunction.grantCompletionAccess` | 同上 | 新設 | `(tables: { projects: dynamodb.ITableV2; audit: dynamodb.ITableV2 }) => void` | 終わりの記録の口（`PrepCompletionPort`。同じ Lambda の中で動く）が要る DynamoDB の権限だけを関数の役割へ足す。プロジェクトの表（`db-projects`）の表の ARN だけへ `dynamodb:GetItem`（`isCurrent`・`readTarget` の強い整合の読み）・`dynamodb:UpdateItem`・`dynamodb:ConditionCheckItem`（`record` の条件つきの書き込み。`TransactWriteItems` は項目ごとにこの 2 つで照らされる）、操作の記録の表（`db-audit`）の表の ARN だけへ `dynamodb:PutItem`（3 つの処理の記録の行。[API の文書の DB の用意の関数の処理](../docs/design/api.md#ランナー手元のマシンの-http-の経路)）。索引の ARN・`Query`・`Scan`・`DeleteItem`・ほかの表は許さない |

- 事後条件: 関数は `VpcConfig` を持たない（スタックの決まりの検査の `lambda_in_vpc` はそのまま当たる）。関数を呼べる主体はこの課題では足さない（#6）
- DynamoDB の権限の付与は #6 が受け持つ。プロジェクトの表と操作の記録の表はまだ無く（#2・#5 が作る）、口の本番の実装も #6 が作るため、#6 が口を `apps/api/src/entries/db-prep.ts` へつなぐ同じ変更で、`AppStack` から `grantCompletionAccess` を 2 つの表で呼ぶ（「#6 へ渡すこと」）。この課題の版は呼ばない。呼ばないまま口をつなぐと `isCurrent` が権限の不足で投げ、SQL の前に止まる（終わりは記さない）ため、安全の側に外れる

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `DbPrepFunction` | 合成の出力の関数が `VpcConfig` を持たず、`Timeout` が `DB_PREP_TIMING.functionTimeoutSeconds`（300）・`Architectures` が `arm64`。`AWS::Lambda::EventInvokeConfig` の `MaximumRetryAttempts` 0・`MaximumEventAgeInSeconds` が `DB_PREP_TIMING.maxEventAgeSeconds`（60）。役割の文が上の操作と資源だけで、DynamoDB の文を持たない | テスト用の 2 つの表で `grantCompletionAccess` を呼んだ合成の出力で、DynamoDB の文が上の 4 つの操作と 2 つの表の ARN だけ（#6 は同じテストの期待を `AppStack` の合成の出力へ移す） | 再試行を 1 以上にする・最大の年齢を外す・`rds-data:*` か `secretsmanager:*` か `dynamodb:*` にする・資源を `*` か索引の ARN に広げる・`Query` か `Scan` を足すと落ちる |

## 設置のコマンド

満たす決定: 決定 6・12、受け入れ条件 5

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `MISSING_CHECKS` | `infra/setup/missing-settings.ts` | 新設 | `readonly MissingCheck[]`（`MissingCheck = { label: string; run: (ctx: MissingContext) => Promise<MissingItem[]> }`。`label` は利用者へ出す照らしの名前） | 4 種類の照らし。ほかの子は配列へ足すだけ |
| `collectMissingSettings` | 同上 | 新設 | `(ctx: MissingContext, checks: readonly MissingCheck[]) => Promise<MissingItem[]>` | 照らしを順に打ち、結果を並べる。1 つの照らしの失敗は「<label> を確かめられない（<例外>）。…diff を打ち直す」の 1 行にする |
| `printMissingSettings` | 同上 | 新設 | `(items: MissingItem[], out: (line: string) => void) => void` | 「足りない設定:」の見出しと 1 件 1 行。0 件なら「足りない設定: 無し」 |
| `readCostAllocationTags` | `infra/setup/aws-reader.ts` | 新設 | `(target: Target, keys: string[]) => Promise<Record<string, "Active" \| "Inactive" \| "Missing">>` | `ListCostAllocationTags` でタグの状態を読む |
| `readOrganizationManager` | 同上 | 新設 | `(target: Target) => Promise<{ member: boolean; managementAccount: string \| null } \| "unknown">` | `DescribeOrganization` で組織の管理のアカウントを読む。組織に入っていなければ `member: false`。権限が無ければ `unknown` |
| `readGetAzsCount` | 同上 | 新設 | `(target: Target) => Promise<number>` | `DescribeSubnets`（`default-for-az=true`）で既定のサブネットのある AZ を数え、0 なら `DescribeAvailabilityZones`（`state=available`・種類 `availability-zone`）の数を返す。`Fn::GetAZs` が返す数の見なし（LIB6） |
| `runDiff` | `infra/setup/nd-setup.ts` | 変更 | 変えない | 確認の値を出した後に `collectMissingSettings` と `printMissingSettings` を打つ。終了コードは変えない |

- `SetupDeps` に `readCostAllocationTags`・`readOrganizationManager`・`readGetAzsCount` を足す（テストは本物の AWS を呼ばない）
- `MISSING_CHECKS` の 4 種類: Google のクライアントの ID が無い・`budget.scope` が `tags` でタグ `app-prefix`・`app-env` が `Active` でない（下のタグの行と、読めないときの行。`account` なら照らさない）・`ops.notify_emails` が空・`readGetAzsCount` が 2 未満（「`Fn::GetAZs` が返す AZ が <数> つで、反映がネットワークを作れずに止まる。既定の VPC の別の AZ に既定のサブネットを作る（`aws ec2 create-default-subnet --profile=<profile> --region=<リージョン> --availability-zone <AZ>`。`target` の値を入れる）か、既定のサブネットをすべて消す」。読めなければ「確かめられない（`ec2:DescribeSubnets`・`ec2:DescribeAvailabilityZones` を許した profile で読む）」）
- 読めないときの行の文（設計文書の決定 12）: 「コスト配分タグ `app-prefix`・`app-env` が有効かを確かめられない。有効でなければ予算は 0 を数え続け、予算の知らせは鳴らない。次の操作: <操作>」。読めない原因は SDK の例外だけでは権限の不足と組織の制限を分けられないため、`readOrganizationManager` で分ける。<操作> は、`member: false` なら「`ce:ListCostAllocationTags` を許した profile で `diff` を打ち直す」、`member: true` なら「組織の管理のアカウント <ID> にタグの有効化を確かめて頼む（メンバーのアカウントでは権限を足しても有効にできない）。頼めなければ設定のファイルの `budget.scope` を `account` にする」、`unknown` なら両方を「組織に入っていなければ …。組織のメンバーなら …」の 2 つに分けて示す（管理のアカウントの ID は「組織の管理のアカウント」とだけ示す）
- タグの行の文（設計文書の決定 6）: 「コスト配分タグ <有効でないタグ> が有効でない。有効になるまで予算は 0 を数え続け、予算の知らせは鳴らない。<待ち>有効にする先: <先>。有効にできなければ設定のファイルの `budget.scope` を `account` にする（アカウントの全体を数える）」。<先> は `readOrganizationManager` が `member: false` なら「このアカウント（請求の画面のコスト配分タグ）」、`member: true` なら「組織の管理のアカウント <ID>（メンバーのアカウントでは有効にできない）」、`unknown` なら「組織に入っていなければこのアカウント、組織のメンバーなら組織の管理のアカウント」。<待ち> は `Missing` のキーがあるときだけ「<Missing のキー> はタグの付いた資源がまだ無く、請求の画面のコスト配分タグの一覧に出ていないため、まだ有効にできない。deploy でタグの付いた資源を作り、一覧にキーが出るまで最大 24 時間待ってから有効にする。」

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `readCostAllocationTags` | 読めない | 権限が無い・組織の制限 | SDK の例外 | `readOrganizationManager` で原因を分け、「確かめられない」の 1 行に次の操作を添えて続ける | 一覧の 1 行（権限の不足なら profile の権限、組織のメンバーなら管理のアカウントへの依頼と `budget.scope: account`、分からなければ両方）。終了コードは変えない | 何も書いていない。再実行できる |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `collectMissingSettings` | 4 種類が当たる入力でそれぞれ 1 行。タグの行の <先> が `member: false`・`member: true`・`unknown` で 3 通りに変わる。タグを読めないときの行の <操作> も同じ 3 通りに変わり、`member: true` と `unknown` で管理のアカウントへの依頼と `budget.scope` の `account` が出る。`budget.scope` が `account` ならタグの行が出ない | 0 件で「無し」。AZ の数 2 で行が出ず 1 で出る | 照らしが投げると「確かめられない」の 1 行 |
| `readGetAzsCount` | 既定のサブネットが 3 つの AZ にあれば 3 | 既定のサブネットが 1 つの AZ にだけあれば、使える AZ が 3 つでも 1。既定のサブネットが無ければ使える AZ の数 | — |
| `runDiff` | 出力の最後に一覧の欄 | — | 足りない設定があっても終了コード 0 |

## DB の用意の関数

満たす決定: 決定 8・9・15、受け入れ条件 1・I10

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `handler` | `apps/api/src/entries/db-prep.ts` | 新設 | `(event: unknown) => Promise<void>` | 本番の依存（`createDataApiExecutor`・`readVersionPassword`・`promoteVersion`・`createPrepLogger`・終わりの記録の口）を実行環境ごとに 1 回組み、`createDbPrepHandler` の結果を呼ぶ。口の本番の実装は #6 がこのファイルで渡す。この課題の版は、呼ばれたら投げる口を渡す（関数を呼ぶ側も #6 が作り、それまで誰も呼ばない） |
| `createDbPrepHandler` | `apps/api/src/db-prep/handler.ts` | 新設 | `(deps: PrepDeps) => (event: unknown) => Promise<void>` | 呼び出しを `dbPrepInvocation` で照らす → 口の `isCurrent(prep_id)` で用意の ID を読み直し、違えば何もせずに終える → `claimPrepRun(prep_id)` が `duplicate` なら何もせずに終える → 口の `readTarget(project_id)` でデータベースと役割と秘密の器の名前と版の ID を読み、`readPassword` でその版のパスワードを読む → `kind` で用意か差し替え → 結果が `applied` か記した番号 = n の `rotation_superseded` なら `promote` でその版へ `AWSCURRENT` を移して確かめる → 結果を口の `record` へ渡す。`PrepDeps` は `{ sql: SqlExecutor; completion: PrepCompletionPort; readPassword: (secret: string, versionId: string) => Promise<string>; promote: (secret: string, versionId: string) => Promise<void>; logger; now: () => number }` |
| `PrepCompletionPort` | 同上 | 新設（型） | `{ isCurrent(prepId: string): Promise<boolean>; readTarget(projectId: string): Promise<{ database: string; role: string; secret: string; secretVersion: string }>; record(inv: DbPrepInvocation, outcome: DbPrepOutcome, secretVersion: string): Promise<"recorded" \| "mismatch"> }` | 終わりの記録の口。実装は #6（プロジェクトのモジュールの操作。`record` は用意の ID・差し替えの番号・版の ID が今の値と合うときだけ書く条件つきの書き込み） |
| `SqlExecutor` | `apps/api/src/db-prep/sql-executor.ts` | 新設（型） | `{ execute(sql: string, params: SqlParam[] \| undefined, opts: { database: string; transactionId?: string }): Promise<Row[]>; begin(opts: { database: string }): Promise<string>; commit(transactionId: string): Promise<void>; rollback(transactionId: string): Promise<void> }` | 用意と差し替えの SQL を打つ口。`transactionId` の無い `execute` は自動の確定で打つ（`CREATE DATABASE` はこれで打つ）。`database` で `postgres` かプロジェクトのデータベースを選ぶ |
| `createDataApiExecutor` | 同上 | 新設 | `(opts: { client: RDSDataClient; resourceArn: string; secretArn: string; retry: { attempts: number; delayMs: number; deadlineMs: number; now: () => number } }) => SqlExecutor` | `ExecuteStatement`（`database`・`transactionId`・`includeResultMetadata: true`・`continueAfterTimeout: false`。偽を明示し、45 秒で終わらない文は Data API が取り消す。PostgreSQL の DDL は取り消すと巻き戻る）・`BeginTransaction`・`CommitTransaction`・`RollbackTransaction` を打つ。行は `records` と `columnMetadata` の列の名前から組む（`formatRecordsAs: "JSON"` は SELECT にだけ効き、`INSERT … RETURNING` の行を返さない）。`transactionId` の無い `execute` と `begin` だけ、`RESUME_WAIT_ERRORS`（`DatabaseResumingException`）の例外を `p-retry` で繰り返す（下の箇条）。繰り返してよいのは、この例外の時は文が DB で打たれていないと推測するからである。AWS の文書は一時停止のため要求が取り消されたことだけを言い、文が DB へ届いていないことまでは書いていないため、これは推測で、#44 で確かめる（全体の設計の未確認のまま残ること）。推測が外れて打たれた文を打ち直すと、`CREATE DATABASE`・`CREATE ROLE` のような繰り返せない文は「既にある」で落ちる。用意の手順は既にあれば作らない作りで何度打っても同じ結果になるため、外れたときに起きるのはその回の `sql_failed` で、次の開始か呼び直しが同じ手順で終える（2 重の作成や壊れた状態は残らない）。繰り返す文を冪等な文に限る案は採らない: 配信の最初の Data API の呼び出しは `claimPrepRun` の `begin` で、再開の待ちはそこで受け、その後の文は書き手が起きている間に打つ（一時停止は接続が 0 本のまま 300 秒続いた後にだけ起きる。LIB80）。手順の途中の繰り返せない文が再開の待ちに当たることはまれで、当たって推測が外れても上のとおり 1 回の `sql_failed` で終わる。限ると、文ごとに繰り返してよいかの印を `SqlExecutor` の口へ足し、推測が正しい場合にも当たった回を `data_api_unavailable` で落とす。尽きたら `DataApiUnavailableError` を投げる。渡すクライアントは `createRdsDataClient`（`maxAttempts: 1`・打ち直さない凍った再試行の戦略。SDK へ渡す設定は `region`・`credentials`・`endpoint`・`requestHandler` だけで、型の外から渡された `retryStrategy`・`retryMode`・`maxAttempts`・`extensions` などは捨てる。除く項目を数える作りでは、`extensions` の `configure` から `setRetryStrategy` を呼んで `maxAttempts` を 1 のまま戦略を差し替える経路を漏らしたため、渡す項目を数える）で作り、SDK の再試行を止める。SDK が文や `commit` を打ち直すと、初回が確定して応答だけが失われたとき打ち直しの失敗が返り、確定したかが分からなくなるためである。SDK の再試行の層は、戦略の `refreshRetryTokenForRetry` がトークンを返す限り `maxAttempts` に関わらず打ち直す。SDK の既定の戦略（`StandardRetryStrategy`）のインスタンスは凍っておらず、`await client.config.retryStrategy()` で取り出して `refreshRetryTokenForRetry` を差し替えると、`maxAttempts: 1` でも打ち直す。そのため `createRdsDataClient` は、`refreshRetryTokenForRetry` が常に投げる（SDK は初回の失敗を投げる）戦略をモジュールの中に持ち、戦略とそのトークンを `Object.freeze` で凍らせて SDK へ渡す。`createRdsDataClient` は作ったクライアントの `config.retryStrategy` と `config.maxAttempts` を、作った時の値のまま書き換えられない項目（`Object.defineProperty` の `writable: false`・`configurable: false`）にし、クライアントの `config` の項目も同じく書き換えられなくして、モジュールの中の `WeakSet` に記す。SDK の `send` は送るたびに `this.config` を読んでミドルウェアを組むため、`config` をオブジェクトごと差し替えると固めた 2 項目を通らずに戦略を変えられるからである。`client.config` そのものを `Object.freeze` しないのは、SDK の署名の層が応答のたびに `config.systemClockOffset` へ書き込み、凍らせると送りが投げるからである。SDK の再試行の層は要求のたびに、送る途中で `config` から戦略と回数を読むため、送る前に照らす作りでは、照らした後・読む前（`const pending = sql.commit(id)` の直後、`await pending` の前）に差し替えると、照らしを通った要求が差し替え後の戦略で打ち直される。値そのものを固めれば、差し替えは代入の時に `TypeError` で投げ、送っている要求にも後の要求にも届かない。`createDataApiExecutor` は作る時に `WeakSet` に無いクライアントを投げ、要求のたびには照らさない（`maxAttempts` だけを読むと、`maxAttempts: 1` と独自の `retryStrategy` を持つクライアントが通り、その戦略が文や `commit` を打ち直せる）。要求のたびの照らしを持たないため、`rollback` も止められない。失敗の経路で `rollback` できず、トランザクションが Data API の期限切れまで開いたまま残ることは起きない |
| `readVersionPassword` | `apps/api/src/db-prep/secret-version.ts` | 新設 | `(client: SecretsManagerClient, secret: string, versionId: string) => Promise<string>` | `GetSecretValue` に `VersionId` を渡してその版の URL を読み、パスワードを返す。ラベル（`AWSPENDING`・`AWSCURRENT`）では読まない |
| `promoteVersion` | 同上 | 新設 | `(client: SecretsManagerClient, secret: string, versionId: string) => Promise<void>` | `DescribeSecret` の `VersionIdsToStages` で、版に `AWSCURRENT` が付いていれば何もしない。付いていなければ `UpdateSecretVersionStage`（`VersionStage: AWSCURRENT`・`MoveToVersionId`・今 `AWSCURRENT` の付く版の `RemoveFromVersionId`）を打ち、`DescribeSecret` を読み直して付いていなければ投げる |
| `createPgExecutor` | `apps/api/test/db-prep/pg-executor.ts` | 新設 | `(connect: (database: string) => Promise<pg.Client>) => SqlExecutor` | テスト用。データベースごとに接続を開き、`begin` は専用の接続に `BEGIN` を打ってその接続を `transactionId` に結ぶ |
| `scramVerifier` | `apps/api/src/db-prep/scram.ts` | 新設 | `(password: string, opts?: { salt?: Uint8Array; iterations?: number }) => string` | RFC 7677 の SCRAM-SHA-256 の検証子 `SCRAM-SHA-256$<回数>:<塩>$<StoredKey>:<ServerKey>`（どれも base64）を返す。塩は既定で `randomBytes(16)`、回数は既定 4096（PostgreSQL の既定と同じ）。`pbkdf2Sync`（HMAC-SHA-256）で塩つきのパスワードを作り、`createHmac` で `Client Key`・`Server Key`、`createHash` で StoredKey を求める。パスワードが印字できる ASCII でなければ投げる（PostgreSQL が掛ける SASLprep を自前で持たないため。API が作るパスワードは base64url の文字だけ） |
| `claimPrepRun` | `apps/api/src/db-prep/prep-run.ts` | 新設 | `(sql: SqlExecutor, prepId: string) => Promise<"first" \| "duplicate">` | 管理のデータベースの 1 つのトランザクション（`begin`〜`commit`）で、`nd_prep.prep_runs`（`prep_id` 主キー・`claimed_at`）へ `INSERT … ON CONFLICT (prep_id) DO NOTHING RETURNING prep_id` を打ち、行を返せば `first`、返さなければ `duplicate`。同じ ID の 2 つの挿入は主キーの一意の索引で後の方が前の確定を待ち、前が確定すれば衝突で何も足さない。同じトランザクションで `claimed_at` が 7 日より古い行を消す（待ち行列の最大の年齢 60 秒より十分長い）。表の有無は 2 回見る。まず鎖なしで `to_regclass` で見て、有れば鎖を取らずに進む。無ければ `pg_advisory_xact_lock(hashtext('nd-prep:schema'))` を取ってから見直し、まだ無ければ鎖の下で作る。トランザクションは READ COMMITTED（PostgreSQL と Data API の既定）で文ごとに新しい写しを読むため、見直しは鎖の前に別の配信が作り終えた表を見て、作る文どうしが重ならない（見直さずに作ると、`CREATE … IF NOT EXISTS` が重なりカタログの一意の制約で落ちうる）。鎖を取った後の見直しは、控えを通さず、カタログの表をその文の時点で読む（`pg_catalog.pg_class` と `pg_namespace` を引く `SELECT EXISTS (…) AS present`）。`to_regclass` は名前をカタログの控え（syscache）で引き、表の鎖を取らないため、別の接続の確定の知らせを受け取らない。見直しにも `to_regclass` を使うと、1 回目の確認で残った「無い」の控えを同じトランザクションで使い続け、鎖を待つ間に別の配信が作って確定した表を見落として作る文を送る（CI の PostgreSQL のテストで、待った後に作る文が送られて落ちた）。1 回目の鎖なしの確認は `to_regclass` のままでよい。古い控えで無いと読んでも、鎖を取って見直す道へ進むだけだからである。作る配信は表と権限の外しを 1 つのトランザクションで確定するため、鎖なしで有ると見えた表は権限を外し終えている。鎖を毎回最初に取る案は採らない: 表が有るふだんの受け取りもすべてこの 1 本の鎖の前で直列になり、鎖を待つ時間が Data API の 45 秒の取り消しに数えられる。表を作る要は初回だけで、二重の確認なら直列になるのは表の無い間の受け取りどうしだけである |
| `claimBinding` | `apps/api/src/db-prep/provision.ts` | 新設 | `(sql: SqlExecutor, project: ProjectIdent) => Promise<"bound" \| "retry" \| "conflict">` | 1 つのトランザクション（`begin`〜`commit`）で `pg_advisory_xact_lock(hashtext('nd-prep:bindings'))` を取り、`nd_prep.bindings`（`project_id` 主キー・`database_name` 一意・`role_name` 一意・`bound_at`）を `project_id`・`database_name`・`role_name` のどれかで引く。下の処理の手順の表で分ける。`bound` のときだけ行を足す。データベースと役割を作る前に打つ |
| `checkIsolationGuard` | 同上 | 新設 | `(sql: SqlExecutor, project: ProjectIdent) => Promise<"ok" \| "conflict">` | データベースか役割が、渡されたもの以外へ `CONNECT` で結ばれていれば `conflict`（`claimBinding` の後に打つ二重の守り）。結び付きは実効の `CONNECT` で読む: ACL の受け手（`datacl` が空なら `acldefault`）か持ち主に `pg_has_role(…, 'MEMBER')` で属すれば持つとする。役割の側は、渡された役割がほかのデータベース（接続を許さないものも含む）へ持てば数え、`PUBLIC` は数えない（特定の役割への結び付きでなく、`postgres`・`template1` は手順の 1、プロジェクトのデータベースは手順の 3 が外して読み直す）。渡された役割が superuser なら数える。データベースの側は、管理の役割（`current_user`）・渡された役割・superuser のほかの役割で、実効の `CONNECT` を持つもの（渡された役割に属して受け継ぐ別のログインを含む）を数え、`PUBLIC` は接続を許すときだけ数える |
| `provisionProject` | 同上 | 新設 | `(sql: SqlExecutor, project: ProjectIdent & { password: string }, options?: { deadlineMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }) => Promise<void>` | [用意の手順](../docs/design/data.md#用意の手順) の 1〜6。2 の `CREATE DATABASE` は `transactionId` なしで打ち、4 は `database` にプロジェクトのデータベースを渡して打つ。6 は役割が無ければ `CREATE ROLE`、あれば（作り直し）`ALTER ROLE` で渡されたパスワードを書き、どちらでもスキーマの前に `GRANT <役割> TO CURRENT_USER WITH SET TRUE, INHERIT FALSE` を打つ（superuser でない管理の役割がスキーマの持ち主をその役割にするには SET ROLE できる所属が要り、PostgreSQL 16 の `CREATE ROLE` の作り手には ADMIN OPTION だけが付くため）。1・3・4 の `REVOKE` は取り消す権限が無いと警告だけで終わるため、それぞれの後に `has_database_privilege('public', …)`・`has_any_column_privilege('public', …)` で読み直し、`PUBLIC` に残れば投げる（3 は同じトランザクションの中で読み、`ALLOW_CONNECTIONS true` を打たずに巻き戻す）。5 は管理の役割・プロジェクトの役割・superuser のほかの接続へ `pg_terminate_backend(pid, 0)` を送り、残りの数を読み直す。期限（`deadlineMs` の既定 15,000）の内で `pollMs`（既定 500）と期限までの残りの小さい方を待って送りと読みを繰り返し、期限を過ぎても残れば投げる（期限の後も読みを 1 回打ってから決める）。どの失敗も役割に接続を与える前に投げる。何度打っても、最後に渡したパスワードで同じ結果になる |
| `rotateRole` | `apps/api/src/db-prep/rotate.ts` | 新設 | `(sql: SqlExecutor, project: ProjectIdent & { password: string; seq: number }) => Promise<RotateResult>` | 1 つのトランザクションで `pg_advisory_xact_lock(hashtext('nd-rotate:' \|\| role))` を取り、`nd_prep.rotation_seq` の記した番号と n を比べ、小さいときだけパスワード・番号・書いた時刻を書き、境の時刻 `old_conn_cutoff` を空にする。結果は `applied`・`superseded_equal`・`superseded_greater` と記した番号 |
| `terminateRoleConnections` | 同上 | 新設 | `(sql: SqlExecutor, role: string, seq: number, opts: { deadlineMs: number; pollMs: number; now: () => number }) => Promise<{ kind: "done"; remaining: number } \| { kind: "superseded_greater"; recorded: number }>` | `rotateRole` のトランザクションが確定した後に、別のトランザクションで同じ排他の鎖を取る。記した番号が n より大きければ何も切らずに `superseded_greater`。番号 n の行の `old_conn_cutoff` が空なら `clock_timestamp()` を記す。切りと読み直しは、切り始めの時刻から `deadlineMs`（既定 15,000）の 1 つの期限を共にする（`now` は既定 `performance.now`）。1. 切る: `pg_stat_activity` のうち、その役割で `backend_start` が `old_conn_cutoff` より前の接続へ、1 つの SQL で `pg_terminate_backend(pid, 0)` を送る（`timeout` 0 はシグナルを送るだけで待たない。0 より大きい待ちは呼び出しごとに掛かり、接続ごとに呼ぶと期限を食い尽くすため使わない。設計文書の LIB22）。2. 読み直す: 同じ条件の残りの数を読む。トランザクションの中の `pg_stat_activity` は、その中で最初に読んだ時点の写しを返し続ける（設計文書の LIB21）ため、毎回の読みの直前に `SELECT pg_stat_clear_snapshot()` を打って写しを捨てる。1 の接続の一覧を読む前にも打つ。3. 残りが 0 なら返す。0 でなく期限の内なら、`min(pollMs, 期限までの残り)`（`pollMs` の既定 500）待って 2 へ戻る。期限を過ぎていれば、その読みの数を返す。期限を過ぎた後でも、2 の読みを最低 1 回打ってから返す（1 で期限を過ぎていても、読まずに数を決めない）。返した数が 1 以上なら `createDbPrepHandler` が `connections_remain` にする |

- `createDbPrepHandler`
  - 事前条件: 環境変数でクラスタの ARN・管理の役割の秘密の器の ARN・秘密の器の頭が渡っている（`handler` が読む）
  - 副作用: Data API への SQL・秘密の器の結んだ版の読み取りと、その版への `AWSCURRENT` の移し・終わりの記録の口の呼び出し。ほかの AWS の API とファイルには触れない
- `handler` は `RDSDataClient` を `requestHandler` の `requestTimeout` 60,000 ミリ秒で作る（Data API の 45 秒より長くし、SDK が先に時間切れを返して、Data API が終えた文を打ち直さないようにする。全体の設計の LIB91）
- `createDataApiExecutor` の繰り返し
  - `p-retry` に `{ retries: attempts - 1, factor: 1, minTimeout: delayMs, maxTimeout: delayMs, randomize: false, maxRetryTime: deadlineMs }`（既定で `attempts` 12・`retries: 11`・`delayMs` 5,000・`deadlineMs` 60,000）を渡す。期限は呼び出しごとの最初の試行の開始から測り、`now`（既定 `performance.now`。`p-retry` が `maxRetryTime` を測るのと同じ時計）で測る
  - `p-retry` の `maxRetryTime` は待ちを残り時間に切り詰めるだけで、待った直後に期限を照らさずに次の試行を呼ぶ（設計文書の LIB8）。そのため、試行の関数の始めで期限を照らし、残りが 0 以下なら打たずに `AbortError` を投げる
  - `RESUME_WAIT_ERRORS` に無い例外は試行の中で `AbortError` に包み、繰り返さない（`shouldRetry` は使わない）。トランザクションの中の文（`transactionId` を持つ `execute`）と `commit`・`rollback` は繰り返さずに投げ、呼ぶ側が `rollback` して失敗にする。`begin` が通った時点で書き手は起きている
- 識別子は `pg` の `escapeIdentifier` で組む。`CREATE ROLE … PASSWORD`・`ALTER ROLE … PASSWORD` は引数の束縛を受けないため、パスワードは SQL の文の中の文字列になる。その文が失敗すると PostgreSQL は既定（`log_min_error_statement` が `ERROR`）で文をサーバーのログに書き、`log_statement` を `ddl` 以上にすれば成功した文も書く（設計文書の LIB24）。そのため平文を文に載せず、`scramVerifier` の検証子を `escapeLiteral` で文字列にして渡す。PostgreSQL は SCRAM の形の文字列をそのまま保存し（LIB23）、Data API も Aurora PostgreSQL 14 以上では `scram-sha-256` だけを受ける（全体の設計の LIB91）。ログに残りうるのは検証子だけで、検証子から接続に要るパスワードは求められない（32 バイトの乱数のパスワードの総当たりは成り立たない）。名前と番号を照らす値は `SqlExecutor` の引数で渡す
- `PROGRESS_DB_IDENT_SHAPE` に合わない名前を口が返したら、SQL を打たずに投げる
- 2 つの `SqlExecutor` の違いと、同じ手順を照らす前提の守り方（CI が打つのは `createPgExecutor` だけで、Data API の実装は SDK のクライアントを差し替えた単体テストと #44 の実測で確かめる）

| 違い | Data API の実装 | `pg` の実装 | 守り方 |
| --- | --- | --- | --- |
| 文の長さと応答の大きさ | 応答は 1 MiB まで（LIB91）。文の長さの上限は確かめていない | 上限は実質無い | 手順の文はどれも検証子を含めて 1 KiB 未満で、返す行は数行に限る（一覧を読む文は `count(*)` か `LIMIT` を付ける）。作り物の `SqlExecutor` のテストで、`provisionProject`・`rotateRole`・`terminateRoleConnections`・`claimPrepRun`・`claimBinding` が渡す文がどれも 4 KiB 未満であることを照らす。上限は #44 で読む |
| トランザクションの中の再開の待ち | `transactionId` を持つ文は繰り返さない（上の箇条） | 再開が無い | `begin` だけを繰り返し、通った後は書き手が起きている前提で打つ。中の文が `DatabaseResumingException` を返したら `rollback` して失敗にする（`createDataApiExecutor` の単体テスト） |
| 値の型 | `records` の `Field`（整数は `longValue`、文字列は `stringValue`、真偽は `booleanValue`、空は `isNull`。配列とバイト列は受けない）。引数の整数は `longValue`（`bigint`）で渡る | `pg` の型の変換（`int4` は数、`int8`・`numeric` は文字列、時刻は `Date`）。引数の整数は Data API に合わせて `$n::bigint` で送る | 読む列はどれも SQL の側で `::int`・`::text`・`::boolean` に型を決め、時刻は読まずに SQL の中で比べる。`int` を受ける関数（`make_interval` など）へ渡す整数の引数は SQL の側で `CAST(… AS int)` にする。`Row` を `Record<string, string \| number \| boolean \| null>` にし、両方の実装が同じ値を返すことを、同じ行の作り物の応答（Data API）と PostgreSQL のサービスコンテナ（`pg`）で照らす |
| 接続と統計の写し | 接続の池を使い回し、トランザクションの間は 1 つの接続に結ぶ（LIB91） | トランザクションごとに専用の接続 | `pg_stat_clear_snapshot()` と `pg_terminate_backend` は、`terminateRoleConnections` の 1 つのトランザクションの中だけで打つ。切る相手はプロジェクトの役割の接続だけで、Data API の池の接続（管理の役割）に当たらない。Data API の上で同じに動くことは #44 で読む |

- Data API が接続を残して一時停止を妨げると #44 で分かったとき（決定 83 の「接続を残さない」が外れたとき）: 用意の後に一時停止へ入るまでの時間を #44 で測り、1 時間を超えて妨げるなら、2 つ目のチームのプロジェクトでホステッドのレーンを動かす前に設計へ戻す。戻す先の候補は、同じ手順を `pg` の実装で打つ ECS のタスク（設計文書の決定 15 の採らなかった案）である。手順は `SqlExecutor` の裏に置いたため、起点と実装を替えるだけで SQL の手順とそのテストはそのまま使える

### 処理の手順

| 関数 | 条件の組み合わせ | 結果 |
| --- | --- | --- |
| `createDbPrepHandler` | 呼び出しが `dbPrepInvocation` に合わない | 口を呼ばずに終える。ログに形の誤りだけを出す |
| `createDbPrepHandler` | `isCurrent` が偽 | SQL を打たず、`record` も呼ばずに終える（全体の設計の決定 96） |
| `createDbPrepHandler` | `claimPrepRun` が投げる（Data API の再開の待ちが尽きた `DataApiUnavailableError` と、確定の応答が届かないときを含む） | 受け取りを確かめられないため、`failed` を含めて `record` を呼ばずに投げる（関数の誤り）。同じ用意の ID のもう一方の配信が受け取っていればそれが続け、どちらも受け取っていなければ見回りが期限の後に扱う。下の `DataApiUnavailableError` の行は、受け取りの後の段だけに当たる |
| `createDbPrepHandler` | `claimPrepRun` が `duplicate`（同じ用意の ID の 2 つ目の配信。LIB92） | 用意と差し替えの SQL を打たず、`readTarget`・`promote`・`record` も呼ばずに終える。ログに `duplicate_delivery` を出す。1 つ目の配信だけが結果を確定するため、2 つ目が並行の DDL の衝突を `failed` に記して `無い` へ戻すことは起きない |
| `createDbPrepHandler` | `isCurrent`・`readTarget`・`readPassword`・`promote`・`record` のどれかが投げる | 終わりを記さずに投げる（関数の誤り。自動の再試行は 0 回で、見回りが期限の後に扱う）。`promote` が投げたら `record` を呼ばない |
| `createDbPrepHandler` | `applied`、または `rotate` で記した番号 = n の `rotation_superseded` | `promote` が版を確かめた後にだけ `record` を呼ぶ。`failed` と、記した番号 > n の `rotation_superseded` では `promote` を呼ばない |
| `createDbPrepHandler` | `record` が `mismatch` | 書かれずに終える。ログに出す |
| `createDbPrepHandler` | `claimPrepRun` が `first` を返した後の段で、Data API の再開の待ちが尽きた（`DataApiUnavailableError`） | `failed`・`data_api_unavailable` |
| `createDbPrepHandler` | `create` で `claimBinding` か `checkIsolationGuard` が `conflict` | 何も書かずに `failed`・`guard_conflict` |
| `createDbPrepHandler` | `create` か `rotate` で、ほかの SQL の失敗 | `failed`・`sql_failed` |
| `createDbPrepHandler` | `rotate` で `superseded_greater`（`rotateRole` か `terminateRoleConnections` のどちらか） | 接続を切らずに `rotation_superseded`（記した番号） |
| `createDbPrepHandler` | `rotate` で `applied` か `superseded_equal` | `terminateRoleConnections` の古い接続の残りが 0 なら `applied` か `rotation_superseded`、1 以上なら `failed`・`connections_remain`。境の時刻より後に始まった接続は数えない。`failed` で保留を下ろさないことは口の実装（#6）が I17・I22 のとおりに守る |
| `claimBinding` | 3 つのどれにも当たる行が無く、データベースも役割も無い | `bound`（行を足す） |
| `claimBinding` | 3 つのどれにも当たる行が無いが、データベースか役割が既にある | `conflict`（結び付きの無い資源） |
| `claimBinding` | 当たる行が 1 つで、3 つの値がすべて同じ | `retry`（途中で止まった作成の打ち直し） |
| `claimBinding` | 当たる行が 1 つで値のどれかが違う、または当たる行が 2 つ以上 | `conflict` |
| `checkIsolationGuard` | データベースが無い・役割が無い | `ok`（作り直しで片方だけあるときも、結び付きが渡されたものだけなら `ok`） |
| `checkIsolationGuard` | データベースが `datallowconn = false` で、`PUBLIC` が `CONNECT` を持つ（`datacl` が空の既定の ACL か、`PUBLIC` の `CONNECT` を含む） | `PUBLIC` を結び付きに数えず、ほかの役割だけで照らす。用意の手順の 2 の後・3 の `REVOKE` の前に止まった状態で、誰も接続できないため。`provisionProject` の 3 が `PUBLIC` から外してから `ALLOW_CONNECTIONS true` にする |
| `checkIsolationGuard` | データベースが `datallowconn = true` で、`PUBLIC` が `CONNECT` を持つ | `conflict`（用意の手順で作ったものでない） |

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `createDataApiExecutor` | 再開の待ちが尽きた | Aurora の再開の遅れ | 期限か回数の尽き | `DataApiUnavailableError` を投げる。受け取り（`claimPrepRun`）の後の段なら `failed`・`data_api_unavailable` を口へ渡し、受け取りの段なら終わりを記さずに投げる | ログに理由のコード | 作るなら `無い` へ戻り次の開始で、差し替えなら見回りの呼び直しで続く |
| `provisionProject` | SQL の失敗 | 権限・名前の衝突 | SDK の例外（`pg` の実装では `pg` の例外） | `failed`・`sql_failed` を口へ渡す | ログに例外の名前と、取れるときの SQLSTATE だけ（値は出さない） | 手順は何度打っても同じ結果。次の開始か呼び直しで続く |
| `readVersionPassword` | 読めない・形が違う | 版が無い・権限・URL の形 | SDK の例外・形の照らし | 終わりを記さずに投げる | ログに例外の名前 | 何も書いていない。見回りが期限の後に扱う |
| `promoteVersion` | 移せない・読み直しで付いていない | 権限・ほかの書き手との競合 | SDK の例外・読み直し | 終わりを記さずに投げる | ログに例外の名前 | DB は書いた後で、`作成中` か保留が残る（I20 で URL を渡さない）。呼び直しか作り直しが、移しを打ち直してから記す |
| `PrepCompletionPort` の `record` | 投げる | プロジェクトの表へ書けない | 例外 | 終わりを記さずに投げる | ログに例外の名前 | 見回りが期限の後に扱う（作るなら `無い` へ戻り、次の開始で同じ名前で打ち直す。手順は何度打っても同じ結果） |

### 並行と排他

| 同時に走りうる処理 | 共有する資源 | 排他の取り方 | 冪等性と中断からの再開 |
| --- | --- | --- | --- |
| 同じ役割の 2 つの差し替えの呼び出し | 役割のパスワードと `nd_prep.rotation_seq` | `pg_advisory_xact_lock`（STD83） | 番号の比べで古い方は書かない（I17） |
| 同じ番号 n の呼び直しと、時間切れの守りが外れて遅れた前の呼び出し（順序が逆になる） | 役割の接続 | 切るのは境の時刻 `old_conn_cutoff` より前に始まった接続だけ。境の時刻は、パスワードを書いたトランザクションの確定の後に、最初に切りの段へ来た呼び出しが排他の鎖の下で記し、後から来た呼び出しは記された値を使う | 終わりを記すのは切りの段の後だけで、API は終わりの記録を受けてから保留を下ろす（I20）。そのため新しいパスワードの接続はどれも境の時刻より後に始まり、遅れた呼び出しの切りに当たらない。境の時刻より前に始まった接続は、確定の前に古いパスワードで認証したものだけである |
| 同じ用意の ID の重複の配信（非同期の呼び出しは、再試行が 0 回でも同じ呼び出しを 2 回以上届けうる。LIB92） | データベースと役割・終わりの記録 | `claimPrepRun` が `nd_prep.prep_runs` の主キーで 1 つ目だけを `first` にする。用意と差し替えの SQL・版の移し・終わりの記録は `first` の配信だけが打つ | 1 つ目が途中で落ちても同じ用意の ID は打ち直さない。やり直しは新しい用意の ID で起きる（作るなら次の開始、差し替えなら見回りの呼び直し。I18・I22） |
| 同じプロジェクトの作成の打ち直し | データベースと役割 | API の用意の ID（I18）と、関数が SQL の前に用意の ID を読み直すこと。手順は何度打っても同じ結果 | 次の開始で続く（`claimBinding` は `retry`） |
| 2 つのプロジェクトの作成 | `nd_prep.bindings` | `pg_advisory_xact_lock(hashtext('nd-prep:bindings'))` と表の一意の制約 | 後に来た方が同じ名前を渡せば `conflict` |

### ログと記録の出力

| 関数 | 出すもの | レベルまたは書き先 | 出さないもの |
| --- | --- | --- | --- |
| Aurora のサーバーのログ（PostgreSQL が書く。関数は書き先を持たない） | 失敗した文（既定の `log_min_error_statement`）。役割のパスワードの文では検証子だけ | Aurora のログのファイル（`ProgressDb` は `cloudwatchLogsExports` を付けず、CloudWatch Logs へ出さない） | パスワードの平文（文に載せないため、どの設定でも現れない） |
| `createDbPrepHandler` | 用意の ID・種類・結果・理由のコード・所要時間・口の結果（`recorded`・`mismatch`）・失敗のときの例外の名前と、取れるときの SQLSTATE（`pg` の実装の `err.code`。Data API の実装は持たない） | `pino` の 1 行の JSON を標準出力へ（関数のログの群へ） | パスワード・URL・秘密の器の値・データベースと役割の名前・SQL の文 |

値を出さない決まりは 2 つで、`redact` は 2 つ目の守りとする。

1. 出す項目を決まった形で組む。ログの呼び出しは `logger.info({ prep_id, kind, result, reason, duration_ms, record_result, err_name, sqlstate }, "<固定の文>")` の形だけにし、メッセージの文字列は定数にして値を埋め込まない。例外は `err` のまま渡さず、`err.name` と `err.code` だけを取り出す（SDK と `pg` の例外の `message` と `stack` には、SQL の文・データベースや役割の名前が入りうるが、`redact` はキーのパスでしか伏せず文字列の中は伏せられないため）。呼び出し・口の返す名前・秘密の器の値をそのまま渡さない
2. `redact: { paths, remove: true }` の `paths` に次を並べる: `password`・`*.password`・`url`・`*.url`・`secret`・`*.secret`・`SecretString`・`*.SecretString`・`database`・`*.database`・`role`・`*.role`・`sql`・`*.sql`・`err`・`*.err`・`message`・`stack`・`*.message`・`*.stack`

### 既存の部品の再利用

| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `createDataApiExecutor` の再試行 | `p-retry`（設計文書の LIB8）・横断の部品の `withRetry`（[全体の設計の決定 91](../docs/design/platform.md#決定の記録)・[詳細設計の横断の部品](../docs/design/detail.md)） | 設計文書の決定 14・`ls packages/` | `p-retry` を使う。`packages/core` は #2 が作り、まだ無い（`ls packages/` は `contracts` だけ）。そろえ方は #56 |
| `createDbPrepHandler` のログ | `pino`（設計文書の LIB10）・横断の部品の `createLogger` | 設計文書の決定 14 | `pino` を使い、出す項目を決まった形で組み、`redact` を 2 つ目の守りにする（上の「ログと記録の出力」）。そろえ方は #56 |
| 識別子の組み立て | `pg` の `escapeIdentifier` | LIB3 | 使う |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `provisionProject`（`createPgExecutor`・PostgreSQL のサービスコンテナ） | 2 つのプロジェクトを作り、A の役割で A へ接続できる。superuser でない管理の役割（`CREATEDB`・`CREATEROLE`・`pg_signal_backend`）で、初回の作成と作り直しが通る | 同じ値で 2 回打っても同じ結果 | A の役割で B・`postgres`・`template1` へ接続できると落ちる。A の役割で `pg_database` と `pg_roles` から B の名前が読めると落ちる。superuser でない管理の役割で SET できる所属の `GRANT` を外すと落ちる（外して通れば落ちる）。取り消す権限の無い管理の役割で、`REVOKE` が警告だけで終わったのに用意が通るか役割ができると落ちる。作り物の `SqlExecutor` で、1・3・4 の読み直しが残りを返すと役割を作らずに投げ、5 の残りが期限まで 0 にならないと投げる |
| `claimPrepRun`（`createPgExecutor`・PostgreSQL のサービスコンテナ） | 新しい用意の ID で `first`。表の無い DB で表を作って `first` | 同じ用意の ID の 2 回目は `duplicate`。8 日前の行は消え、6 日前の行は残る | 同じ用意の ID を 2 つの接続から同時に打ち、ちょうど 1 つだけが `first` になる（両方 `first` なら落ちる）。表の無い間に別の接続が鎖を持てば、鎖なしで無いと見た後で鎖を待ち、別の接続が表を作って確定した後の見直しで作る文を打たずに `first`（鎖の待ちの監視は 10 秒の期限で止め、落ちたら鎖を外してから受け取りの終わりを待つ）。表が有れば、別の接続が鎖を持っていても待たずに `first` |
| `createDbPrepHandler`（`createPgExecutor`・PostgreSQL のサービスコンテナ・作り物の口） | — | — | 重複の配信: 同じ `create` の呼び出しを 2 つ同時に打ち、`CREATE DATABASE` と `CREATE ROLE` を打つのが 1 つだけで、`record` が 1 回だけ `applied` で呼ばれる。`failed` の `record` が 1 回でも呼ばれるか、`record` が 2 回呼ばれると落ちる。受け取りの失敗: 作り物の `SqlExecutor` で、1 つ目の配信の `claimPrepRun` の `begin` に `DataApiUnavailableError` を投げさせ、2 つ目の配信は受け取って用意を終える。`record` が 2 つ目の `applied` の 1 回だけで、1 つ目が `failed`（`data_api_unavailable`）の `record` を呼ぶと落ちる。`commit` が投げた（確定したかが分からない）ときも、`record` も用意の SQL も呼ばれない |
| `claimBinding`（`createPgExecutor`・PostgreSQL のサービスコンテナ） | 新しい名前で `bound` | A の作成をデータベースと役割を作った後・最後の `GRANT` の前で止め、A の打ち直しが `retry` で用意を終える | 途中で止まった A に対し、B が A のデータベースの名前と B の役割・B のデータベースと A の役割・A の 2 つの名前を渡すとどれも `conflict`。行の無い既存のデータベースで `conflict`。2 つを同時に打って片方だけが `bound` |
| `checkIsolationGuard` | 新しい名前で `ok` | 作り直し（片方だけある）で `ok`。A の作成を `CREATE DATABASE … ALLOW_CONNECTIONS false` の直後・`REVOKE` の前で止め、同じ結び付きの打ち直しが `ok` になり、`provisionProject` が用意を終えて A の役割だけが `CONNECT` を持つ | B のデータベースに A の役割を渡す・A の役割に B のデータベースを渡すと `conflict`。`ALLOW_CONNECTIONS true` で `PUBLIC` が `CONNECT` を持つ既存のデータベースで `conflict`。A の役割が所属する役割から B のデータベースの `CONNECT` を受け継ぐと、A でも B でも `conflict`。A の役割に所属する別のログインがあれば `conflict`。`template1` に `PUBLIC` の `CONNECT` を戻しても `ok` で、打ち直しが外し直す |
| `rotateRole` | 記した番号 < n で書く | 記した番号 = n で書かない | 記した番号 > n で何も変えない。2 つを同時に打って番号の大きい方だけが残る |
| `terminateRoleConnections`（`createPgExecutor`・PostgreSQL のサービスコンテナ） | 書く前に開いた役割の接続を 3 本の実際の PostgreSQL 16 で切り、同じトランザクションの中の読み直しで残り 0 を返す（`pg_stat_clear_snapshot()` を外すと、最初の写しの 3 を読み続けて落ちる） | 境の時刻が記されていれば記し直さない。作り物の `SqlExecutor` で次を照らす（時計は差し替える）: 残りの読みの直前ごとに `pg_stat_clear_snapshot()` を打つ。切りの SQL が `pg_terminate_backend(pid, 0)` の 1 回で、接続の数（1 本・10 本）で呼ぶ回数が変わらない。1 回目の読み直しが 1・2 回目が 0 なら 0 を返す。読みが 1 のまま期限の 15 秒を過ぎれば、最後の読みの 1 を返し、期限の後に次の読みを打たない。切りの SQL が戻るまでに時計を期限の後へ進めても、残りを 1 回読んでから返し、その数が 0 なら 0（`createDbPrepHandler` は `applied`）、1 以上ならその数（`createDbPrepHandler` は `connections_remain`）。待ちは毎回 `pollMs` と期限までの残りの小さい方 | 順序の逆転: 呼び出し T1 が番号 n を書いて切りの前で止まり、呼び直しの T2（同じ n）が `superseded_equal`・切り・終わりまで進み、その後に新しいパスワードで接続 C を開き、T1 を再開すると C が切られずに残る（C が切られると落ちる）。T1 が `rotateRole` の前で止まり、T2 が終わって C を開いた後に T1 を最初から打っても C が残る。記した番号が n+1 に上がった後の T1（n）は何も切らずに `superseded_greater` |
| `createDataApiExecutor`（SDK のクライアントを差し替える） | `execute` が `database` と `transactionId` を `ExecuteStatement` へそのまま渡し、`transactionId` の無い `execute` は持たない。`begin` の返す ID を `commit`・`rollback` へ渡す。2 回目の試行で `DatabaseResumingException` が止めば返す。既定の値で `p-retry` に渡す値が `retries: 11`・`factor: 1`・`minTimeout: 5000`・`maxTimeout: 5000`・`randomize: false`・`maxRetryTime: 60000` | `DatabaseResumingException` が続くと 12 回試し、13 回目を打たない（最後の試行の始めは 55 秒）。`p-retry` の切り詰めた待ちが期限ちょうどで明けたとき、試行の関数が打たずに投げる（作り物のクライアントの呼ばれた回数が増えない。時計は差し替える）。`transactionId` を持つ `execute` は `DatabaseResumingException` でも繰り返さない。`INSERT … RETURNING` の行を `records` から読み、`claimPrepRun` が Data API の応答の形で `first` と `duplicate` を分ける。送りの層（`requestHandler`）を差し替えた `createRdsDataClient` のクライアントは 503 でも 1 回だけ送る（既定のクライアントは打ち直すことを同じ差し替えで照らす） | `createRdsDataClient` で作っていないクライアント（既定の `RDSDataClient`・`maxAttempts: 1` と打ち直す `retryStrategy` を持つ `RDSDataClient`）は `createDataApiExecutor` を作る時に何も送らずに投げる。`createRdsDataClient` は型の外から渡された `retryStrategy` と `maxAttempts` を捨て、503 でも 1 回だけ送る。型の外から渡された `extensions` も捨て、拡張の `configure` から `setRetryStrategy` で打ち直す戦略を指定しても 503 で 1 回だけ送る（同じ拡張を持つ既定のクライアントは `maxAttempts` が 1 のまま打ち直すことを照らす）。作った後に `config.retryStrategy`・`config.maxAttempts` へ代入するか `Object.defineProperty` で差し替えると `TypeError` で投げ、`client.config` へオブジェクトごと代入するか `Object.defineProperty` で差し替えても `TypeError` で投げ、503 でも `commit` を 1 回だけ送る。`await client.config.retryStrategy()` で取り出した戦略のインスタンスの `refreshRetryTokenForRetry` へ代入すると `TypeError` で投げ、その後も 503 で `commit` を 1 回だけ送る（SDK の既定の戦略を持つ `maxAttempts: 1` のクライアントは、同じ差し替えで打ち直すことを照らす。凍った戦略を渡すのを外すと落ちる）。`commit` を送っている途中（約束を受けた後・待つ前）に差し替えを試みても、その `commit` は 1 回だけ送る。差し替えを試みた後の `rollback` は照らしで投げず、送りの層まで届いて 1 回だけ送る（固めを外すと、この 3 つが落ちる）。`RESUME_WAIT_ERRORS` に無い例外（`BadRequestException` など）は 1 回で投げる。尽きたら `DataApiUnavailableError` を投げ、`createDbPrepHandler` が `data_api_unavailable` を渡す |
| `readVersionPassword` | 版の URL からパスワードを返し、`VersionId` を渡して `VersionStage` を渡さない | — | 版が無い・URL にパスワードが無いと投げる。例外の文にパスワードと URL が現れない |
| `promoteVersion` | `AWSCURRENT` の付かない版で `UpdateSecretVersionStage` に `MoveToVersionId` とそれまでの版の `RemoveFromVersionId` を渡し、読み直す | 既に付いていれば `UpdateSecretVersionStage` を呼ばない（中断からの再開） | 読み直しで付いていなければ投げる |
| `createDbPrepHandler` | 処理の手順の表の各行（作り物の口と `SqlExecutor`）。`isCurrent` が偽なら、`SqlExecutor`・`readTarget`・`readPassword`・`promote`・`record` のどれも呼ばれない。中断からの再開: 1 回目の差し替えの呼び出しを `promote` の後・`record` の前で投げさせ、同じ番号 n・同じ版の ID・新しい用意の ID の呼び直しが、`rotation_superseded`（記した番号 = n）で `promote` を打ち（作り物の秘密の器は既に `AWSCURRENT` を版に持つため移さない）、その後に `record` を呼んで保留が下りる。どの呼び出しでも `record` は `promote` の後にだけ呼ばれる | `promote` が投げると `record` が呼ばれない（呼ばれると落ちる）。`failed` で `promote` が呼ばれると落ちる | ログの出力（作り物の書き先に集めた全行）に、作り物のパスワード・URL・データベースと役割の名前のどれかが部分の文字列として現れると落ちる。作り物の `SqlExecutor` と `readPassword` が、それらの値を `message` に含む例外を投げる場合（再開の待ちの尽き・SQL の失敗・秘密の器の失敗）でも同じに照らす |
| ロガーの設定 | — | — | `paths` の各キーに値を入れた物を渡すと、出力にそのキーが無い |
| `scramVerifier` | PostgreSQL のサービスコンテナで平文から作った役割の `pg_authid.rolpassword`（テストの準備だけで読む）の塩と回数を渡すと、同じ検証子を返す。`provisionProject` が検証子で作った役割へ、平文のパスワードで `pg` の接続が通る（PostgreSQL のサービスコンテナ）。`rotateRole` の後も新しい平文で通り、古い平文で落ちる | 呼ぶたびに塩が変わり、同じパスワードでも違う検証子になる | 印字できない文字を含むパスワードで投げる |
| パスワードを含む文 | — | — | `provisionProject`・`rotateRole` を作り物の `SqlExecutor` で打ち、渡された SQL の文と引数のすべてに作り物のパスワードの平文が部分の文字列として現れると落ちる（作り直しの `ALTER ROLE` を含む）。PostgreSQL のサービスコンテナを `log_statement=all`・`log_min_error_statement=error` で起こし、既にある役割へ `CREATE ROLE` を打って失敗させた後、コンテナのログに平文が現れると落ちる |

CI の `check` のジョブに `postgres:16`（要約値で固定）のサービスコンテナを置き、接続の値を `ND_TEST_PG_URL` で渡す。値が無いとき、`CI` が真なら DB のテストは落ち、手元では飛ばす（このリポジトリはテストを CI に寄せる）。用意の手順は `postgres`・`template1` の `PUBLIC` の権限のようにクラスタ全体の権限を変えるため、それを打つテスト（`provision.test.ts` の PostgreSQL の組）は、接続先が使い捨てのクラスタだと示す `ND_TEST_PG_DISPOSABLE_CLUSTER` が `1` と完全に一致するときだけ打つ（`off`・`no`・打ち間違いでは打たない。無ければ CI では落とし、手元では飛ばす）。手元の既存のクラスタを `ND_TEST_PG_URL` で指しても、その利用者の権限を変えない。CI はジョブだけのコンテナを指すため `1` にする。

## 実測と戻しの予行の手順

満たす決定: 決定 10・13、受け入れ条件 6・7

リリース承認ゲートの承認の後に行う。M1・M2 は読むだけで、反映のパイプラインで反映した運用する環境で行う。M4・M5 は `app` のスタックを変えるため運用する環境では打たない（運用する環境の `app` は反映のパイプラインだけで反映する。AGENTS.md の「反映の経路」）。同じコミットを、運用する環境と別の `environment` の値（例 `rehearsal`）の設定のファイルで設置のコマンドから立てた、自分で設置する環境（以下、予行の環境）で行い、終えたら予行の環境を残すか消すかを運用する人が決める。結果を #13 のリリース後テストのコメントと、全体の設計の費用の見込み・未確認のまま残ることへ返す。値はリポジトリと課題に書かず、比と時間と回数だけを書く。接続する項目は #44 が受ける。

| # | 項目 | 手順 | 合格の目安 |
| --- | --- | --- | --- |
| M1 | 接続の無い間の一時停止 | 反映の後 3 日、CloudWatch の `ServerlessDatabaseCapacity` を 5 分の粒度で読み、0 でない時間の合計と起きた回数を数える | 0 でない時間が保守の起き上がり（1 回 20 分程度）だけ |
| M2 | 単価 | EventBridge Scheduler・DynamoDB の PITR とストリームの単価の頁を、設置したリージョンで読む | 見込みの額への効きを全体の設計の見込みに書く |
| M4 | 戻しの予行 | 予行の環境で、決定 10 の手順。戻す前に、Aurora のクラスタの識別子とリソースの ID（`DescribeDBClusters` の `DbClusterResourceId`）・利用者の表の項目の数と作り物の目印の項目 1 件を控える。保存した前の合成の結果を設置のコマンドの `deploy` で反映し、同じ値を読み直し、確認の値の照らしを読む | クラスタの識別子とリソースの ID が前後で同じ・利用者の表の項目の数と目印の項目が残る・確認の値の違う `deploy` が止まる。プロジェクトのデータベースの残りは確かめない（#44 が受ける） |
| M5 | 予算と運用の知らせ | 予行の環境で、予算を 1 ドルにした設定で `diff`・`deploy` し、知らせのメールが届くことを読んだ後に戻す | 宛先に届く |
