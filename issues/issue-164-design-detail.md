# #164 の詳細設計: push から人を待たずに反映するパイプラインと、反映の直前の検査

設計文書 [issue-164-design.md](./issue-164-design.md) の構成要素を、ファイルと関数の粒度へ下ろした文書である。決定の番号と受け入れ条件の番号は、設計文書と要求仕様（[issue-164-requirements.md](./issue-164-requirements.md)。条件 11・12 は決定 4 の再改訂後の文）のものである。#181 で実装するもの（2 つのキーのスキーマ、`ND_CONFIRMATION_STAGE` の設定、宣言の記録の作成、設置のコマンドの検査）は含めない。

## 地図

パッケージ・モジュール構成（触るファイルだけ。`*` は新設）:

```text
infra/
├── bin/
│   ├── app.ts
│   └── app-bootstrap.ts            *
├── lib/
│   ├── pipeline-stack.ts
│   ├── naming.ts
│   ├── app-stack.ts                （コメントだけ）
│   ├── confirmation-stage.ts       *
│   ├── assembly-check.ts           *
│   ├── deploy-guard.ts             *
│   ├── app-bootstrap-template.ts   *
│   └── bootstrap-collision.ts      *
├── test/
└── package.json
packages/contracts/
├── src/settings.ts
├── schema/settings.schema.json     （生成物）
└── test/
    ├── settings.test.ts
    └── fixtures/confirmation-stage-cases.json *
docs/operations/*.md、AGENTS.md、package.json、package-lock.json、knip.jsonc
```

依存の向き: `infra/bin` が `infra/lib` を import し、`infra/lib` は `packages/contracts` だけを import する。反映の直前の検査は `deploy-guard.ts` → `assembly-check.ts`・`confirmation-stage.ts` の一方向で、この 3 つは `node:` の組み込みだけを読む。`naming.ts`（`aws-cdk-lib` を読む）を import しない。名前と ARN は `pipeline-stack.ts` が作って値（`GuardConfig`。型は `assembly-check.ts` に置く）で渡す。`pipeline-stack.ts` は `deploy-guard.ts` を import せず、パスで esbuild に渡して束ねる（検査へ渡す値の型 `GuardConfig` は `assembly-check.ts` から `import type` する）。`bin/app-bootstrap.ts` は `infra/setup/aws-reader.ts` の `resolveProfile` を読むだけで、`infra/setup/` は変えない。循環は無い。

| パス | 種類 | 役割 1 文 | 依存する先 | クラスまたはモジュール | メソッドと最上位の関数 |
| --- | --- | --- | --- | --- | --- |
| `infra/lib/pipeline-stack.ts` | 変更 | パイプラインの段・権限・トリガーと、2 つの CodeBuild の手順を作る | `naming.ts`・`assembly-digest.ts`・esbuild | `PipelineStack` | `bundleDeployGuard`（新設）、`guardConfig`（新設）、`prepareBuildSpec`・`deployBuildSpec`・`constructor`（変更） |
| `infra/lib/naming.ts` | 変更 | 設置ごとの qualifier と、反映に使う資源の名前を返す | `aws-cdk-lib`・`node:crypto` | モジュール | `appQualifier`・`launchDeclaredParameterName`・`deployRoleName`・`appBootstrapNames`・`cdkRoleArn`（新設）、`pipelineResourceNames`（変更） |
| `infra/lib/confirmation-stage.ts` | 新設 | 設定の値と宣言の記録から、段階と反映を拒むかを決める | 無し | モジュール | `confirmationStage`・`refusalReason`（新設） |
| `infra/lib/assembly-check.ts` | 新設 | 合成の結果の形と、中の段階の値を調べる | `node:fs`・`node:crypto`・`node:path` | モジュール | `checkAssembly`・`checkTemplateStage`（新設） |
| `infra/lib/deploy-guard.ts` | 新設 | `cdk deploy` の直前の検査を順に打ち、1 つでも満たさなければ非 0 で終わる | `assembly-check.ts`・`confirmation-stage.ts`・`node:child_process` | モジュール | `runDeployGuard`・`checkTrigger`・`checkSettings`・`checkExecutionRole`・`checkSimulations`・`checkBootstrapVersion`・`awsCli`・`main`（新設） |
| `infra/lib/app-bootstrap-template.ts` | 新設 | CDK の標準の bootstrap のテンプレートに、設置ごとの制約を当てる | `yaml` | モジュール | `appExecutionPolicy`・`restrictBootstrapTemplate`（新設） |
| `infra/lib/bootstrap-collision.ts` | 新設 | qualifier が別の設置と衝突しないかを判定する | 無し | モジュール | `checkQualifier`（新設） |
| `infra/bin/app-bootstrap.ts` | 新設 | 衝突の確認と、テンプレートの書き出しのコマンド | `lib/` の 3 モジュール・`setup/aws-reader.ts`・AWS SDK | モジュール | `parseArgs`・`bootstrapReader`・`mainAppBootstrap`（新設） |
| `infra/bin/app.ts` | 変更 | `pipeline` がある設置のアプリのスタックを、アプリ専用の qualifier で合成する | `naming.ts` | モジュール | `buildApp`（変更） |
| `infra/lib/app-stack.ts` | 変更 | 資源を同じスタックに置く理由のコメントを直す | — | `AppStack` | 無し |
| `packages/contracts/src/settings.ts` | 変更 | `pipeline.branch` の文字を限る | `zod` | `settingsSchema` | 無し（定数 `BRANCH_SHAPE`） |
| `packages/contracts/schema/settings.schema.json` | 変更 | `npm run generate` の生成物 | — | — | — |
| `packages/contracts/test/fixtures/confirmation-stage-cases.json` | 新設 | 段階の判定の入力と期待する結果の表（#181 も読む） | — | — | — |
| `packages/contracts/test/settings.test.ts` | 変更 | ブランチ名の形のテスト | — | — | — |
| `infra/test/pipeline-stack.test.ts` | 変更 | スタック・2 つの手順・反映の直前の検査のテスト | — | — | — |
| `infra/test/naming.test.ts`・`infra/test/app.test.ts` | 変更 | qualifier と名前、合成の qualifier のテスト | — | — | — |
| `infra/test/app-bootstrap-template.test.ts`・`infra/test/bootstrap-collision.test.ts` | 新設 | テンプレートの制約と衝突の判定のテスト | — | — | — |
| `package.json` | 変更 | スクリプト `app-bootstrap` を足す | — | — | — |
| `infra/package.json`・`package-lock.json` | 変更 | `yaml`（`tools` と同じ 2.9.1）と `@aws-sdk/client-cloudformation`（ほかの SDK と同じ 3.1170.0）を足す | — | — | — |
| `knip.jsonc` | 変更 | `esbuild` を import するので `infra` の `ignoreDependencies` を外し、使われないと数えられるファイルがあれば `entry` に足す | — | — | — |
| `docs/operations/pipeline-approval.md`・`setup.md`・`settings.md`・`idp-and-apps.md`、`AGENTS.md` | 変更 | 承認の段の無い流れに書き直す | — | — | — |

