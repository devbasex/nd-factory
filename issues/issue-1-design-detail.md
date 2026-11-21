# #1 の詳細設計: このリポジトリの CI の検査を、ツールの設定のファイルと 2 つの自前の照らしへ下ろす

設計文書 [issue-1-design.md](./issue-1-design.md) の「解き方の全体像」の表を、ファイルと設定の中身へ下ろした文書である。決定の理由は設計文書にある。対象は nd-factory 自体の開発（A）の CI で、利用者のプロジェクトの検査ではない。

## 地図

触るファイル（`*` は新設）:

```text
nd-factory/
├── eslint.config.js                       置き場ごとの塊を足す
├── .dependency-cruiser.cjs              * 依存の向きの規則
├── .gitleaks.toml                       * 漏れの規則と作り物の値の許可
├── knip.jsonc                            * 入口
├── package.json                           スクリプト deps-check・knip・ndf-contract・test:integration、開発の依存
├── vitest.config.ts                       結合のテストを分ける
├── .ndf/project.json                      必須のチェックに 3 つ足す
├── AGENTS.md                              LEAK_CHECK_PATTERN の行
├── .github/
│   ├── zizmor.yml                       * zizmor の設定
│   └── workflows/
│       ├── ci.yml                         check に手順を足し、leak-check・workflow-audit を足す
│       └── ndf-contract.yml             * NDF の契約の照合
├── apps/api/src/users-handler.ts          除外の注釈（#2）
├── apps/api/src/user-store.ts             除外の注釈（#2）
├── apps/web/src/main.ts                   除外の注釈（#2）
├── apps/web/src/users-client.ts           除外の注釈（#4）
├── infra/lib/app-stack.ts                 除外の注釈（#2）
├── infra/test/api-routes.test.ts        * 合成の結果の API Gateway の経路と操作の表の照らし
└── tools/
    ├── package.json                       依存 @nd-factory/contracts・ajv・ajv-formats・yaml
    ├── tsconfig.json                      checks/src を含める
    ├── checks/src/ndf-contract-check.ts * NDF の契約の照合（CLI）
    └── test/
        ├── ndf-contract-check.test.ts   *
        ├── contracts-round-trip.test.ts *  形の正本の往復と I14 の表の照らし
        ├── lint-config.test.ts          *  ESLint の塊が落とすこと
        ├── deps-config.test.ts          *  dependency-cruiser の規則が落とすこと
        ├── knip-config.test.ts          *  knip の設定が落とすこと
        ├── scan-config.integration.test.ts * gitleaks と zizmor の設定が落とすこと（実行ファイルを起こす）
        ├── ci-definition.test.ts          すべてのワークフローを yaml で読む
        └── ref-check.test.ts              ワークフローの版の比べのテストを足す
```

依存の向き: `tools/checks` と `tools/test` は `packages/contracts` だけを import し、ほかの置き場は文字として読む。ツールの設定のファイルはどの置き場のコードも import しない（`eslint.config.js` が料金プランの名前を `@nd-factory/contracts` から読むのを除く）。

| パス | 種類 | 役割 1 文 | 依存する先 | 最上位の関数 |
| --- | --- | --- | --- | --- |
| `tools/checks/src/ndf-contract-check.ts` | 新設 | 固定の点と既定の枝の先端の NDF の契約を、形の正本の判定とデータで照らす | `@nd-factory/contracts`（NDF の契約の使い方） | `fetchContract`・`compareContract`・`renderSummary`・`mainNdfContractCheck`（新設） |
| `tools/test/contracts-round-trip.test.ts` | 新設 | 見本と変形を 4 つの形で検証して比べ、I14・I12・I15 の表の照らしを行う | `@nd-factory/contracts`・ajv・ajv-formats | `mutate`・`representationsOf`（新設。テストの中の関数） |
| `tools/test/ci-definition.test.ts` | 変更 | すべてのワークフローを `yaml` で読んで照らす | `yaml` | `loadWorkflows`・`triggersPullRequest`・`permissionBlocks`（新設）、`jobNames`（変更）、`credentialWords`（変えない） |

## ESLint の設定

満たす決定: 設計の決定 1・9・10、受け入れ条件 1・4・5・6

