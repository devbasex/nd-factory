# #136: NDF の固定の点を 11.0.36 へ上げ、契約の照合が 6 項目を必ず実行する

## 関連リンク

- 要求仕様: [issue-136-requirements.md](./issue-136-requirements.md)（正は [#136](https://github.com/devbasex/nd-factory/issues/136) の本文）。受け入れ条件は番号で指す
- 設計書: [issue-136-design.md](./issue-136-design.md)、詳細設計書: [issue-136-design-detail.md](./issue-136-design-detail.md)
- モード: `standard`。変更の種類は不具合で、課題は 1 つ、公開インタフェースは変わらない。触るファイルが 4 を超え、新しく作る関数もあるため、設計書と実装計画を省かない

## 修正対象

詳細設計書の「地図」の表から引き写した。関数ごとの仕様は詳細設計書の構成要素ごとの節にある。`docs/design/platform.md` は設計の結果の表にも載るが、設計の Pull Request で直し終えているため、ここには載せない。

| ファイル | 変える中身 |
| --- | --- |
| `ndf-pin.json` | 固定の点を `8d22be728e81983e5051799bcee4637ff65f0071`（`ndf--v11.0.36`）にする |
| `package.json` | スクリプト `ndf-contract:sync` を足す |
| `packages/contracts/package.json` | `exports` に `./ndf-contract-use-schema` と `./ndf-contract-use` を足す。`dependencies` に `mdast-util-from-markdown`・`mdast-util-gfm`・`micromark-extension-gfm` を足す |
| `packages/contracts/data/ndf-contracts.json` | 受ける組をバージョン 16・`c50ef840…` の 1 組にする |
| `packages/contracts/data/ndf-contract-use.json`（新設） | 手で書く使い方のデータ（使う 11 のインタフェースの id・`skillPrefix`・渡す環境変数・`envSetBy`・読む項目） |
| `packages/contracts/data/ndf-contract-use.generated.json`（新設） | 生成のコマンドが固定の点の契約から書く行と形。手で直さない |
| `packages/contracts/src/ndf-contract-use-schema.ts`（新設） | 型 `NdfContractUse`・`ReportReading` など、zod の形 `ndfContractUseData`・`ndfContractUseGenerated`、定数 `REPORT_ITEMS`。データの JSON を読まない |
| `packages/contracts/src/ndf-contract-use.ts`（新設） | `buildContractUse`・`judgeCallWith`・`filePathPattern`・`readReportWith`・`ndfContractUse` |
| `packages/contracts/test/data.test.ts` | 受ける組の期待値をバージョン 16 にする |
| `packages/contracts/test/ndf-contract-use.test.ts`（新設） | 判定・読み取り・網羅・データの組み立ての単体テスト |
| `packages/contracts/test/fixtures/ndf-contract-8d22be7/entrypoint-cases.json`（新設） | 固定の点のサンプル 26 件の写し（説明の文の列は写さない） |
| `packages/contracts/test/fixtures/ndf-contract-8d22be7/unattended-report.json`（新設） | 固定の点の区間の報告の `shape` と `cases` 16 件の写し |
| `tools/checks/src/ndf-contract-check.ts` | 照合の 1・4・5・6 項目目を広げ、skip の道と `CONTRACT_USE_REQUIRED` と型のコピーを消し、生成のコマンド（`generateContractUse`・`mainNdfContractSync`）を足す |
| `tools/test/ndf-contract-check.test.ts` | 偽物の使い方を新しい型にし、新しい照合と生成のテストを足す |
| `tools/test/fixtures/ndf-contract-752a9cf/`（削除） | 古い固定の点の写し |
| `tools/test/fixtures/ndf-contract-8d22be7/*.json`（新設） | 新しい固定の点の `entrypoints.json`・`env.json`・`ndf-files.json` の写し |
| `docs/design/execution.md` | 決定 104・「契約のバージョンの照合し」・「NDF 11 の名前」の行の値を新しい固定の点にする |
| `docs/specifications/contracts-and-core.md` | 受ける組の値をバージョン 16 にし、使い方の書き出しを足す |
| `docs/operations/pipeline-approval.md` | skip の行で承認してよいとする注記を消す |

## タスク分解

変更の種類が不具合なので、最初のタスクは再現のテスト（今は落ちる）から始める。

### Task 1: 固定の点と受ける組を 11.0.36 にする

- **対象ファイル:** `packages/contracts/test/data.test.ts`、`ndf-pin.json`、`packages/contracts/data/ndf-contracts.json`、`docs/design/execution.md`、`docs/specifications/contracts-and-core.md`
- **変更内容:** 詳細設計書の「固定の点と受ける組」の表の値に変える。execution.md は決定 104・「契約のバージョンの照合し」・「NDF 11 の名前」の行で、バージョン 8 と `ed8b0365…` を今の値として残さない。確定仕様は受ける組の値だけをここで直す
- **満たす受け入れ条件:** 136:1・136:2・136:3
- **進め方:** 受ける組の期待値をバージョン 16 にしたテストを先に書き、今は落ちることを確かめる → データと固定の点を直して通す → 文書の値をそろえる。受け入れ条件 1 は、`git ls-remote` か `gh api` でタグ `ndf--v11.0.36` の指すコミットと `ndf_ref` を比べて確かめる

### Task 2: 使い方の型と手で書くデータを置き、生成のコマンドで契約の行を作る

- **対象ファイル:** `packages/contracts/src/ndf-contract-use-schema.ts`、`packages/contracts/data/ndf-contract-use.json`、`packages/contracts/data/ndf-contract-use.generated.json`、`packages/contracts/package.json`（`./ndf-contract-use-schema` の `exports` だけ）、`package.json`、`tools/checks/src/ndf-contract-check.ts`（`SCHEMAS` の列・`generateContractUse`・`mainNdfContractSync`・`ContractUseSyncError`・起動の処理の `sync` の分岐・定数 `GENERATED_PATH`・`USE_DATA_PATH`）、`tools/test/ndf-contract-check.test.ts`、`tools/test/fixtures/ndf-contract-8d22be7/*.json`、`tools/test/fixtures/ndf-contract-752a9cf/`（削除）
- **変更内容:** 詳細設計書の「使い方のデータと型」の内部のデータと定数、「契約の照合と生成のコマンド」の `generateContractUse` と `mainNdfContractSync`。既存のテストの `pinnedContract` を新しい固定の点のフィクスチャに向け直す。照合の側の型のコピーと skip の道は、この時点では残す（Task 6 で消す）。最後に `npm run ndf-contract:sync` を打って生成のファイルをコミットする
- **満たす受け入れ条件:** 136:6（受け入れ条件 4 の前提になる生成のファイルを置く）
- **進め方:** 生成のテスト（フィクスチャの契約から作ると手で書く id の行・`path`・区間の報告の形を持ち、使わないインタフェースの行が入らない。契約に無い id で `ContractUseSyncError`。手で書く id と生成の行が食い違った作業ツリーでも起動して書き直す）を先に書く → 最小の実装 → 整理

### Task 3: 呼び出しの判定を作る

- **対象ファイル:** `packages/contracts/src/ndf-contract-use.ts`（`judgeCallWith`・`filePathPattern`）、`packages/contracts/test/ndf-contract-use.test.ts`、`packages/contracts/test/fixtures/ndf-contract-8d22be7/entrypoint-cases.json`
- **変更内容:** 詳細設計書の「呼び出しの判定」の処理の手順と `filePathPattern` の規則。`buildContractUse` と `ndfContractUse` はまだ作らず、`exports` にも足さない（Task 5 で足す）。テストは相対パスで関数を読む
- **満たす受け入れ条件:** 136:4（照合の 1 項目目が使う判定）
- **進め方:** 詳細設計書の単体テストの観点の表（使うインタフェースへのサンプル 21 件で `valid` と同じ・`resume` と `resume-loop`・`spec-io-args` と `spec-outside`・全体の一致・`terminal-env`・読めない正規表現）を先に書く → 最小の実装 → 整理

### Task 4: 区間の報告の読み取りを作る

- **対象ファイル:** `packages/contracts/src/ndf-contract-use.ts`（`readReportWith`）、`packages/contracts/package.json`（`dependencies` の 3 つ）、`packages/contracts/test/ndf-contract-use.test.ts`、`packages/contracts/test/fixtures/ndf-contract-8d22be7/unattended-report.json`
- **変更内容:** 詳細設計書の「区間の報告の読み取り」の処理の手順（設計書の決定 7 の規則 1〜6）。見出しと節は GFM の構文木で決める
- **満たす受け入れ条件:** 136:8
- **進め方:** 詳細設計書の単体テストの観点の表（`cases` 16 件・後勝ち・見出しの扱い・`無し` の扱い・誤りの一覧に値を入れない）を先に書く → 最小の実装 → 整理

### Task 5: 使い方の書き出しを組み立てる

- **対象ファイル:** `packages/contracts/src/ndf-contract-use.ts`（`buildContractUse`・`ndfContractUse`）、`packages/contracts/test/ndf-contract-use.test.ts`
- **変更内容:** 詳細設計書の「使い方のデータと型」の `buildContractUse` と異常系の表。`acceptedVersions` は `NDF_CONTRACTS.accepted` を引き、コピーしない。`exports` の `./ndf-contract-use` は、照合が新しい形を読めるようになる Task 6 と同じ単位で足す（先に足すと、今の照合が新しい形を読めずに終了コード 2 で落ちるため）
- **満たす受け入れ条件:** 136:4
- **進め方:** 網羅のテスト（id の集合が 11 の id のリストと等しい）と、形の誤り・id の不一致・`files` と `env` の id の誤りで `DataFileError` を投げるテストを先に書く → 最小の実装 → 整理

### Task 6: 照合が書き出しを必ず読み、6 項目を照合する

- **対象ファイル:** `packages/contracts/package.json`（`./ndf-contract-use` の `exports`）、`tools/checks/src/ndf-contract-check.ts`（`compareContract`・`checkCases`・`checkFiles`・`checkReport`・`checkEntrypoints`・`isContractUse`・`MainOptions`・`mainNdfContractCheck`）、`tools/test/ndf-contract-check.test.ts`、`docs/specifications/contracts-and-core.md`、`docs/operations/pipeline-approval.md`
- **変更内容:** 詳細設計書の「契約の照合と生成のコマンド」の変更の関数と異常系の表。`CONTRACT_USE_REQUIRED`、照合の側の型 `NdfContractUse`・`ReportRequiredRule` のコピー、skip の道を消す。出力の行の形と `ask-journal` の通知は変えない。確定仕様に使い方の書き出しを足し、承認の手順から skip の注記を消す
- **満たす受け入れ条件:** 136:4・136:5・136:6
- **進め方:** 設計書のテスト設計の表の照合の行（書き出しが無く取得できない `repoUrl` でも終了コード 1 で `read:` を出さない・`no-such-entrypoint` のサンプルで 1 項目目の行・`target`・`path`・`required`・`commit` だけを変えた契約で 6・4・5・6 項目目・`ask-journal` の通知）を先に書く → 実装 → 整理。最後に手元で `npm run ndf-contract` を打ち、`checked: fixed 8d22be7… 1-6` が出て `skip:` が無く、終了コード 0 になることを確かめる

## レビューの単位

課題全体の見込みは約 2,500 行で 1,000 行を超えるため、タスクの依存の向きで 4 つに分けた。単位 2 と 3 は互いに依存せず、どちらも単位 1 の型と生成のファイルの上に積む。単位 4 は 2 と 3 の両方を使う。どの単位も単独で `npm run check` が通り、照合は単位 4 まで今の skip のまま動く。

行数は追加と削除の和で、`git diff --shortstat <ベース>...HEAD -- . ':(exclude)package-lock.json' ':(exclude)packages/contracts/data/ndf-contract-use.generated.json'` で数える（ロックファイルと生成のファイルは数えない）。

| 単位 | 含むタスク | 満たす受け入れ条件 | 見込みの差分の行数 | 実際の行数 |
| --- | --- | --- | --- | --- |
| 固定の点と生成のコマンド | Task 1・2 | 136:1・136:2・136:3・136:6・136:7 | 約 850 | 2,024（うち固定の点の写しのフィクスチャが 1,474。フィクスチャを除くと 550） |
| 呼び出しの判定 | Task 3 | 136:6 | 約 500 | 224 |
| 区間の報告の読み取り | Task 4 | 136:6・136:8 | 約 500 | 304（依存の規則の例外とそのテストを含む） |
| 書き出しと 6 項目の照合 | Task 5・6 | 136:4・136:5・136:6 | 約 700 | 716 |

受け入れ条件 7（execution.md の「区間と結果の行」と「承認資料」の記述）は、設計の Pull Request で書き終えている。execution.md を触る単位 1 の完了判定で、記述が残っていることを確かめる。

## リファクタリングの時機

| 時機 | 対象 | 理由 |
| --- | --- | --- |
| 実装の前（準備のリファクタリング） | しない | 2 つ以上のタスクが触るファイルは `tools/checks/src/ndf-contract-check.ts`（742 行。6 タスクのうち Task 2・6 の 2 つ）と `tools/test/ndf-contract-check.test.ts`（948 行。同じく 2 つ）と `packages/contracts/src/ndf-contract-use.ts`（新設。Task 3〜5 の 3 つ）である。照合のファイルを覆うテストは約 80 件ある。新設のファイルは関数ごとに足すだけで、既存の構造の上に積まない |
| 実装の中 | 各タスクで行う | `tdd-cycle` のリファクタリングのステップ |
| スプリントの終わり（cross-refactoring） | (1) `tools/checks/src/ndf-contract-check.ts` に同居する照合と生成のコマンド。(2) 同じ固定の点の写しが `packages/contracts/test/fixtures/ndf-contract-8d22be7/` と `tools/test/fixtures/ndf-contract-8d22be7/` の 2 か所にあること | (1) は単位 1 と 4 が同じファイルを触り、取得の処理（`fetchContract`）と `SCHEMAS` を共有する。生成のコマンドを別のモジュールへ分けるかの候補になる。(2) は単位 1〜3 が別々に写しを置くため、まとめられるかの候補になる |

## リスクと対処

| リスク | 対処 |
| --- | --- |
| CI の照合が `8d22be7` を深さ 1 で取得できない（設計書の「未確認のまま残ること」） | 単位 1 の Pull Request で CI の `ndf-contract` の結果を見て確かめる。取得できなければ、単位 1 を止めて判断を仰ぐ |
| 単位 4 より前に `./ndf-contract-use` を `exports` に足すと、今の照合が新しい形を読めず終了コード 2 で落ちる | `./ndf-contract-use` の `exports` は Task 6 と同じ単位で足す。単位 2・3 のテストは相対パスで関数を読む |
| フィクスチャに説明の文を写すと、参照の検査が探す語を持ち込む | フィクスチャと生成のファイルには、詳細設計書が挙げた列だけを写す。`summary`・`source` などの説明の文の列と、`shape.values` の説明の文は写さない |
| 手で書くデータを直した後に生成のコマンドを打ち忘れる | `buildContractUse` が読み込みのときに食い違いを例外にし、`npm run check` が落とす。照合の 6 項目目も生成の固定の点を `ndf-pin.json` と比べる |
| Markdown の解析器の 3 つの依存が `node:` の組み込みを読む | 足す前に、それぞれの入口が `node:` を読まないことを確かめる。読むなら判断を仰ぐ（スキーマの正本の決まり） |

## 切り戻し手順

- データの移行は無い。単位ごとの Pull Request を新しい順に戻せば、前の状態に戻る
- 単位 1 だけを戻すと、固定の点は `752a9cf`、受ける組はバージョン 8 に戻り、生成のファイルと手で書くデータが消える。単位 2〜4 を残したまま単位 1 だけを戻すことはできない（単位 2〜4 が単位 1 の型と生成のファイルを使う）

## 完了の定義

- [ ] 受け入れ条件 136:1〜136:8 をすべて満たし、条件ごとに設計書の「テスト設計」の表の手段と結果が対応している
- [ ] `npm run check` が通る（単位ごと）
- [ ] 手元と CI の `npm run ndf-contract` が `checked: fixed 8d22be728e81983e5051799bcee4637ff65f0071 1-6` を出し、`skip:` の行が無く、終了コード 0 で終わる（単位 4）
- [ ] 「レビューの単位」の実際の行数を書き足した
