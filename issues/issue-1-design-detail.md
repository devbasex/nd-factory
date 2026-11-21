# #1 の詳細設計: 検査を置き場とジョブへ下ろす

設計文書 [issue-1-design.md](./issue-1-design.md) の構成要素を、ファイルと関数の粒度へ下ろした文書である。決定の理由は設計文書にあり、ここでは「どこに何を作るか」だけを書く。全体の設計（`docs/design/`）で決めた置き場・依存の向き・落とすものは決め直さない。

## 地図

触るファイル（`*` は新設）:

```text
nd-factory/
├── eslint.config.js                       規則の組を読み込む
├── package.json                           スクリプト leak-check・ndf-contract
├── .ndf/project.json                      必須のチェックに 2 つ足す
├── AGENTS.md                              LEAK_CHECK_TERMS の行
├── .github/workflows/
│   ├── ci.yml                             ジョブ leak-check を足す
│   └── ndf-contract.yml                 * ジョブ ndf-contract
├── packages/contracts/
│   ├── package.json                       書き出し ./secret-shapes
│   ├── data/secret-shapes.json          * 秘密の形・インフラの値の形・作り物の値
│   └── src/secret-shapes.ts             * その形（zod）と読み手
└── tools/
    ├── package.json                       依存 ajv・ajv-formats・@nd-factory/contracts
    ├── tsconfig.json                      checks/src を含める
    ├── checks/
    │   ├── data/lint-exceptions.json    * 規則の控え（決定 5）
    │   ├── data/leak-allow.json         * 漏れの検査の外し（パス・種類・件数）
    │   ├── data/screen-pending.json     * I14 の画面の控え（操作の名前・画面を作る課題）
    │   └── src/
    │       ├── lint-rules.ts            * ESLint の規則の組
    │       ├── leak-check.ts            * 漏れの検査（CLI）
    │       ├── round-trip.ts            * 形の往復と I15・I12 の形
    │       ├── operation-coverage.ts    * I14 の対応
    │       └── ndf-contract-check.ts    * NDF の契約の照合（CLI）
    └── test/
        ├── lint-rules.test.ts           *
        ├── leak-check.test.ts           *
        ├── round-trip.test.ts           *
        ├── operation-coverage.test.ts   *
        ├── ndf-contract-check.test.ts   *
        ├── ci-definition.test.ts          すべてのワークフローを読む
        └── ref-check.test.ts              ワークフローの版の比べのテストを足す
```

依存の向き: `tools/checks` は `packages/contracts` だけを import し（`@nd-factory/contracts` の書き出しを経る）、ほかの置き場のコードは文字として読む。`eslint.config.js` は `tools/checks/src/lint-rules.ts` を import する（根の設定は置き場の外で、ESLint が読む）。`packages/contracts/src/secret-shapes.ts` は zod だけに依る。循環は無い。

| パス | 種類 | 役割 1 文 | 依存する先 | モジュール | 最上位の関数 |
| --- | --- | --- | --- | --- | --- |
| `tools/checks/src/lint-rules.ts` | 新設 | 置き場ごとの ESLint の設定の塊を組む | `@nd-factory/contracts`（料金プランの名前があれば） | `lint-rules` | `loadLintExceptions`・`ruleGroups`・`buildLintConfigs`（新設） |
| `tools/checks/src/leak-check.ts` | 新設 | 追跡しているファイルのパスと本文の、形と実際の値の当たりを出す | `@nd-factory/contracts/secret-shapes` | `leak-check` | `loadLeakTerms`・`listTrackedTexts`・`findShapeHits`・`findTermHits`・`maskPath`・`mainLeakCheck`（新設） |
| `tools/checks/src/round-trip.ts` | 新設 | 4 つの形の検証の結果を比べる | `@nd-factory/contracts`・ajv・ajv-formats | `round-trip` | `mutate`・`representationsOf`・`findRoundTripMismatches`・`findValueShapeFindings`（新設） |
| `tools/checks/src/operation-coverage.ts` | 新設 | 操作の表と画面・MCP・HTTP の経路・機能を突き合わせる | `@nd-factory/contracts`・`typescript` | `operation-coverage` | `screenOperationNames`・`loadScreenPending`・`findCoverageFindings`（新設） |
| `tools/checks/src/ndf-contract-check.ts` | 新設 | 固定の点と既定の枝の先端の契約を照らす | `@nd-factory/contracts`（NDF の契約の使い方） | `ndf-contract-check` | `pinChanged`・`fetchContract`・`compareContract`・`renderSummary`・`mainNdfContractCheck`（新設） |
| `packages/contracts/src/secret-shapes.ts` | 新設 | 秘密の形のデータの形と読み手 | zod | `secret-shapes` | `secretShapesSchema`・`loadSecretShapes`（新設） |
| `tools/test/ci-definition.test.ts` | 変更 | すべてのワークフローを照らす | — | テスト | `workflowFiles`・`triggersPullRequest`・`permissionBlocks`（新設）、`jobNames`・`credentialWords`（変えない） |
| `eslint.config.js` | 変更 | 規則の組を最後に足す | `tools/checks/src/lint-rules.ts` | 設定 | — |

## 規則の組（境界・依存の向き・I8・画面の HTTP の経路）

