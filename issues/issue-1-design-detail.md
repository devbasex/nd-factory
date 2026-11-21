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
├── infra/lib/app-stack.ts                 除外の注釈（#4。旧経路 `PUT /v1/users` の登録）
└── tools/
    ├── package.json                       依存 @nd-factory/contracts・ajv・ajv-formats・yaml
    ├── tsconfig.json                      checks/src を含める
    ├── checks/src/ndf-contract-check.ts * NDF の契約の照合（CLI）
    ├── checks/leak-scan.sh              * gitleaks の 1 回の探し（除外を効かなくする。`leak-check` のジョブと結合のテストが打つ）
    ├── checks/gitleaks-default.toml     * 既定の規則で探す設定（`[extend] useDefault = true`）と、既定の規則の正当な当たりの許可
    └── test/
        ├── ndf-contract-check.test.ts   *
        ├── contracts-round-trip.test.ts *  形の正本の往復と I14 の表の照らし
        ├── lint-config.test.ts          *  ESLint の塊が落とすこと
        ├── deps-config.test.ts          *  dependency-cruiser の規則が落とすこと
        ├── knip-config.test.ts          *  knip の設定が落とすこと
        ├── leak-scan.integration.test.ts *  gitleaks の設定が落とすこと（実行ファイルを起こす）
        ├── workflow-audit.integration.test.ts * zizmor の設定が落とすこと（実行ファイルを起こす）
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
| `apps/*` | `no-restricted-syntax` | 引数なしの `new Date()`・鍵 `ConditionExpression` を持つオブジェクトの性質・丸ごと落とす指定子（`@aws-sdk/*`・`node:http`・`http`・`node:https`・`https`・`uuid`・`node:console`・`console`）の動的な `import()`・大域のオブジェクト（`globalThis`・`global`・`window`・`self`）からの `console`・`fetch` の分割代入（`const { console } = globalThis`） | 時計・条件つきの書き込み・外部の呼び出し・ID・ログと伏せ字 |
| `apps/*` | `no-restricted-globals`（`checkGlobalObject`・`globalObjects: ["global"]`） | `console`・`fetch`（`globalThis`・`global`・`window`・`self` からの性質の参照を含む。分割代入はこの規則では落ちないので上の `no-restricted-syntax` の行で落とす） | ログと伏せ字・外部の呼び出し |
| `apps/*` | `@typescript-eslint/no-restricted-imports`（`allowTypeImports`） | `@aws-sdk/*`・`node:http`・`http`・`node:https`・`https`・`uuid`・`node:console`・`console`（Node.js が受け付ける `node:` を付けない表記も落とす） | 外部の呼び出し・条件つきの書き込み・操作の記録の書き手・ID・ログと伏せ字 |
| `apps/*` | `@typescript-eslint/no-restricted-imports`（`node:crypto`・`crypto` の `importNames`）と `no-restricted-syntax`（動的な `import()`） | `node:crypto`（`crypto`）の名前空間の import・既定の import・動的な `import()`・`export * from`・`export * as … from` を丸ごと落とし、名前つきの import と名前つきの再書き出し（`export { … } from`）は `randomUUID`・`randomBytes`・`randomFill`・`randomFillSync`（渡したバッファを乱数で埋める）・`randomInt`（乱数の整数を返す）・`randomUUIDv7`・`getRandomValues`・`generatePrime`・`generatePrimeSync`（乱数で素数を作る）・`webcrypto`（`webcrypto.randomUUID` などを持つ）の名前だけを落とす。実行中の Node.js の `node:crypto` の書き出しから乱数の関数の名前を拾って照らすテストを置き、版が上がって増えた名前を落とし忘れない（`importNames` に `default` と合わせて並べる）。型だけの import と、`subtle`（`SubtleCrypto` で乱数の関数を持たない。`subtle.digest` などに使う）や `createHash` などほかの名前の名前つきの import・名前つきの再書き出し（`export { createHash } from "node:crypto"`）は落とさない。モジュールの値を持たせないので、移した先を追わずに済む | ID と冪等の鍵 |
| `apps/web/src/**` | `no-restricted-syntax` | 料金プランの名前と同じ文字列（JSX の属性の値と `JSXText` を含む）。名前は #29 の書き出しから読み、無ければこの選び方を作らない | I8（画面） |
| `apps/web/src/**`・`apps/api/src/**`・`infra/lib/**` | `no-restricted-syntax` | `/v1/` を含む文字列とテンプレートの文字列（経路は形の正本の登録の書き出しからだけ読む。K2-2・K2-3）。生成した画面の呼び出し（`apps/web/src/generated/`）も対象で、生成は経路を登録の書き出しから読む | I14（画面の呼び出し・HTTP の経路の登録） |
| `apps/web/**` の外の `*.tsx` | `no-restricted-syntax` の `Program` | ファイルそのもの（1 ファイル 1 件） | 言語と書き方の決まりの画面の行（決定 140） |

- すべての塊に `linterOptions: { reportUnusedDisableDirectives: "error" }` を置く（決定 9）。骨組みのコードの今の当たりは、当たる行の前に `// eslint-disable-next-line <規則> -- #2 が横断の部品へ移す` の形（`#4` の行は「#4 が置き換える」）で外す。外す行は「今の姿」の 5 つのファイルの当たる行だけで、実装で ESLint を打って決める
- `eslint.config.js` は最上位の `await` で #29 の料金プランの名前の書き出しを読む。定数 `PLAN_EXPORT_REQUIRED` が偽（#29 の前）なら、読めないときは名前の選び方を作らない。#29 の Pull Request が真にし、以後は読めないと設定の読み込みが失敗する

### 単体テストの観点（`tools/test/lint-config.test.ts`）

