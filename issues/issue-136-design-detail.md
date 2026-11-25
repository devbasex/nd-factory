# #136 の詳細設計: NDF の固定の点を 11.0.36 へ上げ、契約の照合が 6 項目を必ず実行する

設計書 [issue-136-design.md](./issue-136-design.md) の構成要素を、ファイルと関数の粒度に分けて書いた文書である。新しく作る関数は 2 つ以上あり、既存の関数のシグネチャも変える（`compareContract`・`MainOptions`）。このため、設計書には畳まずに別ファイルにした。

構成要素は次の 5 つで、この文書はこの順に書く。

| 構成要素 | 設計書での位置 |
| --- | --- |
| 固定の点と受ける組 | 決定 1 |
| 使い方のデータと型 | 決定 2・3・4・5 |
| 呼び出しの判定 | 決定 4・5 |
| 区間の報告の読み取り | 決定 7 |
| 契約の照合と生成のコマンド | 決定 5・6、「#47 と上流の不足 3 件は食い違いにならない」 |

## 地図

パッケージとモジュールの構成（触るファイルだけを載せる。`*` は新しく作るファイル）:

```text
ndf-pin.json
package.json
packages/contracts/
  package.json
  data/
    ndf-contracts.json
    ndf-contract-use.json              *
    ndf-contract-use.generated.json    *
  src/
    ndf-contract-use.ts                *
  test/
    data.test.ts
    ndf-contract-use.test.ts           *
    fixtures/ndf-contract-8d22be7/
      entrypoint-cases.json            *
      unattended-report.json           *
tools/
  checks/src/ndf-contract-check.ts
  test/
    ndf-contract-check.test.ts
    fixtures/ndf-contract-752a9cf/     （消す）
    fixtures/ndf-contract-8d22be7/     *
      entrypoints.json
      env.json
      ndf-files.json
docs/design/execution.md
docs/specifications/contracts-and-core.md
docs/operations/pipeline-approval.md
```

依存の向きは一方向で、循環は無い。

- `packages/contracts/src/ndf-contract-use.ts` が読むのは、同じパッケージの `data.ts`（`NDF_CONTRACTS`・`DataFileError`）と、2 つの JSON と、zod だけである。`node:` の組み込みは読まない
- `tools/checks/src/ndf-contract-check.ts` は、`@nd-factory/contracts/ndf-contract-use` から型と zod の形を読み込む。書き出しの実体は、今までどおり `--root` の作業ツリーから実行時に解決する
- スキーマの正本の側から `tools` は読まない

| パス | 種類 | 役割 | 依存する先 | モジュール | 最上位の関数と値（新設 / 変更） |
| --- | --- | --- | --- | --- | --- |
| `ndf-pin.json` | 変更 | 固定の点を `8d22be728e81983e5051799bcee4637ff65f0071` にする | — | — | — |
| `packages/contracts/data/ndf-contracts.json` | 変更 | 受ける組をバージョン 16・`c50ef840…` の 1 組にする | — | — | — |
| `packages/contracts/data/ndf-contract-use.json` | 新設 | 手で書く使い方のデータ | — | — | — |
| `packages/contracts/data/ndf-contract-use.generated.json` | 新設 | 固定の点の契約から生成した行と形 | — | — | — |
| `packages/contracts/src/ndf-contract-use.ts` | 新設 | 使い方の型・データの読み込み・呼び出しの判定・区間の報告の読み取りを持ち、`ndfContractUse` を書き出す | `./data.ts`・zod・上の 2 つの JSON | `ndf-contract-use` | `ndfContractUseData`・`ndfContractUseGenerated`（zod の形）、`buildContractUse`・`judgeCallWith`・`filePathPattern`・`readReportWith`・`ndfContractUse`（新設） |
| `packages/contracts/package.json` | 変更 | `exports` に `"./ndf-contract-use": "./src/ndf-contract-use.ts"` を足す | — | — | — |
| `package.json` | 変更 | `"ndf-contract:sync": "node tools/checks/src/ndf-contract-check.ts sync"` を足す | — | — | — |
| `packages/contracts/test/ndf-contract-use.test.ts` | 新設 | 判定・読み取り・網羅・データの組み立ての単体テスト | `../src/ndf-contract-use.ts`・フィクスチャ | — | — |
| `packages/contracts/test/fixtures/ndf-contract-8d22be7/entrypoint-cases.json` | 新設 | 固定の点のサンプル 26 件の写し（`id`・`entrypoint`・`call`・`env`・`valid` の列だけ） | — | — | — |
| `packages/contracts/test/fixtures/ndf-contract-8d22be7/unattended-report.json` | 新設 | 固定の点の区間の報告の `shape` と `cases` 16 件の写し | — | — | — |
| `packages/contracts/test/data.test.ts` | 変更 | 受ける組の期待値をバージョン 16 にする | — | — | — |
| `tools/checks/src/ndf-contract-check.ts` | 変更 | 照合の 1・4・5・6 項目目を広げ、skip の道を消し、生成のコマンドを足す | `@nd-factory/contracts/ndf-contract-use`（型と zod の形）・zod・`node:` | `ndf-contract-check` | `compareContract`・`checkCases`・`checkFiles`・`checkReport`・`checkEntrypoints`・`isContractUse`・`mainNdfContractCheck`（変更）、`generateContractUse`・`mainNdfContractSync`（新設）。`CONTRACT_USE_REQUIRED` と型 `NdfContractUse`・`ReportRequiredRule` のコピーは消す |
| `tools/test/ndf-contract-check.test.ts` | 変更 | 偽の使い方を新しい型にし、新しい照合と生成のテストを足す | 照合のモジュール・フィクスチャ | — | — |
| `tools/test/fixtures/ndf-contract-752a9cf/` | 削除 | 古い固定の点の写し | — | — | — |
| `tools/test/fixtures/ndf-contract-8d22be7/*.json` | 新設 | 新しい固定の点の `entrypoints.json`（15 行の `id`・`kind`・`target`・`lead`・`args`・`env`・`files`）・`env.json`（`id`・`set_by`）・`ndf-files.json`（`id`・`path`・`reader`・`fields`）の写し | — | — | — |
| `docs/design/execution.md` | 変更 | 決定 104 と「契約のバージョンの照合し」の行の値を新しい固定の点にする | — | — | — |
| `docs/specifications/contracts-and-core.md` | 変更 | 受ける組の値をバージョン 16 にし、使い方の書き出しを足す | — | — | — |
| `docs/operations/pipeline-approval.md` | 変更 | skip の行で承認してよいとする注記を消す | — | — | — |