満たす決定: 設計の決定 1・2・5、受け入れ条件 1・4・5（画面の HTTP の経路）・6・7

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `loadLintExceptions` | `tools/checks/src/lint-rules.ts` | 新設 | `(path: string) => LintException[]` | 控えのファイルを読み、形を照らして返す |
| `ruleGroups` | 同上 | 新設 | `(planNames: readonly string[]) => RuleGroup[]` | 下の表の規則の組を、組の ID・掛ける置き場・規則ごとの選び方で返す |
| `buildLintConfigs` | 同上 | 新設 | `(groups: RuleGroup[], exceptions: LintException[]) => Linter.Config[]` | 組を置き場ごとに 1 つの塊へ合わせ、控えのファイルにはその組を除いた塊を足す |

- `buildLintConfigs`
  - 事前条件: 組の ID が一意。控えの `group` が組の ID のどれか
  - 事後条件: どのファイルにも、規則ごとに 1 つの塊だけが効く（ESLint は同じ規則を後の塊で上書きするため、選び方を塊の中で合わせる）。縛る塊は `linterOptions.noInlineConfig: true` を持つ
  - 副作用: 無し
- `eslint.config.js` は最上位の `await` で料金プランの名前（#29 の書き出し。無ければ空）と控えを読み、`buildLintConfigs` の結果を今の設定の後ろに足す

規則の組（`apps/*` は `apps/api`・`apps/web`・`apps/runner`・`apps/nd-runtime`・`apps/db-prep` の `src/` の `*.ts`。テストのディレクトリと e2e を含まない）:

| 組の ID | 掛ける置き場 | 規則と選び方 | プラットフォームの行 |
| --- | --- | --- | --- |
| `boundary.clock` | `apps/*` | `no-restricted-properties` の `Date.now`・`no-restricted-syntax` の引数なしの `new Date()` | 時計 |
| `boundary.ids` | `apps/*` | `no-restricted-properties` の `Math.random`・`crypto.randomUUID`・`crypto.getRandomValues`。`no-restricted-imports` の `node:crypto` の `randomUUID`・`randomBytes` と `uuid` | ID と冪等の鍵 |
| `boundary.log` | `apps/*` | `no-restricted-globals` の `console`（`checkGlobalObject`） | ログと伏せ字 |
| `boundary.outbound` | `apps/*` | `no-restricted-globals` の `fetch`（`checkGlobalObject`）。`@typescript-eslint/no-restricted-imports` の `@aws-sdk/*`・`node:http`・`node:https`（`allowTypeImports`） | 外部の呼び出し |
| `boundary.retry` | `apps/*` | `no-restricted-syntax` の、繰り返しの文（`for`・`for…of`・`for…in`・`while`・`do…while`）の中の `callHttp(…)` と `….send(…)` の呼び出し | 再試行 |
| `boundary.conditional-write` | `apps/*` | `no-restricted-syntax` の、鍵 `ConditionExpression` を持つオブジェクトの性質。AWS SDK の import は `boundary.outbound` が落とす | 条件つきの書き込み・操作の記録の書き手 |
| `boundary.authorize` | `apps/*` から `apps/web` を除く | `no-restricted-syntax` の数値 `403` と、文字列 `human_only`・`scope_insufficient`・`role_insufficient` | 認可の判定 |
| `usage.reason` | `apps/*` から `apps/web` を除く | `no-restricted-syntax` の文字列 `monthly_cap_reached`・`place_not_allowed`・`inference_not_allowed`・`currency_mismatch`・`concurrency_full`（使える量の判定が返す理由のコード） | 使える量の判定（I8） |
| `usage.plan-values` | `apps/**`・`packages/core/src/**` から使える量の判定のモジュール（`packages/core/src/usage-limit*`）を除く | `no-restricted-imports` の料金プランの値の書き出し（#29 へ渡す欠けの 1 つの書き出し） | 使える量の判定（I8） |
| `usage.plan-names` | `apps/web/src/**` | `no-restricted-syntax` の、料金プランの名前と同じ文字列。名前は #29 の閉じた語の集まりから読み、無ければこの組を作らない | I8（画面） |
| `screen.route` | `apps/web/src/**` | `no-restricted-syntax` の、`/v1/` を含む文字列とテンプレートの文字列 | I14 の画面の呼び出し |
| `routes.generated` | `apps/api/src/**`・`infra/**`（テストを除く） | `no-restricted-syntax` の、`/v1/` で始まる文字列とテンプレートの文字列、と HTTP の方法と `/` で始まる経路の鍵の形（`GET /…` など）の文字列。経路は #2 の生成した登録の書き出し（`packages/contracts`）からだけ読む | I14 の HTTP の経路の登録（API Gateway と Lambda の振り分け） |
| `deps.contracts` | `packages/contracts/src/**` | `no-restricted-imports` の `@nd-factory/*`（自分を除く）・`zod` 以外の外のパッケージ・相対で置き場の外 | 依存の向き |
| `deps.core` | `packages/core/src/**` | 同上の、`@nd-factory/contracts` 以外の `@nd-factory/*`・相対で置き場の外 | 依存の向き |
| `deps.apps` | `apps/*/src/**` ごと | `@nd-factory/` の別の app・`@nd-factory/infra`・`@nd-factory/tools`・相対で自分の app の外 | 依存の向き |
| `deps.web` | `apps/web/src/**` | `@nd-factory/core` のうち `clock`・`ids`・`redact`・`log` 以外の書き出し | 依存の向き |
| `deps.infra` | `infra/**` | `apps/*` の名前・相対で `apps/` | 依存の向き |
| `deps.tools` | `tools/**` | `@nd-factory/contracts` 以外の `@nd-factory/*`・相対で `tools/` の外 | 依存の向き |

