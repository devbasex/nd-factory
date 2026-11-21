# #1 の詳細設計: このリポジトリの CI の検査を、ツールの設定のファイルと 2 つの自前の照らしへ下ろす

設計文書 [issue-1-design.md](./issue-1-design.md) の「解き方の全体像」の表を、ファイルと設定の中身へ下ろした文書である。決定の理由は設計文書にある。対象は nd-factory 自体の開発（A）の CI で、利用者のプロジェクトの検査ではない。

## 地図

触るファイル（`*` は新設）:

```text
nd-factory/
├── eslint.config.js                       置き場ごとの塊を足す
├── .dependency-cruiser.cjs              * 依存の向きの規則
├── .gitleaks.toml                       * 自前の漏れの規則と作り物の値の許可（既定を読まない）
├── .gitleaks-default.toml               * 既定の規則と作り物の印の許可
├── knip.jsonc                            * 入口
├── package.json                           スクリプト deps-check・knip・ndf-contract・test:integration、開発の依存
├── vitest.config.ts                       結合のテストを分ける
├── .ndf/project.json                      必須のチェックに 4 つ足す
├── AGENTS.md                              LEAK_CHECK_PATTERN の行
├── .github/
│   ├── zizmor.yml                       * zizmor の設定
│   └── workflows/
│       ├── ci.yml                         check に手順を足し、leak-check・workflow-audit を足す
│       ├── leak-real-value.yml          * 実際の値の照らし（信頼する定義と包みで、Pull Request の内容をデータとして探す）
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
    ├── checks/src/leak-check.ts         * gitleaks の包み（設定を組み、報告を絞って伏せる）
    └── test/
        ├── ndf-contract-check.test.ts   *
        ├── contracts-round-trip.test.ts *  形の正本の往復と I14 の表の照らし
        ├── lint-config.test.ts          *  ESLint の塊が落とすこと
        ├── deps-config.test.ts          *  dependency-cruiser の規則が落とすこと
        ├── knip-config.test.ts          *  knip の設定が落とすこと
        ├── leak-check.test.ts           *  漏れの検査の包みの単体のテスト（gitleaks を起こさない）
        ├── leak-scan.integration.test.ts * gitleaks の設定と包みが落とすこと（leak-check のジョブ）
        ├── workflow-audit.integration.test.ts * zizmor の設定が落とすこと（workflow-audit のジョブ）
        ├── ci-definition.test.ts          すべてのワークフローを yaml で読む
        └── ref-check.test.ts              ワークフローの版の比べのテストを足す
```

依存の向き: `tools/checks` と `tools/test` は `packages/contracts` だけを import し（`leak-check.ts` は何も import しない）、ほかの置き場は文字として読む。ツールの設定のファイルはどの置き場のコードも import しない（`eslint.config.js` が料金プランの名前を `@nd-factory/contracts` から読むのを除く）。

| パス | 種類 | 役割 1 文 | 依存する先 | 最上位の関数 |
| --- | --- | --- | --- | --- |
| `tools/checks/src/ndf-contract-check.ts` | 新設 | 固定の点と既定の枝の先端の NDF の契約を、形の正本の判定とデータで照らす | `@nd-factory/contracts`（NDF の契約の使い方） | `fetchContract`・`compareContract`・`renderSummary`・`mainNdfContractCheck`（新設） |
| `tools/checks/src/leak-check.ts` | 新設 | gitleaks を規則の設定か実際の値の設定で起こし、黙らせる仕組みを効かせず、報告の値とパスを伏せて当たりを出す | Node の組み込みの部品・gitleaks の実行ファイル | `buildConfigs`・`runGitleaks`・`maskPath`・`mainLeakCheck`（新設） |
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
| `apps/**` と `packages/core/src/**`（使える量の判定のモジュール `packages/core/src/usage-limit*` を除く） | `no-restricted-imports` | 料金プランの値の書き出し（#29 が置く 1 つの書き出し。指定子は下の `PLAN_VALUES_SPECIFIER`）。指定子の文字列だけを見るので、相対のパスでの import は dependency-cruiser の `plan-values-only-in-usage-limit` が落とす | I8 |
| `apps/web/src/**` | `no-restricted-syntax` | 料金プランの名前と同じ文字列（JSX の属性の値と `JSXText` を含む）。名前は #29 の書き出しから読む（読めないときの扱いは下の `PLAN_EXPORT_REQUIRED`） | I8（画面） |
| `apps/runner/src/**` | `no-restricted-properties` | `JSON.parse`（NDF のファイルと区間の報告は形の正本の読み取りの関数で読み、ランナーは JSON を自分で解かない。#6 へ渡す欠け K6-4） | F23 の照らしがランナーの読み取りにも効くこと（設計文書の決定 7） |
| `apps/web/src/**` | `no-restricted-imports`（`importNames`） | `screen-pending.json` に並ぶ操作の生成した呼び出しの import（画面を作るなら同じ Pull Request で行を消す。K2-2）。データが無ければこの選び方を作らない | I14（画面の無い間の除外の陳腐化） |
| `apps/web/src/**`・`apps/api/src/**`・`infra/lib/**` | `no-restricted-syntax` | `/v1/` を含む文字列とテンプレートの文字列（経路は形の正本の登録の書き出しからだけ読む。K2-2・K2-3） | I14（画面の呼び出し・HTTP の経路の登録） |
| `apps/web/**` の外の `*.tsx` | `no-restricted-syntax` の `Program` | ファイルそのもの（1 ファイル 1 件） | 言語と書き方の決まりの画面の行（決定 140） |