フィクスチャには、説明の文の列（`summary`・`source` など）を写さない。参照の検査が探す語を持ち込まないためである。

## 固定の点と受ける組

満たす決定: 決定 1、受け入れ条件 1・2・3

関数は変えない。値だけを変える。

| ファイル | 今の値 | 変えた後の値 |
| --- | --- | --- |
| `ndf-pin.json` の `ndf_ref` | `752a9cf48a6d36c00ffb3197c8668d1c898c32e2` | `8d22be728e81983e5051799bcee4637ff65f0071` |
| `packages/contracts/data/ndf-contracts.json` の `accepted` | バージョン 8・`ed8b0365…` | バージョン 16・`c50ef840a72ab71a15023a46a37d050c36ec3aae6d1be6092b7f9dc7f3c0a726` の 1 組 |
| `packages/contracts/test/data.test.ts` の `NDF_CONTRACTS` の期待値 | 同上の今の値 | 同上の後の値 |
| `docs/design/execution.md` の決定 104・「契約のバージョンの照合し」・「NDF 11 の名前」の行 | `ndf v11.0.12`・バージョン 8・`ed8b0365…` | `ndf--v11.0.36`・コミット `8d22be7`・バージョン 16・`c50ef840…` |
| `docs/specifications/contracts-and-core.md` の受ける組 | バージョン 8 | バージョン 16 |

`ndf-pin.json` を直した後に `npm run ndf-contract:sync` を打ち、生成のファイルを同じコミットに入れる（決定 5）。

## 使い方のデータと型

満たす決定: 決定 2・3・4・5、受け入れ条件 4・5

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `buildContractUse` | `packages/contracts/src/ndf-contract-use.ts` | 新設 | `(data: unknown, generated: unknown, accepted: NdfContractSet["accepted"]) => NdfContractUse` | 手で書くデータと生成のデータを zod の形で読み、互いに食い違わないことを確かめて、判定と読み取りの関数を付けた使い方を組み立てる |

書き出す値 `ndfContractUse` は、`buildContractUse(手で書くデータ, 生成のデータ, NDF_CONTRACTS.accepted)` の結果である。モジュールの読み込みのときに 1 回だけ組み立てる。

