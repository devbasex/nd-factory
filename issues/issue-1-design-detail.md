# #1 の詳細設計: 検査を置き場とジョブへ下ろす

設計文書 [issue-1-design.md](./issue-1-design.md) の構成要素を、ファイルと関数の粒度へ下ろした文書である。決定の理由は設計文書にあり、ここでは「どこに何を作るか」だけを書く。全体の設計（`docs/design/`）で決めた置き場・依存の向き・落とすものは決め直さない。

## 地図

触るファイル（`*` は新設）:

```text
nd-factory/
├── eslint.config.js                       規則の組を読み込む
├── package.json                           スクリプト leak-check・ndf-contract・route-check・test:integration
├── vitest.config.ts                       tools の組から *.integration.test.ts を外す
├── vitest.integration.config.ts         * 実物の gitleaks を起こす結合のテストだけを読む
├── .ndf/project.json                      必須のチェックに 2 つ足す
├── AGENTS.md                              LEAK_CHECK_TERMS の行
├── .github/workflows/
│   ├── ci.yml                             ジョブ leak-check を足す。synth に経路の照らしを足す
│   └── ndf-contract.yml                 * ジョブ ndf-contract
├── apps/api/test/
│   └── dispatch-routes.test.ts          * Lambda の振り分けの経路と操作の表の照らし
├── packages/contracts/
│   ├── package.json                       書き出し ./secret-shapes
│   ├── data/secret-shapes.json          * 秘密の形・インフラの値の形・作り物の値
│   └── src/secret-shapes.ts             * その形（zod）と読み手
└── tools/
    ├── package.json                       依存 ajv・ajv-formats・@nd-factory/contracts
    ├── tsconfig.json                      checks/src を含める
    ├── checks/
    │   ├── data/lint-exceptions.json    * 規則の控え（決定 5）
    │   ├── data/leak-allow.json         * 漏れの検査の外し（パス・規則・件数）
    │   ├── data/screen-pending.json     * I14 の画面の控え（操作の名前・画面を作る課題）
    │   └── src/
    │       ├── lint-rules.ts            * ESLint の規則の組
    │       ├── leak-check.ts            * 漏れの検査（CLI）
    │       ├── round-trip.ts            * 形の往復と I15・I12 の形
    │       ├── operation-coverage.ts    * I14 の対応
    │       ├── deployed-routes.ts       * API Gateway の合成の結果の経路の照らし（CLI）
    │       └── ndf-contract-check.ts    * NDF の契約の照合（CLI）
    └── test/
        ├── lint-rules.test.ts           *
        ├── leak-check.test.ts           *   gitleaks を起こさない単体のテスト（check で走る）
        ├── leak-check.integration.test.ts * 実物の gitleaks を起こす結合のテスト（leak-check で走る）
        ├── deployed-routes.test.ts      *
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
| `tools/checks/src/leak-check.ts` | 新設 | gitleaks の設定を組んで起こし、報告を外しで絞って、値を出さずに当たりを出す | `@nd-factory/contracts/secret-shapes`・gitleaks の実行ファイル | `leak-check` | `loadLeakTerms`・`buildGitleaksConfig`・`snapshotTracked`・`runGitleaks`・`applyAllow`・`maskPath`・`mainLeakCheck`（新設） |
| `tools/checks/src/round-trip.ts` | 新設 | 4 つの形の検証の結果を比べる | `@nd-factory/contracts`・ajv・ajv-formats | `round-trip` | `mutate`・`representationsOf`・`findRoundTripMismatches`・`findValueShapeFindings`（新設） |
| `tools/checks/src/operation-coverage.ts` | 新設 | 操作の表と画面・MCP・HTTP の経路・機能を突き合わせる | `@nd-factory/contracts`・`typescript` | `operation-coverage` | `screenOperationNames`・`loadScreenPending`・`findCoverageFindings`（新設） |
| `tools/checks/src/deployed-routes.ts` | 新設 | 合成した CloudFormation の雛形から API Gateway の経路を読み、操作の表と照らす | `@nd-factory/contracts` | `deployed-routes` | `readGatewayRoutes`・`findGatewayRouteFindings`・`mainRouteCheck`（新設） |
| `apps/api/test/dispatch-routes.test.ts` | 新設 | Lambda の振り分けが実際に受ける経路を、操作の表の経路と照らす | `apps/api/src` の振り分け・`@nd-factory/contracts` | テスト | — |
| `tools/checks/src/ndf-contract-check.ts` | 新設 | 固定の点と既定の枝の先端の契約を照らす | `@nd-factory/contracts`（NDF の契約の使い方） | `ndf-contract-check` | `pinChanged`・`fetchContract`・`compareContract`・`renderSummary`・`mainNdfContractCheck`（新設） |
| `packages/contracts/src/secret-shapes.ts` | 新設 | 秘密の形のデータの形と読み手 | zod | `secret-shapes` | `secretShapesSchema`・`loadSecretShapes`（新設） |
| `tools/test/ci-definition.test.ts` | 変更 | すべてのワークフローを YAML として読んで照らす | `yaml` | テスト | `loadWorkflows`・`triggersPullRequest`・`permissionBlocks`（新設）、`jobNames`（YAML の `jobs` の鍵から取るように変える）、`credentialWords`（変えない） |
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
- 規則の組の `files` は `*.ts` と `*.tsx` を両方書く。`*.tsx` の構文は typescript-eslint の解析器が拡張子で JSX として読む（今の設定は `**/*.ts` にだけ型の規則を掛けているので、`**/*.tsx` を同じ塊へ足す）。React の部品の規則（フックの使い方など）は画面を組む課題が足し、この組は持たない

規則の組（`apps/*` は `apps/api`・`apps/web`・`apps/runner`・`apps/nd-runtime`・`apps/db-prep` の `src/` の `*.ts` と、画面の `apps/web/src/` の `*.tsx`。テストのディレクトリと e2e を含まない。画面は React 19 の部品を TSX で書く（プラットフォームの決定 140）ので、画面の組はどれも `*.ts` と `*.tsx` の両方に掛ける）:

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
| `usage.plan-names` | `apps/web/src/**` | `no-restricted-syntax` の、料金プランの名前と同じ文字列（JSX の属性の値を含む）と JSX の本文（`JSXText`）。名前は #29 の閉じた語の集まりから読み、無ければこの組を作らない | I8（画面） |
| `screen.route` | `apps/web/src/**` | `no-restricted-syntax` の、`/v1/` を含む文字列（JSX の属性の値を含む）とテンプレートの文字列 | I14 の画面の呼び出し |
| `routes.generated` | `apps/api/src/**`・`infra/**`（テストを除く） | `no-restricted-syntax` の、`/v1/` で始まる文字列とテンプレートの文字列、と HTTP の方法と `/` で始まる経路の鍵の形（`GET /…` など）の文字列。経路は #2 の生成した登録の書き出し（`packages/contracts`）からだけ読む | I14 の HTTP の経路の登録（API Gateway と Lambda の振り分け） |
| `deps.contracts` | `packages/contracts/src/**` | `no-restricted-imports` の `@nd-factory/*`（自分を除く）・`zod` 以外の外のパッケージ・相対で置き場の外 | 依存の向き |
| `deps.core` | `packages/core/src/**` | 同上の、`@nd-factory/contracts` 以外の `@nd-factory/*`・相対で置き場の外 | 依存の向き |
| `deps.apps` | `apps/*/src/**` ごと | `@nd-factory/` の別の app・`@nd-factory/infra`・`@nd-factory/tools`・相対で自分の app の外 | 依存の向き |
| `deps.web` | `apps/web/src/**` | `@nd-factory/core` のうち `clock`・`ids`・`redact`・`log` 以外の書き出し | 依存の向き |
| `deps.infra` | `infra/**` | `apps/*` の名前・相対で `apps/` | 依存の向き |
| `deps.react` | `apps/web/**` の外のすべての `*.ts` | `no-restricted-imports` の `react`・`react-dom`・`react/*`・`react-dom/*`・`@vitejs/plugin-react`（型だけの import も落とす） | 言語と書き方の決まりの「画面の外のコードは TSX と React を import しない」（決定 140） |
| `files.tsx` | `apps/web/**` の外の `*.tsx` | `no-restricted-syntax` の `Program`（ファイルそのものを 1 件の誤りにする） | 同上（TSX は画面の置き場だけ） |
| `deps.tools` | `tools/**` | `@nd-factory/contracts` 以外の `@nd-factory/*`・相対で `tools/` の外 | 依存の向き |

依存の向きの組は、型だけの import も落とす（ESLint の組み込みの `no-restricted-imports` を使い、`allowTypeImports` を持たない）。

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `LintException` | 型 `{ file: string; group: string; issue: string; reason: string }` | `tools/checks/src/lint-rules.ts` | — |
| `RuleGroup` | 型 `{ id: string; files: string[]; ignores: string[]; rules: Record<規則, 選び方[]> }` | 同上 | — |
| 控え | データ | `tools/checks/data/lint-exceptions.json` | 下の 5 行 |

控えの最初の行（実装で ESLint を走らせ、当たる組だけを置く）:

| ファイル | 組 | 受け持つ課題 |
| --- | --- | --- |
| `apps/api/src/users-handler.ts` | `boundary.clock`・`boundary.log`・`boundary.outbound` | #2 |
| `apps/api/src/user-store.ts` | `boundary.outbound`・`boundary.conditional-write`・`boundary.retry`（当たれば） | #2 |
| `apps/web/src/main.ts` | `boundary.outbound` | #2 |
| `apps/web/src/users-client.ts` | `screen.route` | #4 |
| `infra/lib/app-stack.ts` | `routes.generated`（`api.addRoutes` の `path: "/v1/users"`） | #2（API Gateway の経路を生成した登録から読むように変える。K2-3） |

`infra/lib/app-stack.ts` の行が無いと、#1 の Pull Request の `check` が今の `/v1/users` の経路で落ちる。#2 が API Gateway の定義を生成した登録へ移した Pull Request でこの行を消し、残すと控えの照らしが落とす。

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `loadLintExceptions` | 形の誤り | JSON でない・項目の欠け・知らない組の ID | 読んだ直後 | 止める（例外） | `npm run lint` が設定の読み込みの誤りで終了コード 2 | 直して打ち直す |
| `eslint.config.js` | 料金プランの書き出しが無い | #29 がまだ置いていない | 動的な import の失敗 | 既定値で続ける（名前を空にし `usage.plan-names` を作らない） | 無し | — |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `buildLintConfigs` と ESLint の API（`ESLint#lintText` に置き場のパスを渡す） | 組ごとに違反の文字列で誤りが 1 件出る。画面の組は `*.tsx` のパス（JSX の属性の値と本文を含む）でも出る。`apps/web` の外で `react` を import する・`apps/web` の外に `*.tsx` を置くと出て、`apps/web/src` の `*.tsx` で `react` を import しても出ない | 掛けない置き場（`packages/core`・`infra`・`tools`・`apps/*/test`）で出ない。型だけの import が依存の向きで出て、`@aws-sdk/*` では出ない。`new Date(0)` は出ない | 行の中の `eslint-disable` が効かない |
| 控えの照らし（テスト） | 控えの行のファイルが、今もその組に当たる | 控えの無いファイルは同じ違反で落ちる | 当たらなくなった控えの行で落ちる |
| `loadLintExceptions` | 正しい形を読む | 空の配列 | 知らない組の ID で例外 |

## 漏れの検査

満たす決定: 設計の決定 3・4・9、受け入れ条件 1・2・3

探すのは gitleaks（設計の LIB1）である。この節の関数は、gitleaks の設定を形の正本のデータと CI の秘密から実行の時に組み、gitleaks を起こし、報告を外しで絞り、値を出さずに出力する包みだけを持つ。正規表現で本文を探す処理は自前で持たない。

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `loadLeakTerms` | `tools/checks/src/leak-check.ts` | 新設 | `(env: NodeJS.ProcessEnv) => LeakTerms \| null` | `LEAK_CHECK_TERMS` を読み、種類ごとの語の配列を返す。無いか空なら `null` |
| `buildGitleaksConfig` | 同上 | 新設 | `(shapes: SecretShapes, terms: LeakTerms \| null) => string` | gitleaks の設定（TOML）の中身を組む。既定の規則を残し（`[extend] useDefault = true`）、データの形ごとに規則 `nd-<種類>-<id>`（`regex`・`secretGroup`）を足し、作り物の値・頭・印を規則ごとの許可（`regexTarget = "secret"` の `regexes`）にする。語があれば、種類ごとに大文字と小文字を区別しない規則 `nd-real-<種類>` を本文用（`regex`）とパス用（`path`）の 2 つ足す。語は正規表現の記号を外して入れる |
| `snapshotTracked` | 同上 | 新設 | `(root: string, scanRoot: string) => Promise<void>` | `git ls-files -z` の追跡しているファイルだけを、一時のディレクトリ `<scanRoot>/tree/` の下へ同じ相対パスで写す（依存や生成の出力など、追跡していないファイルを探さないため）。gitleaks に渡す `<scanRoot>` の直下には何も置かない。gitleaks は探す木の根の `.gitleaksignore` を必ず読むため、追跡している根の `.gitleaksignore` を木の根に来させない |
| `runGitleaks` | 同上 | 新設 | `(args: GitleaksRun, config: string) => Promise<GitleaksFinding[]>` | gitleaks を `--redact=100 --no-banner --ignore-gitleaks-allow --gitleaks-ignore-path <空の一時のディレクトリ> --report-format json --report-path - --exit-code 0` で起こし、作業のディレクトリ（cwd）も同じ空の一時のディレクトリにする。設定は環境変数 `GITLEAKS_CONFIG_TOML` で渡す（ファイルに書かない）。子の環境からは `GITLEAKS_CONFIG` を除く（gitleaks は `GITLEAKS_CONFIG` を `GITLEAKS_CONFIG_TOML` より先に読むため）。`GitleaksRun` は `{ mode: "dir"; scanRoot } \| { mode: "git"; gitDir; range }`。報告は標準出力からメモリへ受け、ファイルにもディスクにも書かない。解いた報告から `RuleID`・`File`・`StartLine`・`Commit` だけを `GitleaksFinding` へ写し、残り（`Secret`・`Match`・`Message`・`Author`・`Email`・`Fingerprint` など）は写さずに捨てる。`File` はここでリポジトリの相対パス（`/` 区切り）に正規化する（下の「パスの正規化」） |
| `applyAllow` | 同上 | 新設 | `(findings: GitleaksFinding[], allow: LeakAllow[], scope: "tree" \| "history") => { hits: LeakHit[]; allowFindings: AllowFinding[] }` | 受けるパスは `runGitleaks` が正規化したリポジトリの相対パスで、`LeakAllow.path` とそのまま比べる。`tree`（今の木）では、外しの行のパスと規則の当たりは、件数が外しの `count` と等しいときだけ除き、違えばその当たりを残して件数の食い違いを返す。`history`（履歴）では件数を照らさず、外しの行のパスと規則の組に入る当たりを除く（下の「履歴の当たりと外し」）。どちらでも `nd-real-*` の当たりには外しを効かせない |
| `maskPath` | 同上 | 新設 | `(path: string, shapes: SecretShapes, terms: LeakTerms \| null) => string` | パスの中の形の当たりと語の当たりの部分を `***` に置き換える。出力と標準エラーに出すパスはすべてこれを通す |
| `mainLeakCheck` | 同上 | 新設 | `(argv: string[], env: NodeJS.ProcessEnv) => Promise<number>` | 上をつなぎ、当たりを出して終了コードを返す |
| `secretShapesSchema`・`loadSecretShapes` | `packages/contracts/src/secret-shapes.ts` | 新設 | `z.ZodType`・`() => SecretShapes` | データの形と、データのファイルを読んで照らす読み手。形ごとに、`pattern` が共通の部分の外の書き方（先読み・後読み・後方参照・名前つきの組・行の中の旗）を含まないこと、`new RegExp(pattern, "u")` で作れること、名前の無い組を 1 つ以上持つことを照らし、外れれば形の誤りにする |

- `buildGitleaksConfig`
  - 事前条件: 形の正規表現は gitleaks の正規表現（Go の RE2）で書け、照らす値の部分を 1 つ目の組に持つ
  - 事後条件: 返す TOML はリポジトリにもファイルにも書かれない（`runGitleaks` が環境変数で渡すだけ）
  - 副作用: 無し
- `runGitleaks`
  - 事前条件: `gitleaks` の実行ファイルが `GITLEAKS_BIN` か `PATH` にある
  - 事後条件: 報告はメモリの中だけで扱い、一時のファイルへ書かない（`--redact=100` が伏せるのは `Secret`・`Match` と行の一部だけで、履歴の報告の `File`・`Message`・`Author`・`Email`・`Fingerprint` は伏せられずに残るため、書き出すとパスやコミットのメッセージの中の秘密の語が一時のファイルに残る）。gitleaks の標準エラーはメモリで受けて捨て（設定の読み込みの誤りは設定の中身、つまり語を標準エラーへ出すため）、終了コードだけを見る（`--exit-code 0` なので、0 以外は道具の誤り）。報告の文字列と解いた値は、写した後に参照を残さない
  - 黙らせる仕組みを効かせない: 行の注釈 `gitleaks:allow` は `--ignore-gitleaks-allow` で無効にする。`.gitleaksignore` は gitleaks が `--gitleaks-ignore-path`（既定は cwd）と探す木の根の 2 か所から読むので、前者は空の一時のディレクトリを渡し、後者は `dir` では `<scanRoot>` の直下を空にし（`snapshotTracked`）、`git` では探す木を空の一時のディレクトリにして子の環境の `GIT_DIR` で作業の木の git のディレクトリ（`git rev-parse --absolute-git-dir`）を指す（`git log -p` は作業の木のファイルを要さない）。基準の報告（`--baseline-path`）は渡さない。外しは `applyAllow` の件数つきの外しだけになる
  - パスの正規化: `dir` の報告の `File` は `<scanRoot>/tree/` を頭に持つので、それを外し、区切りを `/` にそろえる。頭が一致しない `File` は道具の誤りとして止める（一時のパスを出さず、外しの照らしを当たり全件へ崩さないため）。`git` の報告の `File` はリポジトリの相対パスなので、区切りだけをそろえる
  - 副作用: 子のプロセス・一時のディレクトリ（終わりに消す）
- `mainLeakCheck`
  - 引数: `[--root <作業の木>] [--base <分岐点のコミット>]`。スクリプト `npm run leak-check`
  - 流れ: `snapshotTracked` で写した木を `dir` で探し、`applyAllow(…, "tree")` を掛ける。`--base` があれば、続けて `git` で `<分岐点>..<HEAD のコミット>` のコミットの差分を探し、`applyAllow(…, "history")` を掛ける（Pull Request の途中のコミットで足して消した値も、Pull Request の上の公開の履歴に残るため）。gitleaks に渡す `--log-opts` は範囲に加えて `--diff-merges=first-parent` を持つ（gitleaks は `--log-opts` を渡すと `git log -p -U0 <log-opts>` を打つだけで、`git log -p` は既定でマージコミットの差分を出さないため。第 1 親との差分なので、競合の解消でマージコミットに初めて入った値も足した行として出る）
  - 履歴の当たりと外し: 外しの `count` は今の木の当たりの件数で、履歴の報告はコミットごとに足した行の当たりを 1 件ずつ出すので、件数は履歴に掛けない（外したファイルを複数のコミットで触った Pull Request が件数の食い違いで落ちないため）。履歴では、外しの行のパスと規則の組に入る当たりを、その外しが今の木の照らしで件数の食い違いを出していないときだけ除く。食い違いがあれば、その組の履歴の当たりも残す。外しに無いパスか規則の履歴の当たりは `leak-history:` で落ちる。**代償**: 外したパスと規則の組に、途中のコミットで値を足して消すと、履歴では通る（今の木の件数は元に戻っているため）。この組は外しのあるファイルなのでレビューで見る（設計文書の「漏れの検査の外しの粒度」）
  - 副作用: 標準出力に当たりの行（今の木は `leak:<規則>`、履歴は `leak-history:<規則>` と、`<伏せたファイル>:<行>` をタブで区切る。履歴の行はコミットの短い SHA を頭に足す）と要約、標準エラーに誤り。ファイルのパスはどの行でも `maskPath` を通し、git と gitleaks の誤りの文言（パスを含みうる）はそのまま出さずに誤りの種類だけを出す

照らす形（データ `secret-shapes.json` の中身。正規表現はデータが持ち、ここでは何を当たりにするかだけを書く）。データは伏せ字（#2）と漏れの検査が同じに読む形の 1 か所で、伏せ字が伏せる値の形（私有鍵の頭・token の頭）もここに置く（設計文書の決定 3・9）。gitleaks の既定の規則は、データの形に足して、データに無い提供者の token も拾う重ねの網として残す。同じ値にデータの規則と既定の規則の両方が当たれば、規則ごとに 1 件ずつ出る:

| 種類 | 当たり | 当たりにしない |
| --- | --- | --- |
| `account-id` | 前後が英数字でない 12 桁の数 | 作り物の `123456789012` |
| `arn` | `arn:` とパーティション（`aws`・`aws-cn`・`aws-us-gov`）で始まり、アカウントの欄が 12 桁のもの。アカウントの欄が空の ARN は、資源の名前が英数字で始まるもの | 作り物の 12 桁のアカウントの欄・資源の名前が作り物の頭（`acme`）で始まる・置き場所の記号（`<…>`・`${…}`）の欄。どれも形の正規表現では除かず、`buildGitleaksConfig` が規則ごとの許可（`regexes`）に作り物の値・頭・置き場所の記号を入れて除く（否定の先読みは RE2 で書けないため） |
| `resource-id` | AWS の資源の ID の頭（`vpc-`・`subnet-`・`sg-`・`i-`・`vol-`・`snap-`・`ami-`・`igw-`・`rtb-`・`eni-`・`nat-`・`eipalloc-`・`lt-`）と 8 か 17 桁の 16 進 | データの作り物の ID の一覧 |
| `endpoint` | 資源ごとに名前の付く AWS の端点（`*.execute-api.<リージョン>.amazonaws.com`・`*.lambda-url.<リージョン>.on.aws`・`*.cloudfront.net`・`*.auth.<リージョン>.amazoncognito.com`・`*.rds.amazonaws.com`・`*.s3.amazonaws.com` の資源の部分） | 資源の部分が作り物の頭で始まる・置き場所の記号（同じく許可で除く） |
| `private-key` | 私有鍵の頭（`-----BEGIN … PRIVATE KEY-----`） | 値に作り物の印（`EXAMPLE`）を含む |
| `token` | nd-factory が扱う提供者の token の頭（GitHub の `ghp_`・`github_pat_` など・AWS のアクセスキーの `AKIA`・`ASIA`・Anthropic の `sk-ant-`・Slack の `xox`）。伏せ字が伏せる対象と同じ一覧 | 値に作り物の印を含む（データの作り物の印を、既定の規則にも全体の許可として掛ける） |
| `real:accounts`・`real:profiles`・`real:environments` | CI の秘密の語のどれか（本文とパス） | — |

`Shape.pattern` は RE2（gitleaks）と JavaScript の `RegExp`（伏せ字）の共通の部分だけで書く。使わないもの: 先読みと後読み（`(?=`・`(?!`・`(?<=`・`(?<!`。RE2 に無い）・後方参照（`\1`・`\k<…>`。RE2 に無い）・名前つきの組（RE2 の `(?P<…>)` と JavaScript の `(?<…>)` で書き方が違う）・行の中の旗（`(?i)` など。JavaScript の `RegExp` は読めない）・所有の量指定と原子の組。大文字と小文字を区別しない形は文字の組（`[Aa]`）で書く。照らす値の部分は名前の無い 1 つ目の組に置く。`nd-real-*` の大文字と小文字の区別なし（`(?i)`）は `buildGitleaksConfig` が語から組む正規表現にだけ付け、データの形には付けない。

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `SecretShapes` | 型 `{ value_shapes: Shape[]; infra_shapes: Shape[]; fake: { values: string[]; prefixes: string[]; markers: string[] }; key_names?: string[] }`。`Shape` は `{ id, kind, pattern }`（`pattern` は上の RE2 と JavaScript の共通の部分だけで書く。`loadSecretShapes` が照らす） | `packages/contracts/src/secret-shapes.ts` | `key_names` は #2 が足す |
| `LeakTerms` | 型 `{ accounts: string[]; profiles: string[]; environments: string[] }` | `tools/checks/src/leak-check.ts` | — |
| `GitleaksFinding` | 型 `{ rule: string; file: string; line: number; commit?: string }`（報告の `RuleID`・`File`・`StartLine`・`Commit` だけ） | 同上 | — |
| `LeakAllow` | 型 `{ path: string; rule: string; count: number; reason: string }`（値も値の要約値も持たない。`count` はそのパスのその規則の今の木の当たりの件数） | `tools/checks/data/leak-allow.json` | 空の配列 |
| `AllowFinding` | 型 `{ path: string; rule: string; expected: number; actual: number }`。件数が増えれば新しい値の混入、減れば外しの残り | `tools/checks/src/leak-check.ts` | — |
| 作り物の値 | データ | `packages/contracts/data/secret-shapes.json` の `fake` | `123456789012`・`us-west-2`・頭 `acme`・`example.com`・印 `EXAMPLE` |
| gitleaks の版と要約値 | 設定値 | `.github/workflows/ci.yml` のジョブ `leak-check` の環境変数 `GITLEAKS_VERSION`・`GITLEAKS_SHA256`（この 1 か所だけ） | 8.30.1 と、その `gitleaks_8.30.1_linux_x64.tar.gz` の sha256。値は版を上げる Pull Request を書く人が、資産を取って `sha256sum` で求め、配布のチェックサムのファイルの行と一致することを確かめてから書く。CI はチェックサムのファイルを取らない |
| 語を必須にする切り替え | 環境変数 `LEAK_CHECK_REQUIRE_TERMS` | `ci.yml` | 正本のリポジトリの中の実行だけ `1`（参照の検査と同じ式） |

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `loadLeakTerms` | 語の形の誤り | JSON でない・種類の欠け・空の語 | 読んだ直後 | 止める | 標準エラーに誤りの種類だけ（語を出さない）、終了コード 2 | 秘密を直して打ち直す |
| `mainLeakCheck` | 語が要る実行で語が無い | 秘密の未登録 | 切り替えの照らし | 止める | 終了コード 2 | 同上 |
| `mainLeakCheck` | 語が無い実行 | fork・秘密の未登録 | 同上 | 既定値で続ける（形だけを探す） | `skip:` の 1 行 | — |
| `loadSecretShapes` | データの形の誤り | データの書き誤り | 読んだ直後 | 止める | 終了コード 2 | 直して打ち直す |
| `runGitleaks` | gitleaks が無い・起きない・0 以外で終わる・報告を読めない | 未導入・設定の正規表現の誤り・道具の不具合 | 起動と終了コードと報告の読み込み | 止める | 標準エラーに誤りの種類だけ（gitleaks の出力は出さない）、終了コード 2 | 導入するかデータを直して打ち直す |
| `snapshotTracked` | git が失敗する・ファイルを読めない | 作業の木でない・消えた・権限 | 子のプロセスの終了コード・読み込み | 止める | 標準エラーに `maskPath` を通したパスと誤りの種類（`ENOENT` などの符号）だけ、終了コード 2 | 打ち直せる |
| `mainLeakCheck` | 当たりがある | 実際の値か秘密の形の混入 | 探した後 | 呼び出し元へ返す | 当たりの行と件数、終了コード 1 | CI で当たった値は、Pull Request の push で既に公開されている。今の木の当たりも履歴の当たりも次の順で扱う（検査の外の作業）。(1) 秘密の値なら、先に値を無効にする（鍵の回転・token と資格情報の失効）。push した値は、枝を作り直しても GitHub の上にコミットの SHA で残り、公開から消えないため、無効にすることだけが値を守る。回転できない値（アカウント ID・資源の ID・端点・profile と環境の名前）は公開されたものとして扱い、持ち主へ知らせ、要るなら GitHub の支援へ残ったコミットの表示の削除を頼む。(2) 混入を消す。履歴の当たりは、Pull Request の枝を作り直して値を含むコミットを外す。(3) 作り物の値なら、作り物の一覧へ足すか外しに理由を書く |
| `mainLeakCheck` | 外しの件数が合わない | 外したファイルへの同じ規則の値の追加・当たりを直したのに外しが残る | 探した後 | 呼び出し元へ返す | `allow:` の行に伏せたパス・規則・外しの件数と実際の件数、終了コード 1 | 値を消すか、正当なら外しの件数を直す（レビューで見る） |

### ログと記録の出力

| 関数 | 出すもの | レベルまたは書き先 | 出さないもの |
| --- | --- | --- | --- |
| `mainLeakCheck` | 当たりの規則・伏せたファイル・行（履歴はコミットの短い SHA）と件数、外しの件数の食い違い、照合を飛ばした旨 | 標準出力 | 当たった文字・当たった行の中身・語・語の数・パスの中の当たった部分・組んだ設定・コミットのメッセージ・作者の名前とメール・`Fingerprint` |
| `mainLeakCheck`・`runGitleaks`・`snapshotTracked` | 誤りの種類と伏せたパス | 標準エラー | gitleaks と子のプロセスの出力と誤りの文言そのもの・パスの中の当たった部分 |
| `runGitleaks` | 何も書かない | — | gitleaks の報告（標準出力からメモリへ受けるだけで、一時のファイル・CI の成果物・ログのどれにも書かない） |

gitleaks の報告は、`--redact=100` を掛けても `File`・`Message`・`Author`・`Email`・`Fingerprint`（コミット・ファイル・規則・行をつないだ文字列）を伏せない（gitleaks v8.30.1 の `report/finding.go` の `Redact` が触るのは `Line`・`Match`・`Secret` だけ）。そのため伏せは包みの出力の側で行い、出力に出す欄は規則・`maskPath` を通したファイル・行・コミットの短い SHA の 4 つに限る。

### 既存の部品の再利用

| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| 黙らせる仕組みの止め方 | gitleaks 8.30.1 の `cmd/root.go` の `Detector`（`--ignore-gitleaks-allow` で行の注釈を無効にする。`.gitleaksignore` は `--gitleaks-ignore-path`（既定 `.`）のファイルかその中の `.gitleaksignore` と、探す木の根の `.gitleaksignore` の 3 つを読み、根の分を止める旗は無い）と `initConfig`（設定は `--config`・`GITLEAKS_CONFIG`・`GITLEAKS_CONFIG_TOML`・木の根の `.gitleaks.toml` の順）と `report/finding.go`（`Redact` は `Line`・`Match`・`Secret` だけを触る） | v8.30.1 の源を読んだ（2026-11-21） | 旗で注釈を止め、`.gitleaksignore` は探す木と cwd の置き方で読ませない（`runGitleaks`） |
| 本文とパスの探し方 | gitleaks 8.30.1 の `dir`・`git`・`--redact`・`GITLEAKS_CONFIG_TOML`・規則ごとの許可 | 配布の実行ファイルをチェックサムで確かめて取り、作り物でない 12 桁と語を含む一時の木を、環境変数で渡した設定（既定の規則に 2 つの規則を足し、`123456789012` を許可）で探した。終了コード 1、報告の `Secret` と `Match` は `REDACTED`、`123456789012` の行は当たらず、報告に値が現れなかった（2026-11-21） | 使う |
| `loadLeakTerms` | 参照の検査の `loadMatchTerms` | `tools/ref-check/src/ref-check.ts` を読んだ | 語の読み方は同じ形に揃え、関数は共有しない（参照の検査の語の種類と混ぜない、設計の決定 4） |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `buildGitleaksConfig` | 形ごとと語の種類ごとに規則が 1 つずつでき、既定の規則を残す | 語が `null` で `nd-real-*` を作らない。正規表現の記号を含む語が文字どおりに当たる | — |
| `loadSecretShapes` | 今のデータの形がすべて `new RegExp(pattern, "u")` で作れ、形ごとの見本（テストの中で組む）に当たる | 作り物の値・頭・印の見本は JavaScript の正規表現でも当たる（伏せ字が同じ形で伏せる） | 先読み（`(?!`）・後読み・後方参照・名前つきの組（`(?P<`・`(?<`）・行の中の旗（`(?i)`）を含む形と、組を持たない形で、それぞれ形の誤り |
| `applyAllow` | `tree` で、外しの行のパスと規則の件数が同じなら当たらない。`history` で、外しの行のパスと規則の組の当たりが、コミットの数に関わらず当たらない | 外しの無いパスはそのまま当たる。パスは正規化した相対パスで比べる（`./` や一時のディレクトリの頭を持つ入力を渡さない。`runGitleaks` の側で正規化する） | `tree` で、同じファイルに同じ規則の値を 1 つ足すと当たりと件数の食い違いが出る。当たりを消して外しが残ると件数の食い違いが出る。`tree` で件数の食い違いを出した外しは、`history` の同じ組の当たりを除かない。`nd-real-*` は `tree` と `history` のどちらでも、外しの行のファイルで当たる |
| `maskPath` | 当たりの無いパスはそのまま | 語と形の両方を含むパスで両方を伏せる | — |
| `runGitleaks`（`GITLEAKS_BIN` に偽の実行ファイルを渡す単体のテスト） | 引数に `--ignore-gitleaks-allow`・`--gitleaks-ignore-path <空のディレクトリ>`・`--report-path -`・`--redact=100` があり、`git` では `--log-opts` に範囲と `--diff-merges=first-parent` がある。子の環境に `GITLEAKS_CONFIG` が無い。偽の実行ファイルが標準出力へ出した報告から 4 つの欄だけが写る | `dir` の `File` の頭 `<scanRoot>/tree/` を外して相対パスにする。`git` の `File` はそのまま | 頭の合わない `File`・JSON でない報告・0 以外の終了コードで止まり、標準エラーに一時のパスも報告の中身も出ない。一時のディレクトリにファイルが残らない |
| `mainLeakCheck`（`leak-check.integration.test.ts`。実物の gitleaks を起こす結合のテスト） | 種類ごとに当たり（違反の文字列は実行の時に組み立てる）、終了コード 1。無ければ 0 | 作り物の値・置き場所の記号・13 桁の数・16 進の中の 12 桁で当たらない。`docs/` の下のファイルで当たる。追跡していないファイルの値には当たらない。`--base` を渡すと、途中のコミットで足して消した値が `leak-history:` で当たる。マージコミット（競合を解くときに値を足す）で足し、後のコミットで消した値も `leak-history:` で当たる（`--diff-merges` を外すと落ちる）。外したファイルを 2 つのコミットで触った Pull Request で、外した値が `leak-history:` で落ちない | 語の形の誤り・必須なのに無い・gitleaks が無いで 2。実際の値をパスに含み本文にも当たりのあるファイルで、標準出力と標準エラーのどちらにも語と当たった文字が現れない。コミットのメッセージに語を含む履歴で、出力にも一時のディレクトリにも語が現れない |
| 黙らせる仕組み（同じ結合のテスト。`dir` と `--base` の `git` の両方で確かめる） | 値の行に `gitleaks:allow` の注釈を付けても当たる。その値の指紋を書いた `.gitleaksignore` を、追跡している木の根（`--root` の作業の木の根）と起動したディレクトリのそれぞれに置いても当たる。追跡している `.gitleaks.toml` に許可を書いても当たる | 件数つきの外しの行は、注釈や `.gitleaksignore` があっても件数どおりに効き、件数が違えば食い違いが出る | `nd-real-*` の当たりは、注釈・`.gitleaksignore`・外しのどれがあっても当たる |

テストの走る場所: `leak-check.test.ts` は gitleaks を起こさず、`npm run check` の `npm run test`（今の `check` ジョブ）で走る。`leak-check.integration.test.ts` は実物の gitleaks が要るので、根の `vitest.config.ts` の `tools` の組から `*.integration.test.ts` を外し、`vitest.integration.config.ts` だけが読む。ジョブ `leak-check` が gitleaks を置いた後に `npm run test:integration` を打ち、続けて `npm run leak-check` を打つ。手元では gitleaks 8.30.1 を `PATH` に置くか `GITLEAKS_BIN` で指して `npm run test:integration` を打つ（無ければ `runGitleaks` が終了コード 2 の誤りにするので、テストは gitleaks が無いと失敗し、黙って飛ばさない）。

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

`OperationView` と `GeneratedView` は、#2 の操作の表と生成物の書き出しから、この検査が読む項目（名前・エンティティ・読むか書くか・人だけか・人だけの操作の対になる読み出しの名前（`paired_read`）・HTTP の経路・機能・見本・要素と結果の形、生成した JSON Schema・OpenAPI・MCP の道具の一覧・HTTP の経路の登録）だけを写した型である。書き出しの名前は #2 の詳細設計が決め、実装の最初のタスクで写す（設計文書の K2-3）。

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
| `screenOperationNames` | `tools/checks/src/operation-coverage.ts` | 新設 | `(files: { path: string; text: string }[], clientModule: string) => ScreenCalls` | 画面のコード（`apps/web/src` のテストでない `*.ts` と `*.tsx`。`*.tsx` は TSX として読む）を TypeScript の構文木で読み、実際の呼び出しの式だけから操作の名前を集める（#2 へ渡す K2-2 の形）。import は呼び出し先を見分けるためだけに使い、import しただけで呼ばない名前は数えない。数える呼び出しは、(a) 生成した呼び出しの書き出しから import した操作の関数（別名の `as` は元の名前へ戻す）を呼ぶ式と、名前空間の import（`import * as api`）の性質を呼ぶ式 `api.<操作の関数>(…)`、(b) 同じ書き出しから import した汎用の呼び出しの関数の、第 1 引数が文字列の定数の呼び出し。(b) の第 1 引数が文字列の定数でない呼び出しは名前に入れず、場所つきの診断にする |
| `ScreenCalls` | 同上 | 新設（型） | `{ names: Set<string>; diagnostics: ScreenDiagnostic[] }`。`ScreenDiagnostic` は `{ path: string; line: number; kind: "non-constant-operation-name" }` | 名前と、名前を読めなかった呼び出しの場所を分けて返す。`findCoverageFindings` は `names` だけを読み、診断は 1 件ごとに `screen-unknown` の欠けとしてファイルと行つきで出す |
| `loadScreenPending` | 同上 | 新設 | `(path: string) => ScreenPending[]` | 画面の控え `tools/checks/data/screen-pending.json` を読み、形を照らして返す。`ScreenPending` は `{ operation: string; issue: string; reason: string }` |
| `findCoverageFindings` | 同上 | 新設 | `(input: CoverageInput) => CoverageFinding[]` | 下の 8 つの欠けと余りを返す。`CoverageInput` は操作の表・MCP の道具の一覧・HTTP の経路の登録・画面の呼び出し（`ScreenCalls`）・画面の控え |
| `readGatewayRoutes` | `tools/checks/src/deployed-routes.ts` | 新設 | `(cdkOut: string) => GatewayRoutes` | 合成の出力（`cdk.out`。入れ子のステージの組み立て `assembly-*` を含む）のすべての雛形（`*.template.json`）を JSON として読み、`AWS::ApiGatewayV2::Route` の `RouteKey` を集める。経路を表に出さずに登録する資源（`AWS::ApiGatewayV2::Api` の `Body`・`BodyS3Location`（OpenAPI の取り込み）・`Target`（quick create。`AWS::ApiGatewayV2::Route` の資源なしに経路を作り、`RouteKey` を省くと `$default` になる）・`AWS::ApiGateway::*`（REST の API）・`$default` の経路・`{proxy+}` を含む経路）は、経路の代わりに `unsupported` として場所つきで返す。`GatewayRoutes` は `{ routes: { routeKey: string; template: string; logicalId: string }[]; unsupported: { template: string; logicalId: string; kind: string }[] }` |
| `findGatewayRouteFindings` | 同上 | 新設 | `(gateway: GatewayRoutes, operations: OperationView[]) => CoverageFinding[]` | `gateway-route-unknown`（雛形の経路のうち、操作の表の経路（利用者向けと機械向けの両方）に無いもの）・`gateway-route-missing`（操作の表の経路のうち、雛形に無いもの）・`gateway-route-unsupported`（`unsupported` の 1 件ごと）を返す |
| `mainRouteCheck` | 同上 | 新設 | `(argv: string[]) => Promise<number>` | 引数 `--cdk-out <合成の出力>`。スクリプト `npm run route-check`。操作の表の書き出しが無ければ `skip: no-operation-table` の 1 行を出して 0。あれば上の 2 つをつなぎ、欠けがあれば行を出して 1 |

| 欠けと余りの種類 | 当たり |
| --- | --- |
| `screen-missing` | 利用者向けの操作のうち、画面のどこからも呼ばれず、画面の控えにも無いもの |
| `screen-pending-stale` | 画面の控えの操作のうち、画面から呼ばれるようになったもの（直したのに残った控え） |
| `screen-pending-unknown` | 画面の控えの操作のうち、操作の表の利用者向けの操作に無いもの |
| `screen-unknown` | 画面が呼ぶのに操作の表に無い名前と、`ScreenCalls.diagnostics` の 1 件ごと（名前を定数で読めない呼び出し。ファイルと行を出す） |
| `mcp-mismatch` | MCP の道具の一覧の名前の集まりと、人だけでない操作の集まりの差（両方の向き） |
| `human-only-without-read` | 人だけの操作のうち、対になる読み出し（`paired_read`。API と MCP の文書の操作の一覧の「依頼と材料の読み出しだけ（`<操作の名前>`）」の名前）が、無い・操作の表に無い・読む操作でない・人だけの操作である・MCP の道具の一覧に無い、のどれかに当たるもの |
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

`HTTP の経路の登録` は 3 か所で照らす。文字列の lint（規則の組 `routes.generated`）は手書きの経路の文字列を落とすが、CDK の別の登録の方法（`HttpRoute` の構成要素・`CfnRoute`・OpenAPI の取り込みなど）や、文字列を組み立てる書き方までは生成物に限定できないので、実際に使う経路を次の 2 つで操作の表と照らす。

| 照らす場所 | 読むもの | 何を落とすか | 走るジョブ |
| --- | --- | --- | --- |
| 生成した登録（`findCoverageFindings` の `route-unknown`） | #2 の生成した経路の登録の書き出し | 登録の中の、操作の表に無い経路 | `check`（単体テスト） |
| API Gateway の合成の結果（`mainRouteCheck`） | `npm run synth` の出力 `infra/cdk.out` の雛形の `AWS::ApiGatewayV2::Route` | 雛形の経路と操作の表の経路の差（両方の向き）と、経路を表に出さない登録の方法 | `synth`（合成の後の手順。`npm run route-check -- --cdk-out infra/cdk.out`） |
| Lambda の振り分け（`apps/api/test/dispatch-routes.test.ts`） | `apps/api` が書き出す、振り分けの入口が `routeKey` を引く登録（#2 の K2-8。入口が実際に引く表そのもの）のキーの集まりと、入口に表に無い `routeKey` の API Gateway の事象を渡した結果 | 登録のキーと操作の表の経路の差（両方の向き。登録にあって表に無い経路・表にあって登録に無い経路）・表に無い経路の事象を `route_unknown` の応答以外で返す | `check`（`apps/api` の単体テスト） |

振り分けの照らしは、`tools` が `apps/` を import できない（依存の向き）ので、`apps/api` 自身のテストに置く。表の外の `routeKey` を 1 つ渡すだけでは、別の表の外の経路を受ける分岐を足しても見つからないので、経路の照らしは入口が実際に引く登録のキーの集まりと操作の表を比べて行い、表の外の事象は拒むときの応答（`route_unknown`）の形を確かめるためだけに使う。登録の外の経路を受ける分岐を入口に置かないことは K2-8 の約束で、登録を通らない分岐はこのテストでは見えないのでレビューで見る。振り分けの入口か操作の表の書き出しが無い間は、テストの名前に「相手が無い」と出して通る。合成の照らしも、操作の表の書き出しが無い間は `skip: no-operation-table` で通る。今の `infra/lib/app-stack.ts` の `PUT /v1/users` は、操作の表が入った時点で `gateway-route-unknown` になるので、操作の表を置く #2 の Pull Request が API Gateway の定義を生成した登録へ移す（控えの `routes.generated` の行と同じ Pull Request）。

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| テスト | 操作の表か生成物の書き出しが無い | #2 がまだ置いていない | 動的な import | 既定値で続ける（リポジトリへの適用を「相手が無い」として通し、作り物の表のテストだけを走らせる） | テストの名前に「相手が無い」 | — |
| `screenOperationNames` | 呼び出しの第 1 引数が文字列の定数でない | 名前を変数で渡した | 構文木 | 呼び出し元へ返す（`ScreenCalls.diagnostics` に場所を入れ、`findCoverageFindings` が `screen-unknown` として出す） | vitest の失敗にファイルと行 | 定数で書き直す |
| `readGatewayRoutes` | 合成の出力が無い・雛形が JSON でない | 合成の前に打った・合成の失敗 | 読み込み | 止める | 標準エラーに誤りの種類とパス、終了コード 2 | 合成してから打ち直す |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `screenOperationNames` | import した操作の関数の呼び出し・名前空間の import の性質の呼び出し・汎用の呼び出しの文字列の定数の 3 つを拾う | 別名の import（`as`）も元の名前で拾う。import しただけで呼ばない関数は拾わない（その操作は `screen-missing` のまま残り、控えにあれば `screen-pending-stale` にならない）。生成した書き出しの外から import した同じ名前の関数の呼び出しは拾わない。テストのファイルを読まない | 変数で渡した名前は `names` に入らず、`diagnostics` にファイルと行が 1 件入る |
| `findCoverageFindings` | 揃った作り物の表で 0 件 | 機械向けの経路を数えない。画面の無い操作を控えに置くと `screen-missing` にならない | 8 つの種類ごとに、1 行を足すか消した表で 1 件。`human-only-without-read` は、`paired_read` を消す・表に無い名前にする・書く操作を指す・人だけの操作を指す・MCP の道具の一覧から消す、のそれぞれで 1 件（同じエンティティに無関係な読む操作が MCP にあっても出る） |
| `readGatewayRoutes`・`findGatewayRouteFindings` | 作り物の雛形（テストの中で組む）の経路が操作の表と揃って 0 件 | 入れ子のステージの組み立ての雛形も読む | 表に無い `RouteKey` で `gateway-route-unknown`、表の経路を雛形から消して `gateway-route-missing`、`Body` を持つ `AWS::ApiGatewayV2::Api`・`Target` を持つ `AWS::ApiGatewayV2::Api`（`RouteKey` の有る無しの両方）・`$default`・`ANY /{proxy+}` でそれぞれ `gateway-route-unsupported`。操作の表と揃った `AWS::ApiGatewayV2::Route` の雛形に `Target` を持つ別の `AWS::ApiGatewayV2::Api` を足すと、`gateway-route-unsupported` が 1 件出て通らない |
| `dispatch-routes.test.ts`（`apps/api`） | 振り分けの登録のキーの集まりが操作の表の経路（利用者向けと機械向けの両方）と等しい。表のすべての経路の事象が `route_unknown` 以外で受けられる | 登録のキーは入口が引く登録の書き出しから読み、テストの中で表から組み直さない（組み直すと入口と食い違っても通る） | 登録にあって表に無いキー・表にあって登録に無い経路をそれぞれ 1 件ずつ出す（作り物の登録と表で確かめる）。表に無い経路の事象が `route_unknown` の応答（状態の番号と理由のコード）で返る |
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
| `schedule` | 判定しない | 既定の枝の先端（`schedule` の取得） |
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
| `.github/workflows/ci.yml` | ジョブ `synth` の「作り物の値で合成する」の後に、`npm run route-check -- --cdk-out infra/cdk.out`（API Gateway の合成の結果の経路の照らし）の手順を足す。ジョブ `leak-check` を足す。取得は履歴をすべて取り（`fetch-depth: 0`。分岐点からのコミットを探すため）、Node の用意と `npm ci` の後に、`GITLEAKS_VERSION` の版の配布の資産 `gitleaks_<版>_linux_x64.tar.gz` だけを取り、その `sha256sum` を環境変数 `GITLEAKS_SHA256` に固定した値と直接比べ（`echo "$GITLEAKS_SHA256  <資産>" \| sha256sum -c -`）、一致したときだけ展開して `PATH` へ置く。配布のチェックサムのファイルは取らない（同じ配布元から取った値と比べても、配布元を信じることにしかならず、固定にならないため）。続けて `npm run test:integration`（実物の gitleaks を起こす結合のテスト）を打ち、最後に `npm run leak-check` を打つ（Pull Request では `-- --base <分岐点>`）。gitleaks の版と要約値はこのジョブの環境変数 `GITLEAKS_VERSION`・`GITLEAKS_SHA256` の 1 か所にだけ書く。環境変数 `LEAK_CHECK_TERMS`（秘密）と `LEAK_CHECK_REQUIRE_TERMS`（`ref-check` と同じ式で変数 `LEAK_CHECK_REQUIRE_TERMS` から作る）を渡す |
| `.github/workflows/ndf-contract.yml`（新設） | `on` は `pull_request` と `schedule`（毎日 1 回）だけ（全体の設計の「いつ」。`push` と `workflow_dispatch` は置かない。設計文書の決定 6）。`permissions: contents: read`。ジョブ `ndf-contract` は Pull Request のとき、既定の取得（マージした結果のコミット）に加えて `base.sha` と `head.sha` を分岐点が求まる深さまで取り（`fetch-depth: 0`）、`npm run ndf-contract -- --base <base.sha> --head <head.sha> --summary "$GITHUB_STEP_SUMMARY"` を打つ。`schedule` では `--base` と `--head` を渡さない。動作の版はコミットの SHA で固定する（`ci.yml` と同じ） |
| `.ndf/project.json` | `ci.required_checks` に `leak-check`・`ndf-contract` を足す。`ci.workflows` に `ndf-contract.yml` の行を足す |
| `package.json` | スクリプト `leak-check`・`ndf-contract`・`route-check`・`test:integration`（`vitest run -c vitest.integration.config.ts`） |
| `vitest.config.ts` | `tools` の組に `exclude: ["tools/test/**/*.integration.test.ts"]` を足す。`npm run check` の `npm run test` は gitleaks を起こさないテストだけを走らせる |
| `vitest.integration.config.ts`（新設） | `tools/test/**/*.integration.test.ts` だけを読む。ジョブ `leak-check` と、gitleaks を入れた手元で打つ |
| `tools/package.json` | 依存 `@nd-factory/contracts`・`ajv`・`ajv-formats`・`yaml` |
| `tools/tsconfig.json` | `checks/src` を含める |
| `packages/contracts/package.json` | 書き出し `./secret-shapes` |
| `AGENTS.md` | 「秘密とインフラの値を置かない」に、実際の値の一覧は CI の秘密 `LEAK_CHECK_TERMS` から受ける行を足す |