- 行の注釈の除外は、骨組みの 5 つのファイルでだけ効かせる（決定 9）。置き場ごとの塊の後ろに、すべてのファイルへ `linterOptions: { noInlineConfig: true }` を置く塊を足し、さらにその後ろの塊で定数 `SKELETON_EXCEPTIONS`（「今の姿」の 5 つのファイルのパスと課題の番号の組。`eslint.config.js` の中）のファイルにだけ `linterOptions: { noInlineConfig: false, reportUnusedDisableDirectives: "error" }` を置く。ほかのファイルの `eslint-disable` の注釈は効かず、違反はそのまま出る。骨組みのコードの今の当たりは、当たる行の前に `// eslint-disable-next-line <規則> -- #2 が横断の部品へ移す` の形（`#4` の行は「#4 が置き換える」）で外す。外す行は 5 つのファイルの当たる行だけで、実装で ESLint を打って決める。#2・#4 がコードを移すときは、注釈を消し、同じ変更で `SKELETON_EXCEPTIONS` の行も消す（注釈が 1 つも無いファイルの行が残ると `lint-config.test.ts` が落ちる）。今のリポジトリに `eslint-disable` の注釈は無い（2026-11-21 に `git grep` で確かめた）
- `eslint.config.js` は最上位の `await` で #29 の料金プランの名前の書き出しと、#2 の `packages/contracts/data/screen-pending.json` を読む。`screen-pending.json` は読めなければその選び方を作らない
- 料金プランの書き出しの置き場と名前は、`eslint.config.js` の定数に置き、#29 へ同じ値で渡す（設計文書の K29-1）: 名前は `PLAN_NAMES_EXPORT`（`@nd-factory/contracts` の書き出し `planNames`。料金プランの名前の閉じた語の集まりを `readonly string[]` で持つ）、値は `PLAN_VALUES_SPECIFIER`（`@nd-factory/contracts/plan-values`。`packages/contracts/data/plan-values.json` を読む 1 つの書き出し）。定数 `PLAN_EXPORT_REQUIRED`（既定は偽）が偽の間は、名前の書き出しを読めなければ画面の名前の選び方を作らずに続ける。真なら、名前の書き出しを `import()` で読めないか空の配列のとき、または `PLAN_VALUES_SPECIFIER` を `import()` で読めないとき、設定の読み込みを例外で止める（`npm run lint` が落ちる）。#29 の書き出しを置く Pull Request が同じ変更で真にする（K29-2）。真にした後に偽へ戻す変更は、`CONTRACT_USE_REQUIRED` と同じく照らしを外す変更としてレビューで見る。テストが定数を差し替えられるよう、`eslint.config.js` は設定を組む関数 `buildConfig({ planExportRequired, loadPlanNames, loadPlanValues })` を名前つきで書き出し、既定の書き出しはその関数に定数と実際の読み込みを渡した結果にする

### 単体テストの観点（`tools/test/lint-config.test.ts`）

| 対象 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| 各塊（ESLint の API の `lintText` に置き場のパスを渡す） | 表の行ごとに、違反の文字列で誤りが出る | 掛けない置き場（`packages/core`・`infra/`（経路の行を除く）・`tools/`・`apps/*/test`）で出ない。型だけの `@aws-sdk/*` の import と `new Date(0)` は出ない。画面の `*.tsx` の JSX の属性と本文でも出る | 違反を直した行に除外の注釈が残ると、使われない注釈の誤りが出る。`SKELETON_EXCEPTIONS` に無いファイルに `eslint-disable-next-line` を書いても違反が出る。`SKELETON_EXCEPTIONS` のファイルが無いか注釈を 1 つも持たないと落ちる |
| 料金プランの書き出しの読み込み（`buildConfig` に読み込みを差し替えて渡す） | 作り物の名前と値の読み込みで、画面の名前の文字列と判定の外の値の import の両方に誤りが出る | `planExportRequired` が偽で名前を読めないと、画面の名前の選び方を作らずに組める | `planExportRequired` が真で、名前を読めない・名前が空・値の指定子を読めないのそれぞれで設定を組む関数が例外を出す |
| 実物の料金プランの書き出し（`PLAN_EXPORT_REQUIRED` が真のときだけ走る。偽の間は「相手が無い」の名前で飛ばす） | 実際の `PLAN_NAMES_EXPORT` から読んだ名前の 1 つを画面の置き場の文字列に置くと誤りが出て、`PLAN_VALUES_SPECIFIER` を `import()` で読め、その import を判定の外に置くと誤りが出る（名前と指定子をテストに写さず、定数と書き出しから読む） | 判定のモジュール（`packages/core/src/usage-limit*`）の中の値の import は出ない | — |

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
| `plan-values-only-in-usage-limit` | `^apps/`・`^packages/core/src/`（`pathNot` で `^packages/core/src/usage-limit` を除く。ESLint の I8 の塊と同じ置き場） | `PLAN_VALUES_FILES`（`^packages/contracts/src/plan-values\.ts$` と `^packages/contracts/data/plan-values\.json$`）。解決したファイルで照らすので、公開の指定子 `@nd-factory/contracts/plan-values`・相対のパス・JSON の直の import のどれでも当たる |
| `plan-values-not-reexported` | `^packages/contracts/src/`（`pathNot` で `^packages/contracts/src/plan-values\.ts$` を除く） | `PLAN_VALUES_FILES`。ほかのモジュールが値を書き出し直すと、判定の外はその入口から値に届き、上の規則に当たらないため |

- `PLAN_VALUES_FILES` は `.dependency-cruiser.cjs` の定数に置き、#29 へ設計文書の K29-1 で同じ値を渡す。公開の指定子を解決したファイルで照らすため、`options` に `enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "types", "default"] }` を置き、`package.json` の `exports` を読ませる（ワークスペースの `node_modules/@nd-factory/contracts` は実のパスへ解決する。`preserveSymlinks` は既定の偽のまま）。2 つの I8 の規則は #29 が値を置く前でも有効で、ファイルが無い間は当たる依存が無いので通る
- 今の当たりは、試しの規則で 0 件だった（設計文書の LIB4）。当たれば、検査を足す Pull Request で直すか、dependency-cruiser の標準の除外（規則の `pathNot`）に課題の番号を `comment` に添えて外す

### 単体テストの観点（`tools/test/deps-config.test.ts`）