| 対象 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| 各塊（ESLint の API の `lintText` に置き場のパスを渡す） | 表の行ごとに、違反の文字列で誤りが出る | 掛けない置き場（`packages/core`・`infra/`（経路の行を除く）・`tools/`・`apps/*/test`）で出ない。型だけの `@aws-sdk/*` の import と `new Date(0)` は出ない。画面の `*.tsx` の JSX の属性と本文でも出る。`apps/web/src/generated/` に置いた、経路の登録の書き出しから経路を読む生成した呼び出しの見本は誤りが 0 件で、経路を文字のまま書き出した見本は経路の行で 1 件 | 違反を直した行に除外の注釈が残ると、使われない注釈の誤りが出る |

## dependency-cruiser の設定

満たす決定: 設計の決定 2、受け入れ条件 1・7

`.dependency-cruiser.cjs` の `forbidden` に置き場ごとの規則を書き、`options` は `tsPreCompilationDeps: true`（型だけの import も数える）・`tsConfig: { fileName: "tsconfig.base.json" }`・`doNotFollow: { path: "node_modules" }`。`npm run deps-check`（`depcruise --config .dependency-cruiser.cjs --output-type err packages apps infra tools`）を `check` のジョブで打つ。

| 規則の名前 | `from`（パス） | `to`（禁じる先） |
| --- | --- | --- |
| `contracts-depends-on-zod-only` | `^packages/contracts/src/` | `packages/contracts/` の外のこのリポジトリのファイルと、`zod` の外のパッケージ |
| `core-depends-on-contracts-only` | `^packages/core/src/` | `packages/contracts/` と `packages/core/` の外のこのリポジトリのファイル |
| `apps-do-not-import-each-other` | `^apps/([^/]+)/` | `^apps/` のうち自分の app の外（`$1` を使う） |
| `apps-do-not-import-infra-or-tools` | `^apps/` | `^infra/`・`^tools/` |
| `web-uses-browser-core-only` | `^apps/web/` | `^packages/core/src/` のうち `clock`・`ids`・`redact`・`log`・`web-http`（画面の通信部品。#2 が置き、生成した呼び出しが受けて送る。設計の K2-2）の外 |
| `infra-depends-on-contracts-only` | `^infra/` | `^packages/core/`・`^apps/`・`^tools/`（全体の設計の依存の表で `infra` が依るのは `packages/contracts` だけ） |
| `tools-depends-on-contracts-only` | `^tools/` | `^packages/core/`・`^apps/`・`^infra/` |
| `react-only-in-web` | `apps/web/` の外 | `react`・`react-dom`・`@vitejs/plugin-react` |
| `plan-values-only-in-usage-limit` | `packages/core/src/usage-limit*` と `packages/contracts/` の外 | 料金プランの値のデータ `packages/contracts/data/plans.json` と、それを読む書き出しのファイル `packages/contracts/src/plans.ts`（`@nd-factory/contracts/plans`。#29 が置く。公開の名前の import も相対のパスの import も、解決したファイルで照らす） |

- 料金プランの値のファイルの名前は `PLAN_VALUE_FILES` に固定する。`deps-config.test.ts` はリポジトリの `packages/contracts` のうち名前に `plan` を含むファイルと、料金プランの書き出しの `exports` の鍵の行き先と、行き先から dependency-cruiser で辿って実際に読み込む値のファイル（`packages/contracts` の JSON と、そこへ至る途中のモジュール。名前によらない）が `PLAN_VALUE_FILES` に合うことを照らし、#29 が別の名前や置き場で置いたときに落とす。鍵は `eslint.config.js` が書き出す `PLAN_EXPORT`（`@nd-factory/contracts/<鍵>`）から読み、ESLint と同じ書き出しを辿る。`eslint.config.js` の `PLAN_EXPORT_REQUIRED` が偽（#29 の前）の間は鍵が無ければ照らさずに通し、真にした後は鍵が無いと落ちる。名前に `plan` を含まない置き場（`data/pricing.json`）へ値を移した作り物の木と、公開の名前を `@nd-factory/contracts/pricing` に変えた作り物の木で落ちることを確かめる
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
| （`[extend]` を持たない） | 既定の規則と既定の全体の許可を読まない。既定の規則は別の 1 回の実行で `tools/checks/gitleaks-default.toml` を渡して探す（設定を省くと、gitleaks は探す木の根の `.gitleaks.toml` を読み、既定の規則が抜けるため。v8.30.1 の `cmd/root.go` の `initConfig`） |
| `[[rules]]` `nd-aws-account-id` | 前後が英数字でない 12 桁の数（`secretGroup` で数の部分）。境界は文字を消費しない `\b` で見て、隣り合う値（`<12 桁>,<12 桁>`）の間の 1 文字の区切りを次の値に残す。`\b` は `_` を英数字と同じに扱うので、`_` だけは消費して区切りとして受ける |
| `[[rules]]` `nd-aws-account-id-joined` | `_` 1 文字で前の 12 桁と繋いだ 12 桁（`<12 桁>_<12 桁>` の後ろ）。`nd-aws-account-id` は前の値の後ろの `_` を消費するので、後ろの値をこの規則で当てる |
| `[[rules]]` `nd-aws-arn` | `arn:` とパーティション（`aws`・`aws-cn`・`aws-us-gov`）で始まり、アカウントの欄が 12 桁のもの。資源の欄は置き場所の記号（`<名前>`・`${名前}`）の全体か、空白・引用符・`<`・`>`・`{`・`}` の外の文字で、値に接した文書の区切り（`<…>` の閉じ・`}`）を含めない |
| `[[rules]]` `nd-aws-arn-s3` | アカウントとリージョンの欄の無い S3 の ARN（`arn:<パーティション>:s3:::`）の資源の名前（置き場所の記号の全体か、名前に使える文字 `A-Za-z0-9._-` の並び。値に接した `}` を含めない） |
| `[[rules]]` `nd-aws-resource-id` | AWS の資源の ID の頭（`vpc-`・`subnet-`・`sg-`・`i-`・`vol-`・`snap-`・`ami-`・`igw-`・`rtb-`・`eni-`・`nat-`・`eipalloc-`・`lt-`）と 8 か 17 桁の 16 進 |
| `[[rules]]` `nd-aws-endpoint` | 資源ごとに名前の付く AWS の端点（`*.execute-api.<リージョン>.amazonaws.com`・`*.lambda-url.<リージョン>.on.aws`・`*.cloudfront.net`・`*.auth.<リージョン>.amazoncognito.com`・`*.rds.amazonaws.com`・S3 の仮想ホストの形 `*.s3.amazonaws.com`・`*.s3.<リージョン>.amazonaws.com`・`*.s3-<リージョン>.amazonaws.com`・`*.s3.dualstack.<リージョン>.amazonaws.com`・`*.s3-website-<リージョン>.amazonaws.com`・`*.s3-website.<リージョン>.amazonaws.com`）の資源の部分。資源のラベルは置き場所の記号（`<名前>`・`${名前}`）の全体か `A-Za-z0-9_-` の並びで、Markdown の自動のリンク `<名前.cloudfront.net>` の `<` は記号の一部にならず秘密に含めない |
| `nd-aws-account-id-joined` の外の 5 つの `nd-aws-*` の規則それぞれの `[[rules.allowlists]]` | 秘密（`secretGroup`。値を見分ける部分）が、作り物の `123456789012` を含む・頭が `acme`・`example.com` を含む・置き場所の記号の全体（`<[A-Za-z0-9_-]+>`・`\$\{[^{}\s]+\}`）を含む。記号の 1 文字（`<`・`}` など）だけでは許さない（文書の区切りの `<…>`・`{…}` に接した実際の名前を許さないため）。リージョンは秘密に含めないので `us-west-2` で外さない（RDS の端点の秘密にはリージョンが入るため、`us-west-2` で外すと実際の資源の名前を見逃す） |
| `nd-aws-account-id-joined` の外の 5 つの `nd-aws-*` の規則それぞれの `[[rules.allowlists]]` | 値に作り物の印 `EXAMPLE` を含む |
| `nd-aws-account-id-joined` の `[[rules.allowlists]]` | 作り物の `123456789012` と別のアカウントの作り物 `210987654321` |
| `nd-aws-account-id` の `[[rules.allowlists]]`（`regexTarget = "match"`） | 作り物の UUID（`00000000-0000-7000-8000-<12 桁>`）の最後の組。規則の正規表現は UUID の前の 4 組があれば当てた文字列に含め、許可はその文字列で見分ける |
| `nd-aws-account-id` の `[[rules.allowlists]]` | 今の木の正当な当たり: 別のアカウントの作り物 `210987654321`（`infra/test/nd-setup.test.ts` が確認したアカウントと違う profile を作る。#1） |

