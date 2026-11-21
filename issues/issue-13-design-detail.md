# #13 の詳細設計: 網・進行表の DB・タスクの土台・費用の見張り・DB の用意のタスク・設置のコマンドの足し

設計文書 [issue-13-design.md](./issue-13-design.md) の構成要素を、ファイルと関数の粒度へ下ろした文書である。新設する関数が 2 つ以上あるため別のファイルにした。値の理由は設計文書の決定にあり、ここでは繰り返さない。ソースのコメントや型で読める情報は写さない。

## 地図

触るファイル（`*` は新設）:

```text
packages/contracts/
├── src/settings.ts
├── src/db-prep-api.ts          *
├── test/settings.test.ts
├── test/db-prep-api.test.ts    *
└── schema/settings.schema.json （生成物）
infra/
├── settings.example.json       （生成物）
├── lib/app-stack.ts
├── lib/naming.ts
├── lib/network.ts              *
├── lib/progress-db.ts          *
├── lib/tasks.ts                *
├── lib/cost-watch.ts           *
├── lib/pipeline-stack.ts
├── setup/nd-setup.ts
├── setup/aws-reader.ts
├── setup/missing-settings.ts   *
├── setup/gc.ts                 *
└── test/（support.ts・app-stack・stack-rules*・pipeline-stack・naming・nd-setup・missing-settings*・gc*・gc-cli*）
apps/db-prep/                   *
├── package.json・tsconfig.json・Dockerfile
├── src/main.ts・exchange.ts・provision.ts・rotate.ts
└── test/exchange.test.ts・provision.test.ts・rotate.test.ts
docs/operations/settings.md・setup.md
.github/workflows/ci.yml
```