| 対象 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| 規則（dependency-cruiser の API の `cruise` を、一時の木に置いた作り物のファイルへ設定のファイルのまま打つ） | 規則ごとに、違反の import を 1 つ置いた木で、その規則の名前の誤りが 1 件出る | 型だけの import でも出る。`@nd-factory/*` の名前の import と相対のパスの import の両方で出る。`apps/web` の `react` の import では出ない | 規則を 1 つ消した設定で、その違反が出なくなる（テストが落ちる） |
| 料金プランの値の規則（一時の木に `packages/contracts/package.json` の `exports` の `./plan-values`・`PLAN_VALUES_FILES` の 2 つの作り物・ワークスペースのリンクを置く） | `apps/api/src/` と `packages/core/src/`（判定の外）から、公開の指定子 `@nd-factory/contracts/plan-values`・モジュールへの相対のパス・JSON への相対のパスのそれぞれで import すると `plan-values-only-in-usage-limit` が 1 件ずつ出る。`packages/contracts/src/index.ts` がモジュールを書き出し直すと `plan-values-not-reexported` が出る | `packages/core/src/usage-limit.ts` からの同じ 3 つの import では出ない。`plan-values.ts` から JSON への import では出ない。型だけの import でも出る | 公開の指定子を解決できない（`couldNotResolve`）と、その観点が落ちる（解決の設定を外すと素通りするのを、テストが落ちることで示す） |
| 実物の料金プランの値の置き場（`PLAN_EXPORT_REQUIRED` が真のときだけ走る。偽の間は「相手が無い」の名前で飛ばす） | 実際の木で `PLAN_VALUES_SPECIFIER` を dependency-cruiser の解決で引くと、`PLAN_VALUES_FILES` のモジュールのパスになり、2 つのファイルがどちらもある（定数とテストに写さず、`eslint.config.js` と `.dependency-cruiser.cjs` から読む） | — | 置き場を変えて定数を直し忘れると落ちる |

## gitleaks の設定と `leak-check` のジョブ

満たす決定: 設計の決定 3・9、受け入れ条件 1・2・3

設定は 2 つに分ける。gitleaks は `[extend] useDefault = true` で既定の規則と一緒に既定の全体の許可（`package-lock.json` などのパスと画像などの拡張子のパス。v8.30.1 の `config/gitleaks.toml` の `[allowlist]`）も継承し、パスの許可を規則の評価の前に当ててファイルを丸ごと飛ばす（`detect/detect.go`。前の設計で 2026-11-21 に v8.30.1 で確かめた）。同じ設定に自前の規則と実際の値の規則を入れると、そのパスに置いた値が素通りするため、自前の規則は既定を読まない設定に置く。

`.gitleaks.toml`（自前の規則。`[extend]` を持たない）:

| 欄 | 中身 |
| --- | --- |
| `[[rules]]` `nd-aws-account-id` | 前後が英数字でない 12 桁の数（`secretGroup` で数の部分） |
| `[[rules]]` `nd-aws-arn` | `arn:` とパーティション（`aws`・`aws-cn`・`aws-us-gov`）で始まり、アカウントの欄が 12 桁のもの |
| `[[rules]]` `nd-aws-arn-no-account` | `arn:` とパーティションで始まり、アカウントの欄が空で（リージョンの欄は空でも値でもよい。`arn:aws:s3:::<バケット>` など。STD4）、資源の部分が英数字で始まるもの。アカウントの欄が `aws` の AWS の管理のポリシー（`arn:aws:iam::aws:policy/…`）は当たらない |
| `[[rules]]` `nd-aws-resource-id` | AWS の資源の ID の頭（`vpc-`・`subnet-`・`sg-`・`i-`・`vol-`・`snap-`・`ami-`・`igw-`・`rtb-`・`eni-`・`nat-`・`eipalloc-`・`lt-`）と 8 か 17 桁の 16 進 |
| `[[rules]]` `nd-aws-endpoint` | 資源ごとに名前の付く AWS の端点（`*.execute-api.<リージョン>.amazonaws.com`・`*.lambda-url.<リージョン>.on.aws`・`*.cloudfront.net`・`*.auth.<リージョン>.amazoncognito.com`・`*.rds.amazonaws.com`・`*.s3.amazonaws.com`）の資源の部分 |
| `[[allowlists]]`（5 つの `nd-aws-*` の規則だけに掛ける。`targetRules`） | 値が作り物の `123456789012`・頭が `acme`・`us-west-2`・`example.com`・置き場所の記号（`<…>`・`${…}`）。作り物の UUID（`00000000-0000-7000-8000-…` の形）の 12 桁の部分 |
| `[[allowlists]]`（`nd-aws-account-id` だけ。`targetRules`・`paths`・`regexes`・`condition = "AND"`） | 今の木の既知の当たり（下の「今の木の当たり」）。パスと値の両方が一致したときだけ外す。行の注に理由を書く |

- 既知の当たりの許可は `condition = "AND"` を必ず書く。gitleaks は 1 つの `[[allowlists]]` の `paths` と `regexes` を既定で OR で結ぶため（v8.30.1 の `config/allowlist.go` の `MatchCondition`。既定は `OR`。2026-11-21 に読んだ）、書かないとそのパスのどの 12 桁も、どのファイルの同じ値も外れる。`paths` は 1 つのファイルの完全一致（`^…$`）、`regexes` は 1 つの値の完全一致にする
- 許可の値の正規表現は、12 桁の連続を含まない書き方（`[2]` のように 1 文字を文字の組に入れる）にする。`.gitleaks.toml` 自身はパスの許可に入らないので、値をそのまま書くと `.gitleaks.toml` が `nd-aws-account-id` に当たる。同じ理由で、許可した値を設計文書やほかのファイルに書かない（書けば当たる）
- `.gitleaks.toml` は全体の許可（`[allowlist]` と `targetRules` の無い `[[allowlists]]`）を持たない。作り物の印 `EXAMPLE` の許可もここに置かない（`nd-real-value` に掛からないため）。`tools/test/leak-scan.integration.test.ts` が設定の中身を読んで縛る

`.gitleaks-default.toml`（既定の規則）: `[extend] useDefault = true` と、作り物の印 `EXAMPLE` を値に含む当たりの許可だけを持つ。許可は既定の規則のうち私有鍵と提供者の token の規則（`private-key`・`github-pat`・`github-fine-grained-pat`・`aws-access-token`・`anthropic-api-key`・`slack-bot-token` など。ID は実装で v8.30.1 の既定の設定から写す）に `targetRules` で掛ける。自前の規則を置かない。既定の全体の許可のパスは、既定の規則にだけ効く（上流がその規則のために置いた許可なので受け入れる）。

### 包み `tools/checks/src/leak-check.ts`

gitleaks の標準出力と標準エラーをそのまま CI の記録へ流さないために、gitleaks を起こして報告を絞る包みを 1 つ持つ。正規表現で本文を探す処理は持たない。Node の組み込みの部品だけを使い、依存を入れる前に打てる。