- `buildContractUse`
  - 事前条件: 呼ぶ側に求めることは無い。入力は `unknown` で受け、形は中で確かめる
  - 事後条件: 返す `entrypoints` の id の集合は、手で書く id の一覧と生成の行の id の集合の両方と同じである。`files` の行は、生成の `files` の行（`id`・`path`）に、手で書く `fields` を id で付けたものである。`acceptedVersions` は引数の `accepted` と同じ参照である
  - 副作用: 無い

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `buildContractUse` | 手で書くデータか生成のデータが形に合わない | JSON の手での書き誤り・生成のファイルの手での書き換え | zod の `safeParse` | `DataFileError` を投げる（`data.ts` の既存の例外） | モジュールの読み込みが失敗する。`npm run check` の単体テストと型検査が落ちる。照合は「書き出しを読めない」で終了コード 2 | データを直して打ち直す |
| `buildContractUse` | 手で書く id と生成の行の id が一致しない | 手で書く一覧を直した後に生成のコマンドを打ち忘れた | id の集合を比べる | 同上。メッセージに、片方にだけある id を並べる | 同上 | `npm run ndf-contract:sync` を打ち直す |
| `buildContractUse` | 手で書く `files` の id が生成の `files` に無い | 同上か、使うインタフェースの `files` に無い id を手で書いた | id で引けない | 同上 | 同上 | データを直すか、生成し直す |
| `buildContractUse` | `env` の `entrypoint` が使うインタフェースに無い | 手での書き誤り | id で引けない | 同上 | 同上 | データを直す |

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 中身 |
| --- | --- | --- | --- |
| `ndfContractUseData` | zod の形（`z.strictObject`） | `packages/contracts/src/ndf-contract-use.ts` | 手で書くデータの形。キーは `entrypoints`（id の文字列の配列）・`skillPrefix`（文字列）・`env`（`entrypoint`・`site`（`hosted` か `local`）・`names` の配列）・`envSetBy`（名前から `set_by` の値への対応）・`files`（`id`・`fields` の配列）・`reportItems`（文字列の配列） |
| `ndfContractUseGenerated` | zod の形（`z.strictObject`） | 同上 | 生成のファイルの形。キーは `commit`（40 桁の 16 進）・`entrypoints`（`id`・`kind`・`target`・`lead`（任意）・`args`（任意）・`env`・`files`（任意）の配列）・`files`（`id`・`path` の配列）・`report`（`values`・`required`・`material`）。`tools` の生成のコマンドも、書く前にこの形で確かめる |
| `NdfContractUse` | 型 | 同上 | 照合とランナーが使う形。設計書の決定 5 の代償にあるとおり、`entrypoints` と `files` は行のオブジェクトの配列になり、`pinnedCommit`（生成の `commit`）と `skillPrefix` が加わる。`readReport` の `errors` は `ReportError` の配列になる |
| `NdfEntrypointRow` | 型 | 同上 | 生成の行 1 つ（`id`・`kind`・`target`・`lead?`・`args?`・`env`・`files?`） |
| `ReportRequiredRule` | 型 | 同上 | 照合の側のコピーをここへ移す。形は今の照合のものと同じ |
| `ReportError` | 型 | 同上 | `{ code: ReportErrorCode; item: string }`。読み取った値を持たない（決定 7） |
| `ReportErrorCode` | 型（文字列の合併） | 同上 | 決定 7 の表の 5 つのコード |
| `packages/contracts/data/ndf-contract-use.json` | 手で書くデータ | 同左 | `entrypoints` は決定 4 の 11 の id。`skillPrefix` は `ndf:`。`env` は `skill-workflow` と `block-next` のそれぞれに、ホステッドと手元のマシンの 2 組を書く。名前は execution.md の「渡す環境変数」の表のとおりで、手元のマシンには `NDF_PROGRESS_DB` を入れない。`envSetBy` は `GH_TOKEN`・`NDF_STATE_HOME` の `user`。`files` は `plan-progress`（`step`・`attention`）・`ask-journal`（項目なし）・`gate-rejections`（項目なし）・`issue-request`（`repo`・`title`・`body`・`labels`）。`reportItems` は、ランナーが区間の報告から読む項目（`結果`・`課題`・`区分`・`承認ゲート`・`質問`・`Pull Request`・`材料`・`人に頼むこと`・`理由`） |
| `packages/contracts/data/ndf-contract-use.generated.json` | 生成のデータ | 同左 | 生成のコマンドだけが書く。手で直さない |

`acceptedVersions` は `NDF_CONTRACTS.accepted` を渡し、データに書かない（決定 3）。

生成のファイルのキーに `ndf_ref` を使わず、`commit` にする。参照の検査は、`ndf_ref` のキーが `ndf-pin.json` の 1 か所だけにあることを確かめるためである。

`report.values` は、契約の `shape.values` のキー（結果の値の名前）だけを契約の順で写した文字列の配列にする。`shape.values` の値の側（結果ごとの説明の文）は写さない。設計書の決定 5 は `shape.values` を「そのまま写す」としているが、判定にも読み取りにも使うのは値の名前だけである。説明の文を写すと、参照の検査が探す語を持ち込むおそれがある（今のフィクスチャも説明の文の列を写していない）。照合の 5 項目目は、このキーの並びと契約の `shape.values` のキーの並びを比べる。`required` と `material` は契約の値をそのまま写す。