`eslint.config.js` の今の設定の後ろに、置き場ごとの塊を足す。`apps/*` は `apps/api`・`apps/web`・`apps/runner`・`apps/nd-runtime`・`apps/db-prep` の `src/` で、画面の `apps/web/src/` は `*.ts` と `*.tsx` の両方（決定 140）。テストのディレクトリと e2e を含まない。ESLint は同じ規則を後の塊で上書きするので、同じファイルに掛かる同じ規則の選び方は 1 つの塊にまとめる。今の設定の型の規則の塊（`files: ["**/*.ts"]`）に `**/*.tsx` を足す。

| 置き場 | 規則 | 落とすもの | 全体の設計の行 |
| --- | --- | --- | --- |
| `apps/*` | `no-restricted-properties` | `Date.now`・`Math.random`・`crypto.randomUUID`・`crypto.getRandomValues` | 時計・ID と冪等の鍵 |
| `apps/*` | `no-restricted-syntax` | 引数なしの `new Date()`・鍵 `ConditionExpression` を持つオブジェクトの性質 | 時計・条件つきの書き込み |
| `apps/*` | `no-restricted-globals`（`checkGlobalObject`） | `console`・`fetch` | ログと伏せ字・外部の呼び出し |
| `apps/*` | `@typescript-eslint/no-restricted-imports`（`allowTypeImports`） | `@aws-sdk/*`・`node:http`・`node:https`・`node:crypto` の `randomUUID`・`randomBytes`・`uuid` | 外部の呼び出し・条件つきの書き込み・操作の記録の書き手・ID |
| `apps/**` と `packages/core/src/**`（使える量の判定のモジュール `packages/core/src/usage-limit*` を除く） | `no-restricted-imports` | 料金プランの値の書き出し（#29 が置く 1 つの書き出し） | I8 |
| `apps/web/src/**` | `no-restricted-syntax` | 料金プランの名前と同じ文字列（JSX の属性の値と `JSXText` を含む）。名前は #29 の書き出しから読み、無ければこの選び方を作らない | I8（画面） |
| `apps/web/src/**`・`apps/api/src/**`・`infra/lib/**` | `no-restricted-syntax` | `/v1/` を含む文字列とテンプレートの文字列（経路は形の正本の登録の書き出しからだけ読む。K2-2・K2-3） | I14（画面の呼び出し・HTTP の経路の登録） |
| `apps/web/**` の外の `*.tsx` | `no-restricted-syntax` の `Program` | ファイルそのもの（1 ファイル 1 件） | 言語と書き方の決まりの画面の行（決定 140） |

- すべての塊に `linterOptions: { reportUnusedDisableDirectives: "error" }` を置く（決定 9）。骨組みのコードの今の当たりは、当たる行の前に `// eslint-disable-next-line <規則> -- #2 が横断の部品へ移す` の形（`#4` の行は「#4 が置き換える」）で外す。外す行は「今の姿」の 5 つのファイルの当たる行だけで、実装で ESLint を打って決める
- `eslint.config.js` は最上位の `await` で #29 の料金プランの名前の書き出しを読み、読めなければ名前の選び方を作らない

### 単体テストの観点（`tools/test/lint-config.test.ts`）

| 対象 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| 各塊（ESLint の API の `lintText` に置き場のパスを渡す） | 表の行ごとに、違反の文字列で誤りが出る | 掛けない置き場（`packages/core`・`infra/`（経路の行を除く）・`tools/`・`apps/*/test`）で出ない。型だけの `@aws-sdk/*` の import と `new Date(0)` は出ない。画面の `*.tsx` の JSX の属性と本文でも出る | 違反を直した行に除外の注釈が残ると、使われない注釈の誤りが出る |

## dependency-cruiser の設定

満たす決定: 設計の決定 2、受け入れ条件 1・7

`.dependency-cruiser.cjs` の `forbidden` に置き場ごとの規則を書き、`options` は `tsPreCompilationDeps: true`（型だけの import も数える）・`tsConfig: { fileName: "tsconfig.base.json" }`・`doNotFollow: { path: "node_modules" }`。`npm run deps-check`（`depcruise --config .dependency-cruiser.cjs --output-type err packages apps infra tools`）を `check` のジョブで打つ。