| 関数 | シグネチャ | 責務 |
| --- | --- | --- |
| `buildConfigs` | `(configRoot: string, pattern: string \| null) => { own: string; defaults: string; realValue: string \| null }` | `configRoot` の `.gitleaks.toml` の文字列を `own`、`.gitleaks-default.toml` の文字列を `defaults`、`pattern` があれば規則 `nd-real-value`（`regex = '''(?i)(?:<pattern>)'''`。許可を持たない）だけを持つ設定を `realValue` として返す。`pattern` の形は `^[A-Za-z0-9_-]+(\|[A-Za-z0-9_-]+)*$`（英数字・`-`・`_` の 1 文字以上の語を `\|` でつなぐ。`'''` と正規表現の記号を含みえず、空の選択肢（`a\|\|b`・頭や末尾の `\|`・`\|` だけ）を持たない。空の選択肢は空文字に当たり、すべての行と、`maskPath` ではすべての文字の間に当たるため）。外れれば値を出さずに例外 |
| `runGitleaks` | `(run: { mode: "dir"; root: string } \| { mode: "git"; root: string; range: string }, config: string) => Promise<GitleaksFinding[]>` | gitleaks を `--redact=100 --no-banner --ignore-gitleaks-allow --gitleaks-ignore-path <空の一時のディレクトリ> --report-format json --report-path - --exit-code 0` で起こす。`git` では `--log-opts "--diff-merges=first-parent <range>"` を渡す（下の「履歴とマージ」）。設定は子の環境変数 `GITLEAKS_CONFIG_TOML` で渡してファイルに書かない（子の環境から `GITLEAKS_CONFIG` を除く）。報告は標準出力からメモリへ受け、`RuleID`・`File`・`StartLine`・`Commit` だけを写して残り（`Secret`・`Match`・`Message`・`Author`・`Email`・`Fingerprint` など）を捨てる。標準エラーはメモリで受けて捨てる（設定の読み込みの誤りで設定の中身、つまり秘密の正規表現を出すため）。0 以外の終了コードは道具の誤り |
| `maskPath` | `(path: string, pattern: string \| null) => string` | パスの中の `pattern` の当たり（大小を区別しない）を `***` に置き換える |
| `mainLeakCheck` | `(argv: string[], env: NodeJS.ProcessEnv) => Promise<number>` | 下の流れをつなぎ、当たりを出して終了コードを返す |

- 引数: `--scope rules|real-value`（必須）・`--root <探す木>`（既定は今のディレクトリ）・`--config-root <設定を読む木>`（既定は `--root`）・`--base <sha> --head <sha>`（組で）・`--require-pattern`（`real-value` でだけ受ける）
  - `rules`: `own` と `defaults` で探す。`LEAK_CHECK_PATTERN` を読まない（環境にあっても使わない）。ジョブ `leak-check`（`ci.yml`。Pull Request の作業の木のコードで動く）が使う
  - `real-value`: `realValue` と `nd-real-path` で探す。ジョブ `leak-real-value`（`leak-real-value.yml`。信頼するコードで動く）が使う
- 秘密を読む実行は、Pull Request が変えうるコードと設定を動かさない（設計文書の決定 3）。`pull_request` の実行は Pull Request の中のワークフローの定義と包みを動かすので、同じリポジトリの枝の Pull Request なら、包みか定義を書き換えて `LEAK_CHECK_PATTERN` を読み出せる。そこで秘密を渡すのは `pull_request_target` と main への `push` で起動するジョブ `leak-real-value` だけにする。`pull_request_target` は既定の枝のワークフローの定義で動くので（GitHub Actions のイベントの仕様。STD6）、定義・包み・`.gitleaks.toml` は既定の枝の取得（`trusted/`）から読み、Pull Request の head は `target/` へ取ってデータとして gitleaks と `git` に読ませるだけにする（`npm ci`・スクリプト・Pull Request の中のファイルの実行をしない）
- 黙らせる仕組みを効かせない: 行の注釈 `gitleaks:allow` は `--ignore-gitleaks-allow` で効かない。`.gitleaksignore` は gitleaks が `--gitleaks-ignore-path` と探す木の根から読むので、前者に空の一時のディレクトリを渡し、探す木で追跡しているファイルに `.gitleaksignore` があれば探す前に終了コード 2 で止める。基準の報告（`--baseline-path`）は渡さない。外しは `.gitleaks.toml` の `targetRules` つきの許可だけで、`nd-real-value` を外す書き方は無い（設計文書の決定 9）
- 履歴とマージ: gitleaks v8.30.1 は `--log-opts` を空白で分けて `git -C <木> log -p -U0` の後ろに足す（`sources/git.go` の `NewGitLogCmdContext`。2026-11-21 に読んだ）。`git log -p` は既定でマージコミットの差分を出さないので、マージの解決で足して head より前に消した値は、範囲だけを渡すと履歴でも今の木でも拾えない。`--diff-merges=first-parent` でマージコミットを最初の親との差分として出させる（マージで取り込んだ既定の枝の変更も差分に出るが、既定の枝は main への `push` で同じ検査を通っている）
- 流れ: (1) 引数を読む。`real-value` なら `LEAK_CHECK_PATTERN` を読み（無いか空なら `null`）、`--require-pattern` があって `null` なら終了コード 2、無くて `null` なら標準出力に `skip: no-pattern` を出して 0 で終える。(2) 今の木を `dir` で、スコープの設定（`rules` は `own` と `defaults` のそれぞれ、`real-value` は `realValue`）で 1 回ずつ探す。(3) `real-value` なら `git ls-files -z` のパスに `pattern` を照らし、当たりを規則 `nd-real-path`・行 0 の当たりにする（gitleaks は本文だけを探すため）。(4) `--base` と `--head` があれば、`git merge-base` の分岐点から `--head` のコミットまでを `git` で、(2) と同じ設定で探す。(5) 当たりを出す
- 必須にする条件: `--require-pattern` はジョブ `leak-real-value` だけが、リポジトリの変数 `LEAK_CHECK_REQUIRE_PATTERN` が `1` のときに渡す。このジョブは `pull_request_target` と `push` で起動するので、fork の Pull Request でもリポジトリの秘密を受ける。秘密を受けない `pull_request` の起動（fork の Pull Request を含む）には `leak-real-value` を置かず、`leak-check` が `rules` で既定と自前の規則だけを走らせる（`rules` は `--require-pattern` を受けず、渡すと引数の誤りで 2）。Dependabot が起こす実行は Actions の秘密でなく Dependabot の秘密を読むと考えられるので（設計文書の「未確認のまま残ること」）、持ち主は同じ値を両方に登録する（設計文書の「人へ残す判断」）。登録が欠ければ `--require-pattern` で 2 になり、黙って通らない
- 出力: 標準出力に当たりの行（`leak:<規則>\t<伏せたファイル>:<行>`。履歴は頭にコミットの短い SHA を足す）と件数。ファイルのパスはどの行でも `maskPath` を通す。git と gitleaks の誤りの文言（パスや設定を含みうる）は出さずに誤りの種類だけを標準エラーに出す
- 終了コード: 当たり無しと `skip: no-pattern` で 0、当たりで 1、道具の誤り・`.gitleaksignore` の存在・`pattern` の形の誤り・必須の `pattern` の欠け・引数の誤りで 2