許可は規則の中の `[[rules.allowlists]]` に書き、最上位の `[[allowlists]]` の `targetRules` を使わない。gitleaks v8.30.1 は `targetRules` の許可を最上位で読んだ設定にだけ付け、`[extend] path` で読まれた側の `targetRules` を捨てる（`config/config.go` の `Translate` は `extendDepth` が 0 のときだけ対象の規則へ付ける）。`LEAK_CHECK_PATTERN` を重ねた設定は `.gitleaks.toml` を `[extend] path` で読むので、`targetRules` では重ねた設定で作り物の値が当たる。規則の中の許可は重ねても規則と一緒に引き継がれる。

`tools/checks/gitleaks-default.toml`:

| 欄 | 中身 |
| --- | --- |
| `[extend] useDefault = true` | gitleaks の既定の規則と既定の全体の許可を読む。nd-factory の規則は持たない |
| `[[rules]]` `id = "<既定の規則の id>"` と、その `[[rules.allowlists]]` | 既定の規則の正当な当たりを外すときだけ足す（規則の欄は id だけ書き、正規表現は既定から引き継ぐ）。今の木は当たり 0 件なので置かない |

ジョブ `leak-check` の手順（3〜6 は 1 つの手順で打ち、一時の設定は `trap` で手順の終わりに消す。秘密を読んだ後は `unset` し、gitleaks の子のプロセスに渡さない）:

1. `actions/checkout`（`fetch-depth: 0`・`persist-credentials: false`）
2. 環境変数 `GITLEAKS_VERSION`・`GITLEAKS_SHA256` の版の linux の資産を取り、`sha256sum` を `GITLEAKS_SHA256` と直接比べ、一致したときだけ展開して `PATH` へ置く（配布元のチェックサムのファイルと比べない。固定にならないため）
3. 実際の値の規則を重ねる: 秘密 `LEAK_CHECK_PATTERN` があれば、一時のディレクトリに `[extend] path = "<リポジトリ>/.gitleaks.toml"` と規則 `nd-real-value`（`regex` に秘密の正規表現を `'''` で囲んで置く）の 2 つだけを持つ設定を書く。無ければ `.gitleaks.toml` をそのまま使い、`LEAK_CHECK_REQUIRE_PATTERN` が `1` で同じリポジトリの枝からの実行（参照の検査と同じ式。fork の Pull Request は秘密を受けないので必須にしない）なら手順を失敗にする
4. 今の木を 2 回探す: `tools/checks/leak-scan.sh dir tools/checks/gitleaks-default.toml`（既定の規則）と `tools/checks/leak-scan.sh dir <設定>`（nd-factory の規則）。依存を入れる前なので、追跡していないファイルは木に無い
5. 履歴を同じ 2 つの設定で探す（マージのコミットの差分を含む）。Pull Request では、分岐点（`git merge-base <base.sha> <head.sha>`）から head までのコミットを `tools/checks/leak-scan.sh git <設定> --range "<分岐点>..<head.sha>"` で探す。main への push では、到達できるすべてのコミットを `tools/checks/leak-scan.sh git <設定>`（範囲なし）で探す。fork の Pull Request は秘密を受けず実際の値の規則で探していないので、通常のマージで main に入ったそのコミットを、ここで実際の値の規則で探す。push の前後（`before..after`）に絞らないのは、同じ並び（`concurrency`）で打ち消された実行・待ちで打ち切られた実行・強制の push の間に入ったコミットも漏らさないため（今の履歴の全体は 1 秒ほどで探せる。実物で確かめた）
6. 一時の設定のファイルを消す。`LEAK_CHECK_PATTERN` は手順の環境変数でだけ渡し、ほかの手順に渡さない