## 準備のアクション

満たす決定: 決定 1・6、受け入れ条件 1・2・8

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `prepareBuildSpec` | `infra/lib/pipeline-stack.ts` | 変更 | `(s: Settings, appStack: string) => BuildSpec`（変えない） | 契約を照合し、版を指定して読んだ設定で合成して、差分・要約値・設定の版と SHA-256 を出す |

- `prepareBuildSpec`
  - 事後条件: `exported-variables` に `SETTINGS_VERSION`・`SETTINGS_SHA256` が加わる。`build` の段の命令は次の順に並ぶ
    1. `SETTINGS_VERSION="$(aws ssm get-parameter --name <名前> --query Parameter.Version --output text)"`
    2. `aws ssm get-parameter --name "<名前>:$SETTINGS_VERSION" --query Parameter.Value --output json > /tmp/nd-settings.value.json`
    3. `node -e` の 1 行で 2 の JSON の文字列を解き、改行を足さずに `/tmp/nd-settings.json` へ書き、その SHA-256 を `SETTINGS_SHA256` に入れる
    4. `npm ci`
    5. `mkdir -p infra/approval`
    6. `npm run ndf-contract -- --summary infra/approval/ndf-contract.md`（パイプ・`||`・`;` でつながない）
    7. 画面のビルド・合成・差分・要約値・変数の書き出し（今のまま）
  - 副作用: SSM の読み取り、NDF のリポジトリへの `git` の通信、`infra/approval/` への書き込み。成果物の指定（`base-directory: infra`、`approval/**/*`）は変えない
- 1〜3 は、合成より前のどこでも同じ結果になる。今の手順が設定の読み取りを先頭に置くので、その位置に置く

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `prepareBuildSpec` | 設定を読めない | パラメーターが無い・権限が無い・版が消えた | 手順 1〜3 の終了コード | 止める | CodeBuild の記録に AWS CLI のエラー。非 0 | 準備の段が失敗し、通知が届く。段をやり直せる |
| `prepareBuildSpec` | 契約の照合が失敗 | 固定の点との食い違い（1）・取得や書き出しのエラー（2） | 手順 6 の終了コード | 止める | 照合の出力。1 か 2 | 後の命令は打たれない。扱いは決定 1 の表 |

### ログと記録の出力

| 関数 | 出すもの | レベルまたは書き先 | 出さないもの |
| --- | --- | --- | --- |
| `prepareBuildSpec` | 照合の要約 | `approval/ndf-contract.md` | 設定の全文 |

## 反映のアクション

満たす決定: 決定 5・6、受け入れ条件 2・12

反映の段は起点のブランチのソースを受けない。検査のコードは、パイプラインのスタックの合成のときに `deploy-guard.ts` を esbuild で 1 つの ESM に束ね、gzip と base64 にしてビルドの手順へ埋め込む。これで、起点のブランチの変更からは検査を変えられない。S3 のアセットとして渡す形は、反映のプロジェクトのロールに決定 6 の一覧に無い読み取り権限が要るので採らない。

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `deployBuildSpec` | `infra/lib/pipeline-stack.ts` | 変更 | `(appStack: string, cdkVersion: string, guard: string) => BuildSpec`（`guard` は束ねた検査の gzip の base64） | 検査 → 要約値の照合 → `cdk deploy` の順の手順を作る |
| `bundleDeployGuard` | `infra/lib/pipeline-stack.ts` | 新設 | `() => string` | `deploy-guard.ts` を束ねて gzip の base64 で返す |
| `confirmationStage` | `infra/lib/confirmation-stage.ts` | 新設 | `(settings: unknown) => "ai" \| "human"` | 2 つのキーから期待する段階を決める |
| `refusalReason` | `infra/lib/confirmation-stage.ts` | 新設 | `(settings: unknown \| undefined, record: RecordState) => string \| null` | 反映を拒む理由を返す（拒まなければ `null`） |
| `checkAssembly` | `infra/lib/assembly-check.ts` | 新設 | `(dir: string, config: GuardConfig) => { templateFile: string; requiredBootstrapVersion: number }` | 合成の結果が、許した形のアプリのスタックだけであることを確かめる |
| `checkTemplateStage` | `infra/lib/assembly-check.ts` | 新設 | `(template: unknown, expected: "ai" \| "human") => string[]` | テンプレートの段階の値の違反を返す |
| `runDeployGuard` | `infra/lib/deploy-guard.ts` | 新設 | `(dir: string, env: Record<string, string \| undefined>, aws: AwsCli) => Promise<void>` | 下の「処理の手順」の順に検査を打つ |
| `checkTrigger` | `infra/lib/deploy-guard.ts` | 新設 | `(config: GuardConfig, executionId: string, aws: AwsCli) => Promise<void>` | 自分の実行の始まり方が `WebhookV2` であることを確かめる |
| `checkSettings` | `infra/lib/deploy-guard.ts` | 新設 | `(config: GuardConfig, expected: { version: string; sha256: string }, aws: AwsCli) => Promise<{ settings: unknown; record: RecordState }>` | 設定を読み直して版と SHA-256 を比べ、宣言の記録の状態を読む |
| `checkExecutionRole` | `infra/lib/deploy-guard.ts` | 新設 | `(config: GuardConfig, aws: AwsCli) => Promise<void>` | 実行のロールの管理ポリシーがアプリ専用の 1 つだけで、インラインポリシーが無いことを確かめる |
| `checkSimulations` | `infra/lib/deploy-guard.ts` | 新設 | `(config: GuardConfig, aws: AwsCli) => Promise<void>` | 実効の権限の許可と拒否を、期待の表と照らす |
| `checkBootstrapVersion` | `infra/lib/deploy-guard.ts` | 新設 | `(config: GuardConfig, required: number, aws: AwsCli) => Promise<void>` | アプリ専用の bootstrap の版が求める版以上であることを確かめる |
| `awsCli` | `infra/lib/deploy-guard.ts` | 新設 | `(args: string[], env?: Record<string, string>) => Promise<{ status: number; stdout: string; stderr: string }>`（型 `AwsCli`） | AWS CLI をシェルを通さずに打つ |
| `main` | `infra/lib/deploy-guard.ts` | 新設 | `() => Promise<void>` | `argv[2]` と環境変数で `runDeployGuard` を打ち、失敗を 1 行で出して終了コード 1 にする |