### 関数の仕様（CI の定義のテスト）

ワークフローは `yaml`（設計の LIB12）で読み、行の正規表現で鍵を拾わない。`yaml` は YAML 1.2 で読むので、最上位の `on` は真偽値でなく鍵の名前として読める（今の `ci.yml` を読んで `on` の下の `push`・`pull_request`、`jobs` の下の 4 つ、`permissions` の `{"contents":"read"}` が取れることを確かめた。2026-11-21）。

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `loadWorkflows` | `tools/test/ci-definition.test.ts` | 新設 | `(root: string) => { path: string; text: string; doc: Workflow }[]` | `.github/workflows/` の `*.yml`・`*.yaml` を読み、`yaml` で解いた値と元の文字列の両方を返す。解けないファイルは失敗にする |
| `jobNames` | 同上 | 変更 | `(doc: Workflow) => string[]` | `jobs` の鍵の名前を返す（今は文字列を行で読んでいる） |
| `triggersPullRequest` | 同上 | 新設 | `(doc: Workflow) => boolean` | `on` が `pull_request` を持つか（文字列・配列・鍵の 3 つの書き方） |
| `permissionBlocks` | 同上 | 新設 | `(doc: Workflow) => { scope: string; value: unknown }[]` | 最上位の `permissions` と、各ジョブの `permissions` を、場所（`top` かジョブの名前）と値の組で返す。`write-all`・`read-all` の文字列の形もそのまま返す |
| `credentialWords` | 同上 | 変えない | `(yaml: string) => string[]` | 元の文字列で資格情報の語を探す（鍵でも値でも当たるように、解いた値でなく文字列を読む） |