`tools/checks/leak-scan.sh`（`<dir|git> <設定> [--range <範囲>] [--report <報告のファイル>] [--paths]`。`--report` は結合のテストが当たりを JSON で受けるため。`--paths` は手元で当たりのファイルの名前を引くときだけ渡し、CI のジョブは渡さない）は、gitleaks の除外を効かなくして 1 回探す。gitleaks のすべての実行はこのスクリプトを通す（ジョブの手順に `gitleaks` を直に書かない）。設定は必ず渡し、無ければ探さずに失敗する（省くと gitleaks が探す木の根の `.gitleaks.toml` を読み、既定の規則で探したつもりで nd-factory の規則だけになるため）。

| 除外 | 効かなくする方法 |
| --- | --- |
| 値の行の `gitleaks:allow` | 引数 `--ignore-gitleaks-allow` |
| `--gitleaks-ignore-path`（既定は `.`）の `.gitleaksignore` | 引数 `--gitleaks-ignore-path <空の一時のディレクトリ>` |
| 探す木の根の `.gitleaksignore` | gitleaks は引数によらず、探す木の根の `.gitleaksignore` を読む（v8.30.1 の `cmd/root.go`）。スクリプトは探す前に `git ls-files --error-unmatch .gitleaksignore` と `test -e .gitleaksignore` を照らし、どちらかで在れば、名前を示して探さずに失敗する |
| 前の報告（`--baseline-path`） | 渡さない |

打つ引数は `gitleaks <dir . | git . --log-opts="-m <範囲>"> --redact=100 --no-banner --exit-code 1 --ignore-gitleaks-allow --gitleaks-ignore-path <空> --config <設定> --report-path <一時の報告> --report-format json` で、一時のディレクトリは終わりに消す。`--verbose` は渡さない（gitleaks の詳しい出力は、伏せた値の外の当たった行の残りとコミットの本文を出す。ARN の行ではアカウント ID の当たりに役割の名前が残り、同じ行の別の規則の秘密も出る。実物で確かめた）。gitleaks の報告は探す木の外の一時のファイルに受け、`jq` で規則の id・ファイル・始めと終わりの行・コミットだけを取り出し、当たりごとに `leak-scan: 当たり <規則> <ファイル>:<行> [<コミット>]` の 1 行を記録に出す。ファイルの名前も秘密の値を含み得る（実際の環境の名前をファイルの名前に使うなど）ので、`--paths` が無ければ、ファイルは報告の中の名前の順の通し番号 `file-<番号>` に替えて記録と報告に出し、名前を伏せたことと `--paths` で引けることを標準エラーに出す。gitleaks の標準出力と標準エラーも、`dir` と `git` のどちらでも一時のファイルに受け、`--paths` が無ければ出さない（gitleaks v8.30.1 の `dir` は、読めないファイルの診断などにファイルの名前を載せる。`sources/files.go`）。記録に出すのは終了コードと整形した当たりだけで、`--paths` を渡したときだけ生の出力を標準エラーへ出す。`--report` を渡されたときは、その 5 つの項目だけの JSON を書く（当たった行・伏せた値・コミットの本文と作者を書かない）。報告を読めなければ失敗にする。`git` では探す前に `git rev-list` で範囲を読めるか確かめ、読めなければ探さずに失敗する（gitleaks v8.30.1 は `git log` の失敗を当たり無しの終了コード 0 で終えるため。実物で確かめた）。`-m` は、gitleaks が範囲を `git log -p -U0 <範囲>` に渡すだけで、そのままではマージのコミットの差分を出さないため（v8.30.1 の `sources/git.go`）に付ける。付けないと、競合の解消で入れて後のコミットで消した値が、今の木にも履歴の探しにも現れない。`-m` はマージのコミットを親ごとの差分で出す。

- 当たりは規則・ファイル・行・コミットだけで出す（当たった行と値は出さない。値は手元で `leak-scan.sh` を打って確かめる）。正当な当たりは、当てた規則の `[[rules.allowlists]]` に、理由と課題の番号の注を添えて足す（設定の変更なのでレビューで見える）。`nd-*` の規則の当たりは `.gitleaks.toml` の規則の中に、既定の規則の当たりは `tools/checks/gitleaks-default.toml` にその規則の id の `[[rules]]` を置いて、その中に足す。最上位の `[[allowlists]]` の `targetRules` は重ねた設定で効かないので使わない。値の行の注と除外のファイルでは外せない。今の木は既定の規則で当たり 0 件（設計文書の LIB1）

## knip の設定

満たす決定: 設計の決定 4・8、受け入れ条件 5・12