### 既存の部品の再利用

| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `buildContractUse` | `data.ts` の `parseWith`・`noDuplicates`・`DataFileError` | `grep -n "^export\|^function" packages/contracts/src/data.ts` | `DataFileError` は書き出されているので使う。`parseWith` と `noDuplicates` は書き出されていない。`data.ts` は設計書の触るファイルに無いため書き出しを足さず、`safeParse` と `z.prettifyError` を直に呼ぶ（`parseWith` と同じ 3 行） |

### 単体テストの観点

| 関数 | 正常 | 異常 |
| --- | --- | --- |
| `ndfContractUse` | `entrypoints` の id の集合が、テストに置いた 11 の id のリストとちょうど同じ（決定 4 の網羅）。`acceptedVersions` が `NDF_CONTRACTS.accepted` と同じ | データから `block-next` を消す・`file-loop-record` を足すと落ちる（テストの観点として、リストとの比較が等しさであることを確かめる） |
| `buildContractUse` | 正しい 2 つのデータから組み立てた `files` の行が、生成の `path` と手で書く `fields` を持つ | 形の誤り・id の不一致・`files` の id が生成に無い・`env` の `entrypoint` が使うインタフェースに無い、のそれぞれで `DataFileError` |

## 呼び出しの判定

満たす決定: 決定 4・5、受け入れ条件 4

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `judgeCallWith` | `packages/contracts/src/ndf-contract-use.ts` | 新設 | `(rows: readonly NdfEntrypointRow[], files: readonly { id: string; path: string }[], skillPrefix: string, call: { entrypoint: string; call: string; env: readonly string[] }) => boolean` | 決定 5 の表の規則で、使うインタフェースへの呼び出しが契約に合うかを判定する |
| `filePathPattern` | 同上 | 新設 | `(path: string) => RegExp` | 読むファイルの `path`（`<名前>` を含む）を、呼び出しの相対パスに全体で一致させる正規表現にする |

`NdfContractUse.judgeCall` は、`buildContractUse` が `judgeCallWith` に生成の行・`files`・`skillPrefix` を渡して作る。

- `judgeCallWith`
  - 事後条件: 例外を投げない。判定できない入力はすべて偽を返す
  - 副作用: 無い

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `judgeCallWith` | 契約の `args` が正規表現として読めない | 上流の契約の誤り | `new RegExp` の例外 | 偽を返す（その正規表現には一致しないとみなす） | 照合では、valid が真のサンプルとの食い違いとして 1 項目目に出る | 上流の修正を待つ。再実行してよい |

### 処理の手順

決定 5 の表を、条件の組み合わせの順に並べ直したものである。上の行から順に当て、最初に当たった行の結果を返す。

| 条件 | 結果 |
| --- | --- |
| `call.entrypoint` が `rows` の id に無い | 偽 |
| `call.env` に、その行の `env` に無い名前が 1 つでもある | 偽 |
| `kind` が `skill`・`report`・`command` | `call.call` の全体が、`args` のどれか 1 つに `^(?:…)$` で一致すれば真。`args` が無ければ偽 |
| `kind` が `block` | (1) `lead` があり、`call.call` がそれで始まれば取り除く。(2) 残りが `/` + `skillPrefix` + `target` + 空白 1 つで始まらなければ偽。始まれば取り除く。(3) 残りの全体が `args` のどれか 1 つに `^(?:…)$` で一致すれば真 |
| `kind` が `hook` | `call.call` が `target` と同じなら真 |
| `kind` が `file` | 行の `files` の id で `files` を引き、どれか 1 つの `path` から作った `filePathPattern` に `call.call` が一致すれば真 |
| `kind` が `spec` | `call.call` が `target` + `/` で始まり、その後ろに 1 文字以上あれば真 |
| ほかの `kind` | 偽 |

`filePathPattern` の規則は次のとおりである。

- `path` を `<…>` の並びとそれ以外に分ける
- `<…>` は `[^/]+` にする
- それ以外の文字は、正規表現の特殊文字をエスケープしてそのまま比べる
- 全体を `^…$` で包む。`path` が `.` なら、`^\.$` になり、`.` だけに一致する

繰り返しと計算量は次のとおりである。

- 繰り返しの終わる条件: `args` と `files` の要素の数で終わる
- 計算量の注意: 呼ぶたびに正規表現を作る。インタフェースは 11 行で、サンプルは 21 件のため、作った正規表現をとっておく仕組みは入れない

### 既存の部品の再利用

| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `judgeCallWith` | 照合のテストの偽の判定（`JUDGE_TABLE`） | `grep -n "judgeCall" -r packages tools apps` | 使えない。テストの中の偽物で、種類ごとの規則を持たない |
| `filePathPattern` | 正規表現のエスケープの部品 | `grep -rn "escapeRegExp\|RegExp.escape" packages apps tools --include=*.ts` | 当たりが無く、既存の部品は無い。特殊文字の置き換えを 1 行で書く |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `judgeCallWith` | 新しい固定の点のサンプルのうち、使うインタフェースへの 21 件で、判定が `valid` と同じ | `block-next` の `resume`（`/goal ` が無い）と `resume-loop`（ある）がどちらも真。`spec-io-args` が真で `spec-outside` が偽。`plan-progress` が真。`loop-bad-budget`・`unknown-flag` が偽（全体の一致）。`terminal-env` が偽（`env` の外の名前） | 使わないインタフェース（`file-loop-record` など）の呼び出しが偽。読めない正規表現を持つ行で偽 |
| `filePathPattern` | `<sprint>/<n>-<plan>-state/progress.jsonl` が `s1/8-release-request-state/progress.jsonl` に一致する | `.` が `.` だけに一致し、`a` に一致しない。`<名前>` が `/` を含む文字列に一致しない | `path` の中の `.` などの特殊文字が、任意の文字に一致しない |

## 区間の報告の読み取り

満たす決定: 決定 7、受け入れ条件 8

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `readReportWith` | `packages/contracts/src/ndf-contract-use.ts` | 新設 | `(report: NdfContractUseGenerated["report"], text: string) => { result: string; errors: readonly ReportError[] }` | 決定 7 の規則 1〜6 で、応答の文から結果と誤りの一覧を取り出す |

`NdfContractUse.readReport` は、`buildContractUse` が生成の `report` を渡して作る。

- `readReportWith`
  - 事後条件: 例外を投げない。`errors` の各要素は `code` と `item` だけを持ち、入力の文の一部を持たない。結果の行が無いとき、`result` は空文字列である
  - 副作用: 無い

### 異常系の処理

誤りは例外にせず、`errors` に入れて返す。コードと当たるときは、設計書の決定 7 の表のとおりである。

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `readReportWith` | 決定 7 の表の 5 つの誤り | 応答の文が契約の形に合わない | 規則 1・2・5・6 | 呼び出し元へ返す（`errors` に足す） | 照合では、サンプルと `errors` の有無が違うときだけ 5 項目目の食い違いになる。ランナーでの扱いは #6 が決める | 無い |

### 処理の手順

| 条件 | 結果 |
| --- | --- |
| `- 結果:` で始まる行が無い | `result` は空文字列。`errors` は `result_line_missing`（`結果`）の 1 件だけで、規則 3〜6 を当てない |
| 最後の `- 結果:` の行の値（前後の空白を除く）が `report.values` に無い | `result` はその値。`errors` は `result_value_unknown`（`結果`）の 1 件だけで、規則 3〜6 を当てない |
| 値が `report.values` にある | 規則 3〜6 を当てる |

規則 3〜6 の当て方は次のとおりである。

1. 結果の行より後ろの行のうち、`- <項目>: <値>` の形の行を項目として読む。値の前後の空白を除く。同じ名前は後の行で上書きする
2. 結果の値の `required` の `always` の項目と、`when` の条件に当たった行の `need` の項目を、要る項目として集める。`when` の条件は、`item` の項目の値が `prefix` で始まるか、`equals` と同じかである。`item` の項目が無ければ条件に当たらない
3. 要る項目ごとに、無い・空・`無し` なら `item_missing`（その項目の名前）を足す。要る項目の順は、`always` の順の後に `when` の順とし、同じ項目は 1 回だけ確かめる
4. `material.item`（`材料`）の値が、空でも `無し` でもないときだけ、形を確かめる
   - 値が `material.body`（`本文`）のとき: 結果の行より前に、`material.heading`（`## 判断の材料`）と同じ行があるかを確かめる。無ければ `material_heading_missing`（`材料`）を足す
   - `本文` でないとき: 値を空白で区切った並びのどれもが、`material.url_prefix`（`https://`）で始まり、その後ろに 1 文字以上あるかを確かめる。そうでなければ `material_form_invalid`（`材料`）を足す

- 繰り返しの終わる条件: 行の数で終わる
- 計算量の注意: 行の数に比例する

### 既存の部品の再利用

| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `readReportWith` | 照合のテストの偽の読み取り・`apps/api` と `infra` の区間の報告の読み手 | `grep -rn "readReport\|- 結果:" packages apps infra tools` | 使えない。テストの偽物は規則 1・2 だけを持つ。ほかの読み手は無い |

