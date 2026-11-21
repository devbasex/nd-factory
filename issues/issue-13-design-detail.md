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
├── data/exit-codes.json
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
| `infra/setup/gc.ts` | 新設 | 古い資産の片付け | `nd-setup` の型 | モジュール | `gcConfirmValue`・`checkGcConfirmTarget`・`checkGcConfirmCounts`・`parseGcPrint`・`gcCliArgs`・`runGc` |
| `packages/contracts/data/exit-codes.json` | 変更 | 終了コード 9 `GC_BUSY` を足す（`setup.md` の表は生成） | — | — | — |
| `infra/setup/aws-reader.ts` | 変更 | コスト配分タグ・組織・AZ・スタックの更新の状態を読む | AWS SDK（Cost Explorer・Organizations・EC2・CloudFormation） | モジュール | `readCostAllocationTags`・`readOrganizationManager`・`readGetAzsCount`・`readStackActivity`（新設） |
| `infra/setup/nd-setup.ts` | 変更 | `gc` の引数と振り分け・`diff` の最後に一覧を出す | 上の 2 つ | モジュール | `parseArgs`・`runDiff`・`mainSetup`・`defaultDeps`（変更） |
| `infra/test/support.ts` | 変更 | スタックの決まりの検査 | — | モジュール | `stackRuleViolations`（新設）・`hourlyCostResources`（変更） |
| `apps/db-prep/src/main.ts` | 新設 | タスクの入口。引き換え → 用意か差し替え → 終わりの報告 | 下の 3 つ・contracts | モジュール | `main` |
| `apps/db-prep/src/exchange.ts` | 新設 | タスクの ID を読み、API と話す | contracts | モジュール | `readTaskArn`・`exchange`・`complete` |
| `apps/db-prep/src/provision.ts` | 新設 | 管理の接続・I10 の守り・用意の手順の 1〜6 | `pg` | モジュール | `connectAdmin`・`claimBinding`・`checkIsolationGuard`・`provisionProject` |
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
  - `kind` が `rotate` のときだけ `project.rotation_seq` を必須にし、`create` で持てば誤りにする。データベースと役割の名前は `PROGRESS_DB_IDENT_SHAPE`（`^[a-z][a-z0-9_]{7,62}$`）に合う。`project.id` はプロジェクトの ID（データの文書のプロジェクトの集約の ID と同じ形）で、`create` と `rotate` のどちらも必須
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
| `readStackActivity` | `infra/setup/aws-reader.ts` | 新設 | `(target: Target) => Promise<{ name: string; status: string; lastUpdated: Date }[]>` | `ListStacks` で消えていないスタックの名前・状態・最後の更新の時刻を読む |
| `mainSetup` | 同上 | 変更 | 変えない | `gc` を `runGc` へ振り分ける |
| `gcConfirmValue` | `infra/setup/gc.ts` | 新設 | `(target: Target, days: number, isolated: { images: number; files: number }, issuedAt: Date) => string` | `<条件の要約値 8 桁>-<数の要約値 8 桁>:<発行の時刻（UTC、`yyyymmddThhmmZ`）>` を作る。条件の要約値はアカウント・リージョン・猶予の日数・発行の時刻から作り、数の要約値は条件の要約値と使われていない資産の 2 つの数から作る。2 つに分けるのは、`print` を打つ前に対象と猶予を照らし、`print` の後に数だけを照らすため |
| `checkGcConfirmTarget` | 同上 | 新設 | `(value: string, target: Target, days: number, now: Date) => "ok" \| "mismatch" \| "expired"` | 値の形を読み、発行の時刻と今の対象・日数で条件の要約値を作り直して比べる。形が違うか条件の要約値が違えば `mismatch`。合っていて発行から 60 分を過ぎていれば `expired`。数は読まない（`print` の前に打つ） |
| `checkGcConfirmCounts` | 同上 | 新設 | `(value: string, isolated: { images: number; files: number }) => "ok" \| "changed"` | `checkGcConfirmTarget` が `ok` を返した値について、今の数で数の要約値を作り直して比べる。違えば `changed`（対象と猶予は既に合っているため、違いは数の変化だけによる） |
| `parseGcPrint` | 同上 | 新設 | `(output: string) => { images: number; files: number }` | `print` の出力から使われていない資産の数を読む。固定の版の CLI はファイル（S3）・イメージ（ECR）の順に、それぞれ最後に `[100.00%] … files scanned: <数> assets (…) eligible for deletion.` を出す。CLI の語は「消せる」だが数は猶予の内を含む使われていない資産で、設置のコマンドは「使われていない資産」と言い換えて示す。読めなければ投げる（CLI の版の変化。`gc-cli.test.ts` が出力の形も照らす） |
| `gcCliArgs` | 同上 | 新設 | `(mode: "print" \| "full", target: Target, days: number) => string[]` | `cdk gc aws://<アカウント>/<リージョン> --unstable=gc --type=all --action=<mode> --rollback-buffer-days=<日数> --created-buffer-days=1 --confirm=<print なら false、full なら true> --profile <profile>` |
| `runGc` | 同上 | 新設 | `(a: GcArgs, deps: SetupDeps) => Promise<number>` | 下の「`runGc` の手順」 |