| 規則の名前 | `from`（パス） | `to`（禁じる先） |
| --- | --- | --- |
| `contracts-depends-on-zod-only` | `^packages/contracts/src/` | `packages/contracts/` の外のこのリポジトリのファイルと、`zod` の外のパッケージ |
| `core-depends-on-contracts-only` | `^packages/core/src/` | `packages/contracts/` と `packages/core/` の外のこのリポジトリのファイル |
| `apps-do-not-import-each-other` | `^apps/([^/]+)/` | `^apps/` のうち自分の app の外（`$1` を使う） |
| `apps-do-not-import-infra-or-tools` | `^apps/` | `^infra/`・`^tools/` |
| `web-uses-browser-core-only` | `^apps/web/` | `^packages/core/src/` のうち `clock`・`ids`・`redact`・`log` の外 |
| `infra-does-not-import-apps` | `^infra/` | `^apps/` |
| `tools-depends-on-contracts-only` | `^tools/` | `^packages/core/`・`^apps/`・`^infra/` |
| `react-only-in-web` | `apps/web/` の外 | `react`・`react-dom`・`@vitejs/plugin-react` |

- 今の当たりは、試しの規則で 0 件だった（設計文書の LIB4）。当たれば、検査を足す Pull Request で直すか、dependency-cruiser の標準の除外（規則の `pathNot`）に課題の番号を `comment` に添えて外す

### 単体テストの観点（`tools/test/deps-config.test.ts`）

| 対象 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| 規則（dependency-cruiser の API の `cruise` を、一時の木に置いた作り物のファイルへ設定のファイルのまま打つ） | 規則ごとに、違反の import を 1 つ置いた木で、その規則の名前の誤りが 1 件出る | 型だけの import でも出る。`@nd-factory/*` の名前の import と相対のパスの import の両方で出る。`apps/web` の `react` の import では出ない | 規則を 1 つ消した設定で、その違反が出なくなる（テストが落ちる） |

## gitleaks の設定と `leak-check` のジョブ

満たす決定: 設計の決定 3、受け入れ条件 1・2・3

`.gitleaks.toml`:

| 欄 | 中身 |
| --- | --- |
| `[extend]` | `useDefault = true`（既定の規則を残す） |
| `[[rules]]` `nd-aws-account-id` | 前後が英数字でない 12 桁の数（`secretGroup` で数の部分） |
| `[[rules]]` `nd-aws-arn` | `arn:` とパーティション（`aws`・`aws-cn`・`aws-us-gov`）で始まり、アカウントの欄が 12 桁のもの |
| `[[rules]]` `nd-aws-resource-id` | AWS の資源の ID の頭（`vpc-`・`subnet-`・`sg-`・`i-`・`vol-`・`snap-`・`ami-`・`igw-`・`rtb-`・`eni-`・`nat-`・`eipalloc-`・`lt-`）と 8 か 17 桁の 16 進 |
| `[[rules]]` `nd-aws-endpoint` | 資源ごとに名前の付く AWS の端点（`*.execute-api.<リージョン>.amazonaws.com`・`*.lambda-url.<リージョン>.on.aws`・`*.cloudfront.net`・`*.auth.<リージョン>.amazoncognito.com`・`*.rds.amazonaws.com`・`*.s3.amazonaws.com`）の資源の部分 |
| `[[allowlists]]`（4 つの `nd-aws-*` の規則に掛ける。`targetRules`） | 値が作り物の `123456789012`・頭が `acme`・`us-west-2`・`example.com`・置き場所の記号（`<…>`・`${…}`）。作り物の UUID（`00000000-0000-7000-8000-…` の形）の 12 桁の部分 |
| `[[allowlists]]`（全体） | 値に作り物の印 `EXAMPLE` を含む |

ジョブ `leak-check` の手順:

1. `actions/checkout`（`fetch-depth: 0`・`persist-credentials: false`）
2. 環境変数 `GITLEAKS_VERSION`・`GITLEAKS_SHA256` の版の linux の資産を取り、`sha256sum` を `GITLEAKS_SHA256` と直接比べ、一致したときだけ展開して `PATH` へ置く（配布元のチェックサムのファイルと比べない。固定にならないため）
3. 実際の値の規則を重ねる: 秘密 `LEAK_CHECK_PATTERN` があれば、一時のディレクトリに `[extend] path = "<リポジトリ>/.gitleaks.toml"` と規則 `nd-real-value`（`regex` に秘密の正規表現を `'''` で囲んで置く）の 2 つだけを持つ設定を書く。無ければ `.gitleaks.toml` をそのまま使い、`LEAK_CHECK_REQUIRE_PATTERN` が `1`（正本のリポジトリの中の実行。参照の検査と同じ式）なら手順を失敗にする
4. `gitleaks dir . --config <設定> --redact=100 --no-banner --exit-code 1`（依存を入れる前なので、追跡していないファイルは木に無い）
5. Pull Request では `gitleaks git . --config <設定> --redact=100 --no-banner --log-opts="<base.sha の分岐点>..<head.sha>"`。分岐点は `git merge-base` で求める
6. 一時の設定のファイルを消す。`LEAK_CHECK_PATTERN` は手順の環境変数でだけ渡し、ほかの手順に渡さない

- 当たりは gitleaks の出力のまま（規則・ファイル・行・伏せた秘密）。正当な当たりは gitleaks の標準の除外（値の行の `gitleaks:allow` か `.gitleaksignore`）に、注か理由を添えて置く。今の木は既定の規則で当たり 0 件（設計文書の LIB1）

## knip の設定

満たす決定: 設計の決定 4・8、受け入れ条件 5・12

`knip.jsonc`: `workspaces` に `.`・`packages/*`・`apps/*`・`infra`・`tools` を置き、ワークスペースごとの入口（Lambda の起点・画面の起点・設置のコマンド・検査の CLI・設定のファイル）と `treatConfigHintsAsErrors: true` を書く。`npm run knip`（`knip --no-progress`）を `check` のジョブで打つ。生成した画面の呼び出しのファイルは入口にしない（使われない書き出しを報告させるため。K2-2）。

- 今の当たり（使われない開発の依存 `infra/package.json` の `esbuild`、使われない書き出し 4 件）は、検査を足す Pull Request で直す。CDK が実行の時に読む `esbuild` のように直せないものだけを `ignoreDependencies` に置き、`knip.jsonc` の行の注に理由と課題の番号を書く

### 単体テストの観点（`tools/test/knip-config.test.ts`）

| 対象 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `knip.jsonc`（一時の木にワークスペースの形を組み、設定を写して knip を子のプロセスで打つ） | 揃った木で当たり 0 件 | 入口から使う書き出しは当たらない | 使われない書き出し・使われない依存・どこからも読まれないファイルをそれぞれ 1 つ足すと当たる。使われない `ignoreDependencies` の行で誤りになる |

## zizmor の設定と CI の定義のテスト

満たす決定: 設計の決定 5、受け入れ条件 1・8・10・13

`.github/zizmor.yml` は既定の点検を外さず、外すときは点検の名前と理由を書く。ジョブ `workflow-audit` は `persist-credentials: false` で取り、`ZIZMOR_VERSION` の版の linux の実行ファイルの資産を `ZIZMOR_SHA256` と直接比べてから置き、`zizmor --offline --config .github/zizmor.yml .github/workflows` を打つ。当たりで失敗する。

CI の定義のテスト（`tools/test/ci-definition.test.ts`）は今のテストを残し、ワークフローを `yaml` で読む。

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `loadWorkflows` | `tools/test/ci-definition.test.ts` | 新設 | `(root: string) => { path: string; text: string; doc: Workflow }[]` | `.github/workflows/` の `*.yml`・`*.yaml` を読み、解いた値と元の文字列を返す。解けなければ失敗 |
| `jobNames` | 同上 | 変更 | `(doc: Workflow) => string[]` | `jobs` の鍵の名前を返す（今は文字列を行で読む） |
| `triggersPullRequest` | 同上 | 新設 | `(doc: Workflow) => boolean` | `on` が `pull_request` を持つか（文字列・配列・鍵の 3 つの書き方） |
| `permissionBlocks` | 同上 | 新設 | `(doc: Workflow) => { scope: string; value: unknown }[]` | 最上位と各ジョブの `permissions` を、場所と値の組で返す |
| `credentialWords` | 同上 | 変えない | `(yaml: string) => string[]` | 元の文字列で AWS の資格情報の語を探す |