- `deployBuildSpec`
  - 事後条件: `install` の段は今のまま。`build` の段は次の順になる
    1. `printf %s '<guard>' | base64 -d | gunzip > /tmp/nd-deploy-guard.mjs`
    2. `node /tmp/nd-deploy-guard.mjs cdk.out`
    3. 要約値の数え直しと `EXPECTED_DIGEST` の比較（今のまま）
    4. `cdk deploy --app cdk.out --require-approval never <appStack>`（今のまま）
  - 決定 5・6 は検査を「要約値を比べる前」に置くので、2 は 3 より前にする。検査は `cdk.out` へ書かない
- `bundleDeployGuard`
  - 事後条件: 束ねの起点は、`deploy-guard.ts` の `main` を import して呼ぶだけの文字列である。束ねた結果の `import` は `node:` の組み込みだけである。同じ入力からは同じ文字列になる（スタックの差分が毎回出ない）
  - 副作用: `infra/lib/` のファイルを読む
- `runDeployGuard`
  - 事前条件: `env` に `ND_GUARD_CONFIG`（JSON）・`PIPELINE_EXECUTION_ID`・`SETTINGS_VERSION`・`SETTINGS_SHA256` がある
  - 事後条件: 正常に返るのは、すべての検査を通ったときだけである
- `checkTrigger`・`checkExecutionRole`
  - 副作用: AWS の読み取り
- `checkSettings`
  - 事後条件: SHA-256 は、`--output json` で受けた値の文字列を解き、改行を足さずに UTF-8 で数える（準備と同じ）。記録の状態は、取得に成功なら `present`、`ParameterNotFound` なら `absent`、ほかの失敗は `unreadable`
  - 副作用: SSM の読み取り
- `checkSimulations`
  - 副作用: `iam:SimulatePrincipalPolicy`
- `checkBootstrapVersion`
  - 事後条件: 版は、反映のロールを引き受けた資格情報で `/cdk-bootstrap/<qualifier>/version` を読む。決定 6 の反映のプロジェクトのロールの一覧にはこのパラメーターの読み取りが無く、反映のロールは標準のテンプレートで読めるためである
  - 副作用: `sts:AssumeRole`、SSM の読み取り。引き受けた資格情報は子プロセスの環境変数にだけ渡す
- `checkAssembly`・`awsCli`
  - 副作用: `checkAssembly` はファイルの読み取り、`awsCli` は外部コマンド
- `main`
  - 副作用: 標準エラーへの出力と終了コード

### 異常系の処理

どの失敗も扱いは「止める」で、`反映しない: <理由>` を CodeBuild の記録に出し、終了コード 1 で終わる。アプリのスタックは変わらない。反映の段が失敗し、通知が届く。直した後の再開は決定 1・5 のとおり（段のやり直しか、Pull Request のマージ）。

| 関数 | 失敗 | 原因 | 検出する場所 |
| --- | --- | --- | --- |
| `runDeployGuard` | 環境変数の欠落、`ND_GUARD_CONFIG` を解析できない、反映を拒む条件に当たる | アクションの変数のつなぎの誤り、宣言した本番、記録がある・読めない | 先頭と `refusalReason` の戻り |
| `main` | 想定外の例外 | 上のどれにも当たらないエラー | 最上位の `catch` |
| `awsCli` | 起動できない・非 0 | CLI が無い・権限が無い・通信の失敗 | `status` を呼んだ側が見る |
| `checkTrigger` | `triggerType` が `WebhookV2` でないか取れない | 手動の開始・最初の実行・ロールバック | 応答の値 |
| `checkSettings` | 取得の失敗、版か SHA-256 の違い、値を JSON として解析できない | 反映の前の書き換え・消して作り直し | 応答と比較 |
| `checkAssembly` | 下の「合成の結果の検査の条件」のどれかに反する。`manifest.json` などを読めない | 起点のブランチの合成のコードの変更 | 各条件 |
| `checkExecutionRole` | 付いた管理ポリシーが 1 つでない・ARN が違う・インラインポリシーがある・取得の失敗 | bootstrap の後の変更 | 応答 |
| `checkSimulations` | 期待の表と違う判定・取得の失敗・応答に判定が無い | 権限の広げ過ぎ・不足 | 応答の `EvalDecision` |
| `checkBootstrapVersion` | 引き受けの失敗・版が無い・数でない・足りない | bootstrap が古い・未作成 | 応答と比較 |
| `bundleDeployGuard` | 束ねの失敗 | 構文の誤り・ファイルが無い | esbuild の例外。パイプラインのスタックの合成が止まる（AWS は変わらない） |