- `SetupDeps` に `readCostAllocationTags`・`readOrganizationManager`・`readGetAzsCount`・`readStackActivity`・`hasDocker: () => Promise<boolean>`・`isTty: () => boolean`・`now: () => Date` を足す（テストは本物の AWS と Docker を呼ばない）
- `MISSING_CHECKS` の 5 種類: Google のクライアントの ID が無い・`budget.scope` が `tags` でタグ `app-prefix`・`app-env` が `Active` でない（下のタグの行と、読めないときの行。`account` なら照らさない）・`ops.notify_emails` が空・`docker version` が 0 で終わらない・`readGetAzsCount` が 2 未満（「`Fn::GetAZs` が返す AZ が <数> つで、反映が網を作れずに止まる。既定の VPC の別の AZ に既定のサブネットを作る（`aws ec2 create-default-subnet --availability-zone <AZ>`）か、既定のサブネットをすべて消す」。読めなければ「確かめられない（`ec2:DescribeSubnets`・`ec2:DescribeAvailabilityZones` を許した profile で読む）」）

- 読めないときの行の文（設計文書の決定 12）: 「コスト配分タグ `app-prefix`・`app-env` が有効かを確かめられない。有効でなければ予算は 0 を数え続け、予算の知らせは鳴らない。次の操作: <操作>」。読めない原因は SDK の例外だけでは権限の不足と組織の制限を分けられないため、`readOrganizationManager` で分ける。<操作> は、`member: false` なら「`ce:ListCostAllocationTags` を許した profile で `diff` を打ち直す」、`member: true` なら「組織の管理のアカウント <ID> にタグの有効化を確かめて頼む（メンバーのアカウントでは権限を足しても有効にできない）。頼めなければ設定のファイルの `budget.scope` を `account` にする」、`unknown` なら両方を「組織に入っていなければ …。組織のメンバーなら …」の 2 つに分けて示す（管理のアカウントの ID は「組織の管理のアカウント」とだけ示す）
- タグの行の文（設計文書の決定 6）: 「コスト配分タグ <有効でないタグ> が有効でない。有効になるまで予算は 0 を数え続け、予算の知らせは鳴らない。有効にする先: <先>。有効にできなければ設定のファイルの `budget.scope` を `account` にする（アカウントの全体を数える）」。<先> は `readOrganizationManager` が `member: false` なら「このアカウント（請求の画面のコスト配分タグ）」、`member: true` なら「組織の管理のアカウント <ID>（メンバーのアカウントでは有効にできない）」、`unknown` なら「組織に入っていなければこのアカウント、組織のメンバーなら組織の管理のアカウント」

### `runGc` の手順

更新の途中のスタックとは、`readStackActivity` の状態が `_IN_PROGRESS` で終わるもの（`REVIEW_IN_PROGRESS` を含む）である。