テストが照らすこと: Pull Request で起動するワークフローのジョブの名前の和集合が必須のチェックの宣言と等しい・ジョブの名前がワークフローの間で重ならない・どのワークフローにも AWS の資格情報の語が無い・最上位の `permissions` が `{ contents: read }` だけで、ジョブの `permissions` は持たないか同じ。参照の検査（`tools/ref-check`）は追跡しているファイルをすべて読むので変えず、ワークフローの文字列に NDF の版を読む式と比べを同じ行に置くと当たるテストを `tools/test/ref-check.test.ts` に足す。

### 単体テストの観点

| 対象 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `loadWorkflows`・`triggersPullRequest`・`jobNames` | 2 つのワークフローを読み、Pull Request で起動するものを選ぶ | `on: pull_request`・`on: [pull_request]`・`on:` の下の鍵の 3 つの書き方 | 解けない YAML で失敗する。片方のワークフローにだけ資格情報の語・`id-token: write` を足すと当たる |
| `permissionBlocks` | 今のワークフローで違反 0 件 | ジョブの `permissions: { contents: read }` は通る | ジョブに `pull-requests: write`・`write-all` を足すと場所つきで当たる |
| `scan-config.integration.test.ts`（gitleaks と zizmor の実行ファイルを起こす。`leak-check` と `workflow-audit` のジョブで `npm run test:integration` として打つ） | 作り物の値だけの一時の木で gitleaks の当たり 0 件、今のワークフローを写した木で zizmor の当たり 0 件 | 作り物の UUID・置き場所の記号・13 桁の数で当たらない | 実行の時に組み立てた作り物でない 12 桁・ARN・端点・token と、重ねた規則の語を `docs/` の下に置くと当たり、報告に値が現れない。途中のコミットで足して消した値が `git` の探しで当たる。書き込みの権限・`persist-credentials` を外した取得・枝の名前で参照した動作で zizmor が当たる |

## 形の正本の往復のテスト

満たす決定: 設計の決定 8、受け入れ条件 1・5

`tools/test/contracts-round-trip.test.ts` は、#2 の書き出し（K2-3）から操作の表と生成物を読む。書き出しが無い間は、リポジトリの表を照らすテストを「相手が無い」の名前で飛ばし、作り物の表のテストだけを走らせる。

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `mutate` | `tools/test/contracts-round-trip.test.ts` | 新設 | `(value: unknown, schema: JsonSchema) => Mutation[]` | 見本から変形（必須の項目を 1 つずつ消す・項目の型を変える・知らない項目を足す・配列を最初の 1 件の値にする）を作る |
| `representationsOf` | 同上 | 新設 | `(op: OperationView, generated: GeneratedView) => Representation[]` | 1 つの操作の要素と結果の形を、zod・JSON Schema・OpenAPI の要素の形・MCP の道具の入力と出力の形の検証の関数として返す。MCP の入力は `{"items": [...]}` に包む。人だけの操作は MCP の形を持たない |

テストが照らすこと:

| # | 照らすこと |
| --- | --- |
| 1 | 見本と変形を 4 つの形で検証し、通るか拒むかが違う組が無い。変形していない見本はすべての形で通る |
| 2 | MCP の道具の名前の集まりが、利用者向けの人だけでない操作の名前の集まりと等しい |
| 3 | 人だけの操作ごとに、同じエンティティの人だけでない読む操作がある |
| 4 | F1〜F20 がどれかの操作の機能にある |
| 5 | 利用者向けの操作の要求と応答の形が配列（I12） |
| 6 | 名前が `_at` で終わる項目が UTC の日時の形、`amount_minor` を持つ要素が `currency` を必須にする（I15） |
| 7 | HTTP の経路の登録の経路の集まりが、操作の表の経路の集まりと等しい（形の正本の中の照らし。実際の登録は下の「実際の経路の照らし」） |

### 単体テストの観点

| 対象 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| 照らすこと 1〜7（作り物の操作の表をテストの中で組む） | 揃った表で 0 件 | 人だけの操作は 3 つの形で比べる。空の配列の見本 | 照らすことごとに、1 か所を壊した表（JSON Schema だけ必須の項目を外す・道具を 1 つ消す・人だけの操作の読み出しを消す・機能を消す・配列でない要求・時刻帯の無い日時・通貨の無い金額・表に無い経路）で 1 件 |

## 実際の経路の照らし

満たす決定: 設計の決定 8、受け入れ条件 1・5

往復のテストの照らすこと 7 は形の正本の中の登録だけを見る。`infra` が API Gateway に実際に置く経路と、Lambda の振り分けが受ける経路は、次の 2 つのテストが操作の表と照らす。どちらも `check` の `npm run test` で走る。