ジョブ `leak-check`（`ci.yml`。`pull_request` と main への `push`。秘密を渡さない）の手順:

1. `actions/checkout`（`fetch-depth: 0`・`persist-credentials: false`）と `actions/setup-node`
2. 環境変数 `GITLEAKS_VERSION`・`GITLEAKS_SHA256` の版の linux の資産を取り、`sha256sum` を `GITLEAKS_SHA256` と直接比べ、一致したときだけ展開して `PATH` へ置く（配布元のチェックサムのファイルと比べない。固定にならないため）
3. 依存を入れる前に `node tools/checks/src/leak-check.ts --scope rules`（Pull Request では `--base <base.sha> --head <head.sha>` を足す）。依存を入れる前なので、追跡していないファイルは木に無い
4. `npm ci` の後に `npm run test:integration -- leak-scan`（gitleaks だけを起こす結合のテスト。作り物の語を `LEAK_CHECK_PATTERN` として子の包みに渡すので、`real-value` の流れもここで縛る）

ジョブ `leak-real-value`（`leak-real-value.yml`。`pull_request_target` と main への `push`。`permissions: contents: read`）の手順:

1. `actions/checkout`（`path: trusted`・`persist-credentials: false`。ref を指定せず、`pull_request_target` では既定の枝、`push` では押したコミットを取る）
2. `actions/checkout`（`path: target`・`ref` は `github.event.pull_request.head.sha` か、`push` では `github.sha`・`fetch-depth: 0`・`persist-credentials: false`）と `actions/setup-node`
3. `leak-check` の手順 2 と同じに gitleaks を置く（版と要約値はこの定義、つまり既定の枝の値）
4. `node trusted/tools/checks/src/leak-check.ts --scope real-value --root target --config-root trusted`（Pull Request では `--base`・`--head`、変数 `LEAK_CHECK_REQUIRE_PATTERN` が `1` なら `--require-pattern` を足す）。`LEAK_CHECK_PATTERN` はこの手順の環境変数でだけ渡す。ほかの手順を置かない（`npm ci` も `target/` のファイルの実行もしない）

`.github/zizmor.yml` には、`leak-real-value.yml` の `pull_request_target` に当たる点検（`dangerous-triggers`）の `ignore` の行を、「信頼する定義と包みで Pull Request の内容をデータとして探し、Pull Request のコードを動かさない（#1）」の注で置く。`ci-definition.test.ts` がこの形を縛る（下の「zizmor の設定と CI の定義のテスト」）。

### 今の木の当たり

既定の規則の当たりは 0 件だった（設計文書の LIB1。gitleaks v8.30.1 を打った）。自前の規則は gitleaks では打っておらず、同じ正規表現を `git grep -P` で近似して今の木を照らした（2026-11-21）。当たりは `infra/test/nd-setup.test.ts` の作り物の別のアカウント（`fake` の `target.account` に置いた 12 桁。値はこの文書に写さない。写すとこの文書が当たる）の 1 件で、`nd-aws-account-id` に当たる。これは `.gitleaks.toml` の `nd-aws-account-id` だけに掛け、パス `^infra/test/nd-setup\.test\.ts$` と値の完全一致を `condition = "AND"` で結ぶ許可で外し、注に「作り物の別のアカウント（設置のコマンドのテスト）」と書く。資源の ID・アカウントの欄の無い ARN は 0 件、端点はどれも頭が `acme` で許可に入る。gitleaks そのもので打った当たりは実装の Pull Request で確かめる（設計文書の「未確認のまま残ること」）

### 単体テストの観点

| 対象 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `buildConfigs`・`maskPath`（`tools/test/leak-check.test.ts`。gitleaks を起こさない） | `pattern` ありで `realValue` が `nd-real-value` の規則 1 つだけを持ち、許可を持たない。`own` は `.gitleaks.toml` のまま | `pattern` が `null` なら `realValue` が `null`。1 文字の語・語 1 つの `pattern` は通る。パスの大小違いの語も伏せる | `'''`・空白・正規表現の記号を含む `pattern`、空の選択肢を持つ `a\|\|b`・`\|a`・`a\|`・`\|` で例外になり、例外の文言に値が出ない |
| `mainLeakCheck` の引数と必須の条件（`leak-check.test.ts`。gitleaks を起こす関数を差し替える） | `real-value` で `pattern` ありなら `realValue` で探す。`rules` は環境に `LEAK_CHECK_PATTERN` があっても読まず、`own` と `defaults` の両方で探す | `real-value` で `pattern` が無く `--require-pattern` も無いと `skip: no-pattern` と 0 で、gitleaks を起こさない | `real-value` で `pattern` が無く `--require-pattern` があると 2。`rules` に `--require-pattern` を渡すと 2。`--scope` の欠け・`--base` だけの指定で 2 |
| `leak-scan.integration.test.ts`（gitleaks の実行ファイルを起こす。`leak-check` のジョブで打つ） | 作り物の値だけの一時の木で当たり 0 件 | 作り物の UUID・置き場所の記号・13 桁の数・`arn:aws:iam::aws:policy/…` で当たらない。既知の当たりの許可のパスに置いた許可の値は当たらない | 実行の時に組み立てた作り物でない 12 桁・ARN（アカウントの欄の無い S3 のバケットの ARN を含む）・端点・token を `docs/` の下に置くと `rules` で、作り物の語を `docs/` の下に置くと `real-value` で当たり、標準出力と標準エラーに値が現れない。同じ値を `package-lock.json` と `*.png` の名前のファイルに置いても自前の規則と `nd-real-value` が当たる。語を含む行に `EXAMPLE` と `gitleaks:allow` を足しても当たる。`.gitleaksignore` を追跡すると終了コード 2。語を含むファイルの名前で `nd-real-path` が当たり、出力のパスが伏せられる。途中のコミットで足して消した値が `git` の探しで当たる。マージの解決で足し、head より前のコミットで消した値が `git` の探しで当たる（`--diff-merges=first-parent` を外すと落ちる回帰）。既知の当たりの許可の値を別のパスに置く・許可のパスに別の 12 桁を置くとどちらも当たる。`.gitleaks.toml` を読み、`paths` か `regexes` を持つ `[[allowlists]]` が `condition = "AND"` を持たないとテストが落ちる（同じ設定から `condition` を消した写しで、別のパスの許可の値が当たらなくなることも示す）。`.gitleaks.toml` に全体の許可を足すとテストが落ちる |