依存の向き: `packages/contracts` ← `infra`・`apps/db-prep` の一方向で、`infra` と `apps/db-prep` は互いを import しない。`infra/lib/tasks.ts` は `apps/db-prep/Dockerfile` をファイルの資産として指すだけで、コードを import しない（[詳細設計の依存の表](../docs/design/detail.md#クラスと関数の構造)の `infra` から `apps/*` への import の禁止に合う）。

| パス | 種類 | 役割 1 文 | 依存する先 | クラスまたはモジュール | メソッドと最上位の関数 |
| --- | --- | --- | --- | --- | --- |
| `packages/contracts/src/settings.ts` | 変更 | 設定のファイルの形に 5 つのキーを足し、既定を解く | zod | モジュール | `settingsSchema`（変更）・`infraValues`（新設） |
| `packages/contracts/src/db-prep-api.ts` | 新設 | DB の用意のタスクの 2 つの HTTP の経路の要求と応答の形 | zod | モジュール | 4 つの zod の定義・`PROGRESS_DB_IDENT_SHAPE`・`DB_PREP_FAILURE_REASONS` |
| `infra/lib/naming.ts` | 変更 | 足す資源の名前 | — | モジュール | `appResourceNames`（変更） |
| `infra/lib/network.ts` | 新設 | VPC・サブネット・エンドポイント・SG | aws-cdk-lib | `Network` | `constructor`・`subnetMask` |
| `infra/lib/progress-db.ts` | 新設 | Aurora のクラスタと管理の役割の秘密の器 | aws-cdk-lib・`Network` | `ProgressDb` | `constructor` |
| `infra/lib/tasks.ts` | 新設 | ECS のクラスタ・実行の役割・DB の用意のタスクの定義 | aws-cdk-lib・`Network` | `TaskPlatform` | `constructor`・`RUNNER_TASK_SIZE`・`DB_PREP_TASK_SIZE` |
| `infra/lib/cost-watch.ts` | 新設 | 運用の知らせのトピックと月の予算 | aws-cdk-lib | `CostWatch` | `constructor` |
| `infra/lib/app-stack.ts` | 変更 | 4 つの部品を組み、AZ を `Fn::GetAZs` から返し、利用者の表に PITR を付ける | 上の 4 つ | `AppStack` | `availabilityZones`（新設の getter）・`constructor`（変更） |
| `infra/lib/pipeline-stack.ts` | 変更 | 反映のアクションを特権にし、`image-publishing` を引き受けられるようにする | — | `PipelineStack` | `constructor`（変更） |
| `infra/setup/missing-settings.ts` | 新設 | 足りない設定の一覧を集めて出す | `aws-reader` | モジュール | `MISSING_CHECKS`・`collectMissingSettings`・`printMissingSettings` |
| `infra/setup/gc.ts` | 新設 | 古い資産の片付け | `nd-setup` の型 | モジュール | `gcConfirmValue`・`gcCliArgs`・`runGc` |
| `infra/setup/aws-reader.ts` | 変更 | コスト配分タグの状態を読む | AWS SDK（Cost Explorer） | モジュール | `readCostAllocationTags`（新設） |
| `infra/setup/nd-setup.ts` | 変更 | `gc` の引数と振り分け・`diff` の最後に一覧を出す | 上の 2 つ | モジュール | `parseArgs`・`runDiff`・`mainSetup`・`defaultDeps`（変更） |
| `infra/test/support.ts` | 変更 | スタックの決まりの検査 | — | モジュール | `stackRuleViolations`（新設）・`hourlyCostResources`（変更） |
| `apps/db-prep/src/main.ts` | 新設 | タスクの入口。引き換え → 用意か差し替え → 終わりの報告 | 下の 3 つ・contracts | モジュール | `main` |
| `apps/db-prep/src/exchange.ts` | 新設 | タスクの ID を読み、API と話す | contracts | モジュール | `readTaskArn`・`exchange`・`complete` |
| `apps/db-prep/src/provision.ts` | 新設 | 管理の接続・I10 の守り・用意の手順の 1〜6 | `pg` | モジュール | `connectAdmin`・`checkIsolationGuard`・`provisionProject` |
| `apps/db-prep/src/rotate.ts` | 新設 | 差し替えと古い接続の切り | `pg` | モジュール | `rotateRole`・`terminateRoleConnections` |
| `.github/workflows/ci.yml` | 変更 | `check` のジョブに PostgreSQL 16 のサービスコンテナと接続の値を足す | — | — | — |

## 形の正本

満たす決定: 決定 7、受け入れ条件 4・5

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `settingsSchema` | `packages/contracts/src/settings.ts` | 変更 | — | `network`・`progress_db`・`budget`（額と `scope`）・`ops` の任意のキーを足す（形は設計文書の「設定のファイル」の表） |
| `infraValues` | 同上 | 新設 | `(s: Settings) => InfraValues` | キーが無ければ既定を入れた値を返す |
| 4 つの zod の定義 | `packages/contracts/src/db-prep-api.ts` | 新設 | `dbPrepExchangeRequest`・`dbPrepExchangeResponse`・`dbPrepCompletionRequest`・`dbPrepCompletionResponse` | 設計文書の「DB の用意のタスクの HTTP の経路」の表の形。どれも要素 1 個の配列 |

- `infraValues`
  - 事後条件: `vpcCidr`・`maxAcu`・`budgetUsd`・`budgetScope`・`opsEmails` がどれも値を持つ。既定は `INFRA_DEFAULTS`（`10.80.0.0/16`・2・30・`tags`・空の配列）
- `dbPrepExchangeResponse`
  - `kind` が `rotate` のときだけ `project.rotation_seq` を必須にし、`create` で持てば誤りにする。データベースと役割の名前は `PROGRESS_DB_IDENT_SHAPE`（`^[a-z][a-z0-9_]{7,62}$`）に合う
- `dbPrepCompletionRequest`
  - `result` ごとに要る項目を判別共用体で縛る（`rotation_superseded` は `recorded_seq`、`failed` は `reason`、`kind` が `rotate` なら `rotation_seq`）

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `INFRA_DEFAULTS` | 定数 | `packages/contracts/src/settings.ts` | 上の 5 つの既定 |
| `DB_PREP_FAILURE_REASONS` | 定数 | `packages/contracts/src/db-prep-api.ts` | `admin_connect_failed`・`guard_conflict`・`connections_remain`・`sql_failed` |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `settingsSchema` | 5 つのキーを持つ・持たない設定のファイル | CIDR の接頭辞 16 と 20 は通り 15 と 21 は落ちる。ACU の 1・16 は通り 0.5・16.5・1.25 は落ちる。予算の 1 は通り 0 は落ちる。範囲は `tags`・`account` が通り `tag` は落ちる | 未知のキー・メールでない宛先 |
| `infraValues` | キーの無い設定で既定 | — | — |
| `dbPrepCompletionRequest` | 3 つの `result` | — | `rotation_superseded` で `recorded_seq` が無い・`create` で `rotation_seq` がある |

## 網

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
| `ProgressDb` の `constructor` | `infra/lib/progress-db.ts` | 新設 | `(scope, id, props: { network: Network; maxAcu: number; names: AppResourceNames })` | Aurora PostgreSQL 16.13・出口の無いサブネット・`ClusterInstance.serverlessV2` の書き手 1 台・最小 0・最大 `maxAcu`・自動の一時停止 300 秒・削除の保護・`RemovalPolicy.RETAIN`・管理の役割 `nd_admin` の生成した秘密の器 `<prefix>/<environment>/progress-db-admin`・保存の暗号化 |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `ProgressDb` | 合成の出力に最小 0・最大 2・一時停止 300 秒・書き手 1 台 | `maxAcu` 16 | — |

## タスクの土台

満たす決定: 決定 5・11、受け入れ条件 2・3・4

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `TaskPlatform` の `constructor` | `infra/lib/tasks.ts` | 新設 | `(scope, id, props: { network: Network; names: AppResourceNames })` | ECS のクラスタ（Container Insights なし）・タスクの実行の役割（ECR の取得とログの書き込みだけ）・DB の用意のタスクの定義（族 `<prefix>-<environment>-db-prep`・`DB_PREP_TASK_SIZE`・x86_64・非 root・イメージは `apps/db-prep/Dockerfile` の資産）・タスクの役割（文なし）・ログの群（30 日） |
| `RUNNER_TASK_SIZE`・`DB_PREP_TASK_SIZE` | 同上 | 新設 | `{ cpu: 1024, memoryMiB: 2048 }`・`{ cpu: 256, memoryMiB: 512 }` | 既定の大きさ。ランナーの値は #6 がタスクの定義で使う |
| `TaskPlatform` の公開の値 | 同上 | 新設 | `cluster`・`executionRole`・`publicSubnets`・`taskSecurityGroup`・`dbPrepTaskDefinition` | #6 が API の関数へ `RunTask` の値として渡す |

- 事後条件: `AWS::ECS::Service`・`AWS::ECS::TaskSet` を作らない。タスクの役割に `Policies` も `ManagedPolicyArns` も無い
- イメージの資産のビルドの文脈はリポジトリの最上位で、`.dockerignore` の代わりに資産の `exclude` で `apps/db-prep` と `packages/contracts` と錠のファイルだけを入れる（要約値の入力を絞る）

## 費用の見張り

満たす決定: 決定 6、受け入れ条件 4

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `CostWatch` の `constructor` | `infra/lib/cost-watch.ts` | 新設 | `(scope, id, props: { budgetUsd: number; budgetScope: "tags" \| "account"; emails: string[]; tags: { prefix: string; env: string }; names: AppResourceNames })` | SNS のトピック `<prefix>-<environment>-ops`（予算のサービスに発行を許す方針つき）・宛先ごとのメールの購読（空なら作らない）・予算 `<prefix>-<environment>-budget`（月・費用・USD。`budgetScope` が `tags` ならタグ `user:app-prefix$<prefix>` と `user:app-env$<environment>` で絞り、`account` なら絞らない）・実績 80%・100%・見込み 100% の 3 つの知らせをトピックへ |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `CostWatch` | 予算の額・3 つの知らせ・タグの絞り | 宛先 0 件で購読が 0 件。`account` で `CostFilters` も `FilterExpression` も無い | — |

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
| `task_role_statement` | タスクの定義の `TaskRoleArn` が指す役割の `Policies`・`ManagedPolicyArns`、またはその役割へ付く `AWS::IAM::Policy` |
| `aurora_min` | `ServerlessV2ScalingConfiguration.MinCapacity` が 0 でない `AWS::RDS::DBCluster` |
| `deletable` | `DeletionPolicy` が `Retain` でない表・バケット・クラスタ（画面の配信のバケットは残す設定で同じに照らす） |
| `pitr` | `PointInTimeRecoverySpecification` が有効でない表 |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `stackRuleViolations` | 今の `AppStack` で 0 件 | — | 決まりごとに違反を 1 つ足した合成の出力で、その決まりの 1 件だけを返す（8 通り） |
| `hourlyCostResources` | 許しの条件を満たす Aurora を返さない | — | 最小 0.5・一時停止なし・読み手 1 台で返す |

## 設置のコマンド

満たす決定: 決定 1・2・6・12、受け入れ条件 5・9

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `MISSING_CHECKS` | `infra/setup/missing-settings.ts` | 新設 | `readonly MissingCheck[]`（`MissingCheck = (ctx: MissingContext) => Promise<MissingItem[]>`） | 5 種類の照らし。ほかの子は配列へ足すだけ |
| `collectMissingSettings` | 同上 | 新設 | `(ctx: MissingContext, checks: readonly MissingCheck[]) => Promise<MissingItem[]>` | 照らしを順に打ち、結果を並べる。1 つの照らしの失敗は「確かめられない」の 1 行にする |
| `printMissingSettings` | 同上 | 新設 | `(items: MissingItem[], out: (line: string) => void) => void` | 「足りない設定:」の見出しと 1 件 1 行。0 件なら「足りない設定: 無し」 |
| `readCostAllocationTags` | `infra/setup/aws-reader.ts` | 新設 | `(target: Target, keys: string[]) => Promise<Record<string, "Active" \| "Inactive" \| "Missing">>` | `ListCostAllocationTags` でタグの状態を読む |
| `readOrganizationManager` | 同上 | 新設 | `(target: Target) => Promise<{ member: boolean; managementAccount: string \| null } \| "unknown">` | `DescribeOrganization` で組織の管理のアカウントを読む。組織に入っていなければ `member: false`。権限が無ければ `unknown` |
| `readGetAzsCount` | 同上 | 新設 | `(target: Target) => Promise<number>` | `DescribeSubnets`（`default-for-az=true`）で既定のサブネットのある AZ を数え、0 なら `DescribeAvailabilityZones`（`state=available`・種類 `availability-zone`）の数を返す。`Fn::GetAZs` が返す数の見なし（LIB6） |
| `runDiff` | `infra/setup/nd-setup.ts` | 変更 | 変えない | 確認の値を出した後に `collectMissingSettings` と `printMissingSettings` を打つ。終了コードは変えない |
| `parseArgs` | 同上 | 変更 | 戻り値に `GcArgs` を足す | `gc --profile <p> [--confirm <値>] [--rollback-buffer-days <日数>]` を読む。日数は 1〜365 の整数（既定 30） |
| `mainSetup` | 同上 | 変更 | 変えない | `gc` を `runGc` へ振り分ける |
| `gcConfirmValue` | `infra/setup/gc.ts` | 新設 | `(target: Target, days: number) => string` | アカウント・リージョン・猶予の日数から確認の値を作る（`deploy` の確認の値と同じ短い要約値の形） |
| `gcCliArgs` | 同上 | 新設 | `(mode: "print" \| "full", target: Target, days: number) => string[]` | `cdk gc aws://<アカウント>/<リージョン> --unstable=gc --type=all --action=<mode> --rollback-buffer-days=<日数> --created-buffer-days=1 --confirm=false --profile <profile>` |
| `runGc` | 同上 | 新設 | `(a: GcArgs, deps: SetupDeps) => Promise<number>` | 確認の値なしは `print` を打って数と確認の値を示す。確認の値があれば照らし、同じときだけ `full` を打つ |

- `SetupDeps` に `readCostAllocationTags`・`readOrganizationManager`・`readGetAzsCount` と `hasDocker: () => Promise<boolean>` を足す（テストは本物の AWS と Docker を呼ばない）
- `MISSING_CHECKS` の 5 種類: Google のクライアントの ID が無い・`budget.scope` が `tags` でタグ `app-prefix`・`app-env` が `Active` でない（下のタグの行。読めなければ「確かめられない（`ce:ListCostAllocationTags` を許した profile で読む）」。`account` なら照らさない）・`ops.notify_emails` が空・`docker version` が 0 で終わらない・`readGetAzsCount` が 2 未満（「`Fn::GetAZs` が返す AZ が <数> つで、反映が網を作れずに止まる。既定の VPC の別の AZ に既定のサブネットを作る（`aws ec2 create-default-subnet --availability-zone <AZ>`）か、既定のサブネットをすべて消す」。読めなければ「確かめられない（`ec2:DescribeSubnets`・`ec2:DescribeAvailabilityZones` を許した profile で読む）」）

- タグの行の文（設計文書の決定 6）: 「コスト配分タグ <有効でないタグ> が有効でない。有効になるまで予算は 0 を数え続け、予算の知らせは鳴らない。有効にする先: <先>。有効にできなければ設定のファイルの `budget.scope` を `account` にする（アカウントの全体を数える）」。<先> は `readOrganizationManager` が `member: false` なら「このアカウント（請求の画面のコスト配分タグ）」、`member: true` なら「組織の管理のアカウント <ID>（メンバーのアカウントでは有効にできない）」、`unknown` なら「組織に入っていなければこのアカウント、組織のメンバーなら組織の管理のアカウント」

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `readCostAllocationTags` | 読めない | 権限が無い・組織の制限 | SDK の例外 | 「確かめられない」の 1 行で続ける | 一覧の 1 行。終了コードは変えない | 何も書いていない。再実行できる |
| `runGc` | profile を解けない | 資格情報・リージョンが無い | `resolveProfile` | 止める | 今の `diff` と同じ文と終了コード | 再実行できる |
| `runGc` | 確認の値が違う | 別のアカウント・猶予の日数を変えた | `gcConfirmValue` との比べ | CLI を呼ばずに止める | 確認の値が違うと示し、今の `deploy` と同じ終了コード | 何も消していない |
| `runGc` | CLI が 0 以外で終わる | 権限・引数の変化・網 | 終了コード | 止める | CLI の出力をそのまま流し、`EXIT.BUILD` | タグを付けた分は残る。次の打ち直しで続く |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `collectMissingSettings` | 5 種類が当たる入力でそれぞれ 1 行。タグの行の <先> が `member: false`・`member: true`・`unknown` で 3 通りに変わる。`budget.scope` が `account` ならタグの行が出ない | 0 件で「無し」。AZ の数 2 で行が出ず 1 で出る | 照らしが投げると「確かめられない」の 1 行 |
| `readGetAzsCount` | 既定のサブネットが 3 つの AZ にあれば 3 | 既定のサブネットが 1 つの AZ にだけあれば、使える AZ が 3 つでも 1。既定のサブネットが無ければ使える AZ の数 | — |
| `runDiff` | 出力の最後に一覧の欄 | — | 足りない設定があっても終了コード 0 |
| `parseArgs` | `gc` の 3 つの形 | 日数 1・365 は通り 0・366 は落ちる | `--profile` が無い |
| `runGc` | 確認の値なしで `print` だけを打つ・同じ確認の値で `full` を打つ | — | 違う確認の値で CLI を呼ばない・CLI の失敗で `EXIT.BUILD` |
| `gc-cli.test.ts` | 固定の版の `cdk gc --help` に `gcCliArgs` が使う 6 つの引数がある | — | 引数の名前が変わると落ちる |

## 反映のパイプライン

満たす決定: 決定 11

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `PipelineStack` の `constructor` | `infra/lib/pipeline-stack.ts` | 変更 | 変えない | 反映のアクションの CodeBuild を `privileged: true` にし、引き受けられる bootstrap の役割に `image-publishing` を足す。準備のアクションは変えない |

`docs/operations/setup.md` の前提の表に Docker（`deploy` を打つ端末）を足し、手順に「イメージの資産を初めて入れる版は、パイプラインのスタックを先に反映する」と「`gc` を月に 1 回、反映と同時でない時に打つ」を足す。

## DB の用意のタスク

満たす決定: 決定 8・9、受け入れ条件 1・I10

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `main` | `apps/db-prep/src/main.ts` | 新設 | `(env: NodeJS.ProcessEnv, deps: PrepDeps) => Promise<number>` | 引き換え → `kind` で用意か差し替え → 終わりの報告。終了コードは報告できたら 0 |
| `readTaskArn` | `apps/db-prep/src/exchange.ts` | 新設 | `(metadataUri: string, fetchFn: typeof fetch) => Promise<string>` | `${ECS_CONTAINER_METADATA_URI_V4}/task` の `TaskARN` を読む |
| `exchange` | 同上 | 新設 | `(apiUrl: string, token: string, taskArn: string, fetchFn) => Promise<ExchangeResult>` | `/v1/db_prep/exchanges/create` を 1 回だけ呼び、応答を形の正本で照らす |
| `complete` | 同上 | 新設 | `(apiUrl: string, completionToken: string, body: DbPrepCompletion, fetchFn) => Promise<void>` | `/v1/db_prep/completions/create` を呼ぶ。届いたか分からない失敗だけを 3 回まで繰り返す（同じ本文は API で冪等） |
| `connectAdmin` | `apps/db-prep/src/provision.ts` | 新設 | `(admin: AdminConnection, opts: { attempts: number; delayMs: number }) => Promise<pg.Client>` | Aurora の再開を待って管理の接続を開く（既定 12 回・5 秒おき = 約 60 秒） |
| `checkIsolationGuard` | 同上 | 新設 | `(client: pg.Client, project: ProjectIdent) => Promise<"ok" \| "conflict">` | データベースか役割が、渡されたもの以外へ `CONNECT` で結ばれていれば `conflict` |
| `provisionProject` | 同上 | 新設 | `(client: pg.Client, connectTo: (database: string) => Promise<pg.Client>, project: ProjectIdent & { password: string }) => Promise<void>` | [用意の手順](../docs/design/data.md#用意の手順) の 1〜6。何度打っても同じ結果になる |
| `rotateRole` | `apps/db-prep/src/rotate.ts` | 新設 | `(client: pg.Client, project: ProjectIdent & { password: string; seq: number }) => Promise<RotateResult>` | 1 つのトランザクションで `pg_advisory_xact_lock(hashtext('nd-rotate:' \|\| role))` を取り、`nd_prep.rotation_seq` の記した番号と n を比べ、小さいときだけパスワードと番号を書く。結果は `applied`・`superseded_equal`・`superseded_greater` と記した番号 |
| `terminateRoleConnections` | 同上 | 新設 | `(client: pg.Client, role: string) => Promise<number>` | 役割の接続を切り、残りの数を読み直して返す |

- `main`
  - 事前条件: 環境の上書きで `ND_DB_PREP_API_URL` と `ND_DB_PREP_EXCHANGE_TOKEN` が渡っている
  - 副作用: PostgreSQL への DDL と API への 2 回の要求。秘密の器・ファイル・AWS の API には触れない
- 識別子は `pg` の `escapeIdentifier`、パスワードは `escapeLiteral` で組む（`CREATE ROLE … PASSWORD` は引数の束縛を受けないため）

### 処理の手順

| 関数 | 条件の組み合わせ | 結果 |
| --- | --- | --- |
| `main` | 引き換えが 401・409 | 終わりを知らせずに終了コード 1（API が見回りで扱う） |
| `main` | `create` で守りが `conflict` | 何も書かずに `failed`・`guard_conflict` |
| `main` | `rotate` で `superseded_greater` | 接続を切らずに `rotation_superseded`（記した番号） |
| `main` | `rotate` で `applied` か `superseded_equal` | `terminateRoleConnections` の残りが 0 なら `applied` か `rotation_superseded`、1 以上なら `failed`・`connections_remain` |
| `checkIsolationGuard` | データベースが無い・役割が無い | `ok`（作り直しで片方だけあるときも、結び付きが渡されたものだけなら `ok`） |

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `readTaskArn` | 読めない | 端点が無い（ECS の外） | `fetch` の失敗 | 止める | ログに理由、終了コード 1 | 何も書いていない。見回りが時間切れで扱う |
| `connectAdmin` | 開けない | Aurora の再開の遅れ・網 | 再試行の尽き | `failed`・`admin_connect_failed` を報告 | 終了コード 0 | 見回りが起こし直す |
| `provisionProject` | SQL の失敗 | 権限・名前の衝突 | `pg` の例外 | `failed`・`sql_failed` を報告 | ログに SQLSTATE だけ（値は出さない） | 手順は何度打っても同じ結果。起こし直しで続く |
| `complete` | 届かない | 網・API の 5xx | 再試行の尽き | 止める | 終了コード 1 | API は用意の ID で冪等。見回りが時間切れで扱う |

### 並行と排他

| 同時に走りうる処理 | 共有する資源 | 排他の取り方 | 冪等性と中断からの再開 |
| --- | --- | --- | --- |
| 同じ役割の 2 つの差し替えのタスク | 役割のパスワードと `nd_prep.rotation_seq` | `pg_advisory_xact_lock`（STD83） | 番号の比べで古い方は書かない（I17） |
| 同じプロジェクトの作成の打ち直し | データベースと役割 | API の用意の ID（I18）と、手順が何度打っても同じ結果 | 起こし直しで続く |

### ログと記録の出力

| 関数 | 出すもの | レベルまたは書き先 | 出さないもの |
| --- | --- | --- | --- |
| `main` | 用意の ID・種類・結果・理由のコード・所要時間 | 標準出力の JSON の 1 行（ログの群へ） | パスワード・管理の接続の値・token・データベースと役割の名前 |

### 既存の部品の再利用

| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `complete` の再試行 | `callHttp`（[詳細設計の横断の部品](../docs/design/detail.md)） | `ls packages/` | 使えない。`packages/core` は #2 が作り、まだ無い。#2 の後に置き換える（`out-of-scope` で起票しない。#2 の境界の検査が拾う） |
| 識別子の組み立て | `pg` の `escapeIdentifier` | LIB3 | 使う |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `provisionProject`（PostgreSQL のサービスコンテナ） | 2 つのプロジェクトを作り、A の役割で A へ接続できる | 同じ値で 2 回打っても同じ結果 | A の役割で B・`postgres`・`template1` へ接続できると落ちる。A の役割で `pg_database` と `pg_roles` から B の名前が読めると落ちる |
| `checkIsolationGuard` | 新しい名前で `ok` | 作り直し（片方だけある）で `ok` | B のデータベースに A の役割を渡す・A の役割に B のデータベースを渡すと `conflict` |
| `rotateRole` | 記した番号 < n で書く | 記した番号 = n で書かない | 記した番号 > n で何も変えない。2 つを同時に打って番号の大きい方だけが残る |
| `exchange`・`complete` | 形の正本に合う応答 | — | 形の違う応答を誤りにする・401 で再試行しない |
| `main` | 処理の手順の表の 5 行 | — | パスワードがログに出ると落ちる |

CI の `check` のジョブに `postgres:16`（要約値で固定）のサービスコンテナを置き、接続の値を `ND_TEST_PG_URL` で渡す。値が無いとき、`CI` が真なら DB のテストは落ち、手元では飛ばす（このリポジトリはテストを CI に寄せる）。

## 実測と戻しの予行の手順

満たす決定: 決定 1・10・13、受け入れ条件 6・7・9

リリース承認ゲートの承認の後、運用する人が反映した環境で行い、結果を #13 のリリース後テストのコメントと、全体の設計の費用の見込み・未確認のまま残ることへ返す。値はリポジトリと課題に書かず、比と時間と回数だけを書く。接続する項目は #44 が受ける。

| # | 項目 | 手順 | 合格の目安 |
| --- | --- | --- | --- |
| M1 | 接続の無い間の一時停止 | 反映の後 3 日、CloudWatch の `ServerlessDatabaseCapacity` を 5 分の粒度で読み、0 でない時間の合計と起きた回数を数える | 0 でない時間が保守の起き上がり（1 回 20 分程度）だけ |
| M2 | 単価 | EventBridge Scheduler・DynamoDB の PITR とストリームの単価の頁を、設置したリージョンで読む | 見込みの額への効きを全体の設計の見込みに書く |
| M3 | `gc` | 反映の後に `gc` を打って数と確認の値を読み、確認の値つきで打つ。戻しの予行の後にもう一度打ち、猶予の間の前の版の資産が消えないことを読む | 猶予の内の資産が残る |
| M4 | 戻しの予行 | 決定 10 の手順。前の合成の結果を `deploy` し、表の項目・Aurora のクラスタ・確認の値の照らしを読む | 状態を持つ資源が残り、確認の値の違う `deploy` が止まる |
| M5 | 予算と運用の知らせ | 予算を 1 ドルにした設定で `diff`・`deploy` し、知らせのメールが届くことを読んだ後に戻す | 宛先に届く |