`knip.jsonc`: `workspaces` に `.`・`packages/*`・`apps/*`・`infra`・`tools` を置き、ワークスペースごとの入口（Lambda の起点・画面の起点・設置のコマンド・検査の CLI・設定のファイル）と `treatConfigHintsAsErrors: true` を書く。`npm run knip`（`knip --no-progress && knip --no-progress --production --workspace apps/web`）を `check` のジョブで打つ。2 つ目の実行は画面の入口からの参照だけで数え、テストだけが import する生成した呼び出しを落とす（通常のモードはテストからの参照も使用に数えるため。K2-2）。テストのために書き出す画面のものは、knip の標準の JSDoc の `@internal` を付けて production の実行から外す（今は `apps/web/src/runtime-config.ts` の `RuntimeConfigError`）。生成は `@internal` を付けない。生成した画面の呼び出しのファイルは `apps/web/src/generated/` に置き、`package.json` の `exports` に載せない（K2-2）。入口のファイルの書き出しも照らすよう、`apps/web` のワークスペースに `includeEntryExports: true` を置く。画面がまだ無い操作の書き出しは、生成が付ける JSDoc の `@screenPending` を knip の標準の `tags: ["-screenPending"]` で外す。タグは書き出しにしか効かず、画面から参照の無い生成したファイル（画面がまだ一つも無い段階や、操作ごとに生成したファイル）は使われないファイルとして落ちるので、生成を置く #2 の Pull Request で `apps/web` の `entry` に `src/generated/**/*.ts!` を足す。末尾の `!` で production の実行でも入口になり、ファイルは使われないものに数えず、書き出しは `includeEntryExports` で照らし続ける（保留中でない使われない書き出しと、テストだけが呼ぶ書き出しは、参照の無いファイルでも落ちる）。生成先が空のうちに足すと knip が当たらない入口（`entry-empty`）として誤りにするので、今は置かない。`knip-config.test.ts` は、リポジトリに `apps/web/src/generated/` があることと `entry` にこの行があることが揃うことを照らす。

- 今の当たり（使われない開発の依存 `infra/package.json` の `esbuild`、使われない書き出し 4 件）は、検査を足す Pull Request で直す。CDK が実行の時に読む `esbuild` のように直せないものだけを `ignoreDependencies` に置き、`knip.jsonc` の行の注に理由と課題の番号を書く

### 単体テストの観点（`tools/test/knip-config.test.ts`）

| 対象 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `knip.jsonc`（一時の木にワークスペースの形を組み、設定を写して knip を子のプロセスで打つ） | 揃った木で当たり 0 件 | 入口から使う書き出しは当たらない | 使われない書き出し・使われない依存・どこからも読まれないファイルをそれぞれ 1 つ足すと当たる。`apps/web/src/generated/` の `@screenPending` の無い使われない呼び出しは、`apps/web` の `exports` に載せても当たる（`includeEntryExports` を外した設定では当たらない）。テストだけが import する生成した呼び出しは、スクリプト `knip` のとおりに打つと当たる（通常のモードだけでは当たらない）。`entry` に `src/generated/**/*.ts!` を足した設定で、すべての操作が `@screenPending` で画面から参照の無い生成したファイルはスクリプト `knip` で当たり 0 件（行の無い設定では使われないファイルとして当たる）、参照の無いファイルの `@screenPending` の無い書き出しとテストだけが呼ぶ書き出しは当たる。リポジトリの生成先の有無と `entry` の行の有無が食い違うと落ちる。使われない `ignoreDependencies` の行で誤りになる |

## zizmor の設定と CI の定義のテスト

満たす決定: 設計の決定 5、受け入れ条件 1・8・10・13

`.github/zizmor.yml` は既定の点検を外さず、外すときは点検の名前と理由を書く。ジョブ `workflow-audit` は `persist-credentials: false` で取り、`ZIZMOR_VERSION` の版の linux の実行ファイルの資産を `ZIZMOR_SHA256` と直接比べてから置き、`zizmor --offline --no-ignores --config .github/zizmor.yml .github/workflows` を打つ（`--no-ignores` で行の中の `# zizmor: ignore[...]` を効かなくする。gitleaks の `gitleaks:allow` を効かなくした承認で足したこと 1 と揃え、外すときは `.github/zizmor.yml` に点検の名前と理由を書く）。当たりで失敗する。`.github/zizmor.yml` は `unpinned-uses` の方針 `"*": hash-pin`（すべての動作を SHA での固定に限る。v1.32.0 の既定と同じだが、版を上げても緩まないよう明示する）だけを持つ。結合のテストは `ci.yml` の点検の手順の `run` を読んで同じ引数で打つ。

CI の定義のテスト（`tools/test/ci-definition.test.ts`）は今のテストを残し、ワークフローを `yaml` で読む。

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `loadWorkflows` | `tools/test/ci-definition.test.ts` | 新設 | `(root: string) => { path: string; text: string; doc: Workflow }[]` | `.github/workflows/` の `*.yml`・`*.yaml` を読み、解いた値と元の文字列を返す。解けなければ失敗 |
| `jobNames` | 同上 | 変更 | `(doc: Workflow) => string[]` | `jobs` の鍵の名前を返す（今は文字列を行で読む） |
| `checkNames` | 同上 | 新設 | `(doc: Workflow) => string[]` | ジョブが GitHub へ報告するチェックの名前を返す（`name` があればその値、無ければ `jobs` の鍵。行列のジョブは行列の値が足されるため宣言と合わない名前） |
| `triggersPullRequest` | 同上 | 新設 | `(doc: Workflow) => boolean` | `on` が `pull_request` を持つか（文字列・配列・鍵の 3 つの書き方） |
| `permissionBlocks` | 同上 | 新設 | `(doc: Workflow) => { scope: string; value: unknown }[]` | 最上位と各ジョブの `permissions` を、場所と値の組で返す |
| `credentialWords` | 同上 | 変えない | `(yaml: string) => string[]` | 元の文字列で AWS の資格情報の語を探す |

テストが照らすこと: Pull Request で起動するワークフローのジョブが報告するチェックの名前（`checkNames`。ブランチの保護が待つ名前）の和集合が必須のチェックの宣言と等しい・ジョブの名前がワークフローの間で重ならない・どのワークフローにも AWS の資格情報の語が無い・最上位の `permissions` が `{ contents: read }` だけで、ジョブの `permissions` は持たないか同じ。参照の検査（`tools/ref-check`）は追跡しているファイルをすべて読むので変えず、ワークフローの文字列に NDF の版を読む式と比べを同じ行に置くと当たるテストを `tools/test/ref-check.test.ts` に足す。

### 単体テストの観点