`checkTemplateStage` の違反は戻り値で返し、`runDeployGuard` が 1 件でもあれば止める。統合か Lambda オーソライザーの呼び出し先を関数に結び付けられない場合も違反の 1 件にする。

### 処理の手順

`runDeployGuard` は次の順に打ち、最初の失敗で止まる。

| 順 | 検査 | 満たす条件 |
| --- | --- | --- |
| 1 | `checkTrigger` | 起点のブランチへの push で始まった |
| 2 | `checkSettings` | 版と SHA-256 が準備と同じ |
| 3 | `refusalReason` | `null` |
| 4 | `checkAssembly` | 下の表のすべて |
| 5 | `checkTemplateStage`（4 が返したテンプレート、`confirmationStage` の段階） | 違反が 0 件 |
| 6 | `checkExecutionRole`・`checkSimulations` | 期待どおり |
| 7 | `checkBootstrapVersion`（4 が返した求める版） | 版が足りる |

段階の判定（`confirmationStage`・`refusalReason`）:

| 設定の値 | 宣言の記録 | `confirmationStage` | `refusalReason` |
| --- | --- | --- | --- |
| `launch_declared === true` かつ `environment_kind === "production"` | どれでも | `human` | 理由を返す |
| `launch_declared` が真偽値で `environment_kind` が `development` か `production`（上の行を除く） | `absent` | `ai` | `null` |
| どちらかのキーが欠落か不正（オブジェクトでない値を含む） | `absent` | `human` | `null` |
| 上の 2 行 | `present`・`unreadable` | 上と同じ | 理由を返す |
| `undefined`（読めない） | どれでも | 呼ばない | 理由を返す |

`confirmation-stage-cases.json` は `{ name, settings, record, stage?, refused }` の配列である。`settings` は 2 つのキーを持つオブジェクトで、読めない行は `null` にして `stage` を置かない。行の一覧は決定 6 の「段階の判定規則の正本と契約テスト」に従う。

合成の結果の検査の条件（`checkAssembly`）:

| 対象 | 条件 |
| --- | --- |
| `manifest.json` の成果物の種類 | `aws:cloudformation:stack`・`cdk:asset-manifest`・`cdk:tree`・`cdk:feature-flag-report` だけ |
| スタック | 1 つだけで、名前が `appStack`。アセットのマニフェストは、そのスタックが依存するものだけ |
| スタックのロール | `cloudFormationExecutionRoleArn` がアプリ専用の実行のロール、`assumeRoleArn` がアプリ専用の反映のロール（`${AWS::Partition}` は置き換えて比べる） |
| アセット | `dockerImages` が空。`files` の `source` のキーは `path` と `packaging` だけ（`executable` を拒む）。`path` は合成の結果の中の相対パスで、`..` とリンクを含まない。置き先のバケットはアプリ専用の qualifier のもの |
| テンプレートの実体 | `stackTemplateAssetObjectUrl` があり、`templateFile` のアセットの置き先と同じで、キーが `<templateFile の中身の SHA-256>.json` である。ほかのアセットのキーは `.json` で終わらない |

最後の行は、検査したファイルと反映されるテンプレートを同じにするためにある。`cdk deploy`（2.1148.1）は `stackTemplateAssetObjectUrl` があると手元のテンプレートではなくその S3 の URL を CloudFormation に渡し、同じキーのオブジェクトがあればアップロードを省く。成果物の種類の一覧とキーの形が実際の合成の結果と合うことは、アプリのスタックを合成して受け入れるテストで確かめる。合わなければ条件を緩めず、設計へ戻す。

段階の値の対象（`checkTemplateStage`）:

- 対象の関数は、`AWS::ApiGatewayV2::Integration` の `IntegrationUri` と、`AuthorizerType` が `REQUEST` の `AWS::ApiGatewayV2::Authorizer` の `AuthorizerUri` が指す `AWS::Lambda::Function` である。URI の中の `Ref`・`Fn::GetAtt` を辿り、別名とバージョンは `FunctionName` の先の関数にする
- テンプレートのどこにあっても、キー `ND_CONFIRMATION_STAGE` の値が `expected` と違えば違反にする

実効の権限の期待の表（`checkSimulations`）:

| 対象のロール | 操作 | 資源 | 期待 |
| --- | --- | --- | --- |
| 反映のロール | 決定 6 の「反映の直前の確認」の表の 5 行 | この設置のアプリのスタック | 表のとおり |
| 反映のロール | 同上 | パイプラインのスタック、`<prefix>-nd-other-app`、`nd-other-<environment>-app` | 拒否 |
| 反映のロール | `iam:PassRole` | 既定の qualifier と別の qualifier の実行のロール | 拒否 |
| 実行のロール | `cloudformation:UpdateStack` | パイプラインのスタック | 拒否 |
| 実行のロール | `iam:UpdateAssumeRolePolicy`・`iam:PutRolePolicy`・`iam:AttachRolePolicy` | 反映のプロジェクトのロールと、パイプラインのスタックの名前で始まるロール名 | 拒否 |
| 実行のロール | `codepipeline:UpdatePipeline` | このパイプライン | 拒否 |
| 実行のロール | `ssm:PutParameter` | 設定のパラメーター | 拒否 |
| 実行のロール | `ssm:PutParameter`・`ssm:DeleteParameter` | 宣言の記録 | 拒否 |

