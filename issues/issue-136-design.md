# NDF との契約: 固定の点を 11.0.36 へ上げ、契約の照合が 6 項目を必ず実行する（#136）

nd-factory が使う NDF の固定の点は 11.0.12（契約バージョン 8）のままで、契約の照合（`npm run ndf-contract`）は使い方の書き出しが無いために何も照合せず成功で終わっている。固定の点を最新の配布 `ndf--v11.0.36`（契約バージョン 16）へ上げて受ける組を直し、この課題で使い方の書き出しをスキーマの正本（`packages/contracts`）に置いて、書き出しが無ければ照合が失敗するようにする。調べた結果、新しい固定の点でも #47 と上流の不足 3 件は照合の食い違いにならないため、この 4 件は要求のとおり範囲に入れない。採らなかった案は「決定の記録」に、比べた候補は末尾の「外部の調査」にある。

## 今の姿

何が起きたか・目的・受け入れ条件は要求仕様（[issue-136-requirements.md](./issue-136-requirements.md)、正は [#136](https://github.com/devbasex/nd-factory/issues/136) の本文）にある。この文書は「どう解くか」と「なぜその解き方か」だけを書く。

```mermaid
graph LR
  PIN["ndf-pin.json<br/>752a9cf（11.0.12・バージョン 8）"]
  ACC["data/ndf-contracts.json<br/>受ける組: バージョン 8"]
  CHK["契約の照合<br/>tools/checks/src/ndf-contract-check.ts"]
  USE["使い方の書き出し<br/>@nd-factory/contracts/ndf-contract-use<br/>（まだ無い）"]
  NDF["NDF の契約のファイル<br/>plugins/ndf/contracts/"]
  DOC["execution.md<br/>決定 104・NDF との契約"]
  PIN --> CHK
  NDF --> CHK
  USE -. 無いので skip .-> CHK
  ACC -. 照合されない .-> CHK
  DOC -. 値を書き写す .-> PIN
```

点線が、この変更で直す箇所である。設計に要る今の構造は次のとおりである。

### 契約の照合の作り

- 照合（`tools/checks/src/ndf-contract-check.ts`）は、2 つのコミットから契約のファイルを読む。2 つのコミットは、固定の点と、NDF のデフォルトブランチの先端である。読むファイルは次の 6 つである
  - `version.json`
  - `domains/entrypoint-cases.json`
  - `domains/entrypoints.json`
  - `domains/env.json`
  - `domains/ndf-files.json`
  - `hooks/unattended-report.json`
- 照合の 6 項目の中身は、[execution.md の「NDF との契約」](../docs/design/execution.md#ndf-との契約) の表の「何を照合するか」の行にある。この文書は項目を番号（1 項目目〜6 項目目）で指す
- 照合の 6 項目が相手にするのは、`@nd-factory/contracts/ndf-contract-use` の `ndfContractUse` である。このモジュールは作業ツリーから解決する。照合の側は、その形を型 `NdfContractUse` として自分の中にコピーして持っている（#2 が書き出しを置くときに合わせる前提だった）
- 書き出しが無いとき、照合は `skip: no-contract-use` を出して終了コード 0 で終わる。定数 `CONTRACT_USE_REQUIRED` が偽だからである。この定数を真にするのは #2（形の正本と横断の部品を作る課題）の予定だった。#1 の設計は、使い方の書き出しを置いて定数を真にする作業を、要件 K2-6 として #2 に割り当てていた（[#1 の設計の K2-6](../docs/design-process/issue-1/design.md)）
- `packages/contracts` にあるのは、受ける組のデータと答えの語（`src/ndf.ts`）だけである。受ける組のデータは `data/ndf-contracts.json` にあり、`src/data.ts` の `NDF_CONTRACTS` が読む。呼び出しの判定・区間の報告の読み取り・使い方のデータは無い。区間の報告は `hooks/unattended-report.json` が形を定める報告で、execution.md の「[区間と結果の行](../docs/design/execution.md#区間と結果の行)」が扱う

### 新しい固定の点で契約がどう変わったか

2026-11-25 時点の最新の配布のタグは `ndf--v11.0.36` である（軽量のタグ。コミット `8d22be728e81983e5051799bcee4637ff65f0071`）。その `version.json` の `history` の最後の行は、バージョン 16・sha256 `c50ef840a72ab71a15023a46a37d050c36ec3aae6d1be6092b7f9dc7f3c0a726` である（外部の調査の STD1）。照合が読む 6 つのファイルを 11.0.12 と比べると、nd-factory が使う部分は変わっていない。

| 契約のファイル | 11.0.12 から 11.0.36 への差 | nd-factory が使う部分への影響 |
| --- | --- | --- |
| `domains/entrypoints.json` | 15 行のまま。`spec-ndf_settings` の `files` から `context` が消えた | 無い（`spec-ndf_settings` は使わない） |
| `domains/entrypoint-cases.json` | 変わらない（26 件） | 無い |
| `domains/env.json` | 中継・アカウント・推論の手段の名前が増えた。`set_by: service` の 6 つは変わらない。`GH_TOKEN`・`NDF_STATE_HOME` の `user` も変わらない | 無い |
| `domains/ndf-files.json` | `reader: service` の行と `fields` は変わらない。`ask-journal` は `fields` を持たないまま | 無い |
| `hooks/unattended-report.json` | 変わらない（`shape` とサンプル 16 件） | 無い |
| `version.json` | バージョン 8 からバージョン 16 へ | 受ける組を直す |

### #47 と上流の不足 3 件は食い違いにならない

要求の「未決」の 2 つ目への答えである。次の 4 件はどれも新しい固定の点に残る。4 件が残っている箇所は、照合の 6 項目のどれも読まない。このため食い違いとして出ない。

| 件 | 残っている姿（`8d22be7`） | 照合が読まない理由 |
| --- | --- | --- |
| `block-next` の `source`（[#47](https://github.com/devbasex/nd-factory/issues/47)） | 無い `forms/ndf-next-block.json` を指す | 照合はインタフェースの行の `source` を読まない |
| `report-unattended` の `source`（[devbasex/ai-plugins#3947](https://github.com/devbasex/ai-plugins/issues/3947) の依頼 2） | 無い `forms/unattended-report.json` を指す | 同上 |
| `ask-journal` の `fields`（同じ課題の依頼 1） | `fields` が無い | 使い方のデータに `ask-journal` の項目を載せない（execution.md の決定 106）。`fields` が足されたときの扱いは、表の後の段落にある |
| `次のコマンド:` の項目（同じ課題の依頼 3） | `shape.items` に無い | 使い方のデータの区間の報告の項目に載せない |

上流が `ask-journal` に `fields` を足しても、照合は失敗にせず、既存の通知の行で知らせるだけにする。この扱いは今の照合の CLI（`contractNotices` と出力の処理）にあり、この変更では作り直さずに維持する。

- 4 項目目の食い違いには数えない。終了コードも変えない
- 照合の CLI は、固定の点と先端のそれぞれで、`ndf-files.json` の `ask-journal` の行に `fields` があれば、`notice: <コミット> の ask-journal が fields を持つ: <項目>` の行を出す
- 出力先は標準出力と、`--summary` で指定した要約のファイルの 2 つである
- この変更で、通知の条件と出力先を変えない

## 文脈と制約

- 固定の点は `ndf-pin.json` のキー `ndf_ref` の 1 か所だけに置く（AGENTS.md。参照の検査 `tools/ref-check` が落とす）
- 受ける組は `packages/contracts/data/ndf-contracts.json` の 1 か所だけに置く。固定の点を付け替える変更で、同じ Pull Request の中で直す（[execution.md の決定 104](../docs/design/execution.md)）
- NDF のバージョンの数字を読んで大小を比べる処理を書かない（execution.md の「NDF との契約」の表）
- スキーマの正本の中で画面が使うモジュールは、`node:` の組み込みを読まない。使い方の書き出しを使うのはランナー（[#6](https://github.com/devbasex/nd-factory/issues/6)）と照合だけだが、同じ決まりに従う。組み込みを読まない純粋な関数とデータで作る
- CI は AWS の資格情報を持たない。照合のワークフロー（`.github/workflows/ndf-contract.yml`）は変えない
- 反映のパイプラインの承認の手順（[docs/operations/pipeline-approval.md](../docs/operations/pipeline-approval.md)）は、照合の記録の `checked: fixed <固定の点> 1-6` の行を読む。この行の形は変えない
- 範囲に含まないもの（実行の契約の追い付き・上流の不足 3 件・#47・ランナーの起動のときの照合）は、要求の「対象範囲」のとおりである

## 解き方の全体像

```mermaid
graph LR
  PIN["ndf-pin.json<br/>8d22be7（11.0.36・バージョン 16）"]
  subgraph contracts["packages/contracts"]
    ACC["data/ndf-contracts.json<br/>受ける組: バージョン 16 の 1 組"]
    UD["data/ndf-contract-use.json（手で書く）<br/>使うインタフェースの id・渡す環境変数<br/>読む項目・区間の報告から読む項目"]
    UG["data/ndf-contract-use.generated.json<br/>使うインタフェースの行と読むファイルの path<br/>区間の報告の形（shape）<br/>（固定の点の契約から生成）"]
    UM["src/ndf-contract-use.ts<br/>ndfContractUse（型・判定・読み取り）"]
  end
  CHK["契約の照合<br/>書き出しが無ければ fail"]
  NDF["NDF の契約のファイル"]
  RUN["ランナー（#6。後で使う）"]
  ACC --> UM
  UD --> UM
  UG --> UM
  NDF -. npm run ndf-contract:sync .-> UG
  UM --> CHK
  PIN --> CHK
  NDF --> CHK
  UM -.-> RUN
```

- 固定の点は `ndf--v11.0.36` のコミット `8d22be7` を指す。受ける組は、バージョン 16 と sha256 `c50ef840…` の 1 組になる。execution.md の決定 104・「契約のバージョンの照合し」の行と、確定仕様の値は、実装の変更でそろえる
- スキーマの正本が、使い方の書き出し（`@nd-factory/contracts/ndf-contract-use`）を持つ。データは JSON に置く。データは 2 つのファイルに分ける。手で書くのは、使うインタフェースの id・Skill の名前の前置き（`ndf:`）・実行の場（ホステッド・手元のマシン）ごとに渡す環境変数・読む項目・区間の報告からランナーが読む項目の名前である。使うインタフェースの決まり（契約の行の列）・読むファイルの `path`・区間の報告の形（結果の値・結果ごとに要る項目・材料の形）は、固定の点の契約から生成する（決定 5）。呼び出しの判定と区間の報告の読み取りは、そのデータだけを使う純粋な関数にする。判定の種類ごとの照合の規則は決定 5、読み取りの規則は決定 7 にある。受ける組は既存の `NDF_CONTRACTS` を引き、コピーしない
- 型 `NdfContractUse` はスキーマの正本の 1 か所に置き、照合はそれを読み込む
- 照合は、書き出しが無ければ、契約を取得する前に `fail: no-contract-use` と終了コード 1 で終わる。skip の道と定数 `CONTRACT_USE_REQUIRED` は消す
- 新しい固定の点で `npm run ndf-contract` が 6 項目を照合し、固定の点の食い違いが 0 件で成功する

execution.md の変更は、直す時期で 2 つに分かれる。

| 箇所 | 直す Pull Request | 状態 |
| --- | --- | --- |
| F23（「契約の照合の定期の検査」の表の「何を照合するか」の行） | この設計の Pull Request | 済み。改訂の中身は下の表 |
| 「区間と結果の行」（報告の項目の誤りと材料の URL で区間を失敗にする行） | この設計の Pull Request | 済み |
| 「承認資料」の「材料の URL の受け入れ条件」 | この設計の Pull Request | 済み |
| 決定 104 と「NDF との契約」の表の「契約のバージョンの照合し」の行（固定の点・受ける組の値） | 実装の Pull Request | 未。固定の点を上げる変更と同じ Pull Request で直す |

「契約のバージョンの照合し」は execution.md の表の行の名前で、そのまま引く。

照合の 1・4・5・6 項目目の中身を変えるため、F23 をこの設計の Pull Request で改訂する。改訂の中身は次の表のとおりである。

| 項目 | 承認済みの F23 | この設計で改訂した後 | 決定 |
| --- | --- | --- | --- |
| 1 項目目 | `entrypoint-cases.json` の 26 件すべてのサンプルを判定へ通す | 26 件すべての参照先のインタフェースの id が `entrypoints.json` にあるかを先に確かめる（今の検査を残す）。その後、「使うインタフェース」の表の 11 のインタフェースへのサンプルだけを判定へ通す（固定の点では 21 件）。使い方のデータが 11 のインタフェースをちょうど持つことは、単体テストで縛る | 決定 4 |
| 4 項目目 | `reader: service` の行の `fields` が、翻訳が読む項目を含むか | 加えて、読むファイルの `path` が、固定の点の契約から生成した値と同じか | 決定 5 |
| 5 項目目 | `shape.values`・`shape.items`・`shape.required`・`shape.material` が、ランナーが区間の報告から読む値と項目を含むか。`cases` のサンプルを読み取りへ通し、`result` と `errors` の有無が同じか | 加えて、生成のファイルにある区間の報告の形（`values`・`required`・`material`）が、契約の `shape` の同じ項目と同じか。ランナーが読む項目の名前（手で書く）が `shape.items` にあるか | 決定 5 |
| 6 項目目 | F23 に記述が無い（[#1 の設計](../docs/design-process/issue-1/design-detail.md) の「使うインタフェースがインタフェースの表にある」だけ） | 生成のファイルが持つ固定の点が `ndf-pin.json` と同じか。使うインタフェースがインタフェースの表にあり、生成した行の `kind`・`target`・`lead`・`args`・`env`・`files` が契約の行と同じか | 決定 5 |

## 決定の記録

各決定の「根拠」に挙げる Value は、プロジェクトの MVV（バージョン 3）の判断の基準である。この文書で使う Value の要旨は次のとおりである。

| Value | 要旨 |
| --- | --- |
| Value 8 | 反映は差分を見て承認した範囲だけにする。CI は検査だけを行い、AWS の資格情報を持たない |
| Value 11 | 責務を分ける。業務の規則はドメインに置き、外部のシステムとの接続はインタフェースの裏に置いてテストで差し替えられるようにする。型の検査で誤りを早く見つける |
| Value 13 | 重複と冗長を作らない。同じ規則・定数・処理は 1 か所に置く。使わなくなったコード・設定・文書は残さない |
| Value 14 | テストを先に書き、変更のたびに自動のテスト・静的解析・型の検査を通す。設計の判断は理由と採らなかった案とともに残す |
| Value 17 | 目先の手間より、堅牢で長く保守しやすい形を選ぶ |

### 決定 1: 上流の最新の配布と同じ契約で作るため、固定の点を `ndf--v11.0.36` のタグのコミットにし、受ける組をバージョン 16 の 1 組にする

- **質問**: 固定の点をどの配布のタグへ上げ、受ける組に何組を持つか
- **選んだ案**: 設計の時点で最新の配布のタグ `ndf--v11.0.36` を固定の点にする（コミット `8d22be728e81983e5051799bcee4637ff65f0071`）。受ける組は、その点の `version.json` の最後の行の 1 組にする（バージョン 16・`c50ef840a72ab71a15023a46a37d050c36ec3aae6d1be6092b7f9dc7f3c0a726`）。execution.md の決定 104 は、同じ考え方のまま値だけをこの点に書き直す
- 採らなかった案: 開発に使っていた `ndf--v11.0.32`（バージョン 15）にする（2026-11-25 の時点で既に 4 つ後ろの配布があり、上げた直後に古い点になる。要求の前提 2 も最新の配布のタグを選ぶとしている）
- 採らなかった案: 受ける組にバージョン 15 と 16 の 2 組を持つ（動いているランナーがまだ無く、古い組を受ける理由が無い。照合が見る組も増える）
- 採らなかった案: デフォルトブランチの先端のコミットを固定の点にする（配布していない変更を含み、利用者の手元の NDF と同じにならない）
- **代償**: 実装を終える前に新しい配布が出ても、この変更では追わない。次の配布を取り込むときに、固定の点と受ける組を同じ Pull Request で直す手間は残る
- 作り方: 標準に倣う
- 比べた候補: STD1 / STD3
- 根拠: Value 8 / Value 13（MVV バージョン 3）。STD1

### 決定 2: 照合が必ず 6 項目を実行するため、使い方の書き出しを #2 を待たずにこの課題で置く

- **質問**: 使い方の書き出し（#1 の設計の K2-6）を、この課題で足すか、#2 が足すのを待つか
- **選んだ案**: この課題でスキーマの正本に書き出しを置く。#1 の設計が K2-6 として #2 に割り当てた中身を、この課題がまとめて引き受ける。中身は、使い方のデータ・呼び出しの判定・区間の報告の読み取り・必須への切り替えである。#2 の受け入れ条件には K2-6 の行が無いため、#2 の範囲の書き換えは要らない
- 採らなかった案: #2 が置くのを待つ（#2 は操作の表・型・ダミーデータなど広い範囲を持ち OPEN のままで、待つと受け入れ条件 4・5 をこのスプリントで満たせない。待つ間、照合は何も照合しないまま成功し続ける）
- **代償**: #2 の設計が K2-6 をもう一度書かないよう、#2 の設計の時点でこの課題の書き出しを読ませる必要がある。#1 の設計の記録（`docs/design-process/issue-1/`）は記録の時点のまま残し、書き直さない
- 根拠: Value 14 / Value 17（MVV バージョン 3）

### 決定 3: 同じ規則を 2 か所に持たないため、使い方の型・データ・関数をスキーマの正本の 1 つのモジュールに置き、受ける組は既存のデータを引く

- **質問**: 使い方の型とデータをどこに持つか
- **選んだ案**: 次のように置く
  - `packages/contracts/src/ndf-contract-use.ts` に、型 `NdfContractUse`・呼び出しの判定・区間の報告の読み取りを置き、`ndfContractUse` を書き出す
  - データは `packages/contracts/data/ndf-contract-use.json` に置き、zod の形で読む
  - 受ける組（`acceptedVersions`）は `NDF_CONTRACTS.accepted` をそのまま渡す
  - `package.json` の `exports` に `./ndf-contract-use` を足す
  - 照合は、型を `@nd-factory/contracts/ndf-contract-use` から型として読み込み、自分の中のコピーを消す。書き出しの実体は、今までどおり `--root` の作業ツリーから解決する
- 採らなかった案: 型を照合の側に残し、書き出しの側で合わせる（同じ形が 2 か所に分かれ、片方だけ直したときに型の検査で落ちない）
- 採らなかった案: 受ける組を使い方のデータにも書く（固定の点を上げるたびに 2 か所を直すことになり、片方の直し忘れを照合の 2 項目目が見落とす）
- **代償**: 照合のツールがスキーマの正本の型に依存する（`tools` は既に `@nd-factory/contracts` に依存しているので、依存は増えない）
- 根拠: Value 13 / Value 11（MVV バージョン 3）

### 決定 4: nd-factory が使わないインタフェースの決まりを持たないため、呼び出しの判定は使うインタフェースだけを受け、照合の 1 項目目は使うインタフェースのサンプルだけを比べる

- **質問**: 呼び出しの判定が受けるインタフェースの範囲を、契約の 15 行すべてにするか、nd-factory が使うインタフェースだけにするか
- **選んだ案**: 判定は、execution.md の「使うインタフェース」の表に載る 11 のインタフェースだけを受け、ほかのインタフェースの呼び出しは偽にする。11 のインタフェースは次のとおりである
  - `skill-workflow`・`block-next`・`report-unattended`
  - `hook-unattended-start`・`hook-unattended-stop`・`hook-unattended-end`
  - `file-plan-progress`・`file-journals`・`file-issue-request`
  - `gate-record`・`spec-io`

  照合の 1 項目目は、2 段で行う。先に、契約のサンプル（`entrypoint-cases.json`）のすべて（固定の点では 26 件）について、参照するインタフェースの id が `entrypoints.json` にあるかを確かめる。今の照合の CLI が行っているこの検査は、使うインタフェースで絞らずにそのまま残す。絞った後に確かめると、上流で使うインタフェースのサンプルの参照先 id が壊れたとき、そのサンプルが絞り込みで外れて照合が通ってしまうためである。次に、この 11 のインタフェースへの呼び出しだけを判定へ通す。固定の点の 26 件では 21 件を比べる。使わないインタフェース（`file-organizer`・`file-loop-record`・`spec-pages`・`spec-ndf_settings`）の 5 件は判定へ通さず、判定の食い違いにも出力の行にもしない

  照合の 1 項目目と 6 項目目は、どちらも使い方のデータの `entrypoints` から比べる対象を決める。このため、データから 1 件（たとえば `block-next`）が消えると、そのサンプルも契約の行も比べられず、照合は通ってしまう。これを防ぐため、承認済みの 11 件に対する網羅を単体テストで縛る
  - スキーマの正本の単体テスト（`packages/contracts/test/ndf-contract-use.test.ts`）に、上の 11 の id を書いたリストを置く。このリストは execution.md の「使うインタフェース」の表を写したもので、表を変えるときに同じ変更で直す
  - テストは、`ndfContractUse.entrypoints` の id の集合が、このリストとちょうど同じかを確かめる。1 件でも欠けるか余ると、テストが落ちて CI が失敗する
  - リストは承認した範囲を表す期待値で、データの規則の 2 つ目の置き場ではない。データとリストの片方だけを変えると落ちることが、このテストの目的である
- 採らなかった案: 照合の側だけで網羅を確かめる（照合が比べる対象をデータから決める限り、データから消えた id を照合は知る手段を持たない）
- 採らなかった案: 15 行すべてのインタフェースの決まりを持ち、26 件すべてを比べる（オーガナイザーやループの保存先のように、使わないと決めたインタフェースの決まりまで nd-factory が持ち続けることになる。execution.md の決定 73 と「使うインタフェースだけ」の決まりに合わない）
- **代償**: 使わないインタフェースのサンプルが契約で変わっても、照合は気づかない。そのインタフェースを使い始める変更で、使うインタフェースとサンプルの比べる範囲を同時に広げる必要がある
- 根拠: Value 13 / Value 11（MVV バージョン 3）

### 決定 5: 契約の行を手で写さないため、使うインタフェースの行と読むファイルの `path` を固定の点の契約から生成し、照合の 4 項目目と 6 項目目で契約の行と項目ごとに比べる

- **質問**: 呼び出しの判定と区間の報告の読み取りが使う上流の決まりを、どこから得て、契約との離れをどう見つけるか。決まりとは、インタフェースの種類・名前・前置きの語・引数の正規表現・入れてよい環境変数・読むファイルの相対パスの形と、区間の報告の結果の値・結果ごとに要る項目・材料の形である
- **選んだ案**: 上流の契約から機械的に取り出せる部分は、固定の点の契約から生成してコミットする。手で書くのは、ランナーに固有の設定だけにする

  | 置き場 | 中身 | 作り方 |
  | --- | --- | --- |
  | `packages/contracts/data/ndf-contract-use.json` | 使うインタフェースの id の一覧（決定 4 の 11 件）・Skill の前置き（`ndf:`）・実行の場ごとに渡す環境変数・`set_by` の許容（`envSetBy`）・翻訳が読む項目・区間の報告からランナーが読む項目の名前（`shape.items` のうち使うもの） | 手で書く |
  | `packages/contracts/data/ndf-contract-use.generated.json` | 生成の元にした固定の点のコミット・使うインタフェースの行（`kind`・`target`・`lead`・`args`・`env`・`files`）・その行の `files` が指す読むファイルの `path`（`ndf-files.json` の行）・区間の報告の形（`hooks/unattended-report.json` の `shape.values`・`shape.required`・`shape.material` をそのまま写したもの） | 生成する |

  - 生成は `npm run ndf-contract:sync` で行う。照合と同じ取得の処理（`fetchContract`）で `ndf-pin.json` の固定の点の `entrypoints.json`・`ndf-files.json`・`hooks/unattended-report.json` を取る。インタフェースの行と `path` は手で書いた id の一覧で絞り、区間の報告の形は絞らずに写して、生成のファイルを書き直す。手で書いた id の一覧に、契約に無い id があれば、生成を失敗にする
  - 固定の点を付け替える Pull Request では、`ndf-pin.json` を直した後にこのコマンドを打ち、生成のファイルを同じ Pull Request でコミットする
  - 生成はネットワークから上流を取得するため、`npm run generate` と `npm run generate:check` には入れない。`npm run check` はネットワークにつながらない環境でも動く必要があるためである
  - 生成のファイルの直し忘れは照合が見つける。照合は、生成のファイルが持つ固定の点のコミットが `ndf-pin.json` と同じかを 6 項目目の最初に比べる。違えば食い違いにする

  照合の 6 項目目は、「使うインタフェースがインタフェースの表にある」に加えて、生成した行の各項目が契約の行と同じかを比べる。4 項目目は、読むファイルの `path` が生成した値と同じかも比べる。5 項目目は、生成した区間の報告の形が契約の `shape` の同じ項目と同じかも比べる。固定の点で食い違えば、生成のし忘れか手で書き換えたことを表す。先端で食い違えば、上流が使うインタフェースの決まりを変えたことを表す。これで、サンプルの無い変更（たとえば引数の正規表現だけが変わる）も、先端の要約で気づける

  呼び出しの判定（`judgeCall`）は、生成した行の列だけを使い、次の規則で呼び出し文字列を照合する。呼び出し文字列は、サンプルの `call` 列にあたり、種類ごとに中身が違う（`entrypoint-cases.json` の `call` の列の説明のとおり）。どの種類でも、呼び出しが入れる環境変数の名前は、すべて行の `env` に載っていなければ偽にする。使うインタフェースに無い id の呼び出しも偽にする

  | `kind` | 呼び出し文字列の中身 | 照合の規則 | サンプルの例（valid） |
  | --- | --- | --- | --- |
  | `skill` | 引数だけ | 文字列全体が、`args` の正規表現のどれか 1 つに全体で一致する | `#895`（`skill-workflow`） |
  | `block` | `ndf-next` ブロックの中身 | 先頭から順に取り出す。(1) `lead` があり、文字列がそれで始まれば取り除く。`lead` は任意で、無くてもよい。(2) 残りが `/` + Skill の前置き + `target` + 空白 1 つで始まることを求め、取り除く。Skill の前置きは契約の表に無い（identity が決める）ので、使い方のデータに `ndf:` として持つ。(3) 残りの全体が、`args` の正規表現のどれか 1 つに全体で一致する | `/ndf:development-workflow #895`・`/goal /ndf:development-workflow --loop Team_A -- 終わり: …`（`block-next`） |
  | `report` | 結果の行の値 | 文字列全体が、`args` のどれか 1 つに全体で一致する | `完了`（`report-unattended`） |
  | `hook` | hook の事象の名前 | 文字列が `target` と同じ | `Stop`（`hook-unattended-stop`） |
  | `command` | サブコマンドの引数 | 文字列全体が、`args` のどれか 1 つに全体で一致する | `設計承認ゲート`（`gate-record`） |
  | `file` | 保存先からの相対パス | 行の `files` に載るファイルのどれか 1 つの `path`（生成のファイルにある `ndf-files.json` の `path`）に一致する。`path` の `<名前>` は `/` を含まない 1 文字以上の並びに一致させ、ほかの文字はそのまま比べる。`path` が `.` のときは、文字列も `.` のときだけ一致する | `s1/8-release-request-state/progress.jsonl`（`file-plan-progress` の `<sprint>/<n>-<plan>-state/progress.jsonl`） |
  | `spec` | プラグインの根からのファイルのパス | 文字列が `target` + `/` で始まり、その後ろに 1 文字以上ある（`target` はディレクトリで、呼び出しはその配下のファイル） | `contracts/schemas/io/check.args.schema.json`（`spec-io`） |

  正規表現の一致は、どの種類でも全体の一致にする（`^(?:…)$` で包む）。部分の一致にすると、`loop-bad-budget`・`unknown-flag` のような偽のサンプルが真になる
- 採らなかった案: 生成のファイルを持たず、ランナーが実行のときにイメージの中の NDF の契約のファイルを読む（照合はスキーマの正本だけを相手にするため、判定が契約のファイルを読むと照合が判定を独立に検査できなくなる。画面と同じ決まりで組み込みを読まない形も崩れる）
- 採らなかった案: 契約の行の列と `path` を使い方のデータへ手で写し、照合で契約と比べる（Value 13 の「定義から作れるものは手で写さない」に反する。上流の契約が変わるたびに、最大 11 のインタフェースの列と読むファイルの `path` を手で写し直すことになる）
- 採らなかった案: 生成のファイルを持つが、サンプルの判定だけで離れを見つける（サンプルの無いインタフェースと引数の形の変更を見落とす。`gate-rejections` のようにサンプルの無い読むファイルもある）
- **代償**: 使い方のデータの型（`NdfContractUse` の `entrypoints` と `files`）が、名前の文字列の配列から、契約の行の項目を持つオブジェクトの配列に変わる。型には生成した区間の報告の形も加わる。照合の 4・5・6 項目目の比べる中身が増える。固定の点を付け替える Pull Request では、生成のコマンドを打つ手順が 1 つ増える（打ち忘れは照合が固定の点の食い違いとして落とす）
- 作り方: 自前で作る
- 比べた候補: STD2 / LIB1
- 根拠: Value 17 / Value 11（MVV バージョン 3）。STD2

### 決定 6: 書き出しが消えたときに素通りさせないため、照合から skip の道を消し、書き出しが無ければ常に失敗にする

- **質問**: 受け入れ条件 5 の「書き出しが無ければ `fail: no-contract-use`」を、どう満たすか。定数 `CONTRACT_USE_REQUIRED` を真にするか、skip の道ごと消すか
- **選んだ案**: 定数 `CONTRACT_USE_REQUIRED` と、テストが差し替える `MainOptions.required` を消す。書き出しが無ければ、常に `fail: no-contract-use <固定の点>` と終了コード 1 にする
  - 「常に」は、契約の取得の成否によらないことを指す。今の CLI は、書き出しが無いと分かった後も固定の点の契約を取得し、取得に失敗すると終了コード 2 で終わる。これでは、ネットワークにつながらない手元の実行で、書き出しの欠落が取得のエラーとして報告される
  - そこで処理の順を次のようにする。`ndf-pin.json` から固定の点を読み、続けて書き出しを読む。書き出しが無いと分かった時点で、契約を取得せずに `fail: no-contract-use <ndf-pin.json の固定の点>` を標準出力に出し、終了コード 1 で終わる。`read:` の行は出さない
  - `ndf-pin.json` を読めないとき（終了コード 2）と、書き出しはあるが読めないとき（終了コード 2）は、今の振る舞いのまま
- 採らなかった案: 定数を真にして残す（#1 の設計は真にした後に偽へ戻さないとしており、偽の側の分岐は二度と通らない。使わないコードを残さない Value 13 に合わない）
- **代償**: 書き出しが無くても照合を成功で終える段階（#2 が書き出しを置く前の段階）へ、定数を切り替えて戻す手段が無くなる（戻す理由も無い）。skip を前提にした手順（pipeline-approval.md の承認の注記）を同じ変更で直す
- 根拠: Value 13（MVV バージョン 3）

### 決定 7: 承認者に訂正後の値を渡すため、区間の報告の読み取りは契約の `rule` と `shape` に沿う

- **質問**: 区間の報告の読み取り（`readReport`）が、報告の文から結果と項目をどう取り出し、何を誤りとするか
- **選んだ案**: 固定の点の `hooks/unattended-report.json` の `rule` と `shape` に沿って、次の規則で読む。規則が使う `shape.values`・`shape.required`・`shape.material` は、決定 5 の生成のファイルから読み、読み取りの関数にもデータにも手で書かない。読み取りは、結果の値と、誤りの一覧（`errors`）を返す
  1. 応答の文の中で**最後の** `- 結果:` の行を結果の行とし、値の前後の空白を除いて結果を取る。結果の行が無ければ誤りにする
  2. 結果が `shape.values` の 3 つ（`判断が要る`・`完了`・`できなかった`）のどれでもなければ誤りにする
  3. 結果の行より後ろの `- <項目>: <値>` の行を項目として読む。値の前後の空白は除く。結果の行より前の項目の行は読まない
  4. 同じ名前の項目が 2 つ以上あれば、最後の行の値を採る。前の行の値は捨てる
  5. `shape.required` が結果の値ごとに要るとする項目を確かめる。`always` の項目と、`when` の条件に当たったときの `need` の項目の両方を確かめる。`when` の条件は、項目の値が `prefix` で始まる・`equals` と同じ、のどちらかである。要る項目が無い、値が空、値が `無し` のどれかなら、欠落として誤りにする。項目「材料」もこの規則だけで扱う。材料が要る結果（`判断が要る`）で材料が無い・空・`無し` なら欠落の誤りにし、材料が要らない結果（`完了`・`できなかった`）なら誤りにしない（契約のサンプルにある `材料: 無し` の `完了` と `できなかった` は有効である）
  6. 項目「材料」に、空でも `無し` でもない値があるときだけ、値の形を確かめる。値は、`shape.material.body`（`本文`）か、`shape.material.url_prefix`（`https://`）で始まる URL を空白で区切って並べたもの、のどちらかでなければ誤りにする。`本文` のときは、区間の報告より前に `shape.material.heading`（`## 判断の材料`）の見出しが要る。無ければ誤りにする

  誤りの一覧の 1 件は、誤りのコードと項目の名前だけを持ち、読み取った値を持たない。上流の読み取り（`report.py`）の誤りの文は「`「材料」が本文でも https:// の URL でもない: <値>`」のように入力の値を含む。この値には署名付き URL や共有トークンが混ざりうる。ランナーはこの一覧を進捗の事象の理由（`report_item_invalid`）に使うため、値を一覧に入れない。伏せ字は既知の秘密の形だけを伏せ、任意の署名を取り除けないため、伏せ字には頼らない。照合の 5 項目目は `errors` の有無だけをサンプルと比べるため、誤りの文を上流と同じにする必要は無い

  | 誤りのコード | 当たるとき | 項目の名前 |
  | --- | --- | --- |
  | `result_line_missing` | 結果の行が無い（規則 1） | `結果` |
  | `result_value_unknown` | 結果が 3 つの値のどれでもない（規則 2） | `結果` |
  | `item_missing` | 要る項目が無い・空・`無し`（規則 5） | 欠けた項目 |
  | `material_form_invalid` | 材料の値が `本文` でも URL の並びでもない（規則 6） | `材料` |
  | `material_heading_missing` | `材料: 本文` なのに「判断の材料」の見出しが無い（規則 6） | `材料` |
- 採らなかった案: execution.md の「[区間と結果の行](../docs/design/execution.md#区間と結果の行)」へのリンクだけを置く（リンク先には、同じ項目の後勝ちと、URL を空白で区切ることが書かれていない。同じ項目を先勝ちで読むと、訂正した承認資料の参照先ではなく古い資料を承認者に見せる）
- 採らなかった案: 上流の誤りの文をそのまま返し、進捗の事象へは伏せ字を通して載せる（伏せ字は既知の秘密の形しか伏せず、材料の欄に入った署名付き URL の署名が残る）
- **代償**: 上流が `rule` を変えたら、この規則と関数を同じ変更で直す。`shape` の変化は照合の 5 項目目と、先端の差分の行で気づける。誤りの理由から値を落とすため、進捗の事象を見る人は、どの項目が誤りかまでは分かるが、どんな値が書かれていたかは分からない
- 根拠: Value 11（MVV バージョン 3）。STD1

## 影響と危険

- **働く範囲**: このリポジトリだけである。照合は nd-factory の CI と手元の `npm run ndf-contract` で動く。利用者のプロジェクトのリポジトリでは動かない
- **プロジェクトごとに違うもの**: 無い。固定の点と受ける組はこのリポジトリのファイルに置く
- **当たるモード**: nd-factory 自体の開発のすべての Pull Request・main への push・毎日の照合

壊れうる箇所と扱い:

| 箇所 | 起きうること | 扱い |
| --- | --- | --- |
| すべての Pull Request の CI（`ndf-contract`） | 照合が必須になるため、上流の配布で使う部分が変わったときに、固定の点を変えない Pull Request まで落ちるおそれがある | 落ちない。失敗になるのは固定の点の食い違いだけで、先端の食い違いは要約に並べるだけである（今の振る舞いのまま）。固定の点は手で上げるので、上流の配布だけでは固定の点の結果は変わらない |
| 反映のパイプラインの承認（pipeline-approval.md） | 「skip の行だけなら注記して承認してよい」の手順が古くなる | 同じ変更で、skip の行が出ない前提の手順に直す |
| 確定仕様 `docs/specifications/contracts-and-core.md` | 受ける組の値がバージョン 8 のまま残る | 同じ変更でバージョン 16 に直す |
| 照合のテストのフィクスチャ（`tools/test/fixtures/ndf-contract-752a9cf/`） | 古い固定の点のコピーのまま残る | 新しい固定の点のコピーに置き換える |
| #2 の設計 | #2 の設計が、この課題がすでに置いた使い方の書き出し（#1 の設計が #2 に割り当てた要件 K2-6）を、もう一度設計してしまう | 決定 2 の代償。#2 の設計の時点でこの書き出しを読む |
| 区間の失敗の理由のコード（`packages/contracts/src/rows/sprints.ts` の `segmentFailureReason`、確定仕様 `docs/specifications/contracts-and-core.md` の区間の行） | 読み取りが項目の誤りを返したときの理由のコード `report_item_invalid` と、材料の URL が受け入れ条件に合わないときの理由のコード `material_url_rejected`（どちらも execution.md の「区間と結果の行」）が値の集まりに無い | この変更では足さない。区間の失敗を書くのはランナーなので、ランナー（[#6](https://github.com/devbasex/nd-factory/issues/6)）の実装で値の集まりと確定仕様に足し、`npm run generate` の生成物もコミットする |
| 承認資料の材料の URL（execution.md の「[承認資料](../docs/design/execution.md#承認資料)」） | この変更で、材料に並んだ URL をすべて承認資料に載せる。`材料: 本文` なら「判断の材料」節も載せる。どちらにも署名付き URL や共有リンクが入りうる。入ると、元の資料の閲覧権限が無い承認者や委任のエージェントにも中身を渡す。読み取り（決定 7）は契約に合わせて材料の欄が `https://` で始まるかだけを見るため、これを防がない | execution.md に材料の URL の受け入れ条件を書いた。条件は、スキームを持つ・スキームが `https`・ホストが `github.com` ちょうど・ポートを書かない・ユーザー名やパスワードを持たない・クエリを持たない・パスとフラグメントが Pull Request・Issue・コミット・ファイルとその行やコメントを指す決まった形に一致する・指す資料を GitHub の API で読めて、応答から組み立てた掲載用の URL と一致する、である。条件は、execution.md の「[承認資料](../docs/design/execution.md#承認資料)」の「確かめる順番」の表の上から順に当て、最初に合わなかった条件の拒否の理由のコードを 1 つだけ出す。条件と理由のコードの対応（たとえば、ホストの条件の順 3 が `host_not_allowed`、クエリの条件の順 6 が `query_present`）は、その表にある。S3 の署名付き URL は順 3 で先に当たるため、`host_not_allowed` になる。条件は、ブラウザーが開く URL に直す前の文字列に当てる。材料の欄の URL と「判断の材料」節の中の URL の両方に当てる。節の URL は、GFM の解釈でリンク先を取り出し、スキームを省いたリンク先・HTML の属性・コードの中の裸の URL も含めて確かめる。承認の依頼を送るのはランナーなので、確かめる処理とテストはランナー（[#6](https://github.com/devbasex/nd-factory/issues/6)）の実装に置く。テストの中身は下の「ランナーのテストに引き継ぐこと」にある |
| ランナー（#6） | 判定と読み取りの関数の形を、ランナーの実装の時点で変えたくなる | ランナーは照合と同じ判定と読み取りの関数を使う（#1 の決定 7 のまま）。形を変えるときは照合のテストも同じ変更で直す |

### ランナーのテストに引き継ぐこと

区間の失敗と承認資料の受け入れ条件は、ランナー（[#6](https://github.com/devbasex/nd-factory/issues/6)）が実装する。ランナーのテストは、API の呼び出しを差し替えた偽物を使い、次を確かめる。例の値はどれも作り物である。

| 報告 | 偽物の API が受けるもの | 理由と進捗の事象とログ |
| --- | --- | --- |
| 材料の欄が `https://acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf?X-Amz-Signature=0000`・`https://github.com/acme/app/pull/1?token=0000`・`https://user:pass@github.com/acme/app/pull/1`・`https://docs.example.com/share/abcd` のどれか | 承認の依頼・問い・承認資料は 1 件も受けない。区間とレーンを `material_url_rejected` で失敗にする進捗の事象を 1 件受ける | 理由は、位置（材料の欄の何番目か）と拒否の理由のコードだけを持つ。コードは順に `host_not_allowed`・`query_present`・`userinfo_present`・`host_not_allowed` である（S3 の署名付き URL はクエリも持つが、表の上から最初に合わない条件のコードだけを出す）。URL の全体・ホスト名・署名やトークンの値が、理由にも進捗の事象にもログにも出ない |
| `材料: 本文` で、「判断の材料」節に `[計画](https://acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf?X-Amz-Signature=0000)` か `<https://docs.example.com/share/abcd>` か `<a href="https://docs.example.com/share/abcd">計画</a>` か `http://github.com/acme/app/pull/1` を含む | 同上 | 理由は、位置（本文の何番目か）と拒否の理由のコードだけを持つ。コードは `http://github.com/…` だけが `scheme_not_https` で、ほかは `host_not_allowed` である。同上の値が出ない |
| `材料: 本文` で、「判断の材料」節に `[計画](//acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf?X-Amz-Signature=0000)` か `www.example.com/share?token=0000` か参照の定義 `[計画]: docs.example.com/share/abcd` か裸の `docs.example.com/share/abcd` を含む | 同上 | 理由は、位置と拒否の理由のコードだけを持つ。コードは `www.` の自動リンクだけが `scheme_not_https`（`http://` を補った後に当てる）で、ほかは `url_not_absolute` である。ホスト名・`X-Amz-Signature=0000`・`token=0000`・`abcd` が出ない |
| `材料: 本文` で、「判断の材料」節のインラインのコード `` `https://acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf?X-Amz-Signature=0000` `` か、コードブロックの中の同じ URL を含む | 同上 | 理由は、位置と拒否の理由のコード `host_not_allowed` だけを持つ。コードの中の署名付き URL も見つける。ホスト名・`X-Amz-Signature=0000` が出ない |
| 材料の欄が `https://github.com:443/acme/app/pull/1`・`https://github.com/acme/app/./pull/1`・`https://github.com/acme/app/blob/main/0000secret`・`https://github.com/acme/app/pull/1/0000secret`・`https://github.com/acme/app/pull/1#token=0000` のどれか | 同上 | 理由は、位置と拒否の理由のコードだけを持つ。コードは順に `port_present`・`path_not_allowed`・`path_not_allowed`・`path_not_allowed`・`fragment_not_allowed` である（`:443` と `./` は、ブラウザーが開く URL に直すと消えるが、直す前の文字列で拒否する）。`0000secret`・`token=0000` が出ない |
| 材料の欄が `https://github.com/acme/app/blob/0123456789abcdef0123456789abcdef01234567/0000secret` か `https://github.com/ACME/app/pull/1` で、偽物の GitHub の API が前者のファイルを「見つからない」と返し、後者の Pull Request をリポジトリの `full_name` `acme/app` で返す | 同上 | 理由は、位置と拒否の理由のコード `ref_unverified` だけを持つ。パスの形が合っても、GitHub の API で読めないファイルの名前や、応答と違う書き方の URL は載せない。`0000secret` が出ない |
| 材料の欄が `https://github.com/acme/app/blob/0123456789abcdef0123456789abcdef01234567/docs/%e8%a8%ad%e8%a8%88.md`（小文字の 16 進数のパーセントエンコード） | 同上 | 理由は、位置と拒否の理由のコード `path_not_allowed` だけを持つ |
| 材料の欄が `https://github.com/acme/app/pull/1#discussion_r1`・`https://github.com/acme/app/issues/2#issuecomment-3`・`https://github.com/acme/app/commit/0123456789abcdef0123456789abcdef01234567`・`https://github.com/acme/app/blob/0123456789abcdef0123456789abcdef01234567/docs/plan.md#L10-L20`・`https://github.com/acme/app/blob/0123456789abcdef0123456789abcdef01234567/docs/%E8%A8%AD%E8%A8%88%20%E6%9B%B8.md`（日本語と空白を含むファイル名 `docs/設計 書.md`）のどれか、または `材料: 本文` で節の中のリンク先がそれだけ。偽物の GitHub の API は、リポジトリの `full_name` を `acme/app` として、それぞれの資料を返す | 承認の依頼を受ける。承認資料の材料の URL の並びと要約値の材料は、報告に書かれた URL と 1 文字も違わない | — |
| `材料: 本文` で、「判断の材料」節に上の行の受け入れる URL のほか、インラインのコード `` `node:fs` `` と、`import { readFile } from "node:fs/promises";` と `C/hooks/unattended-report.json` を含むコードブロックを含む | 承認の依頼を受ける | — |
| 結果の値が `保留 https://acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf?X-Amz-Signature=0000`（読み取りが `result_value_unknown` を返す） | 承認の依頼・問い・承認資料は受けない。区間とレーンを `result_value_unknown` で失敗にする進捗の事象を 1 件受ける（`result_value_unknown` は区間の失敗の理由 `segmentFailureReason` に今ある値で、この変更では足さない。項目の誤りと違い、結果の値そのものが読めないため、`report_item_invalid` に包まない） | 理由は、コード `result_value_unknown` だけを持つ。`保留` も `X-Amz-Signature=0000` も出ない |
| 材料の欄が `https://acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf?X-Amz-Signature=0000 not-a-url`（読み取りが `material_form_invalid` を返す） | 承認の依頼・問い・承認資料は受けない。区間とレーンを `report_item_invalid` で失敗にする進捗の事象を 1 件受ける | 理由は、誤りのコード `material_form_invalid` と項目の名前 `材料` だけを持つ。`X-Amz-Signature=0000` も `not-a-url` も出ない |

## テスト設計

| 受け入れ条件・決定 | どの振る舞いで縛るか | どう壊したら落ちるべきか |
| --- | --- | --- |
| 受け入れ条件 1 | `ndf-pin.json` の `ndf_ref` が `ndf--v11.0.36` のタグの指すコミットと一致する（マージ前の手動の確認。`git ls-remote` か `gh api` のタグの参照と比べる） | 同じ契約（バージョン 16・`c50ef840…`）を持つ別のコミットに `ndf_ref` を差し替えると、タグの参照との一致の確認が失敗する。照合の 2 項目目は契約のバージョンと sha256 だけを比べ、タグが指すコミットかどうかは比べないため、この差し替えを見つけない。この確認はタグの参照との比較でだけ行う |
| 受け入れ条件 2 | 受ける組がバージョン 16・`c50ef840…` の 1 組だけである。スキーマの正本の既存のデータのテストが形（空でない・重ならない）を縛る | バージョン 8 の組を残す・2 組にすると、手動の確認で `history` の最後の行と合わない。固定の点だけを上げて組を直し忘れると、照合の 2 項目目が落ちる |
| 受け入れ条件 3 | execution.md の決定 104 と「契約のバージョンの照合し」の行に、新しいタグ・コミット・バージョン・sha256 がある。バージョン 8・`ed8b0365…` を今の値として書いていない（目で見る） | 値の書き換え忘れ |
| 受け入れ条件 4 | 新しい固定の点で `npm run ndf-contract` が `checked: fixed 8d22be7… 1-6` を出し、`skip:` の行を出さず、終了コード 0 で終わる | 照合のテストで、生成のファイルの `spec-io` の `target` だけを別の値に変える（データの読み込みは壊さない）。固定の点の 6 項目目が `spec-io` の `target` の不一致を食い違いとして出し、終了コード 1 で終わる |
| 受け入れ条件 5 | 作業ツリーのパッケージが書き出しを持たないと `fail: no-contract-use <固定の点>` と終了コード 1。`skip:` の行は出ない。契約の取得に依存しない: 照合のテストで、書き出しを無しにし、取得先の `repoUrl` を取得できない値にしても、終了コードは 2 ではなく 1 で、取得を試みない（決定 6） | skip の分岐を戻すと落ちる。書き出しの欠落を判定する前に契約を取得する順に戻すと、取得できない取得先で終了コードが 2 になって落ちる |
| 受け入れ条件 6 | `npm run check` が通る | 型・lint・生成物・単体テストのどれかが落ちる |
| 受け入れ条件 7 | execution.md の「区間と結果の行」に `report_item_invalid` と `material_url_rejected` の行があり、「承認資料」に材料の URL の受け入れ条件がある（目で見る）。動作はランナー（#6）のテストで確かめる（「ランナーのテストに引き継ぐこと」） | 記述の書き忘れ |
| 受け入れ条件 8 | 決定 7 の 2 つの行（区間の報告の読み取り・誤りの一覧に値を入れない） | 決定 7 の行のとおり |
| 決定 4（呼び出しの判定） | 新しい固定の点のサンプルのうち、使うインタフェースの 21 件で、判定が `valid` と同じになる。使わないインタフェースの呼び出しは偽になる。照合の 1 項目目は、使わないインタフェースのサンプルを判定で比べない。参照先の検査は、使うインタフェースのサンプル 1 件（たとえば `block-next` へのサンプル）の `entrypoint` だけを `entrypoints.json` に無い id（たとえば `no-such-entrypoint`）に差し替えた契約で確かめる。`entrypoints.json` のインタフェースの行は消さずに残す。照合は、1 項目目の食い違いとして、そのサンプルの id を含む行（`mismatch: … 1 … entrypoint-cases.json <サンプルの id>: …`）を出す。終了コードが 1 であることだけでは確かめない（行を消すと 6 項目目も食い違いになり、1 項目目の退行と区別できないため） | 参照先の id の検査を絞り込みの後に移す（差し替えた id は使い方のデータの 11 の id にも契約の id にも無いため、どちらで絞ってもサンプルが外れ、1 項目目の行が出ない）。引数の正規表現の全体一致を部分一致にする（`loop-bad-budget`・`unknown-flag` が真になる）。入れてよい環境変数の外の名前を許す（`terminal-env` が真になる）。block の前置きの語を必須にする（`resume` が偽になる） |
| 決定 4（網羅） | 使い方のデータの `entrypoints` の id の集合が、単体テストに置いた 11 の id のリストとちょうど同じになる | データから `block-next` を 1 件消すと、単体テストが落ちて CI が失敗する。リストに無い id（たとえば `file-loop-record`）を足しても落ちる |
| 決定 4（呼び出しの判定の種類ごとの規則） | 決定 5 の表の種類ごとに、valid のサンプルが真になる。とくに `block-next` の `resume`（`/goal ` の前置きが無い）と `resume-loop`（前置きがある）がどちらも真、`spec-io` の `spec-io-args` が真で `spec-outside` が偽、`file-plan-progress` の `plan-progress` が真になる | `target` と `args` をそのまま連結して比べると `resume` が偽になる。`spec` の `target` を完全一致で比べると `spec-io-args` が偽になる |
| 決定 7（区間の報告の読み取り） | 新しい固定の点の `cases` 16 件で、`result` と `errors` の有無がサンプルと同じになる。加えて単体テストで、結果の行の後ろに同じ項目（たとえば `材料`）が 2 行あるとき、後ろの行の値を採る | 最初の `- 結果:` の行を読む（最後のサンプルが `判断が要る` になる）。同じ名前の項目を先勝ちで読む（2 行目の `材料` の URL ではなく 1 行目の値を返す）。必須の項目（たとえば `判断が要る` の `材料`）の `無し` を欠落として扱わず、有効な値として受ける。条件つきで要る項目を見ない。`材料: 本文` で `## 判断の材料` の節を求めない。空白で区切った複数の URL を誤りにする。材料の要らない `完了`・`できなかった` で `材料: 無し` を誤りにする（契約の `完了` と `できなかった` の有効なサンプルが誤りになる） |
| 決定 7（誤りの一覧に値を入れない） | 単体テストで、材料の欄が `https://acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf?X-Amz-Signature=0000 not-a-url` の報告を読むと、誤りの一覧が `material_form_invalid` と `材料` の 1 件だけになり、一覧を文字列にしても `X-Amz-Signature`・`0000`・`not-a-url` を含まない | 上流と同じく誤りの文に値を入れると、一覧の文字列に署名が出て落ちる |
| `ask-journal` の通知（「#47 と上流の不足 3 件は食い違いにならない」） | 照合のテストで、固定の点の `ndf-files.json` の `ask-journal` に `fields` を足した契約を渡すと、`notice: … の ask-journal が fields を持つ: …` の行が標準出力と要約のファイルの両方に出て、終了コードは 0 のまま、食い違いの件数も 0 のまま | 通知を 4 項目目の食い違いに数えると、終了コードが 1 になって落ちる。通知の処理を消すと、行が出ずに落ちる |
| 決定 5（照合） | 生成したインタフェースの行の項目（`kind`・`target`・`lead`・`args`・`env`・`files`）か、読むファイルの `path` が契約の行と違うと、固定の点で 6 項目目か 4 項目目の食い違いになる。生成した区間の報告の形（たとえば `required` の `判断が要る` の `always`）が契約の `shape` と違うと、5 項目目の食い違いになる。生成のファイルが持つ固定の点が `ndf-pin.json` と違っても、6 項目目の食い違いになる | 比べる項目を 1 つ外すと、その項目だけを変えた契約で食い違いが出ない。`ndf-pin.json` だけを別のコミットに変えて生成し直さないと、食い違いが出る |
| 決定 5（生成） | 照合のテストで、フィクスチャの契約を取得先にして `npm run ndf-contract:sync` の処理を動かすと、手で書いた id の行と `path` と、契約の `shape` と同じ区間の報告の形を持つ生成のファイルができ、コミットした生成のファイルと同じになる。手で書いた id の一覧に契約に無い id を足すと、生成が失敗する | 絞り込みを外すと、使わないインタフェース（`file-loop-record` など）の行が生成のファイルに入って落ちる。契約に無い id を黙って飛ばすと、失敗にならずに落ちる |
| 決定 3 | 照合が読む型が、スキーマの正本の `NdfContractUse` と同じである（型の検査）。書き出しの `acceptedVersions` が `NDF_CONTRACTS.accepted` と同じ値である | 型を照合の側にも書く・受ける組を使い方のデータにコピーすると、片方だけを変えたときに型の検査かテストで落ちる |

## 設計の結果

| 課題 | 扱い | 統合先 | 触るファイル |
| --- | --- | --- | --- |
| #136 | 実装する | — | `ndf-pin.json`、`packages/contracts/data/ndf-contracts.json`、`packages/contracts/data/ndf-contract-use.json`（新設）、`packages/contracts/data/ndf-contract-use.generated.json`（新設。生成のファイル）、`package.json`（`ndf-contract:sync` を足す）、`packages/contracts/src/ndf-contract-use.ts`（新設）、`packages/contracts/package.json`、`packages/contracts/test/ndf-contract-use.test.ts`（新設）、`packages/contracts/test/fixtures/ndf-contract-8d22be7/entrypoint-cases.json`（新設）、`packages/contracts/test/fixtures/ndf-contract-8d22be7/unattended-report.json`（新設）、`packages/contracts/test/data.test.ts`、`tools/checks/src/ndf-contract-check.ts`、`tools/test/ndf-contract-check.test.ts`、`tools/test/fixtures/ndf-contract-752a9cf/entrypoints.json`（消す）、`tools/test/fixtures/ndf-contract-752a9cf/env.json`（消す）、`tools/test/fixtures/ndf-contract-8d22be7/entrypoints.json`（新設）、`tools/test/fixtures/ndf-contract-8d22be7/env.json`（新設）、`tools/test/fixtures/ndf-contract-8d22be7/ndf-files.json`（新設）、`docs/design/execution.md`、`docs/specifications/contracts-and-core.md`、`docs/operations/pipeline-approval.md` |

## 未確認のまま残ること

| 項目 | 内容 |
| --- | --- |
| 実装を終えるまでに新しい配布が出るか | 2026-11-25 の時点の最新は `ndf--v11.0.36` である。実装の途中で 11.0.37 以降が出ても、この変更は 11.0.36 で閉じる（決定 1）。先端の照合の要約に差が出れば、次の固定の点を上げる変更の材料になる |
| CI の照合が新しい固定の点を取得できるか | 照合は固定の点のコミットを深さ 1 で取得する。752a9cf ではこの取得が動いている。`8d22be7` でも取得できるかは、実装の Pull Request で CI の `ndf-contract` の結果を見て確かめる |

## 外部の調査

| 種類 | 調べるか | 理由 |
| --- | --- | --- |
| 標準・仕様 | 調べる | 上流の契約のファイルそのものと、利用する側が使う部分だけを契約として持つ考え方（利用者駆動の契約）、依存をコミットで固定する慣行を確認する |
| 主要な製品 | 調べない | 他の製品の画面や機能の形を取り込む変更ではなく、上流 1 つとの契約の取り決めの中だけで形が決まる |
| ライブラリとサービス | 調べる | 契約のテストに既存のツール（Pact）を使えるかと、固定の点の更新を自動化するツールがあるかを決める |

### 標準・仕様

| # | 標準・仕様 | 何を定めているか | 設計への反映 | 出典 |
| --- | --- | --- | --- | --- |
| STD1 | NDF の契約のファイル（`ndf--v11.0.36` のタグのコミット `8d22be7` の `plugins/ndf/contracts/`） | 照合が読む 6 つのファイル。`version.json` の最後の行はバージョン 16・`c50ef840…`。インタフェースは 15 行、サンプルは 26 件、区間の報告のサンプルは 16 件。11.0.12 からの差は「今の姿」の表のとおり | 決定 1 の値、決定 4 の比べる範囲、決定 5 の生成の元 | `git ls-remote https://github.com/devbasex/ai-plugins 'refs/tags/ndf--v11.0.*'` と、`git fetch --depth 1` で取った 2 つのコミットの `git diff` と `git show`（2026-11-25） |
| STD2 | 利用者駆動の契約（Consumer-Driven Contracts） | 利用する側は、提供する側の能力のうち自分が使う部分だけを、自分の期待として契約に書く（契約は開いていて不完全でよい） | 決定 4（使うインタフェースだけを判定する）と決定 5（使う部分を提供する側の契約から生成して持ち、契約と比べる） | https://martinfowler.com/articles/consumerDrivenContracts.html （2026-11-25） |
| STD3 | GitHub Actions のセキュリティ強化の手引き（サードパーティのアクションの使い方） | 依存は全長のコミット SHA で固定するのが基本で、タグは動かせるため信頼できる作者に限る | 決定 1（固定の点はタグの名前ではなく、タグが指すコミットの 40 桁を書く。今の形のまま） | https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#using-third-party-actions （2026-11-25） |

### ライブラリとサービス

| # | 候補 | バージョン | ライセンス | 最後のリリースの日付 | 終了のアナウンス | 要件を満たすか | 出典 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| LIB1 | Pact（`@pact-foundation/pact`） | 17.1.4 | MIT | 2026-09-07（npm の更新日） | 無し | 満たさない。Pact は、利用する側のテストの実行から契約を生成し、提供する側がそれを検証する作りである。提供する側（NDF）が自分の契約のファイルとサンプルを公開している今の形とは、向きが逆になる。NDF の側に Pact の検証を組み込む必要がある | `npm view @pact-foundation/pact version license time.modified deprecated`・https://docs.pact.io/ （2026-11-25） |
| LIB2 | Renovate | 44.262.1 | AGPL-3.0-only | 2026-11-25（npm の更新日） | 無し | この課題では使わない。固定の点の更新を Pull Request にする自動化はできる。ただし、受ける組と execution.md の値を同じ Pull Request で直す手順は自動化できず、範囲は固定の点を 1 回上げることに限られる | `npm view renovate version license time.modified`（2026-11-25） |
| LIB3 | zod（既存の依存） | 4.6.7 | MIT | 2026-10-12（npm の更新日） | 無し | 満たす。使い方のデータの形と、照合が読む契約のファイルの形を読むのに使う（今の照合と受ける組のデータも zod で読んでいる） | `npm view zod version time.modified`・`packages/contracts/package.json`（2026-11-25） |

### 確認できなかったこと

| 対象 | 試した手段 | 結果と理由 |
| --- | --- | --- |
| Pact で提供する側の参加なしに契約を検証できるか | https://docs.pact.io/ のトップページを読んだ | トップページには、提供する側の検証やブローカーが要るかの記述が無かった。ブローカーの文書は読んでいない |

調べた量: 候補 6 件・取得の試み 9 回。