依存の向きの組は、型だけの import も落とす（ESLint の組み込みの `no-restricted-imports` を使い、`allowTypeImports` を持たない）。

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `LintException` | 型 `{ file: string; group: string; issue: string; reason: string }` | `tools/checks/src/lint-rules.ts` | — |
| `RuleGroup` | 型 `{ id: string; files: string[]; ignores: string[]; rules: Record<規則, 選び方[]> }` | 同上 | — |
| 控え | データ | `tools/checks/data/lint-exceptions.json` | 下の 4 行 |

控えの最初の行（実装で ESLint を走らせ、当たる組だけを置く）:

| ファイル | 組 | 受け持つ課題 |
| --- | --- | --- |
| `apps/api/src/users-handler.ts` | `boundary.clock`・`boundary.log`・`boundary.outbound` | #2 |
| `apps/api/src/user-store.ts` | `boundary.outbound`・`boundary.conditional-write`・`boundary.retry`（当たれば） | #2 |
| `apps/web/src/main.ts` | `boundary.outbound` | #2 |
| `apps/web/src/users-client.ts` | `screen.route` | #4 |

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `loadLintExceptions` | 形の誤り | JSON でない・項目の欠け・知らない組の ID | 読んだ直後 | 止める（例外） | `npm run lint` が設定の読み込みの誤りで終了コード 2 | 直して打ち直す |
| `eslint.config.js` | 料金プランの書き出しが無い | #29 がまだ置いていない | 動的な import の失敗 | 既定値で続ける（名前を空にし `usage.plan-names` を作らない） | 無し | — |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `buildLintConfigs` と ESLint の API（`ESLint#lintText` に置き場のパスを渡す） | 組ごとに違反の文字列で誤りが 1 件出る | 掛けない置き場（`packages/core`・`infra`・`tools`・`apps/*/test`）で出ない。型だけの import が依存の向きで出て、`@aws-sdk/*` では出ない。`new Date(0)` は出ない | 行の中の `eslint-disable` が効かない |
| 控えの照らし（テスト） | 控えの行のファイルが、今もその組に当たる | 控えの無いファイルは同じ違反で落ちる | 当たらなくなった控えの行で落ちる |
| `loadLintExceptions` | 正しい形を読む | 空の配列 | 知らない組の ID で例外 |

## 漏れの検査

満たす決定: 設計の決定 3・4・9、受け入れ条件 1・2・3

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `loadLeakTerms` | `tools/checks/src/leak-check.ts` | 新設 | `(env: NodeJS.ProcessEnv) => LeakTerms \| null` | `LEAK_CHECK_TERMS` を読み、種類ごとの語の配列を返す。無いか空なら `null` |
| `listTrackedTexts` | 同上 | 新設 | `(root: string) => Promise<TrackedText[]>` | `git ls-files -z` の追跡しているファイルのパスをすべて返し、そのうち先頭 8,000 バイトに NUL の無いものは本文も読む。`TrackedText` は `{ path: string; text: string \| null }` |
| `findShapeHits` | 同上 | 新設 | `(texts: TrackedText[], shapes: SecretShapes, allow: LeakAllow[]) => { hits: LeakHit[]; allowFindings: AllowFinding[] }` | 形ごとの正規表現でパスと本文の行を探し、作り物の値を除く。外しの行のパスと種類の本文の当たりは、件数が外しの `count` と等しいときだけ除き、違えばその当たりを残して件数の食い違いを返す |
| `findTermHits` | 同上 | 新設 | `(texts: TrackedText[], terms: LeakTerms) => LeakHit[]` | 語を大文字と小文字を区別せずに、パスと本文の中に文字列として探す。外しは効かない |
| `maskPath` | 同上 | 新設 | `(path: string, shapes: SecretShapes, terms: LeakTerms \| null) => string` | パスの中の形の当たりと語の当たりの部分を `***` に置き換える。出力と標準エラーに出すパスはすべてこれを通す |
| `mainLeakCheck` | 同上 | 新設 | `(argv: string[], env: NodeJS.ProcessEnv) => Promise<number>` | 上をつなぎ、当たりを出して終了コードを返す |
| `secretShapesSchema`・`loadSecretShapes` | `packages/contracts/src/secret-shapes.ts` | 新設 | `z.ZodType`・`() => SecretShapes` | データの形と、データのファイルを読んで照らす読み手 |

- `findShapeHits`
  - 事前条件: 形の正規表現は名前つきの組 `value` を 1 つ持つ（照らす値の部分）
  - 事後条件: 当たりは `{ kind, file, line }` だけで、当たった文字を持たない。パスの当たりは `line` を `0` にする
  - 副作用: 無し
- `mainLeakCheck`
  - 引数: `[--root <作業の木>]`。スクリプト `npm run leak-check`
  - 副作用: 標準出力に当たりの行（`leak:<種類>` と `<伏せたファイル>:<行>` をタブで区切る）と要約、標準エラーに誤り。ファイルのパスは当たりの行でも読み込みの誤りでも `maskPath` を通し、git や読み込みの誤りの文言（パスを含みうる）はそのまま出さずに誤りの種類だけを出す

照らす形（データの中身。正規表現はデータが持ち、ここでは何を当たりにするかだけを書く）:

| 種類 | 当たり | 当たりにしない |
| --- | --- | --- |
| `account-id` | 前後が英数字でない 12 桁の数 | 作り物の `123456789012` |
| `arn` | `arn:` とパーティション（`aws`・`aws-cn`・`aws-us-gov`）で始まり、アカウントの欄が 12 桁で作り物でないもの。アカウントの欄が空の ARN は、資源の名前が英数字で始まり作り物の頭（`acme`）で始まらないもの | 置き場所の記号（`<…>`・`${…}`）の欄 |
| `resource-id` | AWS の資源の ID の頭（`vpc-`・`subnet-`・`sg-`・`i-`・`vol-`・`snap-`・`ami-`・`igw-`・`rtb-`・`eni-`・`nat-`・`eipalloc-`・`lt-`）と 8 か 17 桁の 16 進 | データの作り物の ID の一覧 |
| `endpoint` | 資源ごとに名前の付く AWS の端点（`*.execute-api.<リージョン>.amazonaws.com`・`*.lambda-url.<リージョン>.on.aws`・`*.cloudfront.net`・`*.auth.<リージョン>.amazoncognito.com`・`*.rds.amazonaws.com`・`*.s3.amazonaws.com` の資源の部分） | 資源の部分が作り物の頭で始まる・置き場所の記号 |
| `private-key` | 私有鍵の頭（`-----BEGIN` と `PRIVATE KEY-----` の間に種類） | — |
| `token` | token の頭の形（GitHub の `ghp_`・`gho_`・`ghu_`・`ghs_`・`ghr_`・`github_pat_`、AWS のアクセスキーの `AKIA`・`ASIA`、Slack の `xox?-`、Anthropic の `sk-ant-`）と続く長さ | 値に作り物の印（`EXAMPLE`）を含む |
| `real:accounts`・`real:profiles`・`real:environments` | CI の秘密の語のどれか | — |

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `SecretShapes` | 型 `{ value_shapes: Shape[]; infra_shapes: Shape[]; fake: { values: string[]; prefixes: string[]; markers: string[] }; key_names?: string[] }`。`Shape` は `{ id, kind, pattern, flags }` | `packages/contracts/src/secret-shapes.ts` | `key_names` は #2 が足す |
| `LeakTerms` | 型 `{ accounts: string[]; profiles: string[]; environments: string[] }` | `tools/checks/src/leak-check.ts` | — |
| `LeakAllow` | 型 `{ path: string; kind: string; count: number; reason: string }`（値も値の要約値も持たない。`count` はそのパスのその種類の本文の当たりの件数） | `tools/checks/data/leak-allow.json` | 空の配列 |
| `AllowFinding` | 型 `{ path: string; kind: string; expected: number; actual: number }`。件数が増えれば新しい値の混入、減れば外しの残り | `tools/checks/src/leak-check.ts` | — |
| 作り物の値 | データ | `packages/contracts/data/secret-shapes.json` の `fake` | `123456789012`・`us-west-2`・頭 `acme`・`example.com`・印 `EXAMPLE` |
| 語を必須にする切り替え | 環境変数 `LEAK_CHECK_REQUIRE_TERMS` | `ci.yml` | 正本のリポジトリの中の実行だけ `1`（参照の検査と同じ式） |

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `loadLeakTerms` | 語の形の誤り | JSON でない・種類の欠け・空の語 | 読んだ直後 | 止める | 標準エラーに誤りの種類だけ（語を出さない）、終了コード 2 | 秘密を直して打ち直す |
| `mainLeakCheck` | 語が要る実行で語が無い | 秘密の未登録 | 切り替えの照らし | 止める | 終了コード 2 | 同上 |
| `mainLeakCheck` | 語が無い実行 | fork・秘密の未登録 | 同上 | 既定値で続ける（形だけを探す） | `skip:` の 1 行 | — |
| `loadSecretShapes` | データの形の誤り・正規表現が作れない | データの書き誤り | 読んだ直後 | 止める | 終了コード 2 | 直して打ち直す |
| `listTrackedTexts` | git が失敗する | 作業の木でない | 子のプロセスの終了コード | 止める | 終了コード 2 | 打ち直せる |
| `mainLeakCheck` | 当たりがある | 実際の値か秘密の形の混入 | 探した後 | 呼び出し元へ返す | 当たりの行と件数、終了コード 1 | 混入を消す。履歴に残った値は別に扱う（検査の外） |
| `mainLeakCheck` | 外しの件数が合わない | 外したファイルへの同じ種類の値の追加・当たりを直したのに外しが残る | 探した後 | 呼び出し元へ返す | `allow:` の行に伏せたパス・種類・外しの件数と実際の件数、終了コード 1 | 値を消すか、正当なら外しの件数を直す（レビューで見る） |
| `listTrackedTexts` | ファイルを読めない | 消えた・権限 | 読み込み | 止める | 標準エラーに `maskPath` を通したパスと誤りの種類（`ENOENT` などの符号）だけ、終了コード 2 | 打ち直せる |

### ログと記録の出力

| 関数 | 出すもの | レベルまたは書き先 | 出さないもの |
| --- | --- | --- | --- |
| `mainLeakCheck` | 当たりの種類・伏せたファイル・行と件数、外しの件数の食い違い、照合を飛ばした旨 | 標準出力 | 当たった文字・当たった行の中身・語・語の数・パスの中の当たった部分 |
| `mainLeakCheck`・`listTrackedTexts` | 誤りの種類と伏せたパス | 標準エラー | 子のプロセスと読み込みの誤りの文言そのもの・パスの中の当たった部分 |

### 既存の部品の再利用

| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `listTrackedTexts`・`findTermHits` | 参照の検査の `gitGrep`・`loadMatchTerms` | `tools/ref-check/src/ref-check.ts` を読んだ | 形の正規表現に前後の照らし（後読み）が要り、`git grep -E` では書けない。語の読み方は同じ形に揃え、関数は共有しない（参照の検査の語の種類と混ぜない、設計の決定 4） |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `findShapeHits` | 種類ごとに当たる（違反の文字列は実行の時に組み立てる）。パスに形の値を含むファイルで `line` 0 の当たりが出る | 作り物の値・置き場所の記号・13 桁の数・16 進の中の 12 桁で当たらない。`docs/` の下のファイルで当たる | 外しの行のファイルと種類で、件数が同じなら当たらない。同じファイルに同じ種類の別の値を 1 つ足すと、当たりと件数の食い違いが出る。当たりを消して外しが残ると件数の食い違いが出る |
| `findTermHits` | 大文字と小文字によらず当たる。パスの中の語にも当たる | 語の前後に別の文字があっても当たる | 外しの行のファイルでも当たる |
| `maskPath` | 当たりの無いパスはそのまま | 語と形の両方を含むパスで両方を伏せる | — |
| `mainLeakCheck` | 当たりで終了コード 1、無ければ 0 | 語の無い実行で `skip:` と 0 | 語の形の誤り・必須なのに無いで 2。実際の値をパスに含み本文にも当たりのあるファイルで、標準出力と標準エラーのどちらにも語と当たった文字が現れない。同じパスのファイルを読めなくした（権限を外した）作業の木で終了コード 2、標準エラーに語が現れない |

## 形の往復と I15・I12 の形

満たす決定: 設計の決定 8、受け入れ条件 1

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `mutate` | `tools/checks/src/round-trip.ts` | 新設 | `(value: unknown, schema: JsonSchema) => Mutation[]` | 見本の値から変形（必須の項目を 1 つずつ消す・項目の型を変える・知らない項目を足す・配列を最初の 1 件の値にする）を作る |
| `representationsOf` | 同上 | 新設 | `(op: OperationView, generated: GeneratedView) => Representation[]` | 1 つの操作の要素と結果の形を、zod・JSON Schema・OpenAPI の要素の形・MCP の道具の入力と出力の形の 4 つの検証の関数として返す |
| `findRoundTripMismatches` | 同上 | 新設 | `(ops: OperationView[], generated: GeneratedView) => Mismatch[]` | 見本と変形を 4 つで検証し、通るか拒むかが違う組を返す。変形していない見本は、該当するすべての形で通ることも確かめ、どれか 1 つでも拒めば `sample-rejected` の食い違いとして、拒んだ形の名前と一緒に返す |
| `findValueShapeFindings` | 同上 | 新設 | `(generated: GeneratedView) => ValueShapeFinding[]` | 利用者向けの操作の要求と応答が配列でない（I12）・名前が `_at` で終わる項目が UTC の日時の形でない・`amount_minor` を持つ要素が `currency` を必須にしない（I15）を返す |

- `representationsOf`
  - 事前条件: 生成物が古くない（#2 の `check` が先に落とす）
  - 事後条件: MCP の道具の入力は `{"items": [...]}` に包んで検証する（API と MCP の文書の道具の入力の形）。人だけの操作は MCP の形を持たないので 3 つで比べる
  - 副作用: 無し（ajv のコンパイルは関数の中で閉じる）

`OperationView` と `GeneratedView` は、#2 の操作の表と生成物の書き出しから、この検査が読む項目（名前・エンティティ・読むか書くか・人だけか・HTTP の経路・機能・見本・要素と結果の形、生成した JSON Schema・OpenAPI・MCP の道具の一覧・HTTP の経路の登録）だけを写した型である。書き出しの名前は #2 の詳細設計が決め、実装の最初のタスクで写す（設計文書の K2-3）。

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `representationsOf` | JSON Schema をコンパイルできない | 生成物が draft 2020-12 でない・知らない書式 | ajv | 呼び出し元へ返す（その操作を食い違いとして出す） | vitest の失敗に操作の名前 | 生成を直す（#2） |
| テスト | 操作の表の書き出しが無い | #2 がまだ置いていない | 動的な import | 既定値で続ける（照らす操作 0 件で通り、見本の表でだけ確かめる） | テストの名前に「相手が無い」 | — |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `findRoundTripMismatches` | 作り物の操作の表（テストの中で組む）で食い違いが 0 件 | 人だけの操作は 3 つで比べ、見本が 3 つで通ることを確かめる（MCP の形を求めない）。空の配列の見本 | JSON Schema だけで項目を必須から外すと、その操作と変形が返る。4 つの形をそろって見本を拒むように変えた表で `sample-rejected` が返る（比べだけでは 0 件になる入力）。1 つの形だけが見本を拒むと `sample-rejected` と変形なしの食い違いの両方が返る |
| `mutate` | 必須の項目ごとに 1 つ消した変形ができる | 必須の項目が無い形で消す変形を作らない | — |
| `findValueShapeFindings` | 正しい形で 0 件 | — | 時刻帯の無い日時の形・通貨の無い金額・配列でない要求でそれぞれ 1 件 |
| リポジトリへの適用 | 今の操作の表と生成物で 0 件 | — | — |

## I14 の対応

満たす決定: 設計の決定 5（画面の控え）、受け入れ条件 5（API と MCP の文書の照らす検査の表の「画面と操作の対応」「MCP と操作の対応」「HTTP の経路の登録」「機能の対応」の 4 行。「画面の呼び出し」は規則の組の `screen.route`、「値の形」「配列」は形の往復の節）

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `screenOperationNames` | `tools/checks/src/operation-coverage.ts` | 新設 | `(files: { path: string; text: string }[], clientModule: string) => Set<string>` | 画面のコード（`apps/web/src` のテストでない `*.ts`）を TypeScript の構文木で読み、生成した呼び出しの書き出しから import した操作の関数の名前か、呼び出しの第 1 引数の文字列の定数を操作の名前として集める（#2 へ渡す K2-2 の形） |
| `loadScreenPending` | 同上 | 新設 | `(path: string) => ScreenPending[]` | 画面の控え `tools/checks/data/screen-pending.json` を読み、形を照らして返す。`ScreenPending` は `{ operation: string; issue: string; reason: string }` |
| `findCoverageFindings` | 同上 | 新設 | `(input: CoverageInput) => CoverageFinding[]` | 下の 8 つの欠けと余りを返す。`CoverageInput` は操作の表・MCP の道具の一覧・HTTP の経路の登録・画面が呼ぶ名前・画面の控え |