`cloudformation:RoleArn` は、決定 6 の表が値を渡すとする行だけ `--context-entries`（型 `string`）で渡す。「拒否」は判定が `allowed` でないことである。

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `GuardConfig` | 型: `partition`・`account`・`region`・`appStack`・`pipelineName`・`pipelineStack`・`settingsParameter`・`recordParameter`・`qualifier`・`deployRoleName`・`appArns`（実行・反映のロール、アセットのバケット、実行の管理ポリシー） | `infra/lib/assembly-check.ts` | — |
| `RecordState` | 型: `"present" \| "absent" \| "unreadable"` | `infra/lib/confirmation-stage.ts` | — |
| `ALLOWED_ARTIFACT_TYPES` | 定数 | `infra/lib/assembly-check.ts` | 上の 4 種類 |
| `STACK_SIMULATION_CASES` | 定数 | `infra/lib/deploy-guard.ts` | 決定 6 の表の 5 行 |
| `ALLOWED_TRIGGER` | 定数 | `infra/lib/deploy-guard.ts` | `WebhookV2` |

### ログと記録の出力

| 関数 | 出すもの | レベルまたは書き先 | 出さないもの |
| --- | --- | --- | --- |
| `runDeployGuard` | 通った検査の名前を 1 行ずつ、段階、設定の版 | CodeBuild の記録（標準出力） | 設定の値・資格情報・AWS CLI の応答の全文 |
| `main` | `反映しない: <理由>` | 標準エラー | 同上 |

### 既存の部品の再利用

| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `bundleDeployGuard` | `NodejsFunction` の束ね、`infra` の `esbuild` | `infra/package.json`、`infra/lib/app-stack.ts` を読む | `esbuild` を使う。`NodejsFunction` は Lambda を作るので使えない |
| `confirmationStage`・`refusalReason` | `settingsSchema`（`packages/contracts`） | `packages/contracts/src/settings.ts` を読む | 使えない。2 つのキーは #181 で足し、検査は zod を束ねない |
| `checkAssembly` | `cxapi` の合成の結果の読み取り、`assemblyDigest`、`nd-setup.ts` の `checkBootstrap` | `grep -rn "manifest" infra --include=*.ts` | 使えない。反映の段に `aws-cdk-lib` が無く、`infra/setup/` は変えない。求める版は同じく成果物の最大値にする |
| `checkTemplateStage` | `aws-cdk-lib/assertions` の `Template` | `infra/test/pipeline-stack.test.ts` を読む | テスト用で、反映の段に無い |
| `runDeployGuard`・`checkTrigger`・`checkSettings`・`checkExecutionRole`・`checkSimulations`・`checkBootstrapVersion` | `infra/setup/aws-reader.ts` | 同ファイルを読む | 使えない。SDK と profile を前提にし、反映の段に `node_modules` が無い |
| `awsCli` | `nd-setup.ts` の `runCommand` | `infra/setup/nd-setup.ts` を読む | 使えない。出力を端末へ流すだけで、受け取らない |
| `main` | 無し | `ls infra/lib infra/bin` | 束ねた検査の起点として要る |

### 単体テストの観点

`aws` は偽の応答を返す関数に差し替え、合成の結果は一時のディレクトリに作る。実際の AWS は呼ばない。

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `deployBuildSpec` | 検査 → 要約値 → 反映の順 | — | 手順に合成が無い。長さが 25,600 文字未満 |
| `bundleDeployGuard` | 解いた結果の `import` が `node:` だけ | 2 回の結果が同じ | — |
| `confirmationStage`・`refusalReason` | 表の全行 | 片方のキーだけの欠落・不正、版の履歴に依らない | 記録の `unreadable` |
| `checkAssembly` | `NodejsFunction` を含む実際のアプリのスタックの合成を受け入れる | ほかのアセットが `.zip` | `executable`・`dockerImages`・別のスタック・許可外の種類・別の実行のロール・URL の差し替え・キーと中身の不一致・`..` のパス |
| `checkTemplateStage` | 全関数が `ai` | `human` を期待して未設定 | 一部だけ未設定・違う値・オーソライザーだけ違う・関数を特定できない・対象外の資源の違う値 |
| `runDeployGuard` | 全部通る | — | 環境変数の欠落、各検査の失敗で後の検査を打たない |
| `checkTrigger` | `WebhookV2` | — | `CreatePipeline`・`StartPipelineExecution`・値が無い |
| `checkSettings` | 一致、記録なし | 末尾に改行のある値 | 版だけ違う・SHA-256 だけ違う・取得の失敗 |
| `checkExecutionRole` | 管理ポリシー 1 つ | — | `AdministratorAccess` の追加・インラインポリシー |
| `checkSimulations` | 期待どおり | — | 決定 6 のテスト設計の 6 ケース |
| `checkBootstrapVersion` | 版が同じ | 版が 1 大きい | 版が無い・足りない・引き受けの失敗 |
| `awsCli`・`main` | `main` は成功で 0 | — | `main` は失敗で 1 と理由の 1 行。`awsCli` は偽の関数に差し替えるので単体では打たない |

## パイプラインのスタック

満たす決定: 決定 2・5・6、受け入れ条件 1・3・4・12

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `constructor` | `infra/lib/pipeline-stack.ts` | 変更 | `(scope: Construct, id: string, props: PipelineStackProps)`（変えない） | 下の事後条件の資源を作る |
| `guardConfig` | `infra/lib/pipeline-stack.ts` | 新設 | `(stack: Stack, s: Settings, appStack: string) => GuardConfig` | 検査へ渡す名前と ARN を `naming.ts` から作る |