| 段 | 確認の値なし | 確認の値あり |
| --- | --- | --- |
| 1 | profile を解く | profile を解く。`isTty()` が偽なら 2 で止まる（CLI の確かめが既定の答えで消すため） |
| 2 | 更新の途中のスタックがあれば名前を示して 9 で止まる | `checkGcConfirmTarget` で対象と猶予と期限を照らす。`mismatch` か `expired` なら CLI を呼ばずに 7 で止まる（`mismatch` は「アカウント・リージョン・猶予の日数のどれかが 1 段目と違う」、`expired` は「1 段目から打ち直す」と示す）。資産の数はここでは読まない |
| 3 | `print` を打ち、`parseGcPrint` で数を読む | 更新の途中のスタックがあれば 9 で止まる |
| 4 | 「使われていない資産: イメージ <数>・ファイル <数>（猶予の内のものを含む。消える数ではない）」「戻しの猶予: <日数> 日・作った日の猶予: 1 日」「猶予を満了して消す資産の数は、確認の値つきで打つと CLI が一まとまりごとに示し、答えを求める」「確認の値: <値>（<時刻> まで有効）」を示して 0 で終わる | `print` を打ち、`parseGcPrint` で読んだ数を `checkGcConfirmCounts` で照らす。`changed` なら、今の数と新しい確認の値を示して 7 で止まる（何も消していない） |
| 5 | — | `readStackActivity` を読み直し、更新の途中のスタックがあれば名前を示して `full` を呼ばずに 9 で止まる（段 3 の照らしと `print` の間に始まった更新を拾う。何も消していない） |
| 6 | — | `gc` の開始の時刻を控え、`full` を `--confirm=true` で打つ。CLI の確かめの問いと答えは端末へそのまま通す |
| 7 | — | `readStackActivity` を読み直し、更新の途中のスタックか、最後の更新が開始の時刻より後のスタックがあれば、名前と「その反映が終わった後に `diff` から打ち直す（消えた資産を発行し直す）」を示す。終了コードは CLI のとおり |

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `readCostAllocationTags` | 読めない | 権限が無い・組織の制限 | SDK の例外 | `readOrganizationManager` で原因を分け、「確かめられない」の 1 行に次の操作を添えて続ける | 一覧の 1 行（権限の不足なら profile の権限、組織のメンバーなら管理のアカウントへの依頼と `budget.scope: account`、分からなければ両方）。終了コードは変えない | 何も書いていない。再実行できる |
| `runGc` | profile を解けない | 資格情報・リージョンが無い | `resolveProfile` | 止める | 今の `diff` と同じ文と終了コード | 再実行できる |
| `runGc` | 確認の値が違う | 別のアカウント・リージョン・猶予の日数を変えた・値の形が違う | `checkGcConfirmTarget` の `mismatch`（`print` の前） | CLI を呼ばずに止める | 確認の値が違うと示し、今の `deploy` と同じ終了コード | 何も消していない |
| `runGc` | 確認の値が古い | 発行から 60 分を過ぎた・以前に得た値の使い回し | `checkGcConfirmTarget` の `expired`（`print` の前） | CLI を呼ばずに止める | 1 段目から打ち直すと示し、7 | 何も消していない |
| `runGc` | 使われていない資産が変わった | 1 段目の後に反映か削除があった | `checkGcConfirmCounts` の `changed`（`print` の後） | `full` を呼ばずに止める | 今の数と新しい確認の値を示し、7 | 何も消していない。新しい値で打ち直す |
| `runGc` | 更新の途中のスタックがある | 反映・戻し・変更セットの待ち | `readStackActivity`（段 3 と、`full` の直前の段 5） | CLI か `full` を呼ばずに止める | スタックの名前を示し、9 | 何も消していない。反映が終わった後に打ち直す |
| `runGc` | 端末でない | CI・パイプ・リダイレクト | `isTty` | 止める | 「端末から打つ」と示し、2 | 何も消していない |
| `runGc` | 設置する人が CLI の問いに `n` を答えた | — | CLI の終了 | 止める | CLI の出力をそのまま流し、`EXIT.BUILD` | 答える前の一まとまりは消えている。打ち直しで残りを示し直す |
| `runGc` | CLI が 0 以外で終わる | 権限・引数の変化・網 | 終了コード | 止める | CLI の出力をそのまま流し、`EXIT.BUILD` | タグを付けた分は残る。次の打ち直しで続く |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `collectMissingSettings` | 5 種類が当たる入力でそれぞれ 1 行。タグの行の <先> が `member: false`・`member: true`・`unknown` で 3 通りに変わる。タグを読めないときの行の <操作> も同じ 3 通りに変わり、`member: true` と `unknown` で管理のアカウントへの依頼と `budget.scope` の `account` が出る。`budget.scope` が `account` ならタグの行が出ない | 0 件で「無し」。AZ の数 2 で行が出ず 1 で出る | 照らしが投げると「確かめられない」の 1 行 |
| `readGetAzsCount` | 既定のサブネットが 3 つの AZ にあれば 3 | 既定のサブネットが 1 つの AZ にだけあれば、使える AZ が 3 つでも 1。既定のサブネットが無ければ使える AZ の数 | — |
| `runDiff` | 出力の最後に一覧の欄 | — | 足りない設定があっても終了コード 0 |
| `parseArgs` | `gc` の 3 つの形 | 日数 1・365 は通り 0・366 は落ちる | `--profile` が無い |
| `checkGcConfirmTarget`・`checkGcConfirmCounts` | 同じ対象・日数・数で `ok` | 発行から 60 分ちょうどは通り 60 分 1 秒は `expired` | 日数かアカウントが違えば数を渡さずに `mismatch`・形の壊れた値で `mismatch`・対象と日数が同じで数だけが違えば `changed` |
| `runGc` | 確認の値なしで `print` だけを打つ・同じ確認の値で `full` を `--confirm=true` で打つ | — | 違う確認の値で CLI を（`print` も）呼ばない・同じ条件で以前に得た値（発行の時刻が古い）で `full` を呼ばない・数が変わると `full` を呼ばずに新しい値を示す・更新の途中のスタック（`UPDATE_IN_PROGRESS`・`REVIEW_IN_PROGRESS`）があると 9 で CLI を呼ばない・段 3 の照らしの後、`print` の間に更新が始まると（2 回目の `readStackActivity` が `UPDATE_IN_PROGRESS` を返す）9 で `full` を呼ばない・端末でないと 2・`full` の後に開始より後に更新したスタックがあると打ち直しを示す・CLI の失敗で `EXIT.BUILD` |
| `parseGcPrint` | 固定の版の `print` の出力の見本から 2 つの数を読む | 0 件 | 形の違う出力で投げる |
| `gc-cli.test.ts` | 固定の版の `cdk gc --help` に `gcCliArgs` が使う 6 つの引数がある。`parseGcPrint` が読む出力の形と、確かめの問いの文（「猶予を満了して消す数」を示す）が固定の版の CLI にある | — | 引数の名前・出力の形・問いの文が変わると落ちる |