| 対象 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `loadWorkflows`・`triggersPullRequest`・`jobNames`・`checkNames` | 2 つのワークフローを読み、Pull Request で起動するものを選ぶ | `on: pull_request`・`on: [pull_request]`・`on:` の下の鍵の 3 つの書き方。鍵と同じ `name` | 解けない YAML で失敗する。鍵が宣言と同じでも `name` を上書きしたジョブ・行列のジョブは宣言と合わない。片方のワークフローにだけ資格情報の語・`id-token: write` を足すと当たる |
| `permissionBlocks` | 今のワークフローで違反 0 件 | ジョブの `permissions: { contents: read }` は通る | ジョブに `pull-requests: write`・`write-all` を足すと場所つきで当たる |
| `leak-scan.integration.test.ts` の nd-factory の規則（`tools/checks/leak-scan.sh` を子のプロセスで打ち、gitleaks を起こす。`leak-check` のジョブで打つ） | 作り物の値だけの一時の木で、`.gitleaks.toml` と重ねた設定（`[extend] path` で `.gitleaks.toml` を読み `nd-real-value` を足したもの）の両方で当たり 0 件 | 作り物の UUID・置き場所の記号・13 桁の数・`123456789012`・`EXAMPLE` の印の値が、`.gitleaks.toml` と重ねた設定の両方で当たらない（規則の中の許可が重ねても効く）。`package-lock.json` の名前のファイルに置いた許可の値に合わない 12 桁も当たる（既定の全体の許可が効かない） | 実行の時に生成した架空の値（許可の値に合わず検出の規則に合う 12 桁・ARN・S3 の ARN・S3 のリージョンつきの形を含む端点）を `docs/` の下に置くと `.gitleaks.toml` と重ねた設定の両方で当たり、重ねた規則の語は重ねた設定で当たる。報告と標準出力に値が現れず、報告の項目は規則・ファイル・行・コミットだけ。`--paths` を渡さなければ、重ねた規則の語を名前に含むファイルの当たりで、その語とファイルの名前が出力と報告に現れず、ファイルは `file-<番号>` になる。1 つの行に ARN（役割の名前つき）・資源の ID・重ねた規則の語を並べると規則ごとに当たり、どの値も役割の名前も出力に現れない（`--verbose` を足すと落ちる）。`git` の探しで、当たったコミットの本文が出力に現れない。診断にファイルの名前を載せる偽の gitleaks を PATH に置くと、`dir` と `git` のどちらでも `--paths` を渡さなければその名前が出力に現れず、渡せば現れる。隣り合う 12 桁を 1 文字の区切り（`,`・`;`・空白・タブ・`\|`・`:`・`/`・`-`・`_`）で 3 つ並べるとそれぞれ当たり、作り物の値・作り物の UUID の最後の組と並べた値も当たり、英数字に接した 12 桁と 13 桁は当たらない。Markdown の自動のリンク `<名前.cloudfront.net>`・`<https://名前.s3.<リージョン>.amazonaws.com/…>`・波括弧に接した S3 の ARN・`<…>` で囲んだ ARN の実際の名前が当たる。途中のコミットで足して消した値が `git` の探しで当たる |
| `leak-scan.integration.test.ts` の既定の規則 | — | 根に nd-factory の規則だけの `.gitleaks.toml` を置いた木でも、`tools/checks/gitleaks-default.toml` を渡すと、`dir` と `git` の両方で架空の token（形だけ合わせたもの）が既定の規則で当たる | 設定を渡さずにスクリプトを打つと、探さずに失敗する |
| `leak-scan.integration.test.ts` のマージのコミット | — | — | 2 つの枝で同じファイルを変えて競合させ、マージのコミットの競合の解消でだけ架空の値を足し、後のコミットで消した木で、分岐点からの `git` の探しがその値をマージのコミットの当たりとして報告する（`-m` を外すと落ちる） |
| `leak-scan.integration.test.ts` の除外の拒み（`dir` と `git` のそれぞれで、次の 2 つを別のケースにする） | — | 値の行に `gitleaks:allow` を付け、`.gitleaksignore` を置かない木で、その値が対象の規則の当たりとして報告される（終了コードだけでなく、報告の規則の id とファイルを照らす。`--ignore-gitleaks-allow` を外すと落ちる） | 当たりの指紋を書いた `.gitleaksignore` を根に置いた木（`dir` は追跡していないファイル、`git` は追跡しているファイル）で、スクリプトが `.gitleaksignore` の名前を示して失敗し、gitleaks を起こさない（報告のファイルが無い。根の照らしを外すと落ちる） |
| `workflow-audit.integration.test.ts`（zizmor を起こす。`workflow-audit` のジョブで打つ） | 今のワークフローを写した木で当たり 0 件 | — | 書き込みの権限・`persist-credentials` を外した取得・枝の名前で参照した動作で当たる |

`leak-scan.integration.test.ts` が当てる値は、すべて実行の時に生成した架空の値にする（乱数の 12 桁・架空の ARN と端点・形だけ合わせた token・重ねた規則の語）。生成した値が許可の値（`123456789012` など）に合わず、検出の規則に合うことをテストの中で確かめてから木に置く。実在のアカウント・資源・端点の値と有効な token は使わず、値をリポジトリにも置かない（ソースには組み立ての手順だけを書く）。

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
| 7 | HTTP の経路の登録の経路の集まりが、操作の表の経路の集まりと等しい |
| 8 | 合成したテンプレートの `AWS::ApiGatewayV2::Route` の経路（方法と経路）から除外の旧経路を引いた集まりが、経路の登録（`generated/routes.json`）から除外の受け口の経路を引いた集まり（反映済みの経路）と等しい。除外が要らなくなった行があれば落ちる。経路の登録が無い間は比べを「相手が無い」で飛ばし、テンプレートから経路を 1 本以上取り出せることだけを確かめる（設計 PR #49 の承認で足した） |

照らすこと 8 の除外の表（`ROUTE_EXCLUSIONS`。テストの中の定数）は、行ごとに外すものと、外すのを終える課題の番号を持つ。