| 欠けと余りの種類 | 当たり |
| --- | --- |
| `screen-missing` | 利用者向けの操作のうち、画面のどこからも呼ばれず、画面の控えにも無いもの |
| `screen-pending-stale` | 画面の控えの操作のうち、画面から呼ばれるようになったもの（直したのに残った控え） |
| `screen-pending-unknown` | 画面の控えの操作のうち、操作の表の利用者向けの操作に無いもの |
| `screen-unknown` | 画面が呼ぶのに操作の表に無い名前 |
| `mcp-mismatch` | MCP の道具の一覧の名前の集まりと、人だけでない操作の集まりの差（両方の向き） |
| `human-only-without-read` | 人だけの操作のうち、同じエンティティに人だけでない読む操作が無いもの |
| `route-unknown` | HTTP の経路の登録のうち、操作の表に無い経路 |
| `feature-missing` | F1〜F20 のうち、どの操作の機能にも無いもの |

- `findCoverageFindings`
  - 事前条件: 利用者向けの操作と機械向けの経路（ランナー・手元のマシン・DB の用意のタスク）が、#2 の書き出しで分かれている（設計文書の K2-3）
  - 事後条件: 機械向けの経路は `screen-missing`・`mcp-mismatch` の対象に入れない
  - 副作用: 無し

画面の控えの段階（設計文書の決定 5）:

| 段階 | 控えの中身 | 何が必須になるか |
| --- | --- | --- |
| #1 の実装 | 空の配列（操作の表がまだ無い） | — |
| #2 が操作の表を置く Pull Request | 画面の無い利用者向けの操作をすべて、その画面を作る課題の番号つきで置く。課題の番号は全体の設計の操作の一覧の「機能」から引く | 表に無い名前を画面が呼ばないこと・控えの操作が表にあること |
| 操作を足す Pull Request | 画面を同じ Pull Request で足すか、控えに行を足す（足す行はレビューで見る） | 同上 |
| 画面を作る課題の Pull Request | 自分の番号の行を消す。画面から呼ぶようになった操作の行を残すと `screen-pending-stale` で落ちる | その操作の `screen-missing` |

`HTTP の経路の登録` の照らしは #2 の生成した登録を読む。`apps/api` の振り分けと `infra/` の API Gateway の定義に経路を手で書くことは規則の組 `routes.generated` が落とすので、両方の実際の登録は生成した登録からだけ作られる（設計文書の K2-3）。

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| テスト | 操作の表か生成物の書き出しが無い | #2 がまだ置いていない | 動的な import | 既定値で続ける（リポジトリへの適用を「相手が無い」として通し、作り物の表のテストだけを走らせる） | テストの名前に「相手が無い」 | — |
| `screenOperationNames` | 呼び出しの第 1 引数が文字列の定数でない | 名前を変数で渡した | 構文木 | 呼び出し元へ返す（`screen-unknown` として場所を出す） | vitest の失敗にファイルと行 | 定数で書き直す |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `screenOperationNames` | import した関数と文字列の定数の両方を拾う | 別名の import（`as`）も元の名前で拾う。テストのファイルを読まない | 変数で渡した名前を `screen-unknown` にする |
| `findCoverageFindings` | 揃った作り物の表で 0 件 | 機械向けの経路を数えない。画面の無い操作を控えに置くと `screen-missing` にならない | 8 つの種類ごとに、1 行を足すか消した表で 1 件 |
| `loadScreenPending` | 正しい形を読む | 空の配列 | 項目の欠けで例外 |

## NDF の契約の照合

満たす決定: 設計の決定 6・7、受け入れ条件 1・9。読む契約は #41 の決定（固定の点の置き場 `plugins/ndf/contracts/`・区間の報告は `C/hooks/unattended-report.json`・先端は既定の枝）に従う。`C/` は `plugins/ndf/contracts/` の略である。

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `pinChanged` | `tools/checks/src/ndf-contract-check.ts` | 新設 | `(root: string, base: string, head: string) => Promise<boolean>` | `git merge-base <base> <head>` で分岐点を求め、分岐点と head のコミットの `ndf-pin.json` の中身を `git show` で比べる。作業の木は読まない |
| `fetchContract` | 同上 | 新設 | `(rev: ContractRev, workDir: string) => Promise<ContractFiles>` | NDF のリポジトリから 1 つのコミットを深さ 1 で取り、契約のファイルを読む。先端は `git ls-remote --symref` の `HEAD` で既定の枝を引く |
| `compareContract` | 同上 | 新設 | `(files: ContractFiles, use: NdfContractUse \| null) => ContractFinding[]` | 下の 6 つを照らし、食い違いを返す |
| `renderSummary` | 同上 | 新設 | `(fixed: ContractFinding[], tip: ContractFinding[] \| null, skipped: string[]) => string` | 要約の Markdown（照らした先ごとの `checked:` か `skip:` の行と、固定の点と先端の食い違いの表）を作る |
| `mainNdfContractCheck` | 同上 | 新設 | `(argv: string[], env: NodeJS.ProcessEnv) => Promise<number>` | 起動の判定・取得・照らし・要約・終了コードをつなぐ |