### 単体テストの観点

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `readReportWith` | 新しい固定の点の `cases` 16 件で、`result` と `errors` の有無がサンプルと同じ | 結果の行の後ろに `材料` が 2 行あるとき、後ろの値を採る。結果の行が 2 つあるとき、最後の行を採る。`完了` と `できなかった` の `材料: 無し` が誤りにならない。URL を空白で区切った並びが誤りにならない | `判断が要る` の `材料: 無し` が `item_missing`。`区分: ndf-gate:…` で `承認ゲート` が無いと `item_missing`。`材料: 本文` で見出しが無いと `material_heading_missing`。材料の欄が `https://acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf?X-Amz-Signature=0000 not-a-url` のとき、`errors` は `material_form_invalid`・`材料` の 1 件だけで、`JSON.stringify(errors)` が `X-Amz-Signature`・`0000`・`not-a-url` を含まない |

## 契約の照合と生成のコマンド

満たす決定: 決定 4・5・6、受け入れ条件 4・5

### 関数の仕様

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `compareContract` | `tools/checks/src/ndf-contract-check.ts` | 変更 | `(files: ContractFiles, use: NdfContractUse, pinned: string) => ContractFinding[]`（今は `(files, use: NdfContractUse \| null)`） | 照合の 1〜6 項目目を実行し、食い違いを返す。使い方が無い場合の扱いは呼び出し元へ移す |
| `checkCases` | 同上 | 変更（責務） | 今のまま | 1 項目目。先にすべてのサンプルの参照先の id が `entrypoints.json` にあるかを確かめ、その後で使うインタフェースへのサンプルだけを判定へ通す |
| `checkFiles` | 同上 | 変更（責務） | 今のまま | 4 項目目。今の確かめに加えて、読むファイルの `path` が契約の行の `path` と同じかを比べる |
| `checkReport` | 同上 | 変更（責務） | 今のまま | 5 項目目。`values`・`required`・`material` は契約の `shape` と同じかを比べ、`items` は含むかを確かめる。サンプルの照合は今のまま |
| `checkEntrypoints` | 同上 | 変更 | `(files: ContractFiles, use: NdfContractUse, pinned: string, findings: ContractFinding[]) => void` | 6 項目目。生成の固定の点を比べた後、使うインタフェースの行が契約にあり、6 つの列が同じかを比べる |
| `isContractUse` | 同上 | 変更（責務） | 今のまま | 書き出しが新しい `NdfContractUse` の形かを確かめる |
| `MainOptions` | 同上 | 変更（型） | `{ repoUrl?: string; loadUse?: (root: string) => Promise<NdfContractUse \| null> }`（`required` を消す） | テストが差し替える依存 |
| `mainNdfContractCheck` | 同上 | 変更（失敗の扱い） | 今のまま | 書き出しが無ければ、契約を取得せずに `fail: no-contract-use` と終了コード 1 で終える |
| `generateContractUse` | 同上 | 新設 | `(files: ContractFiles, ids: readonly string[]) => NdfContractUseGenerated` | 契約のファイルから、手で書く id の行と、その行の `files` が指す読むファイルの `path` と、区間の報告の形を取り出す |
| `mainNdfContractSync` | 同上 | 新設 | `(argv: string[], env: NodeJS.ProcessEnv, options?: { repoUrl?: string }) => Promise<number>` | 固定の点の契約を取得し、生成のファイルを書き直す |

ファイルの末尾の起動の処理は、最初の引数が `sync` なら `mainNdfContractSync` を、それ以外なら `mainNdfContractCheck` を呼ぶ。`sync` を照合と同じファイルに置くのは、取得の処理（`fetchContract`）と契約のファイルの形（`SCHEMAS`）を共有するためである。

`SCHEMAS` には次の列を足す。

- `domains/entrypoints.json` の行に、`kind`・`target`・`lead`（任意）・`args`（任意）・`files`（任意）
- `domains/ndf-files.json` の行に、`path`

- `compareContract`
  - 事前条件: `pinned` は `ndf-pin.json` の固定の点である。固定の点を照合するときも先端を照合するときも、同じ値を渡す
- `mainNdfContractCheck`
  - 事後条件: 出力の行の形（`read:`・`checked:`・`fail:`・`notice:`・`diff:`・`mismatch:`）は今のまま。`skip:` の行は出さない
  - 副作用: 一時ディレクトリへの `git` の取得（ネットワーク）・標準出力・要約のファイルへの追記
- `mainNdfContractSync`
  - 事後条件: `<root>/packages/contracts/data/ndf-contract-use.generated.json` が、`ndfContractUseGenerated` の形に合う JSON になる。JSON は 2 つの空白で字下げし、最後に改行を 1 つ置く
  - 副作用: 一時ディレクトリへの `git` の取得（ネットワーク）・生成のファイルの書き込み・標準出力

### 異常系の処理

| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `mainNdfContractCheck` | 書き出しが無い | 作業ツリーのパッケージに `./ndf-contract-use` が無い | 使い方の読み込みが null を返す | 止める。契約を取得しない | 標準出力に `fail: no-contract-use <固定の点>`、標準エラーに理由、要約のファイルにも同じ行。終了コード 1。`read:` の行は出さない | 一時ディレクトリを作らない。書き出しを戻して打ち直す |
| `mainNdfContractCheck` | `ndf-pin.json` を読めない・書き出しはあるが読めない | 今のまま | 今のまま | 今のまま | 今のまま（終了コード 2） | 今のまま |
| `checkEntrypoints` | 生成の固定の点が `ndf-pin.json` と違う | 固定の点を上げた後に生成のコマンドを打ち忘れた | `use.pinnedCommit !== pinned` | 6 項目目の食い違いを足し、残りの比較も続ける | `mismatch: <fixed か tip> 6 …ndf-contract-use.generated.json: 生成の固定の点 <値> が ndf-pin.json の <値> と違う`。固定の点の照合なら終了コード 1 | `npm run ndf-contract:sync` を打ち直す |
| `checkEntrypoints` | 生成の行の列が契約と違う | 生成のファイルの手での書き換え（固定の点）・上流の変更（先端） | 列ごとに `JSON.stringify` で比べる | 列ごとに 1 件の食い違いを足す | `mismatch: … 6 …entrypoints.json <id>: <列> が契約と違う`。値は出さない（契約の値は公開の情報だが、行が長くなるため） | 固定の点なら生成し直す |
| `checkCases` | 使うインタフェースへのサンプルの参照先が `entrypoints.json` に無い | 上流の契約の誤り | 絞り込みの前の id の確かめ | 1 項目目の食い違いを足し、そのサンプルを判定へ通さない | `mismatch: … 1 …entrypoint-cases.json <サンプルの id>: …`（今の文のまま） | 上流の修正を待つ |
| `checkFiles` | 読むファイルの `path` が契約と違う | 同上（生成し忘れか上流の変更） | `row.path !== wanted.path` | 4 項目目の食い違いを足す | `mismatch: … 4 …ndf-files.json <id>: path が生成の値と違う` | 固定の点なら生成し直す |
| `checkReport` | `values`・`required`・`material` が契約の `shape` と違う | 同上 | 正規化した JSON で比べる | 5 項目目の食い違いを、キーごとに 1 件足す | `mismatch: … 5 …unattended-report.json: shape.<キー> が生成の値と違う` | 同上 |
| `generateContractUse` | 手で書く id が契約の `entrypoints.json` に無い | 手での書き誤り・上流でインタフェースが消えた | id で引けない | `ContractFetchError` でない専用の例外（`ContractUseSyncError`）を投げる | — | — |
| `generateContractUse` | 契約のファイルの形が読めない | 上流の契約の誤り | `SCHEMAS` の `safeParse` | 同上 | — | — |
| `mainNdfContractSync` | 上の 2 つ | 同上 | 例外を受ける | 止める。生成のファイルを書かない | 標準エラーに `error: 生成できない: <理由>`。契約に無い id は名前を並べる。終了コード 1 | 生成のファイルは前のまま残る。直して打ち直す |
| `mainNdfContractSync` | 引数の誤り・`ndf-pin.json` か手で書くデータを読めない・契約を取得できない | 今の照合と同じ | 同上 | 止める | 標準エラーに理由。終了コード 2 | 同上 |
| `mainNdfContractSync` | 生成のファイルに書けない | 権限・ディスク | `writeFile` の例外 | 止める | 標準エラーに理由。終了コード 2 | 同上 |

生成のファイルは、一時のファイルに書かずに直接書く。書き込みの途中で止まって壊れても、`npm run check` の読み込み（`buildContractUse`）と照合の 6 項目目が落とし、打ち直せば直るためである。

### 処理の手順

`mainNdfContractCheck` の処理の順は次のとおりである。

| 順 | 処理 | 失敗したとき |
| --- | --- | --- |
| 1 | 引数を読む | 終了コード 2 |
| 2 | `ndf-pin.json` から固定の点を読む | 終了コード 2 |
| 3 | 書き出しを読む | 読めなければ終了コード 2。無ければ `fail: no-contract-use <固定の点>` を出して終了コード 1 |
| 4 | 固定の点と先端の契約を取得する | 固定の点は終了コード 2。先端は警告を出して続ける（今のまま） |
| 5 | `compareContract(固定の点, use, pinned)` と、先端があれば `compareContract(先端, use, pinned)` | — |
| 6 | 通知・形の差分・食い違いの行を出し、要約を書く | 要約に書けなければ終了コード 2 |

`mainNdfContractSync` の処理の順は次のとおりである。