| テスト | 担当 | 読むもの | 照らすこと |
| --- | --- | --- | --- |
| `infra/test/api-routes.test.ts` | #1 | 今のテストと同じ組み方（`infra/test/support.ts` の作り物の設定）で合成した `AppStack` の `Template`（`cdk.out` に書く CloudFormation と同じ） | (a) `AWS::ApiGatewayV2::Route` の `RouteKey`（`<方法> <経路>`）の集合が、K2-3 の登録の利用者向けと機械向けの経路の集合と等しい。(b) `AWS::ApiGatewayV2::Api` が `Body`・`BodyS3Location` を持たない（OpenAPI の取り込みは経路を `Route` の資源に出さないため）。(c) `AWS::ApiGateway::*`（REST の API）の資源が無い。(d) `RouteKey` が `$default` でなく、経路が `{proxy+}` を含まない（すべてを受ける経路は表と照らせないため） |
| `apps/api/test/dispatch-routes.test.ts` | #2（K2-7） | `apps/api` の振り分けの登録 | 振り分けが受ける `<方法> <経路>` の集合が操作の表の経路の集合と等しく、表に無い経路の要求が 404 になる |

- 合成の結果を読むので、`HttpRoute`・`CfnRoute`・`addRoutes`・文字列の連結のどれで組んだ経路も同じ形で当たる
- K2-3 の登録の書き出しが無い間は (a) を「相手が無い」の名前で飛ばし、(b)〜(d) は今のスタックで照らす（今の `/v1/users` の経路は (b)〜(d) に当たらない）。比べる関数 `routeKeysOf(template)` と `compareRoutes(keys, registry)` は、作り物の表とテストの中で組んだスタックで落ちることを示す
- #2 の Pull Request の CI で、(a) が飛ばされずに走ったことをテストの出力で確かめる

### 単体テストの観点（`infra/test/api-routes.test.ts`）

| 対象 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `routeKeysOf`・`compareRoutes` と (b)〜(d) | 作り物の表と、その経路を `addRoutes` で置いたスタックで 0 件 | `HttpRoute` と `CfnRoute` で置いた経路も数える。同じ経路の方法違いを別に数える | 経路を 1 件落としたスタック・表に無い経路を足したスタックで 1 件ずつ。`Body` を持つ API・REST の API・`$default`・`{proxy+}` を置いたスタックでそれぞれ落ちる |

## NDF の契約の照合

満たす決定: 設計の決定 6・7、受け入れ条件 1・9。読む契約は実行の文書の「NDF との契約」（固定の点の置き場 `plugins/ndf/contracts/`・先端は既定の枝）に従う。`C/` は `plugins/ndf/contracts/` の略である。

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `fetchContract` | `tools/checks/src/ndf-contract-check.ts` | 新設 | `(rev: ContractRev, repoUrl: string, workDir: string) => Promise<ContractFiles>` | NDF のリポジトリから 1 つのコミットを深さ 1 で取り、契約のファイルを読む。先端は `git ls-remote --symref` の `HEAD` で既定の枝を引く |
| `compareContract` | 同上 | 新設 | `(files: ContractFiles, use: NdfContractUse \| null) => ContractFinding[]` | 下の 6 つを照らし、食い違いを返す |
| `renderSummary` | 同上 | 新設 | `(fixed: ContractFinding[], tip: ContractFinding[] \| null, notes: string[]) => string` | 要約の Markdown（照らした先ごとの `checked:` か `skip:` の行、固定の点と先端の食い違いの表、先端の区間の報告の形の差分）を作る |
| `mainNdfContractCheck` | 同上 | 新設 | `(argv: string[], env: NodeJS.ProcessEnv) => Promise<number>` | 取得・照らし・要約・終了コードをつなぐ |