## knip の設定

満たす決定: 設計の決定 4・8、受け入れ条件 5・12

`knip.jsonc`: `workspaces` に `.`・`packages/*`・`apps/*`・`infra`・`tools` を置き、ワークスペースごとの入口（Lambda の起点・画面の起点・設置のコマンド・検査の CLI・設定のファイル）と `treatConfigHintsAsErrors: true` と `tags: ["-screenPending"]`（画面の無い操作の生成した呼び出しを、使われない書き出しの報告から外す。設計文書の決定 8 の段ごとの扱い）を書く。`npm run knip`（`knip --no-progress`）を `check` のジョブで打つ。生成した画面の呼び出しのファイルは入口にしない（使われない書き出しを報告させるため。K2-2）。

- 今の当たり（使われない開発の依存 `infra/package.json` の `esbuild`、使われない書き出し 4 件）は、検査を足す Pull Request で直す。CDK が実行の時に読む `esbuild` のように直せないものだけを `ignoreDependencies` に置き、`knip.jsonc` の行の注に理由と課題の番号を書く

### 単体テストの観点（`tools/test/knip-config.test.ts`）

| 対象 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `knip.jsonc`（一時の木にワークスペースの形を組み、設定を写して knip を子のプロセスで打つ） | 揃った木で当たり 0 件 | 入口から使う書き出しは当たらない。`@screenPending` の印の付いた使われない書き出しは当たらない | 使われない書き出し・使われない依存・どこからも読まれないファイルをそれぞれ 1 つ足すと当たる。使われない `ignoreDependencies` の行で誤りになる |

## zizmor の設定と CI の定義のテスト

満たす決定: 設計の決定 5、受け入れ条件 1・8・10・13

`.github/zizmor.yml` は既定の点検を外さない。外すのは点検ごとの `ignore` の行（`<ファイル>:<行>` の形）だけで、行ごとに注で理由と課題の番号を書く。点検を丸ごと止める `disable` は使わない。ワークフローの行の注釈 `# zizmor: ignore[...]` は使わない（値の行に紛れてレビューで見落としやすいため。設計文書の決定 9）。どちらも CI の定義のテストが縛る。

ジョブ `workflow-audit` の手順: (1) `actions/checkout`（`persist-credentials: false`）と `actions/setup-node`。(2) `ZIZMOR_VERSION` の版の linux の実行ファイルの資産を `ZIZMOR_SHA256` と直接比べてから `PATH` へ置く。(3) `zizmor --offline --config .github/zizmor.yml .github/workflows` を打ち、当たりで失敗する。(4) `npm ci` の後に `npm run test:integration -- workflow-audit`（zizmor だけを起こす結合のテスト）。gitleaks の実行ファイルは置かない。

CI の定義のテスト（`tools/test/ci-definition.test.ts`）は今のテストを残し、ワークフローを `yaml` で読む。

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `loadWorkflows` | `tools/test/ci-definition.test.ts` | 新設 | `(root: string) => { path: string; text: string; doc: Workflow }[]` | `.github/workflows/` の `*.yml`・`*.yaml` を読み、解いた値と元の文字列を返す。解けなければ失敗 |
| `jobNames` | 同上 | 変更 | `(doc: Workflow) => string[]` | `jobs` の鍵の名前を返す（今は文字列を行で読む） |
| `triggersPullRequest` | 同上 | 新設 | `(doc: Workflow) => boolean` | `on` が `pull_request` か `pull_request_target` を持つか（文字列・配列・鍵の 3 つの書き方） |
| `permissionBlocks` | 同上 | 新設 | `(doc: Workflow) => { scope: string; value: unknown }[]` | 最上位と各ジョブの `permissions` を、場所と値の組で返す |
| `credentialWords` | 同上 | 変えない | `(yaml: string) => string[]` | 元の文字列で AWS の資格情報の語を探す |

テストが照らすこと: Pull Request で起動するワークフローのジョブの名前の和集合が必須のチェックの宣言と等しい・ジョブの名前がワークフローの間で重ならない・どのワークフローにも AWS の資格情報の語が無い・最上位の `permissions` が `{ contents: read }` だけで、ジョブの `permissions` は持たないか同じ・どのワークフローの文字列にも `zizmor: ignore` が無い・`.github/zizmor.yml` が `disable` を持たず、`ignore` の行がどれも課題の番号の注を持つ。秘密の扱い: `secrets.` を読むのは `leak-real-value.yml` だけで、読む手順は `leak-check.ts --scope real-value` の 1 つだけ。`pull_request_target` を持つのは `leak-real-value.yml` だけで、その手順は 2 つの取得・`setup-node`・gitleaks の設置・`trusted/` の包みの実行だけ（`npm`・`target/` の中のパスの実行・head を `path` なしで取る取得を持たない）。参照の検査（`tools/ref-check`）は追跡しているファイルをすべて読むので変えず、ワークフローの文字列に NDF の版を読む式と比べを同じ行に置くと当たるテストを `tools/test/ref-check.test.ts` に足す。

### 単体テストの観点