- `constructor`
  - 事後条件:
    - 管理の方針（`DenyApprovalPolicy`）を作らない
    - ソースのアクションは `triggerOnPush: false`。`Pipeline` の `triggers` は、プロバイダーが `CodeStarSourceConnection`、`sourceAction` がこのアクション、`pushFilter` の `branchesIncludes` が `[p.branch]` の 1 件
    - 反映のプロジェクトのロールは、名前が `deployRoleName` の `Role` にする
    - 反映のプロジェクトのロールの文は、`sts:AssumeRole`（アプリ専用の反映・ファイルの公開・イメージの公開・実行のロール）、`ssm:GetParameter`（2 つのパラメーター）、`codepipeline:GetPipelineExecution`（このパイプライン）、`iam:ListAttachedRolePolicies`・`ListRolePolicies`・`GetRole`・`SimulatePrincipalPolicy`（アプリ専用の実行と反映のロール）と、CDK が付ける成果物とログの権限だけ。パイプラインの ARN は名前から組み立てる（`pipeline.pipelineArn` を参照すると循環する）
    - 準備のプロジェクトが引き受けるのは、アプリ専用の lookup のロールにする
    - 反映のプロジェクトの環境変数 `ND_GUARD_CONFIG` は `toJsonString(guardConfig(...))`
    - 反映のアクションの環境変数は、`EXPECTED_DIGEST`・`SETTINGS_VERSION`・`SETTINGS_SHA256`（準備の変数）と `PIPELINE_EXECUTION_ID`（`#{codepipeline.PipelineExecutionId}`）
- `guardConfig`
  - 事前条件: スタックのアカウントとリージョンが決まっている（`env` を明示する）

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `constructor` | 合成できない | `pipeline` が無い・接続の名前が長い（今のまま） | `constructor` の先頭 | 止める | エラーの文。合成が非 0 | AWS は変わらない |

### 既存の部品の再利用

| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `guardConfig` | `pipelineResourceNames`・`settingsParameterName`・`stackName` | `infra/lib/naming.ts` を読む | 使う。まとめて値にする所だけを足す |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `constructor` | トリガー・ロールの文・アクションの変数・段の名前・失敗の通知 | — | 管理の方針が無い（今のテストを置き換える）。反映のロールに一覧の外の操作が無い。`DetectChanges` が偽 |
| `guardConfig` | 作り物の設定の値 | — | — |

## 資源の名前

満たす決定: 決定 2・6、受け入れ条件 4

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `pipelineResourceNames` | `infra/lib/naming.ts` | 変更 | `(s: Naming) => {...}`（返りから `denyApprovalPolicy` を除く） | パイプラインの資源の名前を返す |
| `appQualifier` | `infra/lib/naming.ts` | 新設 | `(s: Naming) => string` | `nd` と、`<prefix>/<environment>` の SHA-256 の先頭 8 桁を返す |
| `launchDeclaredParameterName` | `infra/lib/naming.ts` | 新設 | `(s: Naming) => string` | `/<prefix>/<environment>/launch-declared` を返す |
| `deployRoleName` | `infra/lib/naming.ts` | 新設 | `(s: Naming, region: string) => string` | `<prefix>-<environment>-deploy-<region>` を返す |
| `appBootstrapNames` | `infra/lib/naming.ts` | 新設 | `(s: Naming) => { stack: string; executionPolicy: string }` | `<prefix>-<environment>-bootstrap` と `<prefix>-<environment>-app-cfn-exec` を返す |
| `cdkRoleArn` | `infra/lib/naming.ts` | 新設 | `(t: { partition: string; account: string; region: string }, qualifier: string, kind: string) => string` | CDK の bootstrap のロールの ARN を返す |

`nd-setup.ts` は `pipelineResourceNames` の返りを列挙して表示するだけなので、キーが 1 つ減っても `infra/setup/` は変えない。ロールの名前は最長 52 文字で、IAM の上限 64 に収まる。

### 既存の部品の再利用

| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `appQualifier` | `node:crypto` の `createHash` | `infra/lib/assembly-digest.ts` を読む | 使う |
| `launchDeclaredParameterName`・`appBootstrapNames`・`deployRoleName` | `secretName`・`resourceName` | `infra/lib/naming.ts` を読む | 使う |
| `cdkRoleArn` | `pipeline-stack.ts` の `bootstrapRole` | 同ファイルを読む | それを置き換えて 1 か所にする |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `pipelineResourceNames` | `denyApprovalPolicy` が無い | — | — |
| `appQualifier` | 10 文字 | `acme-58885/dev` と `acme-91474/dev` が `nd09bda190` | 組が違えば通常は違う値 |
| `launchDeclaredParameterName`・`appBootstrapNames`・`cdkRoleArn` | 作り物の値 | — | — |
| `deployRoleName` | 作り物の値 | `prefix` 20・`environment` 10 文字で 64 以下 | — |

## アプリの合成

満たす決定: 決定 6、受け入れ条件 11

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `buildApp` | `infra/bin/app.ts` | 変更 | `(app: App, env: NodeJS.ProcessEnv) => void`（変えない） | `settings.pipeline` があるときだけ、`AppStack` に `new DefaultStackSynthesizer({ qualifier: appQualifier(settings) })` を渡す |

`pipeline` が無い設置と `PipelineStack` は既定のままにする。`infra/lib/app-stack.ts` は、先頭のコメントの「承認する人が」の理由を、決定 89 の新しい題に合わせた文に直すだけである。

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `buildApp` | `pipeline` がある設定のアプリのスタックのロールがアプリ専用の qualifier | `ND_STACKS=app` でも同じ | `pipeline` が無い設定とパイプラインのスタックは `hnb659fds` のまま |

## アプリ専用の bootstrap

満たす決定: 決定 6、受け入れ条件 11・12

CDK の CLI には、独自のテンプレートの値を渡す引数を使わない。リポジトリにはテンプレートのコピーも実際の値も置かず、打つ時点の CDK の標準のテンプレート（`node_modules/aws-cdk/lib/api/bootstrap/bootstrap-template.yaml`）に制約と値を当てて、リポジトリの外のファイルへ書き出す。版を上げるときも同じコマンドで当て直す。

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `appExecutionPolicy` | `infra/lib/app-bootstrap-template.ts` | 新設 | `(input: BootstrapInput) => PolicyDocument` | 実行のロールの許可と拒否を作る |
| `restrictBootstrapTemplate` | `infra/lib/app-bootstrap-template.ts` | 新設 | `(templateYaml: string, input: BootstrapInput) => string` | 標準のテンプレートに下の表の変更を当て、JSON で返す |

`BootstrapInput` は `{ partition, account, region, settings: Naming, directRoleArns: string[] }` である。