- `mainNdfContractCheck`
  - 引数: `[--root <作業の木>] [--summary <要約のファイル>]`。スクリプト `npm run ndf-contract`
  - 事後条件: どの起動でも、作業の木の `ndf-pin.json` の固定の点と、既定の枝の先端の両方を照らす（設計文書の決定 6）。固定の点の食い違いで終了コード 1、先端の食い違いは要約に並べて 0
  - 出力の行（標準出力と要約の両方）: `checked: fixed <固定の点のコミット> 1-6`・`checked: tip <先端のコミット> 1-6`・`skip: no-contract-use <固定の点のコミット>`（使い方の書き出しが無く、1〜6 を照らさなかった。定数 `CONTRACT_USE_REQUIRED` が偽のときだけ）・`fail: no-contract-use <固定の点のコミット>`（`CONTRACT_USE_REQUIRED` が真なのに書き出しが無い）。先端を取れなければ `checked: tip` を出さず、要約に先端を照らさなかったと出す
  - 副作用: 一時のディレクトリへの取得、要約のファイルへの追記（ワークフローは `GITHUB_STEP_SUMMARY` を渡す）
- 固定の点のコミットは `ndf-pin.json` から読む。キーの名前は参照の検査の書き方に倣って定数に置き、キーを読む行に大小の比べの記号と矢印の関数を置かない（参照の検査の版の比べに当たるため）

照らすこと（実行の文書の (1)〜(5) と、使う口の有無）:

| # | 照らすこと | 契約のファイル | nd-factory の側（#2 の NDF の契約の使い方。K2-6） |
| --- | --- | --- | --- |
| 1 | 見本 26 件を呼び出しの判定へ通し、`valid` と同じ判定になる | `C/domains/entrypoint-cases.json`・`C/domains/entrypoints.json` | 呼び出しの判定 |
| 2 | `version.json` の `history` の最後の行（版と sha256）が受ける組にある | `C/version.json` | 受ける組 |
| 3 | 使う口と実行の場（ホステッド・手元のマシン）の組ごとに、`set_by: service` の名前とその口の `env` 列の名前が、使い方のその組の渡す環境変数の名前を含む | `C/domains/env.json`・`C/domains/entrypoints.json` | 口と実行の場の組ごとの渡す環境変数の名前 |
| 4 | `reader: service` の読むファイルの `fields` が、翻訳が読む項目を含む。読むファイルの行が契約にある | `C/domains/ndf-files.json` | 読むファイルと項目 |
| 5 | 区間の報告の `shape.values`・`shape.items`・`shape.required`・`shape.material` が、ランナーが読む値と項目を含み、同じファイルの `cases` の見本を区間の報告の読み取りへ通して `result` と `errors` の有無が同じ判定になる | `C/hooks/unattended-report.json` | 区間の報告から読む値と項目・区間の報告の読み取りの関数（形の正本の区間の報告の形から作り、ランナーも同じ関数で読む。K2-6） |
| 6 | 使う口がすべて契約の口の表にある | `C/domains/entrypoints.json` | 使う口 |

- 先端では、通っても `C/hooks/unattended-report.json` の `shape` を固定の点と比べ、差分を要約に並べる（実行の文書の「通ったときの差分」）
- `ask-journal` の行が `fields` を持つようになったら、要約の知らせの行へ出す（失敗にしない。#41 の決定 106 の答えを知るため）
- ランナー（#6）が実際に組み立てた呼び出しを判定に通すことと、判定が拒む呼び出しで NDF を起こさないことと、区間の報告を形の正本の読み取りの関数だけで読むことは、`apps/runner` のテストが照らす（#6 へ渡す欠け）

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| NDF のリポジトリの URL | 定数（出所: 実行の文書の「NDF との契約」） | `tools/checks/src/ndf-contract-check.ts` | `https://github.com/devbasex/ai-plugins` |
| 契約の置き場 | 定数（同上） | 同上 | `plugins/ndf/contracts` |
| `ContractFinding` | 型 `{ check: 1〜6; path: string; id?: string; detail: string }`。`id` は見本の id か配列の位置 | 同上 | — |
| `NdfContractUse` | 型（#2 の書き出しから写す） | 同上 | 書き出しが無ければ `null` |
| `CONTRACT_USE_REQUIRED` | 定数（真偽）。NDF の契約の使い方の書き出しを必須にするか | 同上 | 偽。#2 の書き出しを置く Pull Request が同じ変更で真にする（K2-6）。真にした後に偽へ戻す変更は、照合を外す変更としてレビューで見る（1 行の差分に出る） |

### 異常系の処理