| 対象 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `loadWorkflows`・`triggersPullRequest`・`jobNames` | 2 つのワークフローを読み、Pull Request で起動するものを選ぶ | `on: pull_request`・`on: [pull_request]`・`on:` の下の鍵の 3 つの書き方 | 解けない YAML で失敗する。片方のワークフローにだけ資格情報の語・`id-token: write` を足すと当たる |
| `permissionBlocks` | 今のワークフローで違反 0 件 | ジョブの `permissions: { contents: read }` は通る | ジョブに `pull-requests: write`・`write-all` を足すと場所つきで当たる |
| `zizmor` の注釈と設定（`ci-definition.test.ts`） | 今のワークフローと `.github/zizmor.yml` で 0 件 | 注のある `ignore` の行は通る | ワークフローに `# zizmor: ignore[...]` を足す・`disable: true` を足す・注の無い `ignore` の行を足すと当たる |
| 秘密の扱い（`ci-definition.test.ts`） | 今のワークフローで 0 件 | `leak-real-value.yml` の包みの手順の `env` の `secrets.LEAK_CHECK_PATTERN` は通る | `ci.yml` のどれかの手順に `secrets.` を足す・`leak-real-value.yml` に `npm ci` か `node target/…` の手順を足す・head の取得から `path: target` を外す・包みを `target/` から起こす・`pull_request_target` をほかのワークフローに足すと当たる |
| `workflow-audit.integration.test.ts`（zizmor の実行ファイルだけを起こす。`workflow-audit` のジョブで `npm run test:integration -- workflow-audit` として打つ） | 今のワークフローを写した木で当たり 0 件 | — | 書き込みの権限・`persist-credentials` を外した取得・枝の名前で参照した動作を置いた一時の木で当たる。`--config` に渡した設定の外の `.github/zizmor.yml` を一時の木に置いても、渡した設定だけが効く |

## 形の正本の往復のテスト

満たす決定: 設計の決定 8、受け入れ条件 1・5

`tools/test/contracts-round-trip.test.ts` は、#2 の書き出し（K2-3）から操作の表と生成物を読む。定数 `CONTRACTS_EXPORT_REQUIRED`（このテストの中。既定は偽）が偽で書き出しが無い間は、リポジトリの表を照らすテストを「相手が無い」の名前で飛ばし、作り物の表のテストだけを走らせる。真なら書き出しを読めないと失敗する。#2 の書き出しを置く Pull Request が、`ROUTE_REGISTRY_REQUIRED`（下の「実際の経路の照らし」）と一緒に同じ変更で真にする（K2-3）。

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
| 8 | `screen-pending.json` の行が、表の利用者向けの操作の名前と課題の番号を持ち、同じ操作が 2 回出ない。生成した呼び出しの `@screenPending` の印の集合が行の集合と等しい |

### 単体テストの観点

| 対象 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| 照らすこと 1〜8（作り物の操作の表をテストの中で組む） | 揃った表で 0 件 | 人だけの操作は 3 つの形で比べる。空の配列の見本 | 照らすことごとに、1 か所を壊した表（JSON Schema だけ必須の項目を外す・道具を 1 つ消す・人だけの操作の読み出しを消す・機能を消す・配列でない要求・時刻帯の無い日時・通貨の無い金額・表に無い経路・表に無い操作か課題の番号の無い `screen-pending.json` の行）で 1 件 |

## 実際の経路の照らし

満たす決定: 設計の決定 8、受け入れ条件 1・5

往復のテストの照らすこと 7 は形の正本の中の登録だけを見る。`infra` が API Gateway に実際に置く経路と、Lambda の振り分けが受ける経路は、次の 2 つのテストが操作の表と照らす。どちらも `check` の `npm run test` で走る。

| テスト | 担当 | 読むもの | 照らすこと |
| --- | --- | --- | --- |
| `infra/test/api-routes.test.ts` | #1 | 今のテストと同じ組み方（`infra/test/support.ts` の作り物の設定）で合成した `AppStack` の `Template`（`cdk.out` に書く CloudFormation と同じ）と、そのスタックの `webConfig.api_url` を `stack.resolve` で解いた値 | (a) `AWS::ApiGatewayV2::Route` の `RouteKey`（`<方法> <経路>`）の集合が、K2-3 の登録の利用者向けと機械向けの経路の集合と等しい。(b) `AWS::ApiGatewayV2::Api` が `Body`・`BodyS3Location` を持たない（OpenAPI の取り込みは経路を `Route` の資源に出さないため）。(c) `AWS::ApiGateway::*`（REST の API）の資源が無い。(d) `RouteKey` が `$default` でなく、経路が貪欲な経路の変数（`\{[^}]+\+\}`。`{proxy+}` に限らず `{rest+}` など名前を問わない）を含まない（すべてを受ける経路は表と照らせないため）。(e) どの `Route` の `ApiId` も、画面の `api_url` が参照する `AWS::ApiGatewayV2::Api` の論理 ID への `Ref` である（経路が画面の呼ぶ API に付いていることを照らす。`api_url` がちょうど 1 つの API を参照しなければ失敗）。`RouteKey` が文字列でない（`Fn::Join` などの組み立てが残る）か、`ApiId` が `Ref` でない `Route` は、素通りさせず失敗にする |
| `apps/api/test/dispatch-routes.test.ts` | #2（K2-7） | `apps/api` の振り分けの登録 | 振り分けが受ける `<方法> <経路>` の集合が操作の表の経路の集合と等しく、表に無い経路の要求が 404 になる |

- 合成の結果を読むので、`HttpRoute`・`CfnRoute`・`addRoutes`・文字列の連結のどれで組んだ経路も同じ形で当たる
- (a) を飛ばすかは、定数 `ROUTE_REGISTRY_REQUIRED`（`infra/test/api-routes.test.ts` の中。既定は偽）で決める。偽で K2-3 の登録の書き出しが無い間だけ (a) を「相手が無い」の名前で飛ばし、(b)〜(e) は今のスタックで照らす（今の `/v1/users` の経路は (b)〜(e) に当たらない）。偽でも書き出しを読めれば (a) を走らせる。真なら、書き出しを読めないと (a) が失敗し、`apps/api/test/dispatch-routes.test.ts`（K2-7）が無いことも失敗にする（ファイルの存在を文字として照らす。`infra` は `apps` を import しない）。#2 の登録の書き出しを置く Pull Request が、同じ変更で真にする（K2-3）。真にした後に偽へ戻す変更は、`CONTRACT_USE_REQUIRED` と同じく照らしを外す変更としてレビューで見る
- 比べる関数 `routeKeysOf(template)`（`RouteKey` と `ApiId` の組を返し、文字列でない `RouteKey` と `Ref` でない `ApiId` を誤りとして返す）と `compareRoutes(routes, registry, apiLogicalId)` は、作り物の表とテストの中で組んだスタックで落ちることを示す