## 反映のパイプライン

満たす決定: 決定 11

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `PipelineStack` の `constructor` | `infra/lib/pipeline-stack.ts` | 変更 | 変えない | 反映のアクションの CodeBuild を `privileged: true` にし、引き受けられる bootstrap の役割に `image-publishing` を足す。準備のアクションは変えない |

`docs/operations/setup.md` の前提の表に Docker（`deploy` を打つ端末）を足し、手順に「イメージの資産を初めて入れる版は、パイプラインのスタックを先に反映する」と「`gc` を月に 1 回、反映と同時でない時に打つ」を足す。あわせて、先の反映の前に保存するもの・戻しを始める条件・前の版へ戻す 4 つの段（設計文書の決定 11）を、運用する環境の節に手順として写す。

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
| `claimBinding` | 同上 | 新設 | `(client: pg.Client, project: ProjectIdent) => Promise<"bound" \| "retry" \| "conflict">` | 1 つのトランザクションで `pg_advisory_xact_lock(hashtext('nd-prep:bindings'))` を取り、`nd_prep.bindings`（`project_id` 主キー・`database_name` 一意・`role_name` 一意・`bound_at`）を `project_id`・`database_name`・`role_name` のどれかで引く。下の処理の手順の表で分ける。`bound` のときだけ行を足す。データベースと役割を作る前に打つ |
| `checkIsolationGuard` | 同上 | 新設 | `(client: pg.Client, project: ProjectIdent) => Promise<"ok" \| "conflict">` | データベースか役割が、渡されたもの以外へ `CONNECT` で結ばれていれば `conflict`（`claimBinding` の後に打つ二重の守り） |
| `provisionProject` | 同上 | 新設 | `(client: pg.Client, connectTo: (database: string) => Promise<pg.Client>, project: ProjectIdent & { password: string }) => Promise<void>` | [用意の手順](../docs/design/data.md#用意の手順) の 1〜6。何度打っても同じ結果になる |
| `rotateRole` | `apps/db-prep/src/rotate.ts` | 新設 | `(client: pg.Client, project: ProjectIdent & { password: string; seq: number }) => Promise<RotateResult>` | 1 つのトランザクションで `pg_advisory_xact_lock(hashtext('nd-rotate:' \|\| role))` を取り、`nd_prep.rotation_seq` の記した番号と n を比べ、小さいときだけパスワード・番号・書いた時刻を書き、境の時刻 `old_conn_cutoff` を空にする。結果は `applied`・`superseded_equal`・`superseded_greater` と記した番号 |
| `terminateRoleConnections` | 同上 | 新設 | `(client: pg.Client, role: string, seq: number) => Promise<{ kind: "done"; remaining: number } \| { kind: "superseded_greater"; recorded: number }>` | `rotateRole` のトランザクションが確定した後に、別のトランザクションで同じ排他の鎖を取る。記した番号が n より大きければ何も切らずに `superseded_greater`。番号 n の行の `old_conn_cutoff` が空なら `clock_timestamp()` を記す。`pg_stat_activity` のうち、その役割で `backend_start` が `old_conn_cutoff` より前の接続だけを `pg_terminate_backend` で切り、同じ条件の残りの数を読み直して返す |

- `main`
  - 事前条件: 環境の上書きで `ND_DB_PREP_API_URL` と `ND_DB_PREP_EXCHANGE_TOKEN` が渡っている
  - 副作用: PostgreSQL への DDL と API への 2 回の要求。秘密の器・ファイル・AWS の API には触れない
- 識別子は `pg` の `escapeIdentifier`、パスワードは `escapeLiteral` で組む（`CREATE ROLE … PASSWORD` は引数の束縛を受けないため）

### 処理の手順

| 関数 | 条件の組み合わせ | 結果 |
| --- | --- | --- |
| `main` | 引き換えが 401・409 | 終わりを知らせずに終了コード 1（API が見回りで扱う） |
| `main` | `create` で `claimBinding` か `checkIsolationGuard` が `conflict` | 何も書かずに `failed`・`guard_conflict` |
| `main` | `rotate` で `superseded_greater`（`rotateRole` か `terminateRoleConnections` のどちらか） | 接続を切らずに `rotation_superseded`（記した番号） |
| `main` | `rotate` で `applied` か `superseded_equal` | `terminateRoleConnections` の古い接続の残りが 0 なら `applied` か `rotation_superseded`、1 以上なら `failed`・`connections_remain`。境の時刻より後に始まった接続は数えない |
| `claimBinding` | 3 つのどれにも当たる行が無く、データベースも役割も無い | `bound`（行を足す） |
| `claimBinding` | 3 つのどれにも当たる行が無いが、データベースか役割が既にある | `conflict`（結び付きの無い資源） |
| `claimBinding` | 当たる行が 1 つで、3 つの値がすべて同じ | `retry`（途中で止まった作成の打ち直し） |
| `claimBinding` | 当たる行が 1 つで値のどれかが違う、または当たる行が 2 つ以上 | `conflict` |
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
| 同じ番号 n の起こし直しのタスクと、遅れていた前のタスク（順序が逆になる） | 役割の接続 | 切るのは境の時刻 `old_conn_cutoff` より前に始まった接続だけ。境の時刻は、パスワードを書いたトランザクションの確定の後に、最初に切りの段へ来たタスクが排他の鎖の下で記し、後から来たタスクは記された値を使う | 終わりを知らせるのは切りの段の後だけで、API は終わりの知らせを受けてから保留を下ろす（I20）。そのため新しいパスワードの接続はどれも境の時刻より後に始まり、遅れたタスクの切りに当たらない。境の時刻より前に始まった接続は、確定の前に古いパスワードで認証したものだけである |
| 同じプロジェクトの作成の打ち直し | データベースと役割 | API の用意の ID（I18）と、手順が何度打っても同じ結果 | 起こし直しで続く（`claimBinding` は `retry`） |
| 2 つのプロジェクトの作成 | `nd_prep.bindings` | `pg_advisory_xact_lock(hashtext('nd-prep:bindings'))` と表の一意の制約 | 後に来た方が同じ名前を渡せば `conflict` |

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
| `claimBinding`（PostgreSQL のサービスコンテナ） | 新しい名前で `bound` | A の作成をデータベースと役割を作った後・最後の `GRANT` の前で止め、A の打ち直しが `retry` で用意を終える | 途中で止まった A に対し、B が A のデータベースの名前と B の役割・B のデータベースと A の役割・A の 2 つの名前を渡すとどれも `conflict`。行の無い既存のデータベースで `conflict`。2 つを同時に打って片方だけが `bound` |
| `checkIsolationGuard` | 新しい名前で `ok` | 作り直し（片方だけある）で `ok` | B のデータベースに A の役割を渡す・A の役割に B のデータベースを渡すと `conflict` |
| `rotateRole` | 記した番号 < n で書く | 記した番号 = n で書かない | 記した番号 > n で何も変えない。2 つを同時に打って番号の大きい方だけが残る |
| `terminateRoleConnections`（PostgreSQL のサービスコンテナ） | 書く前に開いた役割の接続を切り、残り 0 | 境の時刻が記されていれば記し直さない | 順序の逆転: タスク T1 が番号 n を書いて切りの前で止まり、起こし直しの T2（同じ n）が `superseded_equal`・切り・終わりまで進み、その後に新しいパスワードで接続 C を開き、T1 を再開すると C が切られずに残る（C が切られると落ちる）。T1 が `rotateRole` の前で止まり、T2 が終わって C を開いた後に T1 を最初から打っても C が残る。記した番号が n+1 に上がった後の T1（n）は何も切らずに `superseded_greater` |
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
| M3 | `gc` | 下の「M3 の手順」。段 7 のほかは運用する環境でなく専用の検証先で行う。参照中・猶予の内・猶予を満了した資産をそろえ、満了した分だけが消えることを読む | 下の表の合格の条件をすべて満たす。削除が 1 件も起きなければ不合格 |
| M4 | 戻しの予行 | 決定 10 の手順。戻す前に、Aurora のクラスタの識別子とリソースの ID（`DescribeDBClusters` の `DbClusterResourceId`）・利用者の表の項目の数と作り物の目印の項目 1 件を控える。前の合成の結果を `deploy` し、同じ値を読み直し、確認の値の照らしを読む | クラスタの識別子とリソースの ID が前後で同じ・利用者の表の項目の数と目印の項目が残る・確認の値の違う `deploy` が止まる。プロジェクトのデータベースの残りは確かめない（#44 が受ける） |
| M5 | 予算と運用の知らせ | 予算を 1 ドルにした設定で `diff`・`deploy` し、知らせのメールが届くことを読んだ後に戻す | 宛先に届く |

### M3 の手順

戻しの猶予の既定 30 日を待たずに満了を作るため、予行では `--rollback-buffer-days 1` を使う（作った日の猶予は固定の 1 日）。

**検証先**: `cdk gc` はアカウント・リージョンの全体の資産を見るため、1 日の猶予は A・B・C 以外の資産（運用する環境の戻し用の古い版・同じ bootstrap を使うほかのアプリの資産）も消しうる。そのため段 0〜6 と 60 分・`UPDATE_IN_PROGRESS` の照らしは、運用する環境ではなく、M3 のためだけに用意した検証先で行う。検証先は、nd-factory もほかのアプリも置いていないアカウント（無ければ、どのアプリも置いていないリージョン）を、運用する環境と同じ固定の版の CLI で新しく bootstrap したものとし、設定のファイルは検証先の profile と検証先の名前の接頭辞で作る。`--rollback-buffer-days 1` を運用する環境の profile で打たない。段 7 だけは運用する環境で既定の 30 日で打つ。M3 を終えたら検証先の `app` のスタックと、削除の保護を外したうえで残す設定の資源（Aurora のクラスタ・表・バケット）を消す。

**版の作り方**: 資産は DB の用意のイメージの資産と、API の関数のファイルの資産を使う。タスクの定義の環境の値はテンプレートにしか入らず、資産の要約値を変えないため使わない。版 A・B・C は、取り込まない予行の枝の上で、2 つの資産のビルドの入力をどちらも版ごとに変えて作る。

- イメージ: ビルドの文脈に入る `apps/db-prep` の下の目印のファイル（例 `apps/db-prep/rehearsal-mark.txt`。中身を `A`・`B`・`C` にする）。資産の `exclude` で外れない場所に置く
- ファイル: API の関数が束ねた出力に残る値（例 `apps/api/src/users-handler.ts` の応答のヘッダーに載せる目印の文字列 `A`・`B`・`C`）。コメントや使われない定数は束ねる時の minify で消え、ファイルの資産の要約値が変わらないため使わない

各版で `diff --out <版の置き場>` を打ったら、置き場の `*.assets.json` から app のスタックのイメージの資産の識別子（`dockerImages` のキー）とファイルの資産の識別子（`files` のうち API の関数の zip のキー）を控え、どちらも前の版と違うことを読む。違わなければ反映せずに目印の置き場を直す。反映の後に `GetTemplate` で反映したテンプレートを読み、タスクの定義のイメージの URI のタグと関数の `Code.S3Key` が、控えたその版の識別子と同じであることを読む。版 X の分とは、版 X の `*.assets.json` にあって次の版の `*.assets.json` に無い資産（2 つの識別子に加え、変わったテンプレートのファイルなど）の集まりとし、段 5 の数はこの集まりと比べる。

| 段 | 行うこと | 読むこと |
| --- | --- | --- |
| 0 | 検証先を bootstrap した直後に `gc --rollback-buffer-days 1` の 1 段目を打つ | 使われていない資産がイメージ 0・ファイル 0。0 でなければ検証先に他の資産があるため、その検証先を使わない |
| 1 | 版 A を反映し、2 日待つ（A の資産が作った日の猶予を過ぎる） | 上の「版の作り方」の識別子 |
| 2 | 版 B を反映する（A の資産が使われなくなる）。`gc --rollback-buffer-days 1` の 1 段目と 2 段目を打つ | B の識別子。A の資産に日付のタグが付き、消えない（使われなくなった印を付けたばかりで猶予の内）。CLI の問いの「消す数」が 0 |
| 3 | 2 日待つ（A の印が 1 日の猶予を満了し、B の資産が作った日の猶予を過ぎる）。版 C を反映する（B の資産が使われなくなる） | C の識別子 |
| 4 | `gc --rollback-buffer-days 1` の 1 段目を打つ | 使われていない資産の数が A の分と B の分の和と同じ |
| 5 | 2 段目を打ち、CLI の問いに答える | CLI の問いの「消す数」が A の分の数と同じ |
| 6 | 資産のリポジトリとバケットを読む | 下の合格の条件 |
| 7 | 運用する環境で、戻しの予行（M4）の後に、既定の 30 日で `gc` の 1 段目と 2 段目を打つ | M4 で使われなくなった版の資産が消えない（猶予の内） |

| 資産 | 段 6 の時点の扱い | 合格の条件 |
| --- | --- | --- |
| 版 C の資産（控えた 2 つの識別子） | 参照中 | 残る・印が無い |
| 版 B の分 | 猶予の内（段 5 で初めて印が付く） | 残る・印が付く |
| 版 A の分 | 猶予を満了 | 消える |

あわせて、検証先で、段 2 の後に `gc` の 1 段目で得た確認の値を 60 分の後に使うと 7 で止まること、反映の途中（`UPDATE_IN_PROGRESS`）に 2 段目を打つと 9 で止まることを読む。