- `mainNdfContractCheck`
  - 引数: `[--root <作業の木>] [--base <基点のコミット>] [--head <head のコミット>] [--summary <要約のファイル>]`。スクリプト `npm run ndf-contract`
  - 事前条件: `--base` と `--head` は Pull Request のときだけ、両方そろえて渡す（片方だけなら終了コード 2）
  - 事後条件: `--base` があり `pinChanged` が偽なら、取得も照らしもせずに `skip: pin-unchanged` の 1 行を出して 0 で終わる。それ以外は、作業の木（`--root`）の `ndf-pin.json` と形の正本で、固定の点と先端の両方を照らす
  - 出力の行（標準出力と要約の両方に出す。どの行が出たかで、照らしたかどうかと理由を見分ける）:
    - `skip: pin-unchanged` — Pull Request で固定の点を変えていないので照らさなかった
    - `skip: no-contract-use <固定の点のコミット>` — NDF の契約の使い方の書き出しが無いので 1〜6 を照らさなかった（契約のファイルを読めることだけを確かめた）
    - `checked: fixed <固定の点のコミット> 1-6` — 固定の点に対して照らすこと 1〜6 をすべて実行した。食い違いの有無に関わらず、1〜6 を実行したときだけ出す
    - `checked: tip <先端のコミット> 1-6` — 先端に対して同じく実行した（先端を取れなければ出さず、要約に先端を照らさなかったと出す）

使うコミット:

| 起動 | 差分の判定に使うコミット | 契約の照合に使う作業の木 |
| --- | --- | --- |
| `pull_request` | `github.event.pull_request.base.sha` と `github.event.pull_request.head.sha` の分岐点と、`head.sha` | `actions/checkout` の既定の取得（マージした結果のコミット `refs/pull/<番号>/merge`）。マージされる姿で照らす |
| `push`（main） | 判定しない | push したコミット |
| `schedule`・`workflow_dispatch` | 判定しない | 既定の枝の先端（`schedule` の取得） |
  - 副作用: 作業のディレクトリ（一時のディレクトリ）への取得、要約のファイルへの追記（ワークフローは `GITHUB_STEP_SUMMARY` を渡す）
- 固定の点のコミットは `ndf-pin.json` から読む。キーの名前は参照の検査の書き方に倣って定数に置き、キーを読む行に大小の比べの記号と矢印の関数を置かない（参照の検査の版の比べに当たるため）

照らすこと（実行の文書の (1)〜(4) と、#41 の決定 108・106 から足す 2 つ）:

| # | 照らすこと | 契約のファイル | nd-factory の側（#2 の NDF の契約の使い方） |
| --- | --- | --- | --- |
| 1 | 見本 26 件を呼び出しの判定へ通し、`valid` と同じ判定になる | `C/domains/entrypoint-cases.json`・`C/domains/entrypoints.json` | 呼び出しの判定 |
| 2 | `version.json` の `history` の最後の行（版と sha256）が受ける組にある | `C/version.json` | 受ける組 |
| 3 | `set_by: service` の名前と使う口の `env` 列の名前が、ランナーが渡す環境変数の名前を含む | `C/domains/env.json`・`C/domains/entrypoints.json` | 渡す環境変数の名前 |
| 4 | `reader: service` の読むファイルの `fields` が、翻訳が読む項目を含む。読むファイルの行が契約にある | `C/domains/ndf-files.json` | 読むファイルと項目 |
| 5 | 区間の報告の `shape.values` と `shape.items` が、ランナーが読む結果の値と項目を含む | `C/hooks/unattended-report.json` | 区間の報告から読む値と項目 |
| 6 | 使う口がすべて契約の口の表にある | `C/domains/entrypoints.json` | 使う口 |

`ask-journal` の行が `fields` を持つようになったら、4 の照らしに入る前に、要約の「知らせ」の行へその点と `fields` を出す（失敗にしない。#41 の決定 106 の答えを知るため）。

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| NDF のリポジトリの URL | 定数（出所: #41 の決定 104） | `tools/checks/src/ndf-contract-check.ts` | `https://github.com/devbasex/ai-plugins` |
| 契約の置き場 | 定数（出所: #41 の決定 104） | 同上 | `plugins/ndf/contracts` |
| `ContractFinding` | 型 `{ check: 1〜6; path: string; id?: string; detail: string }`。`id` は見本の id か表の行の id | 同上 | — |
| `NdfContractUse` | 型（#2 の書き出しから写す） | 同上 | 書き出しが無ければ `null` |

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `pinChanged` | 基点か head のコミットを読めない・分岐点が無い | ワークフローが履歴を取っていない | `git merge-base`・`git show` の失敗 | 止める | 終了コード 2 | ワークフローを直して打ち直す |
| `fetchContract`（固定の点） | 取れない・契約のファイルが無い・JSON でない | ネットワーク・固定の点の誤り・置き場の移動 | 取得と読み込み | 止める | 標準エラーに理由、終了コード 2 | 打ち直せる。置き場の移動なら固定の点を変える Pull Request で直す |
| `fetchContract`（先端） | 同上 | 同上 | 同上 | 既定値で続ける（先端を照らさなかったと要約に出す） | 要約の行、固定の点の結果で終わる | 次の毎日の実行で照らす |
| `compareContract` | NDF の契約の使い方の書き出しが無い | #2 がまだ置いていない | 動的な import | 既定値で続ける（1〜6 を照らさず、契約のファイルが読めることだけを確かめる） | `skip: no-contract-use <固定の点のコミット>` の 1 行と要約の行。`checked:` の行を出さない | — |
| `mainNdfContractCheck` | 固定の点で食い違う | 固定の点を変えた・nd-factory の側を変えた | 照らした後 | 呼び出し元へ返す | 要約の表と食い違いの行、終了コード 1 | 直すか固定の点を戻す |
| `mainNdfContractCheck` | 先端だけで食い違う | 上流の未配布の変更 | 照らした後 | 既定値で続ける | 要約の表に見本の id と契約のファイルのパス、終了コード 0 | 次の固定の点を変える Pull Request で扱う |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `pinChanged` | 分岐点と head が同じ中身で偽、違えば真 | 空白だけの違いも真（中身の比べ）。分岐の後に基点の枝だけで `ndf-pin.json` を変えたリポジトリで偽。作業の木だけを変えても結果が変わらない | 基点か head を読めないと例外 |
| `compareContract` | 作り物の契約と使い方で 0 件 | 使い方が `null` で照らさない。`ask-journal` に `fields` を足した契約で知らせが出て、食い違いにならない | 1〜6 のそれぞれ 1 つを壊した契約で、その番号の食い違いが出る |
| `mainNdfContractCheck` | 固定の点だけの食い違いで 1、先端だけで 0 と要約の行。どちらも `checked: fixed <固定の点> 1-6` の行が出る | `--base` と `--head` の分岐点が同じ中身で `skip: pin-unchanged` と 0、`checked:` の行が出ない。使い方の書き出しが無いと `skip: no-contract-use` と 0、`checked:` の行が出ない | 固定の点の取得の失敗で 2。`--base` だけを渡すと 2 |