| テンプレートの資源 | 変更 |
| --- | --- |
| `BootstrapVariant` の既定値 | `nd-factory app`（CLI が標準のテンプレートで上書きしないようにする） |
| `DeploymentActionRole` の信頼ポリシー | 主体はアカウントのまま、引き受けとセッションタグの文の `aws:PrincipalArn` を、反映のプロジェクトのロールと `directRoleArns` に限る |
| 同ロールの CloudFormation の書き込み | 標準が持つ書き込み（変更セットの操作、作成・更新・ロールバック、`DeleteStack`、`UpdateTerminationProtection`）の対象を、すべて `stack/<prefix>-<environment>-app/*` にする。`CreateStack`・`UpdateStack`・`CreateChangeSet` には `cloudformation:RoleArn` の条件を付ける。標準に無い書き込み（`SetStackPolicy`）は足さない。スタックの再構成（`Refactor` の文）は外す |
| 同ロールの `iam:PassRole` | 標準のまま（アプリ専用の実行のロールだけ）であることを確かめる |
| `NdExecutionPolicy`（足す） | 名前が `appBootstrapNames().executionPolicy` の管理ポリシー。中身は `appExecutionPolicy` |
| `CloudFormationExecutionRole` | `DependsOn: NdExecutionPolicy`。管理ポリシーは `--cloudformation-execution-policies` で渡す ARN（上の名前の ARN）を使う |

実行の管理ポリシーは、`--cloudformation-execution-policies` で渡す前に存在しなければならない。テンプレートに入れて `DependsOn` で順序を付けるので、bootstrap の外で方針を作る操作は増えない。

- `appExecutionPolicy`
  - 事後条件: 許可は、定数 `EXECUTION_ALLOW`（CloudFormation の資源の型 → 操作と資源の ARN の形）から作る。資源の ARN は、サービスが許すかぎり `<prefix>-<environment>-app-*`・`<prefix>-<environment>-*`・`<prefix>/<environment>/*` に限る。拒否は、パイプラインのスタックの書き込み、反映のプロジェクトのロールとパイプラインのスタックのロール・ポリシーの変更、このパイプラインの定義の変更と削除、反映のプロジェクトの変更、2 つのパラメーターの書き込みと削除である
  - 操作の一覧そのものは、実装で今の権限と照らして作り、リリース承認ゲートで差分を示す（決定 6）
- `restrictBootstrapTemplate`
  - 事後条件: `DeploymentActionRole` の文が、知っている `Sid` と形だけであることを確かめてから変える

実行のロールの許可には、アプリのスタックのロールを作って方針を付ける操作が入る。拒否の文は実行のロール自身の操作を縛るが、**作ったロールが持てる権限は縛らない**。アプリのスタックが作るロールにアクセス許可の境界を求めるかは、設計文書に決定が無い。

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `restrictBootstrapTemplate` | 解析できない・資源が無い・知らない文がある・結果が 51,200 バイトを超える | CDK の版上げでテンプレートが変わった | 変更の前後 | 呼び出し元へ返す（例外） | `mainAppBootstrap` が理由を出して 1 | ファイルを書かない。コードを直して再実行 |

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `EXECUTION_ALLOW` | 定数 | `infra/lib/app-bootstrap-template.ts` | アプリのスタックの合成に現れる資源の型ごと |

51,200 バイトは、`TemplateBody` で渡せる CloudFormation の上限である。初めての bootstrap にはテンプレートを置くバケットが無い。

### 既存の部品の再利用

| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `appExecutionPolicy` | `aws-cdk-lib/aws-iam` の `PolicyDocument` | `infra/lib/pipeline-stack.ts` を読む | 使わない。テンプレートの JSON に直に入れる |
| `restrictBootstrapTemplate` | `cdk bootstrap --show-template`、`yaml`（`tools` の依存） | `tools/package.json`、標準のテンプレートを読む | `yaml` を使う。子プロセスは起こさず、パッケージのファイルを読む |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `appExecutionPolicy` | 実際に合成したアプリのスタックの資源の型がすべて `EXECUTION_ALLOW` にある。拒否の文がそろう | `prefix` が最長 | `Resource: "*"` と `*:*` の許可が無い |
| `restrictBootstrapTemplate` | 打つ版の標準のテンプレートで、信頼・対象・条件・`PassRole`・`DependsOn` が上の表のとおり | `directRoleArns` が空 | 知らない文を足したテンプレートで例外 |

## qualifier の衝突の確認

満たす決定: 決定 6

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `checkQualifier` | `infra/lib/bootstrap-collision.ts` | 新設 | `(target: { qualifier: string; stackName: string; tags: Record<string, string> }, reader: BootstrapReader) => Promise<{ ok: true; mode: "create" \| "update" } \| { ok: false; reason: string }>` | 決定 6 の表の 2 つの場合だけを成功にする |
| `parseArgs` | `infra/bin/app-bootstrap.ts` | 新設 | `(argv: string[]) => CheckArgs \| TemplateArgs \| UsageError` | 引数を解く |
| `bootstrapReader` | `infra/bin/app-bootstrap.ts` | 新設 | `(target: Target) => BootstrapReader` | SSM と CloudFormation の読み取りを返す |
| `mainAppBootstrap` | `infra/bin/app-bootstrap.ts` | 新設 | `(argv: string[], deps: BootstrapDeps) => Promise<number>` | `check` と `template` を打つ |

`BootstrapReader` は `versionExists(qualifier): Promise<boolean>`（`ParameterNotFound` だけを偽にし、ほかの失敗は投げる）と、`describeStack(name): Promise<{ status; qualifier; tags } | null>`（存在しないときだけ `null`）である。

コマンドは次の 2 つである。

| コマンド | すること |
| --- | --- |
| `npm run app-bootstrap -- check --profile <P> --settings <F>` | 衝突の確認 |
| `npm run app-bootstrap -- template --profile <P> --settings <F> --out <ファイル> [--direct-role <ARN>]...` | 衝突の確認を通してから、テンプレートを書き、打つ `cdk bootstrap` のコマンドを表示する。bootstrap は打たない |

