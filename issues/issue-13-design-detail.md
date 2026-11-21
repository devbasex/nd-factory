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
├── lib/images.ts               *
├── bin/app.ts
├── setup/images.ts             *
├── setup/images-cli.ts         *
└── test/（support.ts・app-stack・stack-rules*・pipeline-stack・naming・nd-setup・missing-settings*・images*）
apps/db-prep/                   *
├── package.json・tsconfig.json・Dockerfile
├── src/main.ts・exchange.ts・provision.ts・rotate.ts
└── test/exchange.test.ts・provision.test.ts・rotate.test.ts
docs/operations/settings.md・setup.md・pipeline-approval.md
.github/workflows/ci.yml
```

依存の向き: `packages/contracts` ← `infra`・`apps/db-prep` の一方向で、`infra` と `apps/db-prep` は互いを import しない。`infra/lib/images.ts` と `infra/setup/images.ts` は `apps/db-prep/Dockerfile` をビルドの入力のパスとして指すだけで、コードを import しない（[詳細設計の依存の表](../docs/design/detail.md#クラスと関数の構造)の `infra` から `apps/*` への import の禁止に合う）。

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
| `infra/lib/pipeline-stack.ts` | 変更 | 準備のアクションを特権にしてイメージを作らせ、自前の ECR への push を許す。反映のアクションは、反映の前に引くイメージが残す 10 版にあるかを読む | — | `PipelineStack` | `constructor`・`prepareBuildSpec`・`deployBuildSpec`（変更） |
| `infra/setup/missing-settings.ts` | 新設 | 足りない設定の一覧を集めて出す | `aws-reader` | モジュール | `MISSING_CHECKS`・`collectMissingSettings`・`printMissingSettings` |
| `infra/lib/images.ts` | 新設 | イメージごとの自前の ECR とライフサイクルの規則、合成の入力のダイジェストの読み方 | aws-cdk-lib | `ImageRepository` | `constructor`・`IMAGE_SPECS`・`readImageDigests`・`KEEP_IMAGES` |
| `infra/bin/app.ts` | 変更 | 合成の入力のダイジェストを読んで `AppStack` へ渡す | `images.ts` | モジュール | 最上位の処理（変更） |
| `infra/setup/images.ts` | 新設 | 使用中の版を押し出さないかを照らし、イメージを作って push し、一覧を書く。反映の前に引くイメージが残す 10 版にあるかを確かめる | `images.ts`・AWS SDK（ECR・ECS） | モジュール | `buildAndPushImages`・`checkPushKeepsInUse`・`checkImagesKept` |
| `infra/setup/images-cli.ts` | 新設 | パイプラインの準備のアクションから `buildAndPushImages` を打つ入口 | `setup/images.ts` | モジュール | `main` |
| `packages/contracts/data/exit-codes.json` | 変更 | 6 `BUILD` の意味にイメージの作成と push を、4 `PROFILE` の意味にイメージの照らしの権限を足し、9 `IMAGES` を足す。0・5・6 の「AWS へ書いたか」を自前の ECR への push に合わせる（`setup.md` の表は生成） | — | — | — |
| `infra/setup/aws-reader.ts` | 変更 | コスト配分タグ・組織・AZ を読む | AWS SDK（Cost Explorer・Organizations・EC2） | モジュール | `readCostAllocationTags`・`readOrganizationManager`・`readGetAzsCount`（新設） |
| `infra/setup/nd-setup.ts` | 変更 | `diff` の合成の前にイメージを push し、`deploy` の前に引くイメージが残す 10 版にあるかを確かめる。`diff` の最後に一覧を出す | 上の 2 つ | モジュール | `runDiff`・`synthesize`・`runDeploy`・`defaultDeps`（変更） |
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
| `TaskPlatform` の `constructor` | `infra/lib/tasks.ts` | 新設 | `(scope, id, props: { network: Network; names: AppResourceNames; images: ImageDigests; repositories: Record<ImageKey, IRepository> })` | ECS のクラスタ（Container Insights なし）・タスクの実行の役割（ECR の取得とログの書き込みだけ）・DB の用意のタスクの定義（族 `<prefix>-<environment>-db-prep`・`DB_PREP_TASK_SIZE`・x86_64・非 root・イメージは DB の用意の自前の ECR からダイジェストで引く。下の「イメージ」）・タスクの役割（文なし）・ログの群（30 日） |
| `RUNNER_TASK_SIZE`・`DB_PREP_TASK_SIZE` | 同上 | 新設 | `{ cpu: 1024, memoryMiB: 2048 }`・`{ cpu: 256, memoryMiB: 512 }` | 既定の大きさ。ランナーの値は #6 がタスクの定義で使う |
| `TaskPlatform` の公開の値 | 同上 | 新設 | `cluster`・`executionRole`・`publicSubnets`・`taskSecurityGroup`・`dbPrepTaskDefinition` | #6 が API の関数へ `RunTask` の値として渡す |

- 事後条件: `AWS::ECS::Service`・`AWS::ECS::TaskSet` を作らない。タスクの役割に `Policies` も `ManagedPolicyArns` も無い
- DB の用意のタスクの定義は、`props.images` に DB の用意（キー `db-prep`）のダイジェストがあるときだけ作り、イメージを `ContainerImage.fromEcrRepository(<リポジトリ>, "sha256:…")` でダイジェストで引く。無いとき（初めての設置・CI の合成）は作らない。ほかのキー（#6 の `runner`）の有無に依らない

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

## イメージ

満たす決定: 決定 1・2、受け入れ条件 9

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `IMAGE_SPECS` | `infra/lib/images.ts` | 新設 | `readonly { key: "db-prep"; dockerfile: string; context: string }[]` | 作るイメージの並び（今は DB の用意だけ）。#6 は `runner` の行を足す |
| `KEEP_IMAGES` | 同上 | 新設 | 定数 `10` | リポジトリごとに残す版の数（設計文書の決定 2） |
| `ImageRepository` の `constructor` | 同上 | 新設 | `(scope, id, props: { name: string })` | ECR のリポジトリ（名前 `<prefix>-<environment>-<key>`・タグは書き換え不可・push の時の検査・`RemovalPolicy.RETAIN`）と、規則 1 つ（`tagStatus: any`・`imageCountMoreThan: KEEP_IMAGES`） |
| `readImageDigests` | 同上 | 新設 | `(env: NodeJS.ProcessEnv) => ImageDigests` | 環境の値 `ND_IMAGES` が指す一覧のファイル（`nd-setup-images.json`）を読み、キーごとのダイジェストを返す。無ければ空 |
| `buildAndPushImages` | `infra/setup/images.ts` | 新設 | `(target: Target, s: Settings, out: string, deps: ImageDeps) => Promise<ImagesResult>` | `IMAGE_SPECS` のキーごとにリポジトリがあるかを読む。リポジトリのあるキーについて先に `checkPushKeepsInUse` を打ち、どれか 1 つでも押し出すなら何も push せずに投げる（9）。通れば、リポジトリのあるキーごとに `docker build --platform linux/amd64` → `build-<UTC の時刻>` のタグで push → ダイジェストを読み、得たキーだけを `<out>/nd-setup-images.json` に書く。結果は `{ digests: ImageDigests; noRepository: ImageKey[] }`。リポジトリのあるキーが 1 つも無ければ一覧を書かない |
| `checkPushKeepsInUse` | 同上 | 新設 | `(target: Target, key: ImageKey, deps: ImageDeps) => Promise<{ ok: true } \| { ok: false; inUse: string; newer: number }>` | 族 `<prefix>-<environment>-<key>` の最新の有効なタスクの定義（`DescribeTaskDefinition`）が引くダイジェストを使用中の版とし、リポジトリの版（`DescribeImages`）を push の時刻で並べて、使用中の版より後の版の数を数える。`KEEP_IMAGES - 1`（9）以上なら `ok: false`。族が無い・使用中の版がリポジトリに無いときは `ok: true` |
| `checkImagesKept` | 同上 | 新設 | `(target: Target, assembly: string, deps: ImageDeps) => Promise<string[]>` | 合成の結果の一覧のダイジェストごとに、リポジトリの版（`DescribeImages`）を push の時刻の新しい順に並べ、上から `KEEP_IMAGES` 件に入っていないダイジェスト（無いものを含む）を返す |
| `main` | `infra/setup/images-cli.ts` | 新設 | `(argv: string[], deps: ImageDeps) => Promise<number>` | `push --settings <file> --out <dir>` を打つ。パイプラインの CodeBuild の資格情報（既定の解き方）で動く |
| `synthesize` | `infra/setup/nd-setup.ts` | 変更 | 変えない | 選んだスタックに `app` が含まれるときだけ、画面のビルドの後、合成の前に `buildAndPushImages` を打ち、一覧のファイルを `ND_IMAGES` で合成へ渡す。一覧は合成の結果の置き場にあるため要約値に入る。`app` を含まない（`--stack pipeline` だけ）ときは push せず、一覧も書かない |
| `runDeploy` | 同上 | 変更 | 変えない | 確認の値を照らした後・反映の前に、置き場に一覧があれば `checkImagesKept` を打ち、外れたダイジェストがあれば反映しない（9） |

- `SetupDeps` と `ImageDeps` に `docker: (args: string[]) => Promise<{ code: number; stdout: string }>` と `ecr`（`DescribeRepositories`・`DescribeImages`・`GetAuthorizationToken` の包み）と `ecs`（`DescribeTaskDefinition` の包み）を置く（テストは本物の Docker と AWS を呼ばない）
- push の前の `docker login` は `GetAuthorizationToken` の値を標準入力で渡し、値をログ・出力に出さない
- `AppStack` の props に `images: ImageDigests` を足し、`bin/app.ts` が `readImageDigests(process.env)` で渡す。CI の合成は `ND_IMAGES` を持たず、タスクの定義を作らない版になる。スタックのテストは作り物のダイジェスト（`sha256:` と 0 を 64 桁）を渡して、タスクの定義を持つ版を照らす
- ビルドはビット単位で再現しない前提に置く（設計文書の決定 2）。中身を変えない `diff` や準備でも、毎回ダイジェストの違う版が push される。そのため版の数の守りは、再現に頼らず `checkPushKeepsInUse` と `checkImagesKept` で持つ
- `ImageDigests` はキーごとの任意の値（`Partial<Record<ImageKey, string>>`）で、`readImageDigests` は一覧にあるキーだけを返す。`AppStack` はキーごとにタスクの定義を作るかを決めるため、新しいリポジトリ（#6 の `runner`）を足す初回の反映でも、リポジトリのある `db-prep` のタスクの定義は残る

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `buildAndPushImages` | Docker が無い・作れない | 端末に Docker が無い・Dockerfile の誤り | `docker` の終了コード | 合成せずに止める | 「Docker が要る」か docker の出力、`EXIT.BUILD` | 何も合成していない。再実行できる |
| `buildAndPushImages` | push できない | 権限・網 | `docker push` の終了コード、push の後のダイジェストの読み取り（`DescribeImages`）の SDK の例外 | 合成せずに止める | docker の出力か例外の名前と文、`EXIT.BUILD` | push の済んだ版が残る（どのタスクの定義からも引かれない）。再実行できる |
| `buildAndPushImages`・`checkPushKeepsInUse`・`checkImagesKept` | push の前・反映の前の読み取りを許されない・読めない | profile に `ecr:DescribeRepositories`・`ecr:DescribeImages`・`ecr:GetAuthorizationToken`・`ecs:DescribeTaskDefinition` の許しが無い・網 | `DescribeRepositories`・`DescribeImages`・`DescribeTaskDefinition`・`GetAuthorizationToken` の SDK の例外（`AccessDeniedException` を含む。`DescribeTaskDefinition` の族が無い `ClientException` と `DescribeRepositories` の `RepositoryNotFoundException` は除き、それぞれ「族が無い」「リポジトリが無い」として続ける） | 押し出しの判定と分け、9 にしない。どのイメージも作らず push せず、反映しない | 「<操作> を読めない: <例外の名前>: <文>。profile に <操作> を許して打ち直す（`docs/operations/setup.md` の前提）」、`EXIT.PROFILE` | 何も書いていない（読み取りはすべて最初の build と push の前、`deploy` では反映の前に打つ）。権限を足して再実行できる |
| `checkPushKeepsInUse` | 使用中の版を押し出す | 反映しない `diff` や準備が 9 回続いた | 使用中の版より後の版の数 | どのイメージも作らず push しない | キー・使用中のダイジェスト・後の版の数と「反映を待つ版を反映するか、反映しない版を `aws ecr batch-delete-image` で消してから打ち直す」、`EXIT.IMAGES` | 何も書いていない |
| `checkImagesKept` | 引くイメージが無いか、残す 10 版から外れた | 残す数を超えて古い版へ戻す・承認の後に別の push で押し出された | `DescribeImages` の結果の並び | 反映しない | 外れたダイジェストと「その版のコミットで `diff` から作り直し、新しい差分を承認する」、`EXIT.IMAGES` | 何も書いていない |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `ImageRepository` | 合成の出力に、タグ書き換え不可のリポジトリと、`imageCountMoreThan` が 10 の規則 1 つがある | — | 規則が日数になる・数が変わると落ちる |
| `AppStack`（ダイジェストあり） | DB の用意のタスクの定義のイメージが `<リポジトリ>@sha256:…` | ダイジェストなしでタスクの定義を作らない | ダイジェストを変えると要約値が変わる（合成の結果の要約値の比べ） |
| `buildAndPushImages` | リポジトリがあれば作って push し、一覧を書く | リポジトリが 1 つも無ければ何もしない。`IMAGE_SPECS` が `db-prep` と `runner` で `db-prep` のリポジトリだけがあると、`db-prep` だけを push して一覧に載せ、`noRepository` が `runner` になる | Docker の失敗・push の失敗で投げ、一覧を書かない。login の値が出力に出ない。`checkPushKeepsInUse` が `ok: false` のキーが 1 つでもあれば、どのキーも build も push も呼ばない |
| `checkPushKeepsInUse` | 使用中の版より後の版が 8 で `ok: true` | 後の版が 9 で `ok: false`。族が無い・使用中の版がリポジトリに無いと `ok: true` | `DescribeTaskDefinition` か `DescribeImages` が `AccessDeniedException` を投げると、`buildAndPushImages` が build も push も呼ばずに 4 で終わり（9 にならない）、出力に足りない操作の名前が出る |
| `AppStack`（一部のキーだけのダイジェスト） | 一覧が `db-prep` だけのとき、DB の用意のタスクの定義を作る | 前の版（`db-prep` だけ）の合成の出力と比べ、`runner` のリポジトリを足しても DB の用意のタスクの定義が消える差分にならない | — |
| `synthesize` | `--stack app` と既定で `buildAndPushImages` を呼ぶ | `--stack pipeline` だけで呼ばず、置き場に一覧が無い | — |
| `checkImagesKept`・`runDeploy` | すべて新しい 10 版にあれば反映する | 新しい順の 10 番目で反映し、11 番目で反映しない。置き場に一覧が無ければ確かめずに反映する | 1 つでも無いか外れていれば反映を呼ばず 9 で終わる。`DescribeImages` が `AccessDeniedException` を投げると反映を呼ばず 4 で終わる |

## 設置のコマンド

満たす決定: 決定 6・12、受け入れ条件 5

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

- `SetupDeps` に `readCostAllocationTags`・`readOrganizationManager`・`readGetAzsCount` を足す（テストは本物の AWS を呼ばない）
- `MISSING_CHECKS` の 5 種類: Google のクライアントの ID が無い・`budget.scope` が `tags` でタグ `app-prefix`・`app-env` が `Active` でない（下のタグの行と、読めないときの行。`account` なら照らさない）・`ops.notify_emails` が空・`buildAndPushImages` の `noRepository` が空でない（キーごとに 1 行。「<キー> の ECR がまだ無いため、そのイメージのタスクの定義を持たない版を合成した。この差分を反映した後に、新しい置き場でもう一度 `diff` を打ち、出た確認の値で `deploy` を打つ」。順は下の「初めての設置の手順」）・`readGetAzsCount` が 2 未満（「`Fn::GetAZs` が返す AZ が <数> つで、反映が網を作れずに止まる。既定の VPC の別の AZ に既定のサブネットを作る（`aws ec2 create-default-subnet --availability-zone <AZ>`）か、既定のサブネットをすべて消す」。読めなければ「確かめられない（`ec2:DescribeSubnets`・`ec2:DescribeAvailabilityZones` を許した profile で読む）」）
- 読めないときの行の文（設計文書の決定 12）: 「コスト配分タグ `app-prefix`・`app-env` が有効かを確かめられない。有効でなければ予算は 0 を数え続け、予算の知らせは鳴らない。次の操作: <操作>」。読めない原因は SDK の例外だけでは権限の不足と組織の制限を分けられないため、`readOrganizationManager` で分ける。<操作> は、`member: false` なら「`ce:ListCostAllocationTags` を許した profile で `diff` を打ち直す」、`member: true` なら「組織の管理のアカウント <ID> にタグの有効化を確かめて頼む（メンバーのアカウントでは権限を足しても有効にできない）。頼めなければ設定のファイルの `budget.scope` を `account` にする」、`unknown` なら両方を「組織に入っていなければ …。組織のメンバーなら …」の 2 つに分けて示す（管理のアカウントの ID は「組織の管理のアカウント」とだけ示す）
- タグの行の文（設計文書の決定 6）: 「コスト配分タグ <有効でないタグ> が有効でない。有効になるまで予算は 0 を数え続け、予算の知らせは鳴らない。有効にする先: <先>。有効にできなければ設定のファイルの `budget.scope` を `account` にする（アカウントの全体を数える）」。<先> は `readOrganizationManager` が `member: false` なら「このアカウント（請求の画面のコスト配分タグ）」、`member: true` なら「組織の管理のアカウント <ID>（メンバーのアカウントでは有効にできない）」、`unknown` なら「組織に入っていなければこのアカウント、組織のメンバーなら組織の管理のアカウント」

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `readCostAllocationTags` | 読めない | 権限が無い・組織の制限 | SDK の例外 | `readOrganizationManager` で原因を分け、「確かめられない」の 1 行に次の操作を添えて続ける | 一覧の 1 行（権限の不足なら profile の権限、組織のメンバーなら管理のアカウントへの依頼と `budget.scope: account`、分からなければ両方）。終了コードは変えない | 何も書いていない。再実行できる |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `collectMissingSettings` | 5 種類が当たる入力でそれぞれ 1 行。タグの行の <先> が `member: false`・`member: true`・`unknown` で 3 通りに変わる。タグを読めないときの行の <操作> も同じ 3 通りに変わり、`member: true` と `unknown` で管理のアカウントへの依頼と `budget.scope` の `account` が出る。`budget.scope` が `account` ならタグの行が出ない | 0 件で「無し」。AZ の数 2 で行が出ず 1 で出る | 照らしが投げると「確かめられない」の 1 行 |
| `readGetAzsCount` | 既定のサブネットが 3 つの AZ にあれば 3 | 既定のサブネットが 1 つの AZ にだけあれば、使える AZ が 3 つでも 1。既定のサブネットが無ければ使える AZ の数 | — |
| `runDiff` | 出力の最後に一覧の欄 | — | 足りない設定があっても終了コード 0 |

### 終了コード

正本は `packages/contracts/data/exit-codes.json` で、`setup.md` の表はそこから作る。直す行と足す行は次のとおりである。引くイメージの確かめの失敗は、ビルドの誤りを直して打ち直す 6 と違い、作り直して `diff` からやり直すか、反映しない版を片付けるため、9 に分ける。

| 終了コード | 名前 | 意味 | AWS へ書いたか |
| --- | --- | --- | --- |
| 0 | `OK`（直す） | `diff` は差分を示して止まった。`deploy` は反映した | `diff` は `app` を選び ECR があるときだけ、自前の ECR へ push した。`deploy` は CloudFormation へ反映した |
| 4 | `PROFILE`（直す） | profile が無い・資格情報を得られない・リージョンが無い。イメージの照らしに要る読み取り（下の「イメージ」の異常系の表）を profile が許さない | 書いていない |
| 5 | `BOOTSTRAP`（直す） | bootstrap が無いか版が足りない（求める版と今の版を示す）。bootstrap の版を読めない | `diff` で `app` を選び ECR があるときは、合成の前に push した版が自前の ECR に残る（どのタスクの定義からも引かれない）。`deploy` は書いていない |
| 6 | `BUILD`（直す） | 画面のビルド・イメージの作成と push・合成・差分の作成が失敗した | `diff` で push の後に止まれば、push した版が自前の ECR に残る（どのタスクの定義からも引かれない）。ほかは書いていない |
| 9 | `IMAGES`（足す） | `diff` で、push すると使用中の版が残す 10 版から押し出される。`deploy` で、引くイメージが自前の ECR に無いか、残す 10 版から外れている | 書いていない（`diff` は push の前に止まる） |

`diff` の確かめの順は、引数（2）・設定のファイル（3）・profile（4）・画面のビルド・イメージの照らし（4・9。何も push しない）・イメージの作成と push（6）・合成（6）・bootstrap の版（5）・差分の作成（6）になる。push より後の段は 6 の残りと 5 と 6 の差分の作成で、ここで止まると push した版が残る。`setup.md` の「diff」の節の段の並びをこの順に直し、「どの段で止まっても AWS へは書かない」を「イメージの作成と push より後の段（合成・bootstrap の版・差分の作成）で止まったときは、push した版が自前の ECR に残ることがある。ほかの段では AWS へ書かない」に直す。

`setup.md` の「終了コード」の節の地の文「0 と 8 のほかは、AWS へ何も書いていない。そのため 2〜7 で止まったときは、…」を、次に直す。「0・5・6・8 のほかは、AWS へ何も書いていない。0 の `diff` と、`diff` の 5 と 6 は自前の ECR へ push していることがあるが、反映しなければどのタスクの定義からも引かれない。そのため 2〜7 と 9 で止まったときは、表の意味の原因を直して打ち直せばよい。9 で止まったときは、`diff` なら反映を待つ版を反映するか反映しない版を消してから、`deploy` ならその版のコミットで `diff` から作り直し、新しい差分を読んでから `deploy` を打つ」（7・8 の文はそのまま）。打ち直した `diff` はまた push するため、5 で止まったまま打ち直しを重ねると反映しない版が溜まり、9 に近づく。bootstrap を上げてから打ち直す。

### 初めての設置の手順

ECR がまだ無い設置先では、1 回目の反映が ECR を作り、2 回目の反映が DB の用意のタスクの定義を足す。`setup.md` の「使い方の場面」の「自分で設置する人」の段 2・3（`diff` と `deploy`）を、次の 4 つの段に置き換えてこのまま写す。どの段も同じ profile と設定のファイルで打つ。

1. `npm run nd-setup -- diff --profile <profile> --settings <設定のファイル> --out <置き場 1>` を打つ。足りない設定の一覧に「db-prep の ECR がまだ無いため、そのイメージのタスクの定義を持たない版を合成した」の行があり、差分が自前の ECR のリポジトリを足し、DB の用意のタスクの定義が無いことを読む。網・表・Aurora など、ほかの資源の差分も読み、足す・変える・消す資源のそれぞれに納得する。確認の値（確認の値 1）を控える
2. 段 1 の差分に納得したときだけ、`npm run nd-setup -- deploy --profile <profile> --assembly <置き場 1> --confirm <確認の値 1>` を打ち、0 で終わることを読む
3. 新しい置き場で `npm run nd-setup -- diff --profile <profile> --settings <設定のファイル> --out <置き場 2>` を打つ。DB の用意のイメージを push した行とダイジェストがあり、差分が DB の用意のタスクの定義（イメージは `<リポジトリ>@sha256:…` で、ダイジェストが push の行と同じ）を足し、ほかの資源の消しが無いことを読む。確認の値（確認の値 2）を控える
4. 段 3 の差分に納得したときだけ（段 1 の承認は段 3 の差分を含まない）、`npm run nd-setup -- deploy --profile <profile> --assembly <置き場 2> --confirm <確認の値 2>` を打ち、0 で終わることを読む

## 反映のパイプライン

満たす決定: 決定 2・11

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `PipelineStack` の `constructor` | `infra/lib/pipeline-stack.ts` | 変更 | 変えない | 準備のアクションの CodeBuild を `privileged: true` にし、その役割に `ecr:GetAuthorizationToken`（資源を絞れない）と、`<prefix>-<environment>-` の頭の自前のリポジトリへの `DescribeRepositories`・`DescribeImages`・`BatchCheckLayerAvailability`・`InitiateLayerUpload`・`UploadLayerPart`・`CompleteLayerUpload`・`PutImage`・`BatchGetImage` と、`ecs:DescribeTaskDefinition`（資源を絞れない。読むだけ）を許す。反映のアクションの役割には、同じ頭のリポジトリへの `ecr:DescribeImages` だけを足す（読むだけ。引き受ける bootstrap の役割は今の `deploy`・`file-publishing` のまま） |
| `prepareBuildSpec` | 同上 | 変更 | 変えない | 画面のビルドの後、`infra/setup/images-cli.ts` があれば `node infra/setup/images-cli.ts push --settings <設定> --out .nd-images` を打つ。リポジトリのまだ無いキーごとに「<キー> の ECR がまだ無いため、そのイメージのタスクの定義を持たない版を合成した。この反映の後に準備を再び走らせる（決定 11）」を記録へ出し、リポジトリのあるキーは push して一覧に載せる（どのキーにもリポジトリが無ければ一覧を書かずに続ける）。一覧があれば `ND_IMAGES` にそのパスを付けて合成し、一覧を `cdk.out/nd-setup-images.json` へ写す（要約値に入る）。使用中の版を押し出すときは `images-cli.ts` が 9 で終わり、準備のアクションが失敗する（何も push していない） |
| `deployBuildSpec` | 同上 | 変更 | 変えない | 要約値を照らした後・`cdk deploy` の前に、`cdk.out/nd-setup-images.json` があれば、その各ダイジェストについて `aws ecr describe-images --repository-name <リポジトリ> --query 'reverse(sort_by(imageDetails,&imagePushedAt))[:10].imageDigest'` を読み、ダイジェストが無ければ「承認したイメージ <ダイジェスト> が ECR の新しい 10 版に無いため反映しない。その版のコミットで準備をやり直す」を記録へ出して 1 で終わる（CloudFormation へ書かない）。一覧が無ければ確かめない。反映のアクションは承認した合成の結果だけを入力に持つため、確かめは CLI と JMESPath で閉じ、ソースのコードを使わない |

パイプラインは `SUPERSEDED` の実行の形で、ある実行が承認を待つ間に、後の実行の準備のアクションが push しうる。そのため承認した版が承認の後に残す 10 版から外れることがあり、反映のアクションの確かめが CloudFormation へ書く前にそれを止める。

### 移行の間の動き

| `Source` | 準備のアクション | 反映のアクション |
| --- | --- | --- |
| 前の版（`images-cli.ts` が無い） | push を飛ばし、今のとおり合成する | 今のとおり反映する |
| この課題の版で ECR がまだ無い（マージの後の最初の実行） | ECR の無いことを記録へ出し、一覧を書かない | 今のとおり反映する（ECR を作る）。その後に準備を再び走らせる（決定 11） |
| この課題の版で ECR がある | push し、一覧を置き場へ入れる | 今のとおり反映する |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `PipelineStack`・`prepareBuildSpec` | 合成の出力の準備の役割が上の操作だけを持ち、準備の CodeBuild が特権 | 準備の手順が `images-cli.ts` の有無で分かれる | 反映の役割に `ecr:DescribeImages` のほかの ECR の権限が増えると落ちる |
| `deployBuildSpec`（手順を bash で打つテスト。`aws` を作り物に差し替える） | 一覧のダイジェストが新しい 10 版にあれば `cdk deploy` に進む | 一覧が無ければ確かめずに進む | 承認の後にダイジェストが ECR から消えた（作り物の `aws` が返す並びに無い）・11 番目に下がったとき、`cdk deploy` を打たずに 1 で終わる |

`docs/operations/setup.md` の前提の表に Docker（`diff` を打つ端末）と、AWS の profile の行へイメージの照らしと push に要る許し（`ecr:DescribeRepositories`・`ecr:DescribeImages`・`ecr:GetAuthorizationToken`・`ecr:BatchCheckLayerAvailability`・`ecr:InitiateLayerUpload`・`ecr:UploadLayerPart`・`ecr:CompleteLayerUpload`・`ecr:PutImage`・`ecs:DescribeTaskDefinition`。`deploy` は `ecr:DescribeImages` を使う。許しが無ければ `diff` と `deploy` は何も書かずに終了コード 4 で止まる）を足し、手順に「パイプラインで初めてイメージを引く版は、パイプラインのスタックを先に反映する」と、上の「初めての設置の手順」を足す。あわせて、先の反映の前に保存するもの・戻しを始める条件・前の版へ戻す 4 つの段・マージの後に準備を再び走らせる段（設計文書の決定 11）を、運用する環境の節に手順として写す。

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

満たす決定: 決定 1・2・10・13、受け入れ条件 6・7・9

リリース承認ゲートの承認の後、運用する人が反映した環境で行い、結果を #13 のリリース後テストのコメントと、全体の設計の費用の見込み・未確認のまま残ることへ返す。値はリポジトリと課題に書かず、比と時間と回数だけを書く。接続する項目は #44 が受ける。

| # | 項目 | 手順 | 合格の目安 |
| --- | --- | --- | --- |
| M1 | 接続の無い間の一時停止 | 反映の後 3 日、CloudWatch の `ServerlessDatabaseCapacity` を 5 分の粒度で読み、0 でない時間の合計と起きた回数を数える | 0 でない時間が保守の起き上がり（1 回 20 分程度）だけ |
| M2 | 単価 | EventBridge Scheduler・DynamoDB の PITR とストリームの単価の頁を、設置したリージョンで読む | 見込みの額への効きを全体の設計の見込みに書く |
| M3 | ECR のライフサイクルの規則 | 本物のリポジトリの版を押し出さないよう、試しのリポジトリ `<prefix>-<environment>-lifecycle-check` を作り、DB の用意のリポジトリの規則（`GetLifecyclePolicy`）をそのまま付ける。中身の違う作り物のイメージ（`FROM scratch` にラベル `n=<番号>` だけを変えたもの。ダイジェストがすべて違う）を、番号の順に 1 つずつ（push の時刻が並ぶよう数秒ずつ空けて）10 個 push し、規則の試し（`StartLifecyclePolicyPreview` と `GetLifecyclePolicyPreview`）を読む。続けて 11 個目を push して試しを読み直す。読み終えたら試しのリポジトリを消す（`DeleteRepository --force`）。あわせて、反映の後と戻しの予行（M4）の後に、DB の用意のリポジトリの試しで使用中の版が消える予定に入らないことを読む | 10 個のときは消える予定が 0 件。11 個のときは、最初に push した 1 件（番号 1）だけが消える予定に入る。DB の用意のリポジトリでは、使用中の版が消える予定に入らない |
| M4 | 戻しの予行 | 決定 10 の手順。戻す前に、Aurora のクラスタの識別子とリソースの ID（`DescribeDBClusters` の `DbClusterResourceId`）・利用者の表の項目の数と作り物の目印の項目 1 件を控える。前の合成の結果を `deploy` し、同じ値を読み直し、確認の値の照らしを読む | クラスタの識別子とリソースの ID が前後で同じ・利用者の表の項目の数と目印の項目が残る・確認の値の違う `deploy` が止まる。プロジェクトのデータベースの残りは確かめない（#44 が受ける） |
| M5 | 予算と運用の知らせ | 予算を 1 ドルにした設定で `diff`・`deploy` し、知らせのメールが届くことを読んだ後に戻す | 宛先に届く |
