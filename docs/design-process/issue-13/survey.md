# #13 の設計の外部の調査

[issue-13-design.md](design.md) の「外部の調査」の節を、500 行の上限に収めるために分けた文書である。決定の「比べた候補」の番号（LIB1〜）はこの表を指す。

## 調べる種類

| 種類 | 調べるか | 理由 |
| --- | --- | --- |
| 標準・仕様 | 調べない | 資源の形と DB の側の排他（STD83）は全体の設計が調べた。この課題が新しく従う標準は無い |
| 主要な製品 | 調べない | 構成は MVV の Value 6 と全体の設計で決まり、ほかの製品の構成で変わらない |
| ライブラリとサービス | 調べる | 予算のタグ・Fargate の大きさ・DB の用意の関数の SQL の部品・スケジュールの単価が既定の値と作り方を決める。ECR のライフサイクルの規則の基本は全体の設計の LIB85 にあり、規則の優先の振る舞いを LIB7 に足した |

### ライブラリとサービス

| # | 候補 | バージョン | ライセンス | 最後のリリースの日付 | 終了のアナウンス | 要件を満たすか | 出典 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| LIB1 | コスト配分タグ（AWS Billing） | — | AWS のサービス | — | 無し | 満たす。ユーザーの付けたタグは請求の側で有効にしてから使える。付けてから最大 24 時間で一覧に出て、有効になるまでさらに最大 24 時間。`UpdateCostAllocationTagsStatus` の API で有効にできる。有効にできるのは組織の管理のアカウントと組織に入っていないアカウントだけで、組織のメンバーのアカウントはできない | https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/activating-tags.html ・ https://docs.aws.amazon.com/us_en/awsaccountbilling/latest/aboutv2/custom-tags.html （2026-11-21） |
| LIB2 | Fargate のタスクの大きさ | プラットフォームの版 1.4.0 | AWS のサービス | — | 無し | 満たす。0.25 vCPU は 512 MiB・1 GB・2 GB、1 vCPU は 2〜8 GB を選べる | https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html （2026-11-21） |
| LIB3 | `pg`（node-postgres） | 8.23.1 | MIT | 2026-09-30 | 無し | 満たす。広く使われる PostgreSQL のクライアントで、トランザクションと識別子の手書きの組み立てが要る `CREATE ROLE` を素の SQL で打てる。CI のテストの `SqlExecutor` の実装と、識別子と文字列の組み立てに採る | `npm view pg version license time.modified`（2026-11-21） |
| LIB4 | `postgres`（postgres.js） | 4.1.1 | Unlicense | 2026-11-11 | 無し | 満たす。ただし識別子の組み立ての書き方が独自で、DDL を打つ道具として `pg` より利点が無い | `npm view postgres version license time.modified`（2026-11-21） |
| LIB5 | EventBridge Scheduler | — | AWS のサービス | — | 無し | 満たす。月 1,400 万回の呼び出しまでは無料の枠。例の計算では枠の外は 100 万回あたり 1.00 ドル | https://aws.amazon.com/eventbridge/pricing/ （2026-11-21） |
| LIB6 | CloudFormation の `Fn::GetAZs` | — | AWS のサービス | — | 無し | 条件つきで満たす。既定の VPC の既定のサブネットがある AZ だけを返し、既定のサブネットが無ければ使える AZ をすべて返す。既定のサブネットが 1 つの AZ にだけあると 1 つしか返さない | https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/intrinsic-function-reference-getavailabilityzones.html （2026-11-21） |
| LIB7 | ECR のライフサイクルの規則の評価 | — | AWS のサービス | — | 無し | 満たす。規則はすべて同時に評価し、優先の順に当てる。1 つのイメージを消すのは 0 か 1 つの規則で、ある規則のタグの条件に当たるイメージは、それより優先の低い規則では消えない。`imageCountMoreThan` は push の時刻の新しい順に並べて数を超えたものを消す。`tagPrefixList` は `tagStatus` が `tagged` のときだけ使える。消すのは条件に当たってから 24 時間のうち | https://docs.aws.amazon.com/AmazonECR/latest/userguide/LifecyclePolicies.html ・ https://docs.aws.amazon.com/AmazonECR/latest/userguide/lifecycle_policy_parameters.html （2026-11-21） |
| LIB8 | `p-retry` | 9.0.0 | MIT | 2026-11-02 | 無し | 満たす。Promise を返す処理を回数と間隔で繰り返す。既定は `retries: 10`（初回を除いた回数）・`factor: 2` の指数の待ちで、`factor: 1` と同じ `minTimeout`・`maxTimeout` で固定の間隔にできる。`maxRetryTime` で全体の期限を、`AbortError` と `shouldRetry` で繰り返さない失敗を決められる。`maxRetryTime` は `performance.now()` で測り、失敗の後の待ちを残り時間に切り詰めるが、待ちが明けた後は期限を照らさずに次の試行を呼ぶ。そのため期限は試行の関数の始めでも照らす。広く使われ、保守が続く | `npm view p-retry version license time.modified`・`npm view p-retry readme`・`npm view p-retry@9.0.0 readme`・https://github.com/sindresorhus/p-retry/blob/v9.0.0/index.js （2026-11-21） |
| LIB9 | `pg-format` | 1.0.4 | MIT | 2022-06-23 | 無し | 満たさない。識別子と文字列の組み立てを書式で行えるが、最後のリリースが 2022 年で保守が止まっている。`pg` の `escapeIdentifier`・`escapeLiteral` で足りる | `npm view pg-format version license time.modified`（2026-11-21） |
| LIB10 | `pino` | 10.4.0 | MIT | 2026-10-02 | 無し | 満たす。1 行の JSON のログを速く出し、項目を `redact` で伏せられる。広く使われ、保守が続く | `npm view pino version license time.modified`（2026-11-21） |
| LIB11 | AWS Lambda Powertools の Logger（`@aws-lambda-powertools/logger`） | 2.36.0 | MIT-0 | 2026-10-06 | 無し | 条件つきで満たす。構造化したログを出すが、Lambda の文脈の項目を前提にしている | `npm view @aws-lambda-powertools/logger version license time.modified`（2026-11-21） |
| LIB12 | Secrets Manager の Lambda によるローテーション | — | AWS のサービス | — | 無し | 満たさない。ローテーションの関数は Secrets Manager の端点へ届く必要があり、インターネットへ出られない VPC の中では Interface 型のエンドポイントか NAT が要る。予定で差し替える | https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotation-function-network-access.html ・ https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotate-secrets_lambda.html （2026-11-21） |
| LIB13 | Aurora が管理するマスターユーザーのパスワード（Secrets Manager との統合） | — | AWS のサービス | — | 無し | 条件つきで満たす。Aurora がパスワードを作って Secrets Manager に置き、既定で 7 日ごとに差し替える。秘密の器の名前は Aurora が決める（例の ARN は `rds!cluster-…`） | https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/rds-secrets-manager.html （2026-11-21） |
| LIB14 | RDS Data API | — | AWS のサービス | — | 無し | 条件つきで満たす。HTTPS の端点で SQL を打て、Lambda を VPC に入れずに届く。資格情報は Secrets Manager の秘密の器から使う。Aurora Serverless v2 では、一時停止の間に要求が来ると書き手を再開してから処理する | https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.html ・ https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html （2026-11-21） |
| LIB15 | `cdk-ecr-deployment` | 4.2.92 | Apache-2.0 | 2026-11-17 | 無し | 満たさない。CDK のアセットのイメージを別の ECR へ写すため、写す元の bootstrap のリポジトリに古い版が残る | `npm view cdk-ecr-deployment version license time.modified`（2026-11-21） |
| LIB16 | `cdk-docker-image-deployment` | 0.0.1042 | Apache-2.0 | 2026-11-16 | 無し | 満たさない。手元のイメージをアセットの仕組みで中継の ECR に置き、CodeBuild がタグを付けて送り先へ push する。版が 0.0 のままで、送り先をダイジェストで引く形は書かれていない | https://github.com/cdklabs/cdk-docker-image-deployment ・ `npm view cdk-docker-image-deployment version license time.modified`（2026-11-21） |
| LIB17 | `cdk-nag` | 3.1.0 | Apache-2.0 | 2026-11-20 | 無し | 条件つきで満たす。CDK のスタックを規則の集まりで照らし、独自の規則も書ける。npm の週の取得は 883,437 回（2026-11-13〜19）で、2026-11-20 にも更新があり保守が続く | `npm view cdk-nag version license time.modified`・https://api.npmjs.org/downloads/point/last-week/cdk-nag （2026-11-21） |
| LIB18 | Aurora PostgreSQL の TLS（`rds.force_ssl`） | — | AWS のサービス | — | 無し | 満たす。`rds.force_ssl` を 1 にすると TLS でない接続を断る。既定は Aurora PostgreSQL 17 以上で 1、16 以下で 0 | https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Security.html （2026-11-21） |
| LIB19 | ECS の `RunTask` のタグの伝播（`propagateTags`） | — | AWS のサービス | — | 無し | 満たす。`propagateTags` に `TASK_DEFINITION` を渡すと、タスクの定義のタグを作る時に実行するタスクへ写す。値を渡さなければ写さず、作った後には `TagResource` でしか付けられない | https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_RunTask.html （2026-11-21） |
| LIB20 | AWS Budgets の SNS の知らせ | — | AWS のサービス | — | 無し | 満たす。トピックの資源の方針で `budgets.amazonaws.com` に `SNS:Publish` を許す。許していないトピックは「Invalid SNS topic」として受けない。暗号化したトピックは追加の許しが要る | https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-sns-policy.html （2026-11-21） |
| LIB21 | PostgreSQL 16 の統計の写し（`pg_stat_activity`・`pg_stat_clear_snapshot()`） | 16 | PostgreSQL License | — | 無し | 満たす。すべてのセッションの今の問い合わせの情報は、トランザクションの中で最初に求めた時点で集め、そのトランザクションの間は同じものを見せる。`pg_stat_clear_snapshot()` で今のトランザクションの写しを捨て、次の読みで集め直す | https://www.postgresql.org/docs/16/monitoring-stats.html （2026-11-21） |
| LIB22 | PostgreSQL 16 の `pg_terminate_backend(pid, timeout)` | 16 | PostgreSQL License | — | 無し | 満たす。`timeout` が無いか 0 ならシグナルを送るだけで、送れたら真を返す。0 より大きければ、実際に終わるか時間が過ぎるまで待ち、時間切れでは警告を出して偽を返す。待ちは呼び出しごとに掛かるため、接続ごとに呼ぶと待ちが積み重なる | https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-ADMIN-SIGNAL （2026-11-21） |
| LIB23 | PostgreSQL 16 の `CREATE ROLE`・`ALTER ROLE` のパスワード | 16 | PostgreSQL License | — | 無し | 満たす。パスワードは常に暗号化して保存し、渡した文字列が既に MD5 か SCRAM の形なら、`password_encryption` に依らずそのまま保存する | https://www.postgresql.org/docs/16/sql-createrole.html ・ https://www.postgresql.org/docs/16/sql-alterrole.html （2026-11-21） |
| LIB24 | PostgreSQL 16 のサーバーのログ（`log_min_error_statement`・`log_statement`） | 16 | PostgreSQL License | — | 無し | 満たす。`log_min_error_statement` の既定は `ERROR` で、誤りになった文をログに書く（`PANIC` で止まる）。`log_statement` の既定は `none` で、`ddl` 以上なら `CREATE`・`ALTER` を書く。どちらも superuser か SET の権限が要る。書いた文は機密の値や平文のパスワードを含みうる、と文書が注意する | https://www.postgresql.org/docs/16/runtime-config-logging.html （2026-11-21） |
| LIB25 | `scram_sha_256` | 0.0.2 | Beerware | 2024-09-22 | 無し | 満たさない。SCRAM-SHA-256 の計算の小さい部品だが、版が 0.0 のままで 2 年更新が無い。npm に保守の続く検証子の部品は見つからなかった（`npm search scram-sha-256`） | `npm search scram-sha-256`・`npm view scram_sha_256 license time.modified`（2026-11-21） |