### 単体テストの観点（`infra/test/api-routes.test.ts`）

| 対象 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `routeKeysOf`・`compareRoutes` と (b)〜(e) | 作り物の表と、その経路を `addRoutes` で置いたスタックで 0 件 | `HttpRoute` と `CfnRoute` で置いた経路も数える。同じ経路の方法違いを別に数える。`{id}` のような貪欲でない経路の変数は通る | 経路を 1 件落としたスタック・表に無い経路を足したスタックで 1 件ずつ。`Body` を持つ API・`BodyS3Location` を持つ API・REST の API・`$default`・`{proxy+}`・`/v1/{rest+}` を置いたスタックでそれぞれ落ちる。画面の `api_url` の API から経路を外し、同じ `RouteKey` を別の HTTP API に置いたスタックで (e) が落ちる（(a)〜(d) は通る組み方で示す）。`RouteKey` を `Fn::Join` で組んだ `CfnRoute`・`ApiId` を文字列で書いた `CfnRoute` で落ちる |
| `ROUTE_REGISTRY_REQUIRED` | 偽で書き出しが無いと (a) を飛ばし、(b)〜(e) は走る | 偽で作り物の書き出しを渡すと (a) が走る | 真で書き出しが無いと失敗する。真で `dispatch-routes.test.ts` が無いと失敗する（定数と読む場所をテストの引数で差し替える） |

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
| 3 | 区分が「起動する」の使う口と実行の場（ホステッド・手元のマシン）の組ごとに、`set_by: service` の名前とその口の `env` 列の名前が、使い方のその組の渡す環境変数の名前を含む | `C/domains/env.json`・`C/domains/entrypoints.json` | 口と実行の場の組ごとの渡す環境変数の名前 |
| 4 | `reader: service` の読むファイルの `fields` が、翻訳が読む項目を含む。読むファイルの行が契約にある | `C/domains/ndf-files.json` | 読むファイルと項目 |
| 5 | 区間の報告の `shape.values`・`shape.items`・`shape.required`・`shape.material` が、ランナーが読む値と項目を含み、同じファイルの `cases` の見本を区間の報告の読み取りへ通して `result` と `errors` の有無が同じ判定になる | `C/hooks/unattended-report.json` | 区間の報告から読む値と項目・区間の報告の読み取りの関数（形の正本の区間の報告の形から作り、ランナーも同じ関数で読む。K2-6） |
| 6 | 使う口がすべて契約の口の表にある | `C/domains/entrypoints.json` | 使う口 |

- 先端では、通っても `C/hooks/unattended-report.json` の `shape` を固定の点と比べ、差分を要約に並べる（実行の文書の「通ったときの差分」）
- `ask-journal` の行が `fields` を持つようになったら、要約の知らせの行へ出す（失敗にしない。#41 の決定 106 の答えを知るため）
- この 6 つは形の正本の判定とデータ（#2）を契約と照らす。ランナー（#6）が起動する口（K2-6 の区分）ごとに実際に組み立てた正常な呼び出しを判定に通して通り、環境変数の名前の集合と翻訳が読む項目が口と実行の場ごとの使い方のデータと等しいこと（ホステッドと手元のマシンの両方）と、判定が拒む呼び出しで NDF を起こさないことは `apps/runner` のテストが照らす。環境変数と読む項目を使い方のデータからだけ組むことと、区間の報告を形の正本の読み取りの関数だけで読むことは、そのテストと ESLint の `apps/runner/src/**` の `JSON.parse` の禁止が縛る（設計文書の「#6 へ渡す欠け」K6-1〜K6-4）

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

満たす決定: 設計の決定 3・5・6、受け入れ条件 1・2・10

| ファイル | 変える中身 |
| --- | --- |
| `.github/workflows/ci.yml` | ジョブ `check` の `npm run check` の後に `npm run deps-check` と `npm run knip` の手順を足す。ジョブ `leak-check`（上の「gitleaks の設定と `leak-check` のジョブ」の手順。gitleaks の実行ファイルを置き、結合のテストは `leak-scan` だけを打つ）とジョブ `workflow-audit`（上の「zizmor の設定と CI の定義のテスト」の手順。zizmor の実行ファイルを置き、結合のテストは `workflow-audit` だけを打つ）を足す。動作の版はコミットの SHA で固定する（今の `ci.yml` と同じ） |
| `.github/workflows/ndf-contract.yml`（新設） | `on` は `pull_request`・`push`（main）・`schedule`（毎日 1 回）・`workflow_dispatch`。`permissions: contents: read`。ジョブ `ndf-contract` は `npm ci` の後に `npm run ndf-contract -- --summary "$GITHUB_STEP_SUMMARY"` を打つ |
| `.github/workflows/leak-real-value.yml`（新設） | `on` は `pull_request_target`・`push`（main）。`permissions: contents: read`。ジョブ `leak-real-value` は上の「gitleaks の設定と `leak-check` のジョブ」の手順 |
| `.ndf/project.json` | `ci.required_checks` に `leak-check`・`leak-real-value`・`workflow-audit`・`ndf-contract` を足す。`ci.workflows` に `leak-real-value.yml`・`ndf-contract.yml` の行を足す |
| `package.json` | スクリプト `deps-check`・`knip`・`ndf-contract`・`leak-check`・`test:integration`（引数のファイル名の絞りで、ジョブごとに 1 つの結合のテストだけを打つ）。開発の依存 `dependency-cruiser`・`knip` |
| `vitest.config.ts` | 結合のテスト（`*.integration.test.ts`）を `tools` の単体のテストから外し、`test:integration` でだけ打つ |
| `tools/package.json` | 依存 `@nd-factory/contracts`・`ajv`・`ajv-formats`・`yaml` |
| `tools/tsconfig.json` | `checks/src` を含める |
| `AGENTS.md` | 「秘密とインフラの値を置かない」に、実際の値の語は CI の秘密 `LEAK_CHECK_PATTERN`（語を `\|` でつなぐ）から受ける行と、`gitleaks:allow`・`.gitleaksignore`・`zizmor: ignore` を使わず、除外は設定のファイルに課題の番号を添えて置く行を足す |