| 外すもの | 終える課題 | 理由 | 要らなくなったと見る条件（テストが落ちる） |
| --- | --- | --- | --- |
| 旧経路 `PUT /v1/users` | #4 | 骨組みの経路で、操作の表に無い（#2 の設計の「骨組みの経路」の行） | 合成の経路に無い |
| 受け口 `user`・`runner`・`machine`（受け口ごとに 1 行） | #4 | #2 は `api-fn` と `ApiRoutes` をスタックへ入れず、登録の経路が合成に無い（#2 の決定 11） | その受け口の経路が合成に 1 本でもある、または登録にその受け口の経路が無い |
| 受け口 `db_prep`（`/v1/db_prep/exchanges/create`・`/v1/db_prep/completions/create` の 2 本） | #13 | #2 の登録に 2 本あるが、合成に無い。#13 が DB の用意を Lambda へ移し、この 2 本を全体の設計と操作の表から無くす（#13 の本文の 2026-11-21 の変更） | その受け口の経路が合成に 1 本でもある、または登録にその受け口の経路が無い |

全経路の完全一致へは、除外の表が空になったときに切り替わる（表が空なら、照らすこと 8 は合成の経路の集まりと登録の経路の集まりの完全一致）。#4 が `api-fn` を反映して `PUT /v1/users` を消す Pull Request で、要らなくなった行が落ちるので、その行を消す。受け口を一部だけ反映したときは、その受け口の行だけを消す。#13 が `db_prep` の 2 本を操作の表から消す Pull Request で、`db_prep` の行が「登録にその受け口の経路が無い」で落ちるので、その行を消す。除外の表は、#2 の登録にある受け口（`user`・`runner`・`machine`・`db_prep`）をすべて持つ。表に無い受け口の経路が登録にあれば、照らすこと 8 は「登録にだけある経路」で落ちる。

合成の打ち方: `infra/bin/app.ts` を子のプロセスで `node` で打ち、環境変数で次を渡す。クリーンなチェックアウトの `check` のジョブは画面をビルドしないため、既定の `apps/web/dist` に頼らない。

| 環境変数 | 値 |
| --- | --- |
| `ND_WEB_DIST` | テストが作る一時のディレクトリ（`index.html` を 1 つだけ置く。`infra/test/support.ts` の `tempWebDist` と同じ形） |
| `ND_SETTINGS` | `infra/test/fixtures/settings.json`（`npm run synth` と同じ作り物の設定） |
| `CDK_DEFAULT_ACCOUNT`・`CDK_DEFAULT_REGION` | 作り物の `123456789012`・`us-west-2` |
| `CDK_OUTDIR` | テストが作る一時のディレクトリ。テンプレートはここの `*.template.json` をファイルとして読む（`tools` は `infra` を import しない） |
| `CDK_CONTEXT_JSON` | `{"aws:cdk:bundling-stacks": []}`（Lambda の束ねを飛ばす。経路の比べに束ねは要らない） |

### 単体テストの観点

| 対象 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| 照らすこと 1〜7（作り物の操作の表をテストの中で組む） | 揃った表で 0 件 | 人だけの操作は 3 つの形で比べる。空の配列の見本 | 照らすことごとに、1 か所を壊した表（JSON Schema だけ必須の項目を外す・道具を 1 つ消す・人だけの操作の読み出しを消す・機能を消す・配列でない要求・時刻帯の無い日時・通貨の無い金額・表に無い経路）で 1 件 |
| 照らすこと 8（作り物のテンプレートと登録をテストの中で組む。合成を打つテストは 1 本） | 除外を引いて揃った組で 0 件。除外の表が空で完全に揃った組で 0 件。クリーンなチェックアウトで画面をビルドせずに合成でき、経路を 1 本以上取り出す | 登録が無いと比べを飛ばす | 登録にだけある反映済みの経路・合成にだけある除外に無い経路で 1 件。旧経路が合成に無い・除外の受け口の経路が合成にある・除外の受け口が登録に無い、のそれぞれで除外の行が要らないと 1 件 |

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
  - 出力の行（標準出力と要約の両方）: `checked: fixed <固定の点のコミット> 1-6`・`checked: tip <先端のコミット> 1-6`・`skip: no-contract-use <固定の点のコミット>`（使い方の書き出しが無く、1〜6 を照らさなかった）。先端を取れなければ `checked: tip` を出さず、要約に先端を照らさなかったと出す
  - 副作用: 一時のディレクトリへの取得、要約のファイルへの追記（ワークフローは `GITHUB_STEP_SUMMARY` を渡す）
- 固定の点のコミットは `ndf-pin.json` から読む。キーの名前は参照の検査の書き方に倣って定数に置き、キーを読む行に大小の比べの記号と矢印の関数を置かない（参照の検査の版の比べに当たるため）

照らすこと（実行の文書の (1)〜(5) と、使う口の有無）:

| # | 照らすこと | 契約のファイル | nd-factory の側（#2 の NDF の契約の使い方。K2-6） |
| --- | --- | --- | --- |
| 1 | 見本 26 件を呼び出しの判定へ通し、`valid` と同じ判定になる | `C/domains/entrypoint-cases.json`・`C/domains/entrypoints.json` | 呼び出しの判定 |
| 2 | `version.json` の `history` の最後の行（版と sha256）が受ける組にある | `C/version.json` | 受ける組 |
| 3 | 使う口と実行の場（ホステッド・手元のマシン）の組ごとに、`set_by: service` の名前とその口の `env` 列の名前が、使い方のその組の渡す環境変数の名前を含む | `C/domains/env.json`・`C/domains/entrypoints.json` | 口と実行の場の組ごとの渡す環境変数の名前 |
| 4 | `reader: service` の読むファイルの `fields` が、翻訳が読む項目を含む。読むファイルの行が契約にある | `C/domains/ndf-files.json` | 読むファイルと項目 |
| 5 | 区間の報告の `shape.values`・`shape.items`・`shape.required`・`shape.material` が、ランナーが読む値と項目を含み、同じファイルの `cases` の見本を区間の報告の読み取りへ通して `result` と `errors` の有無が同じ判定になる | `C/hooks/unattended-report.json` | 区間の報告から読む値と項目・区間の報告の読み取り |
| 6 | 使う口がすべて契約の口の表にある | `C/domains/entrypoints.json` | 使う口 |

