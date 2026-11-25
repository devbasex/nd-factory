# NDF の契約の使い方と照合

## 概要

nd-factory は、NDF（devbasex/ai-plugins の `ndf` プラグイン）の契約のファイル（`plugins/ndf/contracts/`）に載る口と形だけを使う。この仕様は、そのうち nd-factory が使う部分をスキーマの正本に持つ仕組み（NDF の契約の使い方）と、それを NDF の契約と突き合わせる検査（契約の照合）を定める。

- 使う NDF のコミット（固定の点）は `ndf-pin.json` の `ndf_ref` の 1 か所に置く。今の値は、配布のタグ `ndf--v11.0.36` が指すコミット `8d22be728e81983e5051799bcee4637ff65f0071` である
- 受ける契約の組は `packages/contracts/data/ndf-contracts.json` の 1 か所に置く。今は契約のバージョン 16・sha256 `c50ef840a72ab71a15023a46a37d050c36ec3aae6d1be6092b7f9dc7f3c0a726` の 1 組である（固定の点の `version.json` の `history` の最後の行）
- 使い方の書き出し（`@nd-factory/contracts/ndf-contract-use` の `ndfContractUse`）は、使うインタフェースの行・読むファイルの `path`・区間の報告の形を持ち、呼び出しの判定（`judgeCall`）と区間の報告の読み取り（`readReport`）を出す。照合とランナー（[#6](https://github.com/devbasex/nd-factory/issues/6)）が同じ関数を使う
- 契約の照合（`npm run ndf-contract`）は、固定の点と NDF のデフォルトブランチの先端の契約を取得し、書き出しと 6 項目で突き合わせる。書き出しが無ければ、契約を取得せずに失敗する
- 生成のコマンド（`npm run ndf-contract:sync`）は、固定の点の契約から使い方の生成のファイルを書き直す

## 用語

語の意味は [用語集](../glossary.md) に従う。用語集に無い語のうち、この文書で使うものは次のとおりである。

| 語 | 意味 |
| --- | --- |
| 固定の点 | nd-factory が使う NDF のコミット。`ndf-pin.json` の `ndf_ref` の値 |
| 先端 | NDF のリポジトリのデフォルトブランチ（`HEAD` が指すブランチ）の最新のコミット |
| 受ける組 | ランナーが起動のときに受け入れる、契約のバージョンと sha256 の組の集合 |
| 使うインタフェース | NDF の契約のインタフェースの表（`domains/entrypoints.json`。15 行）のうち、nd-factory が使う 11 行。一覧は実行の設計の「[NDF との契約](../design/execution.md#ndf-との契約)」の「使うインタフェース」の表にある |
| 使い方の書き出し | `@nd-factory/contracts/ndf-contract-use` が書き出す `ndfContractUse`。型は `NdfContractUse` |
| 生成のファイル | `packages/contracts/data/ndf-contract-use.generated.json`。固定の点の契約から生成のコマンドが書く。手で直さない |
| 手で書くデータ | `packages/contracts/data/ndf-contract-use.json`。使うインタフェースの id など、ランナーに固有の設定 |
| 区間の報告 | NDF が作業の区切りごとに返す応答の文。形は契約の `hooks/unattended-report.json` が定め、実行の設計の「[区間と結果の行](../design/execution.md#区間と結果の行)」が扱う |
| 食い違い | 照合の 1 件の結果。照合の番号（1〜6）・契約のファイルのパス・サンプルなどの id・説明を持つ |

本文に出すコードの名前と置き場は次のとおりである。

| 本文の語 | コードの名前 | 置き場 |
| --- | --- | --- |
| 使い方の型とデータの形 | `NdfContractUse`・`ndfContractUseData`・`ndfContractUseGenerated`・`NdfEntrypointRow`・`REPORT_ITEMS`・`ReportReading`・`ReportError` など | `packages/contracts/src/ndf-contract-use-schema.ts` |
| 使い方の組み立て・判定・読み取り | `buildContractUse`・`judgeCallWith`・`filePathPattern`・`readReportWith`・`ndfContractUse` | `packages/contracts/src/ndf-contract-use.ts` |
| 契約の照合 | `mainNdfContractCheck`・`compareContract`・`contractNotices`・`reportShapeDiff`・`renderSummary`・`contractUseLoaderFrom`・`loadContractUse` | `tools/checks/src/ndf-contract-check.ts` |
| 契約の取得と形 | `fetchContract`・`withFixedContract`・`parseContract`・`readPinnedCommit` | `tools/checks/src/ndf-contract-fetch.ts` |
| 生成のコマンド | `mainNdfContractSync`・`generateContractUse`・`ContractUseSyncError` | `tools/checks/src/ndf-contract-sync.ts` |

## 構成要素と責務

```mermaid
graph LR
  PIN["ndf-pin.json<br/>固定の点"]
  subgraph contracts["packages/contracts"]
    ACC["data/ndf-contracts.json<br/>受ける組"]
    UD["data/ndf-contract-use.json<br/>手で書くデータ"]
    UG["data/ndf-contract-use.generated.json<br/>生成のファイル"]
    US["src/ndf-contract-use-schema.ts<br/>型・データの形・REPORT_ITEMS"]
    UM["src/ndf-contract-use.ts<br/>ndfContractUse（判定・読み取り）"]
  end
  NDF["NDF の契約のファイル<br/>plugins/ndf/contracts/"]
  SYNC["生成のコマンド<br/>npm run ndf-contract:sync"]
  CHK["契約の照合<br/>npm run ndf-contract"]
  RUN["ランナー（#6）"]
  ACC --> UM
  UD --> UM
  UG --> UM
  US --> UM
  PIN --> SYNC
  NDF --> SYNC
  UD --> SYNC
  SYNC --> UG
  US --> SYNC
  US --> CHK
  UM --> CHK
  PIN --> CHK
  NDF --> CHK
  UM -.-> RUN
```

| 構成要素 | 責務 |
| --- | --- |
| 使い方の型とデータの形（`ndf-contract-use-schema.ts`） | 型・zod の形・区間の報告から読む項目の名前を持つ。データの JSON を読まず、読み込みのときに何も組み立てない。照合と生成のコマンドはここから形を読む |
| 使い方の書き出し（`ndf-contract-use.ts`） | 2 つのデータを読み込みのときに形で検証して組み立て、判定と読み取りの関数を付けて書き出す。`node:` の組み込みを読まない |
| 契約の照合（`ndf-contract-check.ts`） | 固定の点と先端の契約を書き出しと 6 項目で突き合わせ、標準出力と要約のファイルに結果を出す |
| 契約の取得と形（`ndf-contract-fetch.ts`） | NDF のリポジトリから 1 つのコミットを深さ 1 で取得し、契約の 6 つのファイルを読む。照合と生成のコマンドが共有する |
| 生成のコマンド（`ndf-contract-sync.ts`） | 固定の点の契約から、使うインタフェースの行・読むファイルの `path`・区間の報告の形を取り出して生成のファイルを書く |

## 背景

| 決めたこと | 理由 |
| --- | --- |
| 固定の点は、設計の時点で最新の配布のタグ `ndf--v11.0.36` のコミットにし、受ける組はその点の 1 組だけにする | 上流の最新の配布と同じ契約で作る（実行の設計の決定 104）。デフォルトブランチの先端は配布していない変更を含み、利用者の手元の NDF と同じにならない。動いているランナーがまだ無く、古い組を受ける理由が無い |
| 固定の点はタグの名前ではなく、タグが指すコミットの 40 桁で書く | タグは動かせる。依存は全長のコミット SHA で固定する（[GitHub Actions のセキュリティ強化の手引き](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#using-third-party-actions)） |
| 型とデータの形を、データを読まないモジュール（`ndf-contract-use-schema.ts`）に分ける | `ndf-contract-use.ts` は読み込みのときに組み立て、手で書くデータと生成のファイルが食い違えば例外を投げる。CLI がそこから形を読むと、食い違った作業ツリーで生成のコマンドが起動できず、直す手段が無くなる |
| 受ける組は既存の `NDF_CONTRACTS.accepted` を引き、使い方のデータに写さない | 固定の点を上げるたびに 2 か所を直すことになり、片方の直し忘れを照合の 2 項目目が見落とす |
| 判定は使うインタフェースだけを受け、照合の 1 項目目も使うインタフェースのサンプルだけを判定で比べる | 使わないと決めたインタフェース（オーガナイザーやループの保存先など）の決まりを nd-factory が持たない（実行の設計の決定 73）。利用する側は自分が使う部分だけを契約として持つ（[利用者駆動の契約](https://martinfowler.com/articles/consumerDrivenContracts.html)） |
| 契約から機械的に取り出せる部分（インタフェースの行・読むファイルの `path`・区間の報告の形）は生成し、手で写さない | 上流が変わるたびに最大 11 行の列を手で写し直すことになる。生成した行を照合で契約と項目ごとに比べると、サンプルの無い変更（引数の正規表現だけの変更など）にも先端の要約で気づける |
| 生成はネットワークから上流を取得するため、`npm run generate` と `npm run generate:check` に入れない | `npm run check` は、ネットワークにつながらない環境でも動く必要がある |
| 照合から skip の道を消し、書き出しが無ければ常に失敗にする | 書き出しが消えたときに照合が素通りしない。取得の前に判定するので、ネットワークにつながらない手元でも欠落が取得のエラーに隠れない |
| 区間の報告の読み取りは、契約の `rule` と `shape` に沿い、見出しを GFM の構文木で決める | 行を上から追う規則では、HTML のブロックやリストの中の見出し風の行を区別できない。同じ項目を後勝ちで読み、訂正した節を承認者に見せる |
| 読み取りの誤りの一覧に、報告の中の値を入れない | 材料の欄には署名付き URL や共有トークンが混ざりうる。伏せ字は既知の秘密の形だけを伏せ、任意の署名を取り除けない |
| 契約のテストに Pact を使わない | Pact は利用する側のテストから契約を生成し、提供する側が検証する作りで、NDF が契約のファイルとサンプルを公開している今の形と向きが逆になる |

## 対象範囲

含む:

- 固定の点（`ndf-pin.json`）と受ける組（`data/ndf-contracts.json`）の値
- 使い方の書き出しと、その型・データ・呼び出しの判定・区間の報告の読み取り
- 契約の照合（`npm run ndf-contract`）と生成のコマンド（`npm run ndf-contract:sync`）

含まない:

- ランナーの起動のときの契約の照合、組み立てた呼び出しの検査、許可範囲の外を開かないファイルの読み取り、承認資料の材料の URL の確かめ（ランナー [#6](https://github.com/devbasex/nd-factory/issues/6)。満たす要件は下の「ランナーが守ること」）
- 区間の失敗の理由のコード `report_item_invalid`・`material_url_rejected` を値の集まり（`packages/contracts/src/rows/sprints.ts` の `segmentFailureReason`）に足すこと（ランナー #6）
- 上流の契約の不足 3 件（[devbasex/ai-plugins#3947](https://github.com/devbasex/ai-plugins/issues/3947)）と、`block-next` の `source` が固定の点に無いファイルを指す件（[#47](https://github.com/devbasex/nd-factory/issues/47)）。どれも照合の 6 項目が読まない箇所に残るため、食い違いにならない（下の「上流の不足を食い違いにしない」）
- CI のワークフロー（`.github/workflows/ndf-contract.yml`）

## 仕様

### 常に成り立つ条件

| 条件 | 守り方 |
| --- | --- |
| 固定の点は `ndf-pin.json` の `ndf_ref` の 1 か所だけにある | 参照の検査（`tools/ref-check`）が落とす。生成のファイルの固定の点のキーは `ndf_ref` でなく `commit` にする |
| 受ける組は `data/ndf-contracts.json` の 1 か所だけにある | 書き出しの `acceptedVersions` は `NDF_CONTRACTS.accepted` と同じ参照である |
| 手で書くデータの使うインタフェースの id と、生成のファイルの行の id が同じ集合で、どちらも重ならない | `buildContractUse` が読み込みのときに `DataFileError` を投げ、`npm run check` が落とす |
| 使い方の書き出しの使うインタフェースは、実行の設計の「使うインタフェース」の表の 11 件ちょうどである | `packages/contracts/test/ndf-contract-use.test.ts` が、11 の id のリストと集合の等しさで比べる。表を変えるときは同じ変更でリストを直す |
| 生成のファイルの固定の点は `ndf-pin.json` と同じ | 照合の 6 項目目が食い違いにする |
| NDF のバージョンの数字を読んで大小を比べない | 受ける組は集合で持ち、組が集合にあるかだけを見る |
| `ndf-contract-use.ts` が依存するのは、同じパッケージ・zod・GFM の解析器（`mdast-util-from-markdown`・`mdast-util-gfm`・`micromark-extension-gfm`）だけである | 依存の規則 `contracts-ndf-contract-use-depends-on-parser-only`（`.dependency-cruiser.cjs`）が落とす。ほかの `packages/contracts/src/` は zod だけに依存する（`contracts-depends-on-zod-only`） |

### 使い方のデータ

使い方のデータは、手で書くもの 2 つと、生成するもの 1 つに分かれる。

| 置き場 | 中身 | 作り方 |
| --- | --- | --- |
| `packages/contracts/data/ndf-contract-use.json` | `entrypoints`（使うインタフェースの 11 の id）・`skillPrefix`（`ndf:`）・`env`（インタフェースと実行の場（`hosted`・`local`）の組ごとに渡す環境変数の名前）・`envSetBy`（`set_by` が `service` でない名前とその値）・`files`（読むファイルの id ごとに翻訳が読む項目） | 手で書く |
| `packages/contracts/src/ndf-contract-use-schema.ts` の `REPORT_ITEMS` | ランナーが区間の報告から読む項目の名前。読み取りの戻り値の `items` の型をこの定数から作るため、JSON ではなくコードに置く | 手で書く |
| `packages/contracts/data/ndf-contract-use.generated.json` | `commit`（生成の元にした固定の点）・`entrypoints`（使うインタフェースの行の `id`・`kind`・`target`・`lead`・`args`・`env`・`files`）・`files`（その行の `files` が指す読むファイルの `id` と `path`）・`report`（区間の報告の形。`values` は契約の `shape.values` のキーを契約の順に並べた配列、`required` と `material` は契約の値そのまま） | 生成のコマンドが書く |

使うインタフェースの 11 件は次のとおりである。

- `skill-workflow`・`block-next`・`report-unattended`
- `hook-unattended-start`・`hook-unattended-stop`・`hook-unattended-end`
- `file-plan-progress`・`file-journals`・`file-issue-request`
- `gate-record`・`spec-io`

手で書くデータの今の値は次のとおりである。

| キー | 値 |
| --- | --- |
| `env` | `skill-workflow` と `block-next` のそれぞれに、`hosted` と `local` の 2 組。名前は `NDF_FACTORY_RUN`・`NDF_VERSION`・`NDF_STATE_HOME`・`NDF_MVV_STATE_DIR`・`NDF_ISSUE_REQUEST_FILE`・`GH_TOKEN`。`hosted` だけに `NDF_PROGRESS_DB` を足す |
| `envSetBy` | `GH_TOKEN`・`NDF_STATE_HOME` が `user` |
| `files` | `plan-progress`（`step`・`attention`）・`ask-journal`（項目なし）・`gate-rejections`（項目なし）・`issue-request`（`repo`・`title`・`body`・`labels`） |
| `REPORT_ITEMS` | `結果`・`課題`・`区分`・`承認ゲート`・`質問`・`Pull Request`・`材料`・`人に頼むこと`・`理由` |

区間の報告の形の説明の文（`shape.values` の値の側）は、判定にも読み取りにも使わないため写さない。説明の文を写すと、参照の検査が探す語を持ち込むおそれもある。

### 使い方の書き出し

`ndfContractUse` は、モジュールの読み込みのときに `buildContractUse(手で書くデータ, 生成のファイル, NDF_CONTRACTS.accepted)` で 1 回だけ組み立てる。

`buildContractUse` は 2 つのデータを zod の形で検証し、次のどれかに当たれば `DataFileError` を投げる。メッセージには、片方にだけある id を並べる。

- どちらかのデータが形に合わない
- 手で書く `entrypoints` と生成の行の id が同じ集合でない、またはどちらかに重なりがある（手で書く一覧を直した後に生成のコマンドを打ち忘れたとき）
- 手で書く `files` の id が生成の `files` に無い
- 手で書く `env` の `entrypoint` が使うインタフェースに無い

書き出しの形（`NdfContractUse`）は次のとおりである。

| 項目 | 中身 |
| --- | --- |
| `acceptedVersions` | `NDF_CONTRACTS.accepted` |
| `pinnedCommit` | 生成の `commit` |
| `skillPrefix`・`env`・`envSetBy` | 手で書くデータの値 |
| `entrypoints` | 生成の行 |
| `files` | 生成の `files`（`id`・`path`）に、手で書く `fields` を id で付けたもの。手で書くデータに無い id は `fields` が空 |
| `reportItems` | `REPORT_ITEMS` |
| `report` | 生成の区間の報告の形 |
| `judgeCall(call)` | 下の「呼び出しの判定」。`call` は `{ entrypoint, call, env }` |
| `readReport(text)` | 下の「区間の報告の読み取り」 |

### 呼び出しの判定

`judgeCall`（実体は `judgeCallWith`）は、使うインタフェースへの呼び出しが契約に合うかを判定する。例外を投げず、判定できない入力はすべて偽を返す。上の行から順に当て、最初に当たった行の結果を返す。

| 条件 | 結果 |
| --- | --- |
| `entrypoint` が使うインタフェースの行に無い | 偽 |
| `env` に、その行の `env` に無い名前が 1 つでもある | 偽 |
| `kind` が `skill`・`report`・`command` | 呼び出し文字列の全体が、`args` のどれか 1 つに全体で一致すれば真。`args` が無ければ偽 |
| `kind` が `block` | (1) `lead` があり、文字列がそれで始まれば取り除く（`lead` は任意）。(2) 残りが `/` + `skillPrefix` + `target` + 空白 1 つで始まらなければ偽。始まれば取り除く。(3) 残りの全体が `args` のどれか 1 つに全体で一致すれば真 |
| `kind` が `hook` | 文字列が `target` と同じなら真 |
| `kind` が `file` | 文字列がパスの境界（下）を守らなければ偽。守れば、行の `files` の id の読むファイルのどれか 1 つの `path` に一致すれば真 |
| `kind` が `spec` | 文字列が `target` + `/` で始まり、その後ろの残りが `.` でなく、パスの境界を守れば真 |
| ほかの `kind` | 偽 |

- 全体の一致は、正規表現を `^(?:…)$` で包んで当てる。部分の一致では、契約の偽のサンプル（`loop-bad-budget`・`unknown-flag`）が真になる
- 正規表現として読めない `args` は、その正規表現に一致しないとみなす
- Skill の前置き（`ndf:`）は契約の表に無い（NDF の identity が決める）ため、手で書くデータに持つ

読むファイルの `path` は `filePathPattern` で正規表現にする。`<名前>` の部分は `/` を含まない 1 文字以上（`[^/]+`）に一致させ、ほかの文字は正規表現の特殊文字をエスケープしてそのまま比べ、全体を `^…$` で包む。`path` が `.` なら、文字列 `.` だけに一致する。たとえば `<sprint>/<n>-<plan>-state/progress.jsonl` は `s1/8-release-request-state/progress.jsonl` に一致する。

パスの境界は、パスの文字列だけを検査する。文字列が `/` で始まらず、`\` と制御文字を含まず、`/` で区切った各成分が空・`.`・`..` のどれでもなければ守っている。`file` の文字列の全体が `.` のときは、ランナーが環境変数に指定したファイルそのもの（`file-issue-request` なら `NDF_ISSUE_REQUEST_FILE`）を指すため、守っているとみなす。判定はファイルシステムを読まないので、シンボリックリンクの先は確かめない。判定が真を返しただけで読み取りを許してはならない（下の「ランナーが守ること」）。

### 区間の報告の読み取り

`readReport`（実体は `readReportWith`）は、区間の報告を生成のファイルの区間の報告の形に沿って読む。例外を投げない。

1. 応答の文の中で最後の `- 結果:` で始まる行を結果の行とし、値の前後の空白を除いて結果にする。結果の行が無ければ `result_line_missing` を返し、後の規則を当てない
2. 結果が `report.values`（`判断が要る`・`完了`・`できなかった`）のどれでもなければ `result_value_unknown` を返し、後の規則を当てない
3. 結果の行より後ろの `- <項目>: <値>` の行を項目として読む。値の前後の空白を除く。結果の行より前の項目の行は読まない
4. 同じ名前の項目は、最後の行の値を採る
5. `report.required` の結果の値の行から、`always` の項目と、`when` の条件に当たった `need` の項目を要る項目として集める。条件は、`item` の項目の値が `prefix` で始まるか、`equals` と同じかである。`item` の項目が無ければ当たらない。要る項目が無い・空・`無し` なら `item_missing` にする。項目「材料」もこの規則だけで扱う。材料が要らない結果（`完了`・`できなかった`）の `材料: 無し` は誤りにしない
6. 項目「材料」に空でも `無し` でもない値があるときだけ、形を確かめる
   - 値が `本文` のとき: 結果の行より前の文を、GFM の拡張を渡した `mdast-util-from-markdown` で解析する。構文木の根の直下にある見出しのうち、その行（前後の空白を除く）が `## 判断の材料` と同じものを探し、最後の見出しを採る。コードブロック・HTML のブロック・引用・リストの中の行は根の直下の見出しにならない。見出しが無ければ `material_heading_missing` にする。あれば、採った見出しの終わりから、その後ろにある根の直下のレベル 1 か 2 の見出し（ATX と Setext のどちらも）の前まで、無ければ解析した文の終わりまでを元の文から切り出し、先頭の改行を 1 つ除いて節にする。閉じないフェンスのコードブロックは、GFM の解釈どおり結果の行の前まで続く
   - それ以外のとき: 値を空白で区切った並びのどれもが、`https://` で始まりその後ろに 1 文字以上あれば URL の並びとして受ける。そうでなければ `material_form_invalid` にする

読み取りが返すもの（`ReportReading`）は次のとおりである。

| 項目 | 中身 |
| --- | --- |
| `result` | 結果の値。結果の行が無ければ空文字列 |
| `errors` | 誤りの一覧。1 件は誤りのコード（`code`）と項目の名前（`item`）だけを持ち、報告の中の値を持たない |
| `items` | 規則 4 で採った項目の値。キーは `REPORT_ITEMS` の名前（`結果` を除く）に限る。報告に無い項目はキーを持たない |
| `material` | `{ kind: "none" }`（材料が無い・空・`無し`、または `errors` が空でない）・`{ kind: "body", section }`（`本文` で取り出した節）・`{ kind: "urls", urls }`（報告の順の URL の並び）のどれか |

| 誤りのコード | 当たるとき | 項目の名前 |
| --- | --- | --- |
| `result_line_missing` | 結果の行が無い（規則 1） | `結果` |
| `result_value_unknown` | 結果が 3 つの値のどれでもない（規則 2） | `結果` |
| `item_missing` | 要る項目が無い・空・`無し`（規則 5）。要る項目の順は `always` の後に `when` の順で、同じ項目は 1 回だけ確かめる | 欠けた項目 |
| `material_form_invalid` | 材料の値が `本文` でも URL の並びでもない（規則 6） | `材料` |
| `material_heading_missing` | `材料: 本文` なのに、文書の直下に「判断の材料」の見出しが無い（規則 6） | `材料` |

ランナーは、区間の報告に由来する値（結果・課題・区分・質問・承認ゲート・Pull Request・材料・「判断の材料」節）を、検証にも承認資料の組み立てにもこの戻り値から取り、応答の文を読み直さない。承認資料の対象の課題番号の並びは項目「課題」だけから作り、設計承認ゲートで外す課題（`--drop`）の候補は、そのうち `plan-progress` にも載る課題に限る。読み取りが誤りを返したときの区間とレーンの扱いは、実行の設計の「[区間と結果の行](../design/execution.md#区間と結果の行)」にある。

### 契約の照合

`npm run ndf-contract`（`node tools/checks/src/ndf-contract-check.ts [--root <作業ツリー>] [--summary <要約のファイル>]`）は次の順で動く。

| 順 | 処理 | 失敗したとき |
| --- | --- | --- |
| 1 | 引数を読む | 終了コード 2 |
| 2 | `ndf-pin.json` から固定の点を読む | 終了コード 2 |
| 3 | 作業ツリー（`--root`。省けば今のディレクトリ）から使い方の書き出しを読む | 読めない・形が違えば終了コード 2。無ければ、契約を取得せずに `fail: no-contract-use <固定の点>` を標準出力と要約に出し、終了コード 1。`read:` の行は出さない |
| 4 | 一時ディレクトリ（`RUNNER_TEMP` か OS の一時ディレクトリの下）を作り、固定の点と先端の契約を取得する | 固定の点を取得できなければ終了コード 2。先端は警告を出して照合しない |
| 5 | 固定の点と先端のそれぞれを 6 項目で照合する | — |
| 6 | 通知・差分・食い違いの行を出し、要約を追記し、一時ディレクトリを消す | 要約に書けなければ終了コード 2 |

書き出しは、照合のスクリプトの置き場ではなく作業ツリーから解決する。`@nd-factory/contracts` のパッケージ本体を Node と同じ探し方で引き、作業ツリーの内側にあり、`package.json` の `name` が `@nd-factory/contracts` であることを確かめる。そのうえでパッケージ自身から `./ndf-contract-use` を解決する。パッケージが書き出しを持たない（`ERR_PACKAGE_PATH_NOT_EXPORTED`）ときだけ「無い」とし、パッケージを引けない・作業ツリーの外へ解決される・読み込みの中で例外が出るときは「読めない」とする。

取得は、NDF のリポジトリ（`https://github.com/devbasex/ai-plugins`）から 1 つのコミットを深さ 1・タグなしで取り、`plugins/ndf/contracts/` の次の 6 つのファイルを読む。先端は `git ls-remote --symref` で `HEAD` が指すブランチを引いて取得する。固定の点が 40 桁の 16 進でない・取ったコミットが固定の点と違う・ファイルが無い・JSON でないときは取得の失敗にする。

- `version.json`
- `domains/entrypoint-cases.json`
- `domains/entrypoints.json`
- `domains/env.json`
- `domains/ndf-files.json`
- `hooks/unattended-report.json`

6 項目の中身は次のとおりである。どの項目も、契約のファイルの形が読めなければ、その項目の食い違いにする。実行の設計の「[契約の照合の定期の検査](../design/execution.md#契約の照合の定期の検査)」の表の「何を照合するか」の行と同じ内容である。

| # | 照合すること |
| --- | --- |
| 1 | `entrypoint-cases.json` のすべてのサンプル（固定の点では 26 件）について、参照するインタフェースの id が `entrypoints.json` にあるかを先に確かめる。この段は使うインタフェースで絞らない。絞った後に確かめると、使うインタフェースのサンプルの参照先が壊れたときに、そのサンプルが絞り込みで外れて見落とすためである。次に、使うインタフェースへのサンプル（固定の点では 21 件）だけを `judgeCall` へ通し、`valid` と同じ判定になるかを比べる。判定が例外を投げても食い違いにする |
| 2 | `version.json` の `history` の最後の行（バージョンと sha256）が、受ける組にある。`history` が空でも食い違いにする |
| 3 | 使い方の `env` の組ごとに、名前がそのインタフェースの `env` 列にあり、`env.json` の行にある。`envSetBy` に載せた名前は `set_by` がその値と同じで、載せない名前は `set_by` が `service` である |
| 4 | 使い方の読むファイルごとに、`ndf-files.json` の行があり、`reader` が `service` で、`path` が生成の値と同じで、`fields` が翻訳が読む項目を含む |
| 5 | `unattended-report.json` の `shape.items` が `REPORT_ITEMS` を含む。生成の区間の報告の形が契約の `shape` と同じ（`values` はキーの並び、`required` と `material` はオブジェクトのキーの順によらない値の全体）。`cases` のサンプル（固定の点では 16 件）を `readReport` へ通し、`result` と `errors` の有無がサンプルと同じ |
| 6 | 生成のファイルの固定の点が `ndf-pin.json` と同じ。使うインタフェースがすべて `entrypoints.json` にあり、生成した行の `kind`・`target`・`lead`・`args`・`env`・`files` が契約の行と同じ。値は出さない（行が長くなるため） |

固定の点で食い違えば、生成のし忘れか、生成のファイルを手で書き換えたことを表す。先端で食い違えば、上流が使う部分の決まりを変えたことを表す。

標準出力の行の形は次のとおりである。

| 行 | 出すとき |
| --- | --- |
| `fail: no-contract-use <固定の点>` | 書き出しが無い |
| `read: fixed <コミット>`・`read: tip <コミット>` | 契約を取得できた |
| `checked: fixed <コミット> 1-6`・`checked: tip <コミット> 1-6` | 6 項目を照合した |
| `notice: <コミット> の ask-journal が fields を持つ: <項目>（#41 の決定 106）` | 固定の点か先端の `ndf-files.json` の `ask-journal` の行が `fields` を持つ。食い違いには数えず、終了コードも変えない |
| `diff: shape.<キー> に足された: …`・`… から消えた: …`・`diff: shape.material.<キー> が変わった: …` | 先端の `unattended-report.json` の `shape.values`・`shape.items`・`shape.required`（値ごとの `always` と、条件ごとの `need`）・`shape.material` が固定の点と違う。照合が通っても出す |
| `mismatch: <fixed か tip> <番号> <契約のファイル>[ <id>]: <説明>` | 食い違いがある |

要約のファイル（`--summary`）には、見出し `## NDF の契約の照合` の下に、上の `read:`・`checked:`・`fail:`・`notice:`・`diff:` の行と、固定の点と先端の食い違いの表（照合した先・番号・契約のファイル・サンプルの id・食い違い）を Markdown で追記する。先端を取得できなかったときは、その旨の行を足す。

終了コードは次のとおりである。

| 終了コード | 意味 |
| --- | --- |
| 0 | 固定の点で食い違いが無い（先端の食い違いは並べるだけ） |
| 1 | 固定の点で食い違う、または書き出しが無い |
| 2 | 引数の誤り・`ndf-pin.json` を読めない・書き出しを読めない・固定の点の契約を取得できない・要約に書けない |

### 上流の不足を食い違いにしない

固定の点 `8d22be7` には次の 4 件が残る。どれも照合の 6 項目が読まない箇所にあるため、食い違いにならない。

| 件 | 残っている姿 | 照合が読まない理由 |
| --- | --- | --- |
| `block-next` の `source`（[#47](https://github.com/devbasex/nd-factory/issues/47)） | 無い `forms/ndf-next-block.json` を指す | 照合はインタフェースの行の `source` を読まない |
| `report-unattended` の `source`（[devbasex/ai-plugins#3947](https://github.com/devbasex/ai-plugins/issues/3947) の依頼 2） | 無い `forms/unattended-report.json` を指す | 同上 |
| `ask-journal` の `fields`（同じ課題の依頼 1） | `fields` が無い | 使い方のデータの `ask-journal` は翻訳が読む項目を持たない（実行の設計の決定 106）。上流が `fields` を足したら `notice:` の行で知らせる |
| `次のコマンド:` の項目（同じ課題の依頼 3） | `shape.items` に無い | `REPORT_ITEMS` に載せない |

### 生成のコマンド

`npm run ndf-contract:sync`（`node tools/checks/src/ndf-contract-check.ts sync [--root <作業ツリー>]`）は次の順で動く。

| 順 | 処理 | 失敗したとき |
| --- | --- | --- |
| 1 | 引数（`--root` だけ）を読む | 終了コード 2 |
| 2 | `ndf-pin.json` から固定の点を、手で書くデータから `entrypoints` を読む。手で書くデータは `ndfContractUseData` の形だけで確かめ、`ndfContractUse` は読み込まない | 終了コード 2 |
| 3 | 固定の点の契約を取得する（照合と同じ取得の処理） | 終了コード 2 |
| 4 | `generateContractUse` で生成のデータを作り、`ndfContractUseGenerated` の形で確かめる | 手で書く id が契約の `entrypoints.json` に無い・行の `files` が指す読むファイルが `ndf-files.json` に無い・契約のファイルの形が読めない・生成のデータが形に合わないとき、`ContractUseSyncError` で `error: 生成できない: <理由>` を出し、終了コード 1。生成のファイルは書かない |
| 5 | 生成のファイルを 2 つの空白で字下げした JSON と最後の改行で直接書き、`wrote: <パス> <固定の点>` を出す | 終了コード 2 |

`generateContractUse` は、行を手で書く id の順に並べ、読むファイルを最初に現れた順に並べて重なりを除く。生成し直しても差分が出ないようにするためである。使わないインタフェースの行は入れない。

手で書くデータと生成のファイルが食い違っていても、生成のコマンドは起動できる。形を `ndf-contract-use-schema.ts` から読み、組み立てる `ndf-contract-use.ts` を読み込まないためである。

### ランナーが守ること

判定と読み取りはランナー（[#6](https://github.com/devbasex/nd-factory/issues/6)）も使う。ランナーは次を満たし、テストで確かめる。

#### 組み立てた呼び出しの検査

- 使うインタフェースのうちランナーが呼び出しを組み立てるもの（`skill-workflow` の Skill の引数・`block-next` のブロックの中身・読むファイルの相対パスなど）と、実行の場（ホステッド・手元のマシン）の組ごとに、組み立ての関数の出力（呼び出し文字列と環境変数の名前の一覧）を `ndfContractUse.judgeCall` へ渡し、真になることを単体テストで確かめる。テストの中で呼び出し文字列や名前を手で書かない
- 組み立ての関数に、契約の `args` に合わない引数（未知の旗など）や `env` 列に無い環境変数を足すと、このテストが落ちる

照合の 1 項目目は、判定が契約のサンプルと同じ答えを出すことだけを確かめ、ランナーの組み立ての関数は通さない。上流の先端でインタフェースの行が変われば、照合の 6 項目目が先端の食い違いとして並べるため、ランナーの組み立てが先端の契約に合わなくなる変化も定期の照合で気づける。

#### ファイルの読み取りの許可範囲

ランナーは、判定が真を返したパスでも、許可範囲の外のファイルを開かない。許可範囲は次のとおりである。

| 読む対象 | 許可範囲 |
| --- | --- |
| `spec` と、`path` が `.` でない `file` | 許可ディレクトリの配下のファイル。許可ディレクトリは、`file` では行の `env` の環境変数にランナーが指定した保存先、`spec` ではプラグインの根の下の `target` |
| `path` が `.` の `file` | ランナーが環境変数に指定したファイルそのもの（`file-issue-request` は `NDF_ISSUE_REQUEST_FILE`）。シンボリックリンクや別のファイルへの付け替えは拒否する |

許可範囲の外を開かない方法は、ランナーの設計で決めて承認を取る。その設計は少なくとも次を満たす。

- 許可範囲の確認は、ファイルを開く OS の呼び出しの中で行わせる（Linux なら `openat2(2)` の `RESOLVE_BENEATH` が候補）。確かめてから開く実装は、確かめた後にパスの途中をリンクへ差し替えられると外を開く。開いた後に確かめる実装は、外のファイルを一度は開く
- 許可ディレクトリは、NDF を起動する前に特定してその実体を開き（ディレクトリのファイル記述子など）、NDF の実行が終わるまで閉じずに持ち続ける。実行中の読み取りは毎回その実体を起点に開き、設定のパスを解決し直さない。開けない・持ち続けられない実行の場では、起動前に理由を返してレーンを始めない。デバイス番号と inode 番号の照合は代わりにならない（削除の後に inode 番号が別のディレクトリに再利用されうる）
- `file` は照合済みの相対パスをそのまま使う。`spec` は呼び出し文字列から先頭の `target/` を取り除いた残りを `target` から開く（そのまま渡すと `target` が二重になる）
- 選んだ仕組みに要るカーネルとコンテナランタイムの条件を書き、起動のときに使えるかを検査する。使えなければ起動前に理由を返し、ほかの開き方へ切り替えない（たとえば Docker Engine の既定の seccomp プロファイルが `openat2` を許すのは 20.10 から）
- 起票の依頼ファイルは、NDF の実行ユーザーが追記でき、そのパスを構成するどのディレクトリも NDF の実行ユーザーが差し替えられない置き場に置く
- 承認の画面に出す依頼は 1 回読んだ中身から組み立て、承認の後に読み直さない

ランナーのテストは一時ディレクトリに許可範囲とその外のファイルを作り、境界の外は、ファイルを開く OS の呼び出しがファイル記述子を返さずに失敗したことで確かめる（開いてから拒否する実装を見逃さないため、時間切れでは判定しない）。どの場合も、外のファイルの中身が戻り値にも進捗の事象にもログにも出ない。

| 用意するもの | 確かめること |
| --- | --- |
| 保存先の中に、判定が真にする相対パス（例 `s1/8-release-request-state/progress.jsonl`）で外のファイルを指すリンクを置く | 判定は真。外を開く呼び出しは失敗し、読み取りを失敗にする |
| 保存先の中のディレクトリ（例 `s1`）を外のディレクトリへのリンクにする | 同上 |
| `target`（例 `contracts/schemas/io`）の下に外のファイルへのリンクを置く | 同上 |
| 保存先の中で、保存先の中のファイルを指す相対のリンクを置く | 読み取りは成功し、リンク先の中身を返す |
| `target` の下の通常のファイル `check.args.schema.json` を、`contracts/schemas/io/check.args.schema.json` で読む | 判定は真。読み取りは成功する（`target` を二重にたどらない） |
| NDF の起動後に、保存先か `target` のパスを外のディレクトリへのリンクに差し替える | 起動前の実体のファイルを返すか失敗する。差し替え先を開く呼び出しは成功しない |
| NDF の起動後に、保存先か `target` を `rename` で退け、同じパスに別の通常のディレクトリを置く | 同上 |
| NDF の起動後に、保存先か `target` を中身ごと消し、同じパスに別のディレクトリを作る（inode 番号の一致は条件にしない） | 読み取りは失敗する。新しいディレクトリを開く呼び出しは成功しない |
| 起動前に保存先か `target` を開けない実行の場を偽物で作る | NDF を起動せず、理由を返してレーンを始めない |
| `NDF_ISSUE_REQUEST_FILE` のファイルに正常な起票依頼の 1 行（`{repo, title, body, labels}`）を書き、`.` で読む | 判定は真。読み取りは成功し、その 1 行を返す |
| `NDF_ISSUE_REQUEST_FILE` のパスを別のファイルへのリンクに差し替える | 読まずに読み取りを失敗にする |
| `NDF_ISSUE_REQUEST_FILE` のパスに別の通常のファイルを `rename` で置き直す | 読まずに読み取りを失敗にする。置き直した依頼はどこにも出ない |
| 依頼ファイルに NDF の実行ユーザーで 1 行追記し、続けてパスを構成する各ディレクトリの差し替えを試す | 追記は成功してランナーが読む。どの差し替えも OS の権限で失敗する |

#### 承認資料の材料の URL

承認資料に載せる材料の URL の受け入れ条件・確かめる順番・拒否の理由のコード・URL の取り出し方は、実行の設計の「[承認資料](../design/execution.md#承認資料)」にある。読み取りは材料の欄が `https://` で始まるかだけを見るため、署名付き URL や共有リンクを防がない。条件を当てるのはランナーである。

ランナーのテストは、GitHub の API を差し替えた偽物を使う。拒否するどの場合も、承認の依頼・問い・承認資料は 1 件も送らず、区間とレーンを `material_url_rejected` で失敗にする進捗の事象を 1 件送る。理由は位置（どの欄の何番目か）と拒否の理由のコードだけを持ち、URL の全体・ホスト名・署名やトークンの値は、理由にも進捗の事象にもログにも出ない。例の値はどれも作り物である。

| 報告 | 結果 |
| --- | --- |
| 材料の欄が `https://acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf?X-Amz-Signature=0000`・`https://github.com/acme/app/pull/1?token=0000`・`https://user:pass@github.com/acme/app/pull/1`・`https://docs.example.com/share/abcd` | 拒否。順に `host_not_allowed`・`query_present`・`userinfo_present`・`host_not_allowed`（表の上から最初に合わない条件のコードだけ） |
| `材料: 本文` で、節に `[計画](https://acme-bucket…?X-Amz-Signature=0000)`・`<https://docs.example.com/share/abcd>`・`<a href="https://docs.example.com/share/abcd">計画</a>`・`http://github.com/acme/app/pull/1` | 拒否。`http://github.com/…` だけ `scheme_not_https`、ほかは `host_not_allowed` |
| `材料: 本文` で、節に `[計画](//acme-bucket…?X-Amz-Signature=0000)`・`www.example.com/share?token=0000`・参照の定義 `[計画]: docs.example.com/share/abcd`・裸の `docs.example.com/share/abcd` | 拒否。`www.` の形だけ `scheme_not_https`（`http://` を補った後に当てる）、ほかは `url_not_absolute` |
| `材料: 本文` で、節のインラインのコードかコードブロックに `https://acme-bucket…?X-Amz-Signature=0000` | 拒否。`host_not_allowed`（コードの中の URL も見つける） |
| 材料の欄が `https://github.com:443/acme/app/pull/1`・`https://github.com/acme/app/./pull/1`・`https://github.com/acme/app/blob/main/0000secret`・`https://github.com/acme/app/pull/1/0000secret`・`https://github.com/acme/app/pull/1#token=0000` | 拒否。順に `port_present`・`path_not_allowed`・`path_not_allowed`・`path_not_allowed`・`fragment_not_allowed`（ブラウザーが開く URL に直す前の文字列で当てる） |
| 材料の欄が `https://github.com/acme/app/blob/<40 桁>/0000secret`（偽物の API が「見つからない」）か `https://github.com/ACME/app/pull/1`（リポジトリの応答の `full_name` が `acme/app`） | 拒否。`ref_unverified` |
| 材料の欄が `https://github.com/acme/app/blob/<40 桁>/docs/%e8%a8%ad%e8%a8%88.md`（小文字の 16 進のパーセントエンコード） | 拒否。`path_not_allowed` |
| 材料の欄が `…/pull/1#discussion_r1`・`…/issues/2#issuecomment-3`・`…/commit/<40 桁>`・`…/blob/<40 桁>/docs/plan.md#L10-L20`・`…/blob/<40 桁>/docs/%E8%A8%AD%E8%A8%88%20%E6%9B%B8.md` のどれか、または `材料: 本文` で節のリンク先がそれだけ。偽物の API は実際の応答の形で返す（`full_name` を持つのはリポジトリの応答だけ） | 承認の依頼を送る。承認資料の材料の URL の並びと要約値の材料は、報告の URL と 1 文字も違わない |
| 材料の欄が `…/pull/1#discussion_r9`（コメントが無い）・`…/issues/2#issuecomment-4`（`issue_url` が `…/issues/5`）・`…/blob/<40 桁>/docs/plan.md#L30`（ファイルが 20 行） | 拒否。`ref_unverified` |
| 材料の欄が `…/pull/1/files#diff-<64 桁>` か `…/commit/<40 桁>#issuecomment-1` | 拒否。`fragment_not_allowed` |
| 区分が `ndf-gate:1`・承認ゲートが「設計 Pull Request のマージ」で、項目「Pull Request」が `…/pull/1?token=0000`・`…/pull/1/files`・`…/pull/1#issuecomment-3` | 拒否。順に `query_present`・`path_not_allowed`・`fragment_not_allowed`。その Pull Request を API で読まない |
| 同じ条件で、項目「Pull Request」が `#34` か `acme/app#34` | 拒否。`url_not_absolute` |
| 同じ条件で、項目「Pull Request」が `https://github.com/acme/app/pull/1` | 承認の依頼を送る。承認資料の Pull Request の URL は、リポジトリの `full_name` と Pull Request の `number` から組み立てた値と同じ |
| `材料: 本文` で、節に `<img srcset="https://docs.example.com/share/a.png 1x, https://docs.example.com/share/b.png 2x">` | 拒否。2 つの URL のそれぞれで `host_not_allowed` |
| `材料: 本文` で、節に受け入れる URL だけと `<details>` の HTML | 承認の依頼を送る。承認資料の本文は `<details>` を持たず `&lt;details>` を持つ |
| `材料: 本文` で、`## 判断の材料` の見出しが 2 つあり、1 つ目の節にコードブロックの中の見出し風の行と署名付き URL がある | 承認の依頼を送る。本文は 2 つ目の節で、読み取りが返した節と同じ |
| `材料: 本文` で、節にリンクの表示文字列・画像の代替テキスト・タイトルとして `https://docs.example.com/share/abcd` があり、リンク先は受け入れる URL | 拒否。`host_not_allowed` |
| 項目「質問」「承認ゲート」「区分」に署名付き URL・共有 URL・`?token=` 付きの URL・スキームの無い共有 URL がある | 拒否。順に `host_not_allowed`・`host_not_allowed`・`query_present`・`url_not_absolute`。問いと題にも載せない |
| `ask.jsonl` の MVV 判定の助言に署名付き URL か共有 URL のリンクがある | 拒否。位置は MVV 判定の助言、コードは `host_not_allowed` |
| 区分が `ndf-gate:1`、項目「課題」が `#12 #13 見て`、`plan-progress` に載る課題が #12 と #14 | 承認の依頼を送る。対象の課題番号は #12 と #13 で、`--drop` の候補は #12 だけ |
| `材料: 本文` で、`<div>` で始まる HTML のブロックの中に見出し風の行と署名付き URL があり、その後に文書の直下の見出しの節がある | 承認の依頼を送る。本文は文書の直下の見出しの節だけ |
| `材料: 本文` で、`## 判断の材料` の行がコードブロックの中にしか無い | 送らない。`report_item_invalid` で失敗にし、理由は `material_heading_missing` と `材料` だけ |
| `材料: 本文` で、節に受け入れる URL と、`node:fs`・`import { readFile } from "node:fs/promises";`・`C/hooks/unattended-report.json` を含むコード | 承認の依頼を送る（これらは URL とみなさない） |
| 結果の値が `保留 https://acme-bucket…?X-Amz-Signature=0000` | 送らない。`result_value_unknown` で失敗にし、理由はこのコードだけ（項目の誤りでないので `report_item_invalid` に包まない） |
| 材料の欄が `https://acme-bucket…?X-Amz-Signature=0000 not-a-url` | 送らない。`report_item_invalid` で失敗にし、理由は `material_form_invalid` と `材料` だけ |

## データ・設定

| ファイル | 中身 |
| --- | --- |
| `ndf-pin.json` | `{"ndf_ref": "8d22be728e81983e5051799bcee4637ff65f0071"}` |
| `packages/contracts/data/ndf-contracts.json` | `{"accepted": [{"version": 16, "sha256": "c50ef840a72ab71a15023a46a37d050c36ec3aae6d1be6092b7f9dc7f3c0a726"}]}`。形の決まりは [スキーマの正本と横断の部品](contracts-and-core.md#データのファイル) にある |
| `packages/contracts/data/ndf-contract-use.json` | 上の「使い方のデータ」の手で書くデータ |
| `packages/contracts/data/ndf-contract-use.generated.json` | 上の「使い方のデータ」の生成のファイル |
| `packages/contracts/package.json` | `exports` に `./ndf-contract-use` と `./ndf-contract-use-schema`。`dependencies` に `mdast-util-from-markdown`・`mdast-util-gfm`・`micromark-extension-gfm` |
| `package.json` | スクリプト `ndf-contract` と `ndf-contract:sync` |

照合と生成のコマンドが読む環境変数は `RUNNER_TEMP`（一時ディレクトリの置き場。無ければ OS の一時ディレクトリ）だけである。

## 外部連携

| 相手 | 使い方 |
| --- | --- |
| NDF のリポジトリ（`https://github.com/devbasex/ai-plugins`） | `git ls-remote` と `git fetch --depth 1 --no-tags` で、公開のリポジトリから資格情報なしで取得する。`GIT_TERMINAL_PROMPT=0` で認証の問い合わせを出さない |
| CI（`.github/workflows/ndf-contract.yml`） | Pull Request・main への push・毎日の定期で照合を動かす。AWS の資格情報を持たない |

## エラー処理

| 場面 | 扱い |
| --- | --- |
| 手で書くデータか生成のファイルが形に合わない・互いに食い違う | `ndf-contract-use.ts` の読み込みが `DataFileError` で失敗し、`npm run check` が落ちる。照合は「書き出しを読めない」で終了コード 2。生成のコマンドは起動できるので、`npm run ndf-contract:sync` で直す |
| 契約の `args` が正規表現として読めない | 判定はその正規表現に一致しないとみなす。照合では `valid` が真のサンプルとの食い違いとして 1 項目目に出る |
| 区間の報告が契約の形に合わない | 読み取りは例外を投げず、`errors` に入れて返す |
| 先端の契約を取得できない | 標準エラーに `warning:` を出し、先端を照合せずに続ける。要約に先端を照合しなかった行を足す |
| 生成のファイルの書き込みが途中で止まる | 一時ファイルを使わずに直接書く。壊れても `npm run check` と照合の 6 項目目が落とし、打ち直せば直る |

## セキュリティ

- 読み取りの誤りの一覧は、誤りのコードと項目の名前だけを持つ。報告の中の値（署名付き URL・共有トークンなど）を入れない
- 判定は、`file` と `spec` のパスの文字列が許可ディレクトリの外を指さないことだけを確かめる。シンボリックリンクを解決した実際の読み取り先の制限はランナーが行う（上の「ファイルの読み取りの許可範囲」）
- 照合は書き出しを作業ツリーの内側からだけ解決し、外へ解決されたら読まない
- 照合と生成は資格情報を使わない。生成のファイルとフィクスチャには、契約の説明の文の列（`summary`・`source` など）と `shape.values` の説明の文を写さない

## 運用

固定の点を新しい配布へ上げるときは、次の値を 1 つの Pull Request で直す。

1. 配布のタグが指すコミットを `gh api repos/devbasex/ai-plugins/git/ref/tags/` の後ろにタグの名前を付けた呼び出しなどで確かめ、`ndf-pin.json` の `ndf_ref` に書く
2. そのコミットの `plugins/ndf/contracts/version.json` の `history` の最後の行を、`packages/contracts/data/ndf-contracts.json` の受ける組にし、`packages/contracts/test/data.test.ts` の期待値も直す
3. `npm run ndf-contract:sync` を打ち、生成のファイルをコミットする
4. 実行の設計の決定 104 と「NDF との契約」の表の「契約のバージョンの照合し」・「NDF 11 の名前」の行の値と、この文書の値を直す
5. `npm run check` と `npm run ndf-contract` を打つ

照合の 2 項目目は契約のバージョンと sha256 だけを比べ、固定の点がタグの指すコミットかどうかは比べない。手順 1 の確かめは手で行う。

使うインタフェースを増やすか減らすときは、実行の設計の「使うインタフェース」の表・手で書くデータの `entrypoints`・単体テストの 11 の id のリストを同じ変更で直し、`npm run ndf-contract:sync` を打つ。使わないインタフェースのサンプルが契約で変わっても照合は気づかないため、使い始める変更で比べる範囲を広げる。

上流が区間の報告の `rule` を変えたら、読み取りの規則と関数を同じ変更で直す。`shape` の変化は、照合の 5 項目目と先端の `diff:` の行で気づける。

## テスト観点

| 観点 | 置き場 |
| --- | --- |
| 固定の点の `version.json` の最後の行と受ける組が同じ 1 組である（形は既存のデータのテストが縛る） | `packages/contracts/test/data.test.ts` |
| 使い方の `entrypoints` の id の集合が 11 の id のリストと等しい（1 件欠けても余っても落ちる）。`acceptedVersions` が `NDF_CONTRACTS.accepted` と同じ | `packages/contracts/test/ndf-contract-use.test.ts` |
| `buildContractUse` が、形の誤り・id の不一致・生成に無い `files` の id・使うインタフェースに無い `env` の `entrypoint` で `DataFileError` を投げる | 同上 |
| 固定の点のサンプルのうち使うインタフェースへの 21 件で、判定が `valid` と同じ。`block-next` の `resume`（前置きなし）と `resume-loop`（前置きあり）がどちらも真。`spec-io-args` が真で `spec-outside` が偽。`loop-bad-budget`・`unknown-flag` が偽（全体の一致）。`terminal-env` が偽（`env` の外の名前）。`..`・`.`・空の成分を含むパスが偽。使わないインタフェースと読めない正規表現で偽 | 同上（フィクスチャ `fixtures/ndf-contract-8d22be7/entrypoint-cases.json`） |
| `filePathPattern` で、`<名前>` が `/` を含む文字列に一致せず、`.` が `.` だけに一致し、`path` の特殊文字が任意の文字に一致しない | 同上 |
| 固定の点の区間の報告のサンプル 16 件で、`result` と `errors` の有無がサンプルと同じ | 同上（フィクスチャ `fixtures/ndf-contract-8d22be7/unattended-report.json`） |
| 同じ項目の後勝ち。結果の行が 2 つあれば最後を採る。`判断が要る` の `材料: 無し` が誤りで、`完了`・`できなかった` の `材料: 無し` は誤りでない。条件つきで要る項目（`区分: ndf-gate:…` の `承認ゲート`）を確かめる。コードブロック（`` ``` `` と `~~~~`）・HTML のブロック・リストの中の見出し風の行を見出しとみなさず、最後の見出しの節を返し、節が次の ATX か Setext の見出しの前で終わる。URL を空白で区切った並びを受ける | 同上 |
| 材料の欄が `https://acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf?X-Amz-Signature=0000 not-a-url` のとき、誤りの一覧が `material_form_invalid`・`材料` の 1 件だけで、文字列にしても値を含まない | 同上 |
| 作り物の契約と使い方で食い違いが 0 件。使わないインタフェースのサンプルの `valid` を逆にしても食い違いが出ない | `tools/test/ndf-contract-check.test.ts`（フィクスチャ `tools/test/fixtures/ndf-contract-8d22be7/`） |
| 使うインタフェースへのサンプル 1 件の参照先を `no-such-entrypoint` にすると、そのサンプルの id を含む 1 項目目の行が出る。生成の `target`・`path`・`required`・`commit` だけを変えると、それぞれ 6・4・5・6 項目目の食い違いになる | 同上 |
| 書き出しが無く、取得先が取得できない値でも、`fail: no-contract-use <固定の点>` と終了コード 1 で、`read:` の行を出さない。食い違いが無ければ終了コード 0 で `checked:` の行を出し、`skip:` の行を出さない | 同上 |
| `ask-journal` に `fields` を足した契約で、`notice:` の行が標準出力と要約の両方に出て、終了コードと食い違いの件数が変わらない | 同上 |
| 生成が、フィクスチャの契約から手で書く id の行・`path`・区間の報告の形を作り、コミットした生成のファイルと同じになる。使わないインタフェースの行が入らない。契約に無い id で `ContractUseSyncError` と終了コード 1 で、生成のファイルを書き換えない。固定の点を取得できないと 2。手で書く id を 1 件足して生成のファイルと食い違わせた作業ツリーでも起動して書き直す | `tools/test/ndf-contract-sync.test.ts`（生成の形）・`tools/test/ndf-contract-check.test.ts`（`mainNdfContractSync`） |
| 固定の点で、照合が `checked: fixed 8d22be728e81983e5051799bcee4637ff65f0071 1-6` を出し、終了コード 0 で終わる | 手元と CI の `npm run ndf-contract` |

## 関連リンク

- 実行の設計の [NDF との契約](../design/execution.md#ndf-との契約)（使うインタフェース・決定 104・契約の照合の定期の検査）
- 実行の設計の [区間と結果の行](../design/execution.md#区間と結果の行) と [承認資料](../design/execution.md#承認資料)
- [スキーマの正本と横断の部品](contracts-and-core.md)
- 課題: [#136](https://github.com/devbasex/nd-factory/issues/136)（NDF の固定の点を上げて照合を必ず実行する）・[#6](https://github.com/devbasex/nd-factory/issues/6)（ランナー）・[#47](https://github.com/devbasex/nd-factory/issues/47)・[devbasex/ai-plugins#3947](https://github.com/devbasex/ai-plugins/issues/3947)