### 確かめられなかったこと

| 対象 | 試した手段 | 結果と理由 |
| --- | --- | --- |
| DynamoDB の PITR とストリームの単価 | 試していない | 見込みの額への効きが小さいため、実測の段で単価の頁を読む |

調べた量: 候補 25 件・取得の試み 37 回（2026-11-21）。内訳は次のとおりで、合計は 10 + 12 + 7 + 3 + 5 = 37 回である。LIB1〜LIB7 と表から外した候補の 10 回: 表の LIB1〜LIB7 の 9 回（LIB1 の頁 2・LIB2〜LIB6 の各 1・LIB7 の頁 2）と、反映のアクションの確かめのために調べ、その確かめを外したため表から外した AWS CLI の出力の絞りの 1 回。MVV 版 2 の Value 15 に照らして足した LIB8〜LIB16 の 12 回: `npm view` が LIB8・9・10・11・15・16 の 6 回、頁が LIB12 の 2・LIB13 の 1・LIB14 の 2・LIB16 の GitHub の 1 の 6 回。cross-review の 1 巡目の指摘で足した 7 回: LIB17 の `npm view` と npm の取得の数の 2 回、LIB8 の readme の 2 回、LIB18・LIB19・LIB20 の頁の 3 回。cross-review の 2 巡目の指摘で足した 3 回: LIB8 の v9.0.0 の実装・LIB21・LIB22 の頁。PR #45 の cross-review の指摘で足した 5 回: LIB23 の頁 2・LIB24 の頁 1・LIB25 の `npm search` と `npm view` の 2。同じ指摘で全体の設計の LIB91〜LIB93 にも足した（取得の数は全体の設計の調べた量にある）。旧版の 19 回は、Value 15 に照らして足した候補の取得を 9 回と数え違えた値で（数え直すと LIB8〜LIB16 で 12 回）、LIB1〜LIB7 と外した候補の 10 回は旧版から変わらない。