表示するコマンドは、環境 `aws://<account>/<region>`・`--profile`・`--template`・`--qualifier`・`--toolkit-stack-name`・`--cloudformation-execution-policies`・`--tags app-prefix=…`・`--tags app-env=…` を持つ。運用する環境では `--direct-role` を渡さない。手順書は、表示の直後でない後日に打つときも `check` を打ち直すと書く。

- `checkQualifier`
  - 事後条件: `create` は版のパラメーターもこの名前のスタックも無い。`update` はスタックが `CREATE_COMPLETE` か `UPDATE_COMPLETE` で、qualifier と 2 つのタグがこの設置の値
- `bootstrapReader`
  - 副作用: AWS の読み取り
- `mainAppBootstrap`
  - 副作用: `template` は `--out` へ書く

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `checkQualifier` | 表の 2 つの場合でない・読み取りの失敗 | 別の設置が使っている・途中の状態・権限が無い | 読み取りの結果 | 呼び出し元へ返す | `ok: false` と理由 | 何も変えない |
| `parseArgs` | 引数の誤り | 欠落・知らない引数 | 解析 | 呼び出し元へ返す | 使い方と 2 | 直して再実行 |
| `bootstrapReader` | 読み取りの失敗 | 権限・通信 | SDK の例外 | 呼び出し元へ返す | `checkQualifier` が `ok: false` にする | 再実行できる |
| `mainAppBootstrap` | 設定か profile を使えない・衝突・`--out` がリポジトリの中・テンプレートの失敗 | 各行の原因 | 各ステップ | 止める | 理由と 1 | ファイルを書かない。再実行できる |

### 既存の部品の再利用

| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `checkQualifier` | `checkBootstrap`（`nd-setup.ts`） | `grep -rn "bootstrap" infra --include=*.ts` | 使えない。版の大小だけを見る |
| `parseArgs`・`mainAppBootstrap` | `nd-setup.ts` の `parseArgs`、`loadSettingsFile`、`resolveProfile` | `infra/setup/` を読む | 設定と profile の読み取りは使う。`parseArgs` は設置のコマンドの引数に固定なので別に持つ |
| `bootstrapReader` | `readBootstrapVersion`（`aws-reader.ts`） | 同ファイルを読む | 使えない。既定の qualifier のパラメーターに固定で、`infra/setup/` は変えない |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `checkQualifier` | `create`・`update` | `acme-58885/dev` が使う `nd09bda190` を `acme-91474/dev` が確認して失敗 | タグ違い・qualifier 違い・途中の状態・版だけがある・読み取りの失敗 |
| `parseArgs` | 2 つのコマンド | `--direct-role` が 0 件と 2 件 | 欠落・知らない引数 |
| `mainAppBootstrap` | `template` が書いて表示する | — | 衝突で書かない・リポジトリの中の `--out` |
| `bootstrapReader` | 単体では打たない（`checkQualifier` の偽の `reader` で縛る） | — | — |

## 設定のスキーマ

満たす決定: 決定 5、受け入れ条件 12

`pipeline.branch` を `z.string().regex(BRANCH_SHAPE, "英数字と . _ - / だけにする")` にする。`BRANCH_SHAPE` は `/^[A-Za-z0-9._/-]+$/` で、`min(1)` はこの式に含まれる。`npm run generate` で `settings.schema.json` を作り直す。テストは、`main`・`release/v1`・`feature_x-1.2` を受け、`*`・`?`・`[`・`]`・`{`・`}`・`!`・`\`・空白・空文字を拒むことを見る。

## 手順書

満たす決定: 決定 2・3・5・6、受け入れ条件 4・5・11・12

`docs/operations/pipeline-approval.md` はパスを保ち、題を「反映のパイプライン」にする。節の並びは次のとおりで、中身は右の列の決定を手順の形にする。

| 節 | 中身の出所 |
| --- | --- |
| 段（照合と反映の直前の検査を含む） | 決定 1・5・6 |
| 反映の後に記録を読む（`approval/diff.txt`・`approval/ndf-contract.md`） | 決定 1・3 |
| 失敗したとき（段のやり直し・Pull Request のマージ・最初の実行の失敗） | 決定 1・5 |
| 起点のブランチの保護と、反映を始められる主体の確かめ、遷移を止める・戻す | 決定 5 |
| 設定のパラメーターを書ける主体の確かめと、書き換える手順 | 決定 6 |
| 承認の段を持っていた版から上げるとき | 決定 2 |
| アプリ専用の bootstrap への移行と切り替えの順序（衝突の確認 → `template` → `cdk bootstrap`） | 決定 6 |
| 接続を有効にする | 今のまま |
| 順序のまとめ（承認の行を持たない） | 決定 3・5 |

## 全体の設計・運用の手順書・開発の指針

満たす決定: 決定 4、受け入れ条件 5〜11

`docs/design/`・MVV・開発の指針の Skill は、設計 PR で書き直してある。実装 PR で直すのは次の 4 つだけである。

| ファイル | 直す所 |
| --- | --- |
| `docs/operations/setup.md` | 「運用する環境」の節の 2 行（承認の後の反映・方針を付けるまで push しない）。「自分で設置する人」の節に、パイプラインを併設する人を移行の手順へ案内する 1 項。ほかの節は変えない |
| `docs/operations/settings.md` | `pipeline.notify_emails` を「実行の失敗の通知の宛先」に、`pipeline.branch` に使える文字を、書き換えた後の反映を決定 6 の手順に直す |
| `docs/operations/idp-and-apps.md` | 「承認を拒む方針を付けるまで push しない」の項を、決定 5 の確かめを終えるまで push しない、に直す |
| `AGENTS.md` | 「リポジトリの形」の表の `docs/operations/` の行の「反映の承認」を「反映のパイプライン」にする |