| 順 | 処理 | 失敗したとき |
| --- | --- | --- |
| 1 | 引数（`sync` の後に `--root` だけ）を読む | 終了コード 2 |
| 2 | `ndf-pin.json` から固定の点を、`packages/contracts/data/ndf-contract-use.json` から `entrypoints` の id の一覧を読む | 終了コード 2 |
| 3 | 固定の点の契約を取得する（`fetchContract`） | 終了コード 2 |
| 4 | `generateContractUse` で生成のデータを作り、`ndfContractUseGenerated` の形で確かめる | 終了コード 1 |
| 5 | 生成のファイルを書き、`wrote: <パス> <固定の点>` を標準出力に出す | 終了コード 2 |

`generateContractUse` は、`entrypoints` の行を手で書く id の順に並べ、`files` の行を最初に現れた順に並べて重なりを除く。並びを決めておき、生成し直したときに差分が出ないようにする。

### 内部のデータと定数

| 名前 | 種類 | 保存先 | 値 |
| --- | --- | --- | --- |
| `CONTRACT_USE_REQUIRED` | 定数 | `tools/checks/src/ndf-contract-check.ts` | 消す（決定 6） |
| `GENERATED_PATH` | 定数 | 同上 | `packages/contracts/data/ndf-contract-use.generated.json`（作業ツリーの根からの相対パス）。食い違いの行の `path` にも使う |
| `USE_DATA_PATH` | 定数 | 同上 | `packages/contracts/data/ndf-contract-use.json` |
| `ENTRYPOINT_COLUMNS` | 定数 | 同上 | `["kind", "target", "lead", "args", "env", "files"]`。6 項目目で比べる列 |

### ログと記録の出力

| 関数 | 出すもの | 書き先 | 出さないもの |
| --- | --- | --- | --- |
| `mainNdfContractCheck` | 書き出しが無いときの `fail: no-contract-use <固定の点>` | 標準出力と要約のファイル | — |
| `mainNdfContractSync` | `wrote: <パス> <固定の点>`・失敗の理由 | 標準出力・標準エラー | 秘密は扱わない |

### 既存の部品の再利用

| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `generateContractUse` | `SCHEMAS`・`read`（照合の中の契約の読み込み） | `grep -n "SCHEMAS\|function read" tools/checks/src/ndf-contract-check.ts` | `SCHEMAS` は使う。`read` は読めないときに食い違いを足す作りで、生成では例外にしたいため使わず、`SCHEMAS[path].safeParse` を直に呼ぶ |
| `mainNdfContractSync` | `fetchContract`・`readPinnedCommit`・`mainNdfContractCheck` の引数の読み方 | `grep -n "fetchContract\|readPinnedCommit\|parseArgs" tools/checks/src/ndf-contract-check.ts` | `fetchContract` と `readPinnedCommit` は使う。引数の読み方は `parseArgs` を同じ形で使う |

### 単体テストの観点

テストのフィクスチャは、`fakeContract` と `fakeUse` を新しい型に合わせて直す。`pinnedContract` と `pinnedUse` は、新しい固定の点のフィクスチャ（`ndf-contract-8d22be7`）を読むように直す。

| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `compareContract` | 作り物の契約と使い方で食い違いが 0 件 | 使わないインタフェースのサンプルの `valid` を逆にしても、食い違いが出ない | `block-next` へのサンプル 1 件の `entrypoint` を `no-such-entrypoint` にすると、そのサンプルの id を含む 1 項目目の行が出る（`entrypoints.json` の行は消さない）。生成の `spec-io` の `target` だけを変えると 6 項目目の食い違い。`path` だけを変えると 4 項目目。`required` の `判断が要る` の `always` だけを変えると 5 項目目。生成の `commit` だけを変えると 6 項目目 |
| `mainNdfContractCheck` | 食い違いが無ければ 0 と、固定の点と先端の `checked:` の行。`skip:` の行が出ない | — | 書き出しが無く、取得先の `repoUrl` が取得できない値でも、終了コードは 1 で、`fail: no-contract-use <固定の点>` を出し、`read:` の行を出さない（取得を試みない）。`ask-journal` に `fields` を足した契約では、`notice:` の行が標準出力と要約に出て、終了コードは 0 のまま |
| `generateContractUse` | フィクスチャの契約から作ると、手で書く id の行と `path` と区間の報告の形を持ち、コミットした生成のファイルと同じ | 使わないインタフェース（`file-loop-record` など）の行が入らない | 契約に無い id を一覧に足すと `ContractUseSyncError` |
| `mainNdfContractSync` | フィクスチャの契約を置いた作り物の上流で、生成のファイルを書いて 0 を返す | — | 契約に無い id で 1 を返し、生成のファイルを書き換えない。固定の点を取得できないと 2 |