- 先端では、通っても `C/hooks/unattended-report.json` の `shape` を固定の点と比べ、差分を要約に並べる（実行の文書の「通ったときの差分」）
- 定数 `CONTRACT_USE_REQUIRED` が偽（#2 の前）の間だけ、書き出しが無いときに `skip: no-contract-use` で通す。#2 が書き出しを置く Pull Request で真にし、以後は書き出しが無いと `fail: no-contract-use` で終了コード 1
- `ask-journal` の行が `fields` を持つようになったら、要約の知らせの行へ出す（失敗にしない。#41 の決定 106 の答えを知るため）
- ランナー（#6）が実際に組み立てた呼び出しを判定に通すことと、判定が拒む呼び出しで NDF を起こさないことは、`apps/runner` のテストが照らす（#6 へ渡す欠け）

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| NDF のリポジトリの URL | 定数（出所: 実行の文書の「NDF との契約」） | `tools/checks/src/ndf-contract-check.ts` | `https://github.com/devbasex/ai-plugins` |
| 契約の置き場 | 定数（同上） | 同上 | `plugins/ndf/contracts` |
| `ContractFinding` | 型 `{ check: 1〜6; path: string; id?: string; detail: string }`。`id` は見本の id か配列の位置 | 同上 | — |
| `NdfContractUse` | 型（#2 の書き出しから写す） | 同上 | 書き出しが無ければ `null` |
| `CONTRACT_USE_REQUIRED` | 定数（真偽値） | 同上 | 偽。#2 が真にし、偽へ戻さない |

### 異常系の処理

| 関数 | 失敗 | 原因 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- |
| `fetchContract`（固定の点） | 取れない・契約のファイルが無い・JSON でない | ネットワーク・固定の点の誤り・置き場の移動 | 止める | 標準エラーに理由、終了コード 2 | 打ち直せる。置き場の移動なら固定の点を変える Pull Request で直す |
| `fetchContract`（先端） | 同上 | 同上 | 既定値で続ける | 要約に先端を照らさなかったと出し、固定の点の結果で終わる | 次の実行で照らす |
| `compareContract` | NDF の契約の使い方の書き出しが無い | #2 がまだ置いていない | 既定値で続ける（1〜6 を照らさず、契約のファイルが読めることだけを確かめる） | `skip: no-contract-use` の行。`checked:` の行を出さない | #2 の Pull Request の CI で `checked: fixed` が出ることを確かめる |
| `mainNdfContractCheck` | 固定の点で食い違う | 固定の点か形の正本を変えた | 呼び出し元へ返す | 要約の表と食い違いの行、終了コード 1 | 直すか固定の点を戻す |
| `mainNdfContractCheck` | 先端だけで食い違う | 上流の未配布の変更 | 既定値で続ける | 要約の表に見本の id と契約のファイルのパス、終了コード 0 | 次の固定の点を変える Pull Request で扱う |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `compareContract` | 作り物の契約と使い方で 0 件 | 使い方が `null` で照らさない。`ask-journal` に `fields` を足した契約で知らせが出て、食い違いにならない | 1〜6 のそれぞれ 1 つを壊した契約で、その番号の食い違いが出る |
| `mainNdfContractCheck` | 固定の点だけの食い違いで 1、先端だけで 0 と要約の行。どちらも `checked: fixed` が出る | 使い方の書き出しが無いと `skip: no-contract-use` と 0 | 固定の点の取得の失敗で 2 |

`fetchContract` はテストでネットワークを使わず、テストの中で作った git のリポジトリを NDF のリポジトリの代わりに渡す（URL を引数で差し替える）。

## ワークフローと宣言

満たす決定: 設計の決定 3・5・6、受け入れ条件 1・10

| ファイル | 変える中身 |
| --- | --- |
| `.github/workflows/ci.yml` | ジョブ `check` の `npm run check` の後に `npm run deps-check` と `npm run knip` の手順を足す。ジョブ `leak-check`（上の「gitleaks の設定と `leak-check` のジョブ」の手順と、最後に `npm ci` の後の `npm run test:integration -- leak-scan`）とジョブ `workflow-audit`（上の「zizmor の設定と CI の定義のテスト」の手順と、`npm run test:integration -- workflow-audit`）を足す。動作の版はコミットの SHA で固定する（今の `ci.yml` と同じ） |
| `.github/workflows/ndf-contract.yml`（新設） | `on` は `pull_request`・`push`（main）・`schedule`（毎日 1 回）・`workflow_dispatch`。`permissions: contents: read`。ジョブ `ndf-contract` は `npm ci` の後に `npm run ndf-contract -- --summary "$GITHUB_STEP_SUMMARY"` を打つ |
| `.ndf/project.json` | `ci.required_checks` に `leak-check`・`workflow-audit`・`ndf-contract` を足す。`ci.workflows` に `ndf-contract.yml` の行を足す |
| `package.json` | スクリプト `deps-check`・`knip`・`ndf-contract`・`test:integration`。開発の依存 `dependency-cruiser`・`knip` |
| `vitest.config.ts` | 結合のテスト（`*.integration.test.ts`）を `tools` の単体のテストから外し、`test:integration` でだけ打つ |
| `tools/package.json` | 依存 `@nd-factory/contracts`・`ajv`・`ajv-formats`・`yaml` |
| `tools/tsconfig.json` | `checks/src` を含める |
| `AGENTS.md` | 「秘密とインフラの値を置かない」に、実際の値の正規表現は CI の秘密 `LEAK_CHECK_PATTERN` から受ける行を足す |