テストが照らすこと: Pull Request で起動するワークフローのジョブの名前の和集合が必須のチェックの宣言と等しい・ジョブの名前がワークフローの間で重ならない・どのワークフローにも資格情報の語が無い・どのワークフローも最上位の `permissions` が `{ contents: read }` だけで、ジョブの `permissions` は持たないか `{ contents: read }` だけ（ジョブの上書きで権限を足させない）。

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `loadWorkflows`・`triggersPullRequest`・`jobNames` | 2 つのワークフローを読み、Pull Request で起動するものを選ぶ | `on: pull_request`・`on: [pull_request]`・`on:` の下の鍵の 3 つの書き方 | 解けない YAML のファイルで失敗する。片方のワークフローにだけ資格情報の語・`id-token: write` を足すと当たる |
| `permissionBlocks` と権限の照らし | 今の 2 つのワークフローで違反 0 件 | ジョブの `permissions: { contents: read }` は通る | ジョブの `permissions` に `pull-requests: write`（資格情報の語に当たらない種類）を足す・ジョブに `permissions: write-all` を書く・最上位に `issues: write` を足すと、それぞれ場所つきで当たる |
| 参照の検査のテスト | — | — | ワークフローの文字列に NDF の版を読む式と比べを同じ行に置くと当たる |