| 関数 | 失敗 | 原因 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- |
| `fetchContract`（固定の点） | 取れない・契約のファイルが無い・JSON でない | ネットワーク・固定の点の誤り・置き場の移動 | 止める | 標準エラーに理由、終了コード 2 | 打ち直せる。置き場の移動なら固定の点を変える Pull Request で直す |
| `fetchContract`（先端） | 同上 | 同上 | 既定値で続ける | 要約に先端を照らさなかったと出し、固定の点の結果で終わる | 次の実行で照らす |
| `compareContract` | NDF の契約の使い方の書き出しが無く、`CONTRACT_USE_REQUIRED` が偽 | #2 がまだ置いていない | 既定値で続ける（1〜6 を照らさず、契約のファイルが読めることだけを確かめる） | `skip: no-contract-use` の行。`checked:` の行を出さない。終了コード 0 | #2 の Pull Request の CI で `checked: fixed` が出ることを確かめる |
| `compareContract` | NDF の契約の使い方の書き出しが無く、`CONTRACT_USE_REQUIRED` が真 | #2 の後に書き出しを消した・名前を変えた | 止める | `fail: no-contract-use` の行、終了コード 1 | 書き出しを戻す |
| `mainNdfContractCheck` | 固定の点で食い違う | 固定の点か形の正本を変えた | 呼び出し元へ返す | 要約の表と食い違いの行、終了コード 1 | 直すか固定の点を戻す |
| `mainNdfContractCheck` | 先端だけで食い違う | 上流の未配布の変更 | 既定値で続ける | 要約の表に見本の id と契約のファイルのパス、終了コード 0 | 次の固定の点を変える Pull Request で扱う |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `compareContract` | 作り物の契約と使い方で 0 件 | 使い方が `null` で照らさない。`ask-journal` に `fields` を足した契約で知らせが出て、食い違いにならない | 1〜6 のそれぞれ 1 つを壊した契約で、その番号の食い違いが出る |
| `mainNdfContractCheck` | 固定の点だけの食い違いで 1、先端だけで 0 と要約の行。どちらも `checked: fixed` が出る | `CONTRACT_USE_REQUIRED` が偽で使い方の書き出しが無いと `skip: no-contract-use` と 0 | `CONTRACT_USE_REQUIRED` が真で書き出しが無いと `fail: no-contract-use` と 1（定数をテストの引数で差し替える）。固定の点の取得の失敗で 2 |

`fetchContract` はテストでネットワークを使わず、テストの中で作った git のリポジトリを NDF のリポジトリの代わりに渡す（URL を引数で差し替える）。

## ワークフローと宣言

満たす決定: 設計の決定 3・5・6、受け入れ条件 1・10

| ファイル | 変える中身 |
| --- | --- |
| `.github/workflows/ci.yml` | ジョブ `check` の `npm run check` の後に `npm run deps-check` と `npm run knip` の手順を足す。ジョブ `leak-check`（上の「gitleaks の設定と `leak-check` のジョブ」の手順と、最後に `npm ci` の後の `npm run test:integration -- scan-config`）とジョブ `workflow-audit`（上の「zizmor の設定と CI の定義のテスト」）を足す。動作の版はコミットの SHA で固定する（今の `ci.yml` と同じ） |
| `.github/workflows/ndf-contract.yml`（新設） | `on` は `pull_request`・`push`（main）・`schedule`（毎日 1 回）・`workflow_dispatch`。`permissions: contents: read`。ジョブ `ndf-contract` は `npm ci` の後に `npm run ndf-contract -- --summary "$GITHUB_STEP_SUMMARY"` を打つ |
| `.ndf/project.json` | `ci.required_checks` に `leak-check`・`workflow-audit`・`ndf-contract` を足す。`ci.workflows` に `ndf-contract.yml` の行を足す |
| `package.json` | スクリプト `deps-check`・`knip`・`ndf-contract`・`test:integration`。開発の依存 `dependency-cruiser`・`knip` |
| `vitest.config.ts` | 結合のテスト（`*.integration.test.ts`）を `tools` の単体のテストから外し、`test:integration` でだけ打つ |
| `tools/package.json` | 依存 `@nd-factory/contracts`・`ajv`・`ajv-formats`・`yaml` |
| `tools/tsconfig.json` | `checks/src` を含める |
| `AGENTS.md` | 「秘密とインフラの値を置かない」に、実際の値の正規表現は CI の秘密 `LEAK_CHECK_PATTERN` から受ける行を足す |