`fetchContract` はテストでネットワークを使わず、テストの中で作った git のリポジトリを NDF のリポジトリの代わりに渡す（URL を引数で差し替える）。

## ワークフローと宣言

満たす決定: 設計の決定 4・6、受け入れ条件 1・8・10

| ファイル | 変える中身 |
| --- | --- |
| `.github/workflows/ci.yml` | ジョブ `leak-check` を足す。`check` と同じ取得と Node の用意の後に `npm run leak-check` を打ち、環境変数 `LEAK_CHECK_TERMS`（秘密）と `LEAK_CHECK_REQUIRE_TERMS`（`ref-check` と同じ式で変数 `LEAK_CHECK_REQUIRE_TERMS` から作る）を渡す |
| `.github/workflows/ndf-contract.yml`（新設） | `on` は `pull_request`・`push`（main）・`schedule`（毎日 1 回）・`workflow_dispatch`。`permissions: contents: read`。ジョブ `ndf-contract` は Pull Request のとき、既定の取得（マージした結果のコミット）に加えて `base.sha` と `head.sha` を分岐点が求まる深さまで取り（`fetch-depth: 0`）、`npm run ndf-contract -- --base <base.sha> --head <head.sha> --summary "$GITHUB_STEP_SUMMARY"` を打つ。ほかの起動では `--base` と `--head` を渡さない。動作の版はコミットの SHA で固定する（`ci.yml` と同じ） |
| `.ndf/project.json` | `ci.required_checks` に `leak-check`・`ndf-contract` を足す。`ci.workflows` に `ndf-contract.yml` の行を足す |
| `package.json` | スクリプト `leak-check`・`ndf-contract` |
| `tools/package.json` | 依存 `@nd-factory/contracts`・`ajv`・`ajv-formats` |
| `tools/tsconfig.json` | `checks/src` を含める |
| `packages/contracts/package.json` | 書き出し `./secret-shapes` |
| `AGENTS.md` | 「秘密とインフラの値を置かない」に、実際の値の一覧は CI の秘密 `LEAK_CHECK_TERMS` から受ける行を足す |

### 関数の仕様（CI の定義のテスト）

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `workflowFiles` | `tools/test/ci-definition.test.ts` | 新設 | `(root: string) => { path: string; text: string }[]` | `.github/workflows/` の `*.yml`・`*.yaml` を読む |
| `triggersPullRequest` | 同上 | 新設 | `(yaml: string) => boolean` | 最上位の `on:` が `pull_request` を持つか |
| `permissionBlocks` | 同上 | 新設 | `(yaml: string) => { scope: string; entries: string[] }[]` | 最上位の `permissions` と、各ジョブの `permissions` を、場所（`top` かジョブの名前）と中身の行の組で返す。`permissions: write-all`・`read-all` の 1 行の形も 1 つの中身として返す |

テストが照らすこと: Pull Request で起動するワークフローのジョブの名前の和集合が必須のチェックの宣言と等しい・ジョブの名前がワークフローの間で重ならない・どのワークフローにも資格情報の語が無い・どのワークフローも最上位の `permissions` に `contents: read` だけを持ち、ジョブの `permissions` は持たないか `contents: read` だけを持つ（ジョブの上書きで権限を足させない）。

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `workflowFiles`・`triggersPullRequest` | 2 つのワークフローを読み、Pull Request で起動するものを選ぶ | `on: [pull_request]` と `on:` の下の鍵の両方の書き方 | 片方のワークフローにだけ資格情報の語・`id-token: write` を足すと当たる |
| `permissionBlocks` と権限の照らし | 今の 2 つのワークフローで違反 0 件 | ジョブの `permissions: { contents: read }` は通る | ジョブの `permissions` に `pull-requests: write`（資格情報の語に当たらない種類）を足す・ジョブに `permissions: write-all` を書く・最上位に `issues: write` を足すと、それぞれ場所つきで当たる |
| 参照の検査のテスト | — | — | ワークフローの文字列に NDF の版を読む式と比べを同じ行に置くと当たる |
