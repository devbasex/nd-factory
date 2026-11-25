# NDF との契約: 固定の点を 11.0.36 へ上げ、契約の照合が 6 項目を必ず実行する（#136）

nd-factory が使う NDF の固定の点は 11.0.12（契約バージョン 8）のままで、契約の照合（`npm run ndf-contract`）は使い方の書き出しが無いために何も照合せず成功で終わっている。固定の点を最新の配布 `ndf--v11.0.36`（契約バージョン 16）へ上げて受ける組を直し、この課題で使い方の書き出しをスキーマの正本（`packages/contracts`）に置いて、書き出しが無ければ照合が失敗するようにする。調べた結果、新しい固定の点でも #47 と上流の不足 3 件は照合の食い違いにならないため、この 4 件は要求のとおり範囲に入れない。採らなかった案は「決定の記録」に、比べた候補は末尾の「外部の調査」にある。

## 今の姿

何が起きたか・目的・受け入れ条件は要求仕様 [issue-136-requirements.md](./issue-136-requirements.md) にある。要求仕様の正は [#136](https://github.com/devbasex/nd-factory/issues/136) の本文である。この文書は「どう解くか」と「なぜその解き方か」だけを書く。

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

2026-11-25 時点の最新の配布のタグは `ndf--v11.0.36` である（軽量のタグ。コミット `8d22be728e81983e5051799bcee4637ff65f0071`）。その `version.json` の `history` の最後の行は、バージョン 16 である（外部の調査の STD1）。sha256 は `c50ef840a72ab71a15023a46a37d050c36ec3aae6d1be6092b7f9dc7f3c0a726` である。照合が読む 6 つのファイルを 11.0.12 と比べると、nd-factory が使う部分は変わっていない。

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
- 照合の CLI は、固定の点と先端のそれぞれで、`ndf-files.json` の `ask-journal` の行に `fields` があるかを見る。あれば、`notice: <コミット> の ask-journal が fields を持つ: <項目>` の行を出す
- 出力先は標準出力と、`--summary` で指定した要約のファイルの 2 つである
- この変更で、通知の条件と出力先を変えない

## 文脈と制約

- 固定の点は `ndf-pin.json` のキー `ndf_ref` の 1 か所だけに置く（AGENTS.md。参照の検査 `tools/ref-check` が落とす）
- 受ける組は `packages/contracts/data/ndf-contracts.json` の 1 か所だけに置く。固定の点を付け替える変更で、同じ Pull Request の中で直す（[execution.md の決定 104](../docs/design/execution.md)）
- NDF のバージョンの数字を読んで大小を比べる処理を書かない（execution.md の「NDF との契約」の表）
- スキーマの正本の中で画面が使うモジュールは、`node:` の組み込みを読まない。使い方の書き出しを使うのはランナー（[#6](https://github.com/devbasex/nd-factory/issues/6)）と照合だけだが、同じ決まりに従う。組み込みを読まない純粋な関数とデータで作る
- CI は AWS の資格情報を持たない。照合のワークフロー（`.github/workflows/ndf-contract.yml`）は変えない
- 反映のパイプラインの承認の手順は、照合の記録の `checked: fixed <固定の点> 1-6` の行を読む。この行の形は変えない。手順は [docs/operations/pipeline-approval.md](../docs/operations/pipeline-approval.md) にある
- 範囲に含まないもの（実行の契約の追い付き・上流の不足 3 件・#47・ランナーの起動のときの照合）は、要求の「対象範囲」のとおりである

## 解き方の全体像

```mermaid
graph LR
  PIN["ndf-pin.json<br/>8d22be7（11.0.36・バージョン 16）"]
  subgraph contracts["packages/contracts"]
    ACC["data/ndf-contracts.json<br/>受ける組: バージョン 16 の 1 組"]
    UD["data/ndf-contract-use.json（手で書く）<br/>使うインタフェースの id・渡す環境変数<br/>読む項目"]
    UG["data/ndf-contract-use.generated.json<br/>使うインタフェースの行と読むファイルの path<br/>区間の報告の形（shape）<br/>（固定の点の契約から生成）"]
    US["src/ndf-contract-use-schema.ts<br/>zod の形・型・区間の報告から読む項目<br/>（JSON を読まない）"]
    UM["src/ndf-contract-use.ts<br/>ndfContractUse（判定・読み取り）"]
  end
  CHK["契約の照合<br/>書き出しが無ければ fail"]
  NDF["NDF の契約のファイル"]
  RUN["ランナー（#6。後で使う）"]
  ACC --> UM
  UD --> UM
  UG --> UM
  US --> UM
  NDF -. npm run ndf-contract:sync .-> UG
  US --> CHK
  UM --> CHK
  PIN --> CHK
  NDF --> CHK
  UM -.-> RUN
```

- 固定の点は `ndf--v11.0.36` のコミット `8d22be7` を指す。受ける組は、バージョン 16 と sha256 `c50ef840…` の 1 組になる。execution.md の決定 104・「契約のバージョンの照合し」の行と、確定仕様の値は、実装の変更でそろえる
- スキーマの正本が、使い方の書き出し（`@nd-factory/contracts/ndf-contract-use`）を持つ。データは JSON に置く。データは 2 つのファイルに分ける。JSON に手で書くのは、使うインタフェースの id・Skill の名前の前置き（`ndf:`）・実行の場（ホステッド・手元のマシン）ごとに渡す環境変数・読む項目である。区間の報告からランナーが読む項目の名前は、読み取りの戻り値の型を決めるため、JSON ではなくスキーマのモジュールの定数に手で書く（決定 7）。使うインタフェースの決まり（契約の行の列）・読むファイルの `path`・区間の報告の形（結果の値・結果ごとに要る項目・材料の形）は、固定の点の契約から生成する（決定 5）。呼び出しの判定と区間の報告の読み取りは、そのデータだけを使う純粋な関数にする。判定の種類ごとの照合の規則は決定 5、読み取りの規則は決定 7 にある。受ける組は既存の `NDF_CONTRACTS` を引き、コピーしない
- 型 `NdfContractUse` と、データの zod の形は、スキーマの正本の 1 か所に置く。置き場は、データの JSON を読み込まないモジュール（`src/ndf-contract-use-schema.ts`）である。照合と生成のコマンドはこのモジュールを読む。こうすると、手で書く id の一覧と生成の行が食い違って `ndfContractUse` を組み立てられない間も、生成のコマンドが起動でき、生成し直して直せる（決定 3）
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
| 1 項目目 | `entrypoint-cases.json` の 26 件すべてのサンプルを判定へ通す | 26 件すべての参照先のインタフェースの id が `entrypoints.json` にあるかを先に確かめる（今の検査を残す）。その後、「使うインタフェース」の表の 11 のインタフェースへのサンプルだけを呼び出しの判定（`judgeCall`）へ通す（固定の点では 21 件）。この項目が確かめるのは判定と契約のサンプルの一致で、ランナーが組み立てる呼び出しが判定に通ることは、ランナーの単体テストで確かめる（「ランナーのテストに引き継ぐこと」）。使い方のデータが 11 のインタフェースをちょうど持つことは、単体テストで縛る | 決定 4 |
| 4 項目目 | `reader: service` の行の `fields` が、翻訳が読む項目を含むか | 加えて、読むファイルの `path` が、固定の点の契約から生成した値と同じか | 決定 5 |
| 5 項目目 | `shape.values`・`shape.items`・`shape.required`・`shape.material` が、ランナーが区間の報告から読む値と項目を含むか。`cases` のサンプルを読み取りへ通し、`result` と `errors` の有無が同じか | 加えて、生成のファイルにある区間の報告の形が、契約の `shape` と同じか（`values` はキーの並び、`required` と `material` は値の全体）。ランナーが読む項目の名前（手で書く `REPORT_ITEMS`）が `shape.items` にあるか | 決定 5 |
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
  - `packages/contracts/src/ndf-contract-use-schema.ts` に、型 `NdfContractUse`・データの zod の形・区間の報告から読む項目の名前の定数を置く。このモジュールはデータの JSON を読み込まず、読み込みのときに何も組み立てない
  - `packages/contracts/src/ndf-contract-use.ts` に、呼び出しの判定・区間の報告の読み取りを置き、データの JSON を読み込んで組み立てた `ndfContractUse` を書き出す
  - データは `packages/contracts/data/ndf-contract-use.json` に置き、zod の形で読む
  - 受ける組（`acceptedVersions`）は `NDF_CONTRACTS.accepted` をそのまま渡す
  - `package.json` の `exports` に `./ndf-contract-use` と `./ndf-contract-use-schema` を足す
  - 照合と生成のコマンドは、型と zod の形を `@nd-factory/contracts/ndf-contract-use-schema` から読み込み、自分の中のコピーを消す。照合が相手にする書き出しの実体（`ndfContractUse`）は、今までどおり `--root` の作業ツリーから実行時に解決する
  - 型と zod の形を `ndf-contract-use.ts` に置かないのは、そのモジュールが読み込みのときに生成の JSON を読み、手で書くデータと食い違えば例外を投げるためである。CLI がそこから zod の形を読むと、食い違った作業ツリーでは CLI が起動前に止まり、直す手段の `npm run ndf-contract:sync` も動かない
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

  照合の 1 項目目は、2 段で行う。先に、契約のサンプル（`entrypoint-cases.json`）のすべて（固定の点では 26 件）について、参照するインタフェースの id が `entrypoints.json` にあるかを確かめる。今の照合の CLI が行っているこの検査は、使うインタフェースで絞らずにそのまま残す。絞った後に確かめると、上流で使うインタフェースのサンプルの参照先 id が壊れたとき、そのサンプルが絞り込みで外れて照合が通ってしまうためである。次に、この 11 のインタフェースへの呼び出しだけを判定へ通す。固定の点の 26 件では 21 件を比べる。使わない 4 つのインタフェース（`file-organizer`・`file-loop-record`・`spec-pages`・`spec-ndf_settings`）へのサンプル 5 件は判定へ通さず、判定の食い違いにも出力の行にもしない

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
  | `packages/contracts/data/ndf-contract-use.json` | 使うインタフェースの id の一覧（決定 4 の 11 件）・Skill の前置き（`ndf:`）・実行の場ごとに渡す環境変数・`set_by` の許容（`envSetBy`）・翻訳が読む項目 | 手で書く |
  | `packages/contracts/src/ndf-contract-use-schema.ts` の定数 `REPORT_ITEMS` | 区間の報告からランナーが読む項目の名前（`shape.items` のうち使うもの）。読み取りの戻り値の項目の型をこの定数から作るため、JSON ではなくコードに書く | 手で書く |
  | `packages/contracts/data/ndf-contract-use.generated.json` | 生成の元にした固定の点のコミット・使うインタフェースの行（`kind`・`target`・`lead`・`args`・`env`・`files`）・その行の `files` が指す読むファイルの `path`（`ndf-files.json` の行）・区間の報告の形（`hooks/unattended-report.json` の `shape.values` のキー（結果の値の名前）を契約の順に並べた文字列の配列と、`shape.required`・`shape.material` をそのまま写したもの） | 生成する |

  - 生成は `npm run ndf-contract:sync` で行う。照合と同じ取得の処理（`fetchContract`）で `ndf-pin.json` の固定の点の `entrypoints.json`・`ndf-files.json`・`hooks/unattended-report.json` を取る。インタフェースの行と `path` は手で書いた id の一覧で絞り、区間の報告の形は絞らずに写して、生成のファイルを書き直す。手で書いた id の一覧に、契約に無い id があれば、生成を失敗にする
  - 固定の点を付け替える Pull Request では、`ndf-pin.json` を直した後にこのコマンドを打ち、生成のファイルを同じ Pull Request でコミットする
  - 生成はネットワークから上流を取得するため、`npm run generate` と `npm run generate:check` には入れない。`npm run check` はネットワークにつながらない環境でも動く必要があるためである
  - 生成のファイルの直し忘れは照合が見つける。照合は、生成のファイルが持つ固定の点のコミットが `ndf-pin.json` と同じかを 6 項目目の最初に比べる。違えば食い違いにする

  照合の 6 項目目は、「使うインタフェースがインタフェースの表にある」に加えて、生成した行の各項目が契約の行と同じかを比べる。4 項目目は、読むファイルの `path` が生成した値と同じかも比べる。5 項目目は、生成した区間の報告の形が契約の `shape` と同じかも比べる。`values` は契約の `shape.values` のキーの並びと比べ、`required` と `material` は値の全体を比べる。`shape.values` の値の側（結果ごとの説明の文）は、判定にも読み取りにも使わないため写さず、比べない。説明の文を写すと、参照の検査が探す語を持ち込むおそれもある。固定の点で食い違えば、生成のし忘れか手で書き換えたことを表す。先端で食い違えば、上流が使うインタフェースの決まりを変えたことを表す。これで、サンプルの無い変更（たとえば引数の正規表現だけが変わる）も、先端の要約で気づける

  呼び出しの判定（`judgeCall`）は、生成した行の列だけを使い、次の規則で呼び出し文字列を照合する。呼び出し文字列は、サンプルの `call` 列にあたり、種類ごとに中身が違う（`entrypoint-cases.json` の `call` の列の説明のとおり）。どの種類でも、呼び出しが入れる環境変数の名前は、すべて行の `env` に載っていなければ偽にする。使うインタフェースに無い id の呼び出しも偽にする

  | `kind` | 呼び出し文字列の中身 | 照合の規則 | サンプルの例（valid） |
  | --- | --- | --- | --- |
  | `skill` | 引数だけ | 文字列全体が、`args` の正規表現のどれか 1 つに全体で一致する | `#895`（`skill-workflow`） |
  | `block` | `ndf-next` ブロックの中身 | 先頭から順に取り出す。(1) `lead` があり、文字列がそれで始まれば取り除く。`lead` は任意で、無くてもよい。(2) 残りが `/` + Skill の前置き + `target` + 空白 1 つで始まることを求め、取り除く。Skill の前置きは契約の表に無い（identity が決める）ので、使い方のデータに `ndf:` として持つ。(3) 残りの全体が、`args` の正規表現のどれか 1 つに全体で一致する | `/ndf:development-workflow #895`・`/goal /ndf:development-workflow --loop Team_A -- 終わり: …`（`block-next`） |
  | `report` | 結果の行の値 | 文字列全体が、`args` のどれか 1 つに全体で一致する | `完了`（`report-unattended`） |
  | `hook` | hook の事象の名前 | 文字列が `target` と同じ | `Stop`（`hook-unattended-stop`） |
  | `command` | サブコマンドの引数 | 文字列全体が、`args` のどれか 1 つに全体で一致する | `設計承認ゲート`（`gate-record`） |
  | `file` | 保存先からの相対パス | 文字列がパスの境界（下）を守り、行の `files` に載るファイルのどれか 1 つの `path`（生成のファイルにある `ndf-files.json` の `path`）に一致する。`path` の `<名前>` は `/` を含まない 1 文字以上の並びに一致させ、ほかの文字はそのまま比べる。`path` が `.` のときは、文字列も `.` のときだけ一致する | `s1/8-release-request-state/progress.jsonl`（`file-plan-progress` の `<sprint>/<n>-<plan>-state/progress.jsonl`） |
  | `spec` | プラグインの根からのファイルのパス | 文字列が `target` + `/` で始まり、その後ろの残りが `.` でなく、パスの境界（下）を守る（`target` はディレクトリで、呼び出しはその配下のファイル） | `contracts/schemas/io/check.args.schema.json`（`spec-io`） |

  パスの境界: `judgeCall` はパスの文字列を検査し、ランナーは、ファイルを開く時点で許可範囲の外のファイルを開かないことを保証する。`judgeCall` はファイルシステムを読まない純粋な関数なので、シンボリックリンクの先を確かめられない。このため、`judgeCall` が真を返しただけで読み取りを許してはならない
  - `judgeCall` の検査: `file` と `spec` の呼び出しは、文字列として許可範囲の外を指さないものだけを真にする。文字列は `/` で始まらず、`\` と制御文字を含まない。`/` で区切った各成分は、空・`.`・`..` のどれでもない。ただし `file` の文字列の全体が `.` のときは、ランナーが環境変数に指定したファイルそのもの（`file-issue-request` なら `NDF_ISSUE_REQUEST_FILE`）を指すので許す。文字列の接頭辞だけを見ると、`contracts/schemas/io/../../x` のような許可ディレクトリの外を指す入力も真になるためである
  - ランナーの保証: ランナーは、許可範囲の外のファイルを開かない。許可範囲は、`path` が `.` かどうかで次の表のとおり変わる。確かめるのはランナー（[#6](https://github.com/devbasex/nd-factory/issues/6)）の実装で、テストは下の「ランナーのテストに引き継ぐこと」にある。ランナーが確かめないと、`judgeCall` が真にしたパスの途中に許可範囲の外を指すリンクがあるとき、読み取りを要求したエージェントがランナーの権限で外のファイルを読める

    | 読む対象 | 許可範囲 | 例 |
    | --- | --- | --- |
    | `spec` と、`path` が `.` でない `file` | 許可ディレクトリの配下のファイル。許可ディレクトリは、`file` では行の `env` の環境変数にランナーが指定した保存先のディレクトリ、`spec` ではプラグインの根の下の `target` | `file-plan-progress` の `s1/8-release-request-state/progress.jsonl` |
    | `path` が `.` の `file` | ランナーが環境変数に指定したファイルそのもの。他のファイルへの付け替え（指定したパスをシンボリックリンクや別のファイルに置き直すなど）は拒否する | `file-issue-request` は、`NDF_ISSUE_REQUEST_FILE` に指定したファイルだけを読む |

    許可範囲の外を開かない方法は、この文書では決めない。ランナー（[#6](https://github.com/devbasex/nd-factory/issues/6)）の設計 PR で決めて、承認を取る。決めるのは、OS のどの仕組みでファイルを開くか、起票の依頼ファイルを誰がいつ作ってどの権限を付けるか、どんなときに読み取りを失敗にするかである。どれも、ホステッドと手元のマシンの 2 つの実行の場に要る条件や、ファイルの所有と権限を変える決定になるため、この課題の実装の変更には入れない。ランナーの設計は、少なくとも次を満たす。

    - 許可範囲の確認は、ファイルを開く OS の呼び出しの中で行わせる（Linux なら `openat2(2)` の `RESOLVE_BENEATH` が候補になる）。ランナーが自分で確かめてから開く実装と、開いた後に実際のパスを確かめる実装は、この要件を満たさない。前者は、確かめた後にパスの途中をリンクへ差し替えられると外のファイルを開く。後者は、外のファイルを一度は開いてしまう
    - 起点にする許可ディレクトリ（`file` の保存先と、`spec` の `target`）は、ランナーが NDF を起動する前に特定する。NDF がまだ何も書き換えられない時点で、そのディレクトリの実体を開いておく（たとえばディレクトリのファイル記述子を持つ）。実行中の読み取りは、毎回その実体を起点に開く。読み取りのたびに設定のパスを解決し直してはならない。実行中に保存先や `target` のパスをシンボリックリンクや別の通常のディレクトリへ置き換えられると、起点そのものが許可範囲の外へ移り、OS に配下への制限を任せても外のファイルを開くためである。起動前に開いた参照（ファイル記述子）は、NDF の実行が終わるまで閉じずに持ち続ける。起動前にこの参照を開けない、または実行の終わりまで持ち続けられない実行の場では、NDF を起動する前に理由を返し、レーンを始めない。読み取りのたびにパスから起点を開き直し、起動前に記録したデバイス番号と inode 番号と比べる方式は、代わりにならない。元のディレクトリを削除した後に同じ inode 番号が別のディレクトリへ再利用されると（ext4 などでは起きうる）、番号が一致して別のディレクトリを起点にしてしまうためである
    - 許可ディレクトリを起点に開くとき、`file` は照合済みの相対パスをそのまま使う。`spec` の呼び出し文字列はプラグインの根からのパスで、許可ディレクトリは `target` なので、照合済みの文字列から先頭の `target/` を取り除いた残りを `target` から開く。文字列をそのまま渡すと `target` が二重になり、正規の `spec-io` の呼び出しでも NDF の引数スキーマを読めない
    - 選んだ仕組みに要るカーネルとコンテナランタイムの条件を書く。たとえば Docker Engine の既定の seccomp プロファイルが `openat2` を許すようになったのは 20.10 からである（[Docker Engine 20.10 リリースノート](https://docs.docker.com/engine/release-notes/20.10/)）。ランナーは、ホステッドでも手元のマシンでも、起動のときにその仕組みを使えるかを検査する。使えなければ、NDF を起動する前に理由を返し、レーンを始めない。ほかの開き方へ切り替えない
    - 起票の依頼ファイル（`path` が `.`）は、NDF の実行ユーザーが追記できるようにする。そのうえで、依頼ファイルのパスを構成するどのディレクトリも、NDF の実行ユーザーが差し替えられない置き場に置く。直上のディレクトリだけを守っても、その親を差し替えられると、NDF の追記がランナーの読むファイルに届かず、承認の画面に依頼が出ない
    - 承認の画面に出す依頼は、1 回読んだ中身から組み立て、承認の後にファイルを読み直さない。読み直すと、承認者が見た依頼と違う中身で起票しうるためである

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
- **代償**: 書き出しが無くても照合を成功で終える段階（#2 が書き出しを置く前の段階）へ、定数を切り替えて戻す手段が無くなる（戻す理由も無い）。skip を前提にした手順（pipeline-approval.md の承認の注記）は、承認の段を外す前の記録として残し、直さない（承認の段は 2026-11-25 に外した。[#164](https://github.com/devbasex/nd-factory/issues/164)）
- 根拠: Value 13（MVV バージョン 3）

### 決定 7: 承認者に訂正後の値を渡すため、区間の報告の読み取りは契約の `rule` と `shape` に沿う

- **質問**: 区間の報告の読み取り（`readReport`）が、報告の文から結果と項目をどう取り出し、何を誤りとするか
- **選んだ案**: 固定の点の `hooks/unattended-report.json` の `rule` と `shape` に沿って、次の規則で読む。規則が使う `shape.values`・`shape.required`・`shape.material` は、決定 5 の生成のファイルから読み、読み取りの関数にもデータにも手で書かない。読み取りは、結果の値と誤りの一覧（`errors`）に加えて、規則 4 で採った項目の値と、規則 6 で取り出した材料を返す（下の「読み取りが返すもの」）
  1. 応答の文の中で**最後の** `- 結果:` の行を結果の行とし、値の前後の空白を除いて結果を取る。結果の行が無ければ誤りにする
  2. 結果が `shape.values` の 3 つ（`判断が要る`・`完了`・`できなかった`）のどれでもなければ誤りにする
  3. 結果の行より後ろの `- <項目>: <値>` の行を項目として読む。値の前後の空白は除く。結果の行より前の項目の行は読まない
  4. 同じ名前の項目が 2 つ以上あれば、最後の行の値を採る。前の行の値は捨てる
  5. `shape.required` が結果の値ごとに要るとする項目を確かめる。`always` の項目と、`when` の条件に当たったときの `need` の項目の両方を確かめる。`when` の条件は、項目の値が `prefix` で始まる・`equals` と同じ、のどちらかである。要る項目が無い、値が空、値が `無し` のどれかなら、欠落として誤りにする。項目「材料」もこの規則だけで扱う。材料が要る結果（`判断が要る`）で材料が無い・空・`無し` なら欠落の誤りにし、材料が要らない結果（`完了`・`できなかった`）なら誤りにしない（契約のサンプルにある `材料: 無し` の `完了` と `できなかった` は有効である）
  6. 項目「材料」に、空でも `無し` でもない値があるときだけ、値の形を確かめる。値は、`shape.material.body`（`本文`）か、`shape.material.url_prefix`（`https://`）で始まる URL を空白で区切って並べたもの、のどちらかでなければ誤りにする。`本文` のときは、結果の行より前に `shape.material.heading`（`## 判断の材料`）の見出しが要る。無ければ誤りにする。見出しと節は、結果の行より前の文を GFM の解析器（LIB4。execution.md の「判断の材料」節の URL の取り出しと同じ解析器）で解析し、文書の直下にある見出しだけから決める。行を上から追う独自の規則は使わない。コードブロック・HTML のブロック・引用・リストの中にある見出し風の行は、文書の直下の見出しではないため、見出しとみなさない
     - 文書の直下の ATX 見出しのうち、その行（前後の空白を除く）が `shape.material.heading` と同じものを「判断の材料」の見出しとする。2 つ以上あれば、最後の見出しを採る。項目の後勝ち（規則 4）と同じく、訂正した節を承認者に見せるためである
     - 節は、採った見出しの終わりの位置から、文書の直下にある次のレベル 1 か 2 の見出し（ATX と Setext のどちらも）の始まりの位置の前まで、それが無ければ結果の行の前までとする。節の文は、解析器が返した位置で元の文から切り出す。閉じないフェンスのコードブロックは、GFM の解釈どおり結果の行の前まで続く

  ランナーは、区間の報告に由来する値（結果・課題・区分・質問・承認ゲート・Pull Request・材料・「判断の材料」節）を、検証にも承認資料の組み立てにも読み取りの戻り値から取り、応答の文を読み直さない。承認資料の対象の課題番号の並びは、戻り値の項目「課題」だけから作る。設計承認ゲートで外す課題（`--drop`）の候補は、この並びのうち `plan-progress` にも載る課題に限る。`plan-progress` だけに載る課題は、この承認の対象ではないため候補にしない（execution.md の「[承認資料](../docs/design/execution.md#承認資料)」の表の「対象の課題番号の並び」の行）。承認資料のうち報告に由来しない項目（Pull Request の状態・MVV 判定の助言・費用）は、同じ表に示す出所（GitHub の API・`ask.jsonl`・API の費用の記録）から補う。読み直すと、検証した値と承認者に見せる値が別の規則で取り出され、訂正前の項目や別の節を見せうるためである。読み取りが返すものは次のとおりである。型はスキーマの正本に置く

  | 戻り値の項目 | 中身 |
  | --- | --- |
  | `result` | 結果の値。結果の行が無ければ空文字列 |
  | `errors` | 誤りの一覧（下の表） |
  | `items` | 規則 4 で採った項目の値。キーは定数 `REPORT_ITEMS`（ランナーが読む項目の名前。`区分`・`質問`・`承認ゲート`・`Pull Request`・`材料` など）の名前に限り、型もこの定数から作る。報告に無い項目はキーを持たない |
  | `material` | 規則 6 で取り出した材料。材料が無い・空・`無し` なら「無し」、`本文` なら上の規則で取り出した節の文、URL の並びなら空白で区切った URL の並び（報告の順）。`errors` があるときは「無し」とし、ランナーは区間を失敗にして使わない |

  誤りの一覧の 1 件は、誤りのコードと項目の名前だけを持ち、読み取った値を持たない。上流の読み取り（`report.py`）の誤りの文は「`「材料」が本文でも https:// の URL でもない: <値>`」のように入力の値を含む。この値には署名付き URL や共有トークンが混ざりうる。ランナーはこの一覧を進捗の事象の理由（`report_item_invalid`）に使うため、値を一覧に入れない。伏せ字は既知の秘密の形だけを伏せ、任意の署名を取り除けないため、伏せ字には頼らない。照合の 5 項目目は `errors` の有無だけをサンプルと比べるため、誤りの文を上流と同じにする必要は無い

  | 誤りのコード | 当たるとき | 項目の名前 |
  | --- | --- | --- |
  | `result_line_missing` | 結果の行が無い（規則 1） | `結果` |
  | `result_value_unknown` | 結果が 3 つの値のどれでもない（規則 2） | `結果` |
  | `item_missing` | 要る項目が無い・空・`無し`（規則 5） | 欠けた項目 |
  | `material_form_invalid` | 材料の値が `本文` でも URL の並びでもない（規則 6） | `材料` |
  | `material_heading_missing` | `材料: 本文` なのに、文書の直下に「判断の材料」の見出しが無い（規則 6） | `材料` |
- 採らなかった案: execution.md の「[区間と結果の行](../docs/design/execution.md#区間と結果の行)」へのリンクだけを置く（リンク先には、同じ項目の後勝ちと、URL を空白で区切ることが書かれていない。同じ項目を先勝ちで読むと、訂正した承認資料の参照先ではなく古い資料を承認者に見せる）
- 採らなかった案: 上流の誤りの文をそのまま返し、進捗の事象へは伏せ字を通して載せる（伏せ字は既知の秘密の形しか伏せず、材料の欄に入った署名付き URL の署名が残る）
- **代償**: 上流が `rule` を変えたら、この規則と関数を同じ変更で直す。見出しを文書の直下に限る規則は、上流の読み取りより厳しい可能性がある。契約のサンプルと判定が分かれれば、照合の 5 項目目が食い違いとして出す。`shape` の変化は照合の 5 項目目と、先端の差分の行で気づける。誤りの理由から値を落とすため、進捗の事象を見る人は、どの項目が誤りかまでは分かるが、どんな値が書かれていたかは分からない
- 根拠: Value 11（MVV バージョン 3）。STD1

## 影響と危険

- **働く範囲**: このリポジトリだけである。照合は nd-factory の CI と手元の `npm run ndf-contract` で動く。利用者のプロジェクトのリポジトリでは動かない
- **プロジェクトごとに違うもの**: 無い。固定の点と受ける組はこのリポジトリのファイルに置く
- **当たるモード**: nd-factory 自体の開発のすべての Pull Request・main への push・毎日の照合

壊れうる箇所と扱い:

| 箇所 | 起きうること | 扱い |
| --- | --- | --- |
| すべての Pull Request の CI（`ndf-contract`） | 照合が必須になるため、上流の配布で使う部分が変わったときに、固定の点を変えない Pull Request まで落ちるおそれがある | 落ちない。失敗になるのは固定の点の食い違いだけで、先端の食い違いは要約に並べるだけである（今の振る舞いのまま）。固定の点は手で上げるので、上流の配布だけでは固定の点の結果は変わらない |
| 反映のパイプラインの承認（pipeline-approval.md） | 「skip の行だけなら注記して承認してよい」の手順が古くなる | 直さない。承認の段は 2026-11-25 に外しており（[#164](https://github.com/devbasex/nd-factory/issues/164)）、この手順は段を持っていたときの記録として残す |
| 確定仕様 `docs/specifications/contracts-and-core.md` | 受ける組の値がバージョン 8 のまま残る | 同じ変更でバージョン 16 に直す |
| 照合のテストのフィクスチャ（`tools/test/fixtures/ndf-contract-752a9cf/`） | 古い固定の点のコピーのまま残る | 新しい固定の点のコピーに置き換える |
| #2 の設計 | #2 の設計が、この課題がすでに置いた使い方の書き出し（#1 の設計が #2 に割り当てた要件 K2-6）を、もう一度設計してしまう | 決定 2 の代償。#2 の設計の時点でこの書き出しを読む |
| 区間の失敗の理由のコード（`packages/contracts/src/rows/sprints.ts` の `segmentFailureReason`、確定仕様 `docs/specifications/contracts-and-core.md` の区間の行） | 読み取りが項目の誤りを返したときの理由のコード `report_item_invalid` と、材料の URL が受け入れ条件に合わないときの理由のコード `material_url_rejected`（どちらも execution.md の「区間と結果の行」）が値の集まりに無い | この変更では足さない。区間の失敗を書くのはランナーなので、ランナー（[#6](https://github.com/devbasex/nd-factory/issues/6)）の実装で値の集まりと確定仕様に足し、`npm run generate` の生成物もコミットする |
| 承認資料の材料の URL（execution.md の「[承認資料](../docs/design/execution.md#承認資料)」） | この変更の後、ランナーは材料に並んだ URL をすべて承認資料に載せる。`材料: 本文` なら「判断の材料」節も載せる。どちらにも署名付き URL や共有リンクが入りうる。入ると、元の資料の閲覧権限が無い承認者や委任のエージェントにも中身を渡す。読み取り（決定 7）は契約に合わせて材料の欄が `https://` で始まるかだけを見るため、これを防がない | execution.md に材料の URL の受け入れ条件を書いた。条件と当て方は、下の「承認資料の材料の URL の受け入れ条件」にある。承認の依頼を送るのはランナーなので、確かめる処理とテストはランナー（[#6](https://github.com/devbasex/nd-factory/issues/6)）の実装に置く。テストの中身は下の「ランナーのテストに引き継ぐこと」にある |
| ランナー（#6） | 判定と読み取りの関数の形を、ランナーの実装の時点で変えたくなる | ランナーは照合と同じ判定と読み取りの関数を使う（#1 の設計の決定 7 のまま。この文書の決定 7 とは別である）。形を変えるときは照合のテストも同じ変更で直す |

### 承認資料の材料の URL の受け入れ条件

上の表の「承認資料の材料の URL」の行で、execution.md に書いた受け入れ条件の中身である。規則の全体は execution.md の「[承認資料](../docs/design/execution.md#承認資料)」にある。

条件は次の 8 つである。

- スキームを持つ
- スキームが `https`
- ホストが `github.com` ちょうど
- ポートを書かない
- ユーザー名やパスワードを持たない
- クエリを持たない
- パスとフラグメントが、Pull Request・Issue・コミット・ファイルとその行やコメントを指す決まった形に一致する。差分の中の位置（`#diff-…`）は受け入れない
- 指す資料と、フラグメントが指すコメントや行を GitHub の API で確かめられて、応答から組み立てた掲載用の URL と一致する。リポジトリの `full_name` は、コミットとファイルの応答が持たないため、どの種類でもリポジトリの API（`GET /repos/<owner>/<repo>`）から取る

条件の当て方は次のとおりである。

- 条件は、execution.md の「[承認資料](../docs/design/execution.md#承認資料)」の「確かめる順番」の表の上から順に当てる。最初に合わなかった条件の拒否の理由のコードを 1 つだけ出す
- 条件と理由のコードの対応は、その表にある。たとえば、ホストの条件の順 3 が `host_not_allowed`、クエリの条件の順 6 が `query_present` である。S3 の署名付き URL は順 3 で先に当たるため、`host_not_allowed` になる
- 条件は、ブラウザーが開く URL に直す前の文字列に当てる
- 条件は、材料の欄の URL・「判断の材料」節の中の URL・項目「Pull Request」の値・項目「区分」「質問」「承認ゲート」の値の中の URL・`ask.jsonl` から載せる MVV 判定の助言の中の URL に当てる。区分・質問・承認ゲートは承認資料の区分・問い・題に載る自由な文で、MVV 判定の助言も NDF が書く自由な文である。どれにも署名付き URL や共有リンクが入りうる。この 4 つの欄の URL は「判断の材料」節と同じ取り出し方で探す
- 項目「Pull Request」は、値が「無し」でなければ、値の全体を 1 つの URL として確かめる。`#34` のような URL の形でない値は順 1 の `url_not_absolute` で拒否する。契約はこの項目を承認ゲートが「設計 Pull Request のマージ」のときに必須とするが、必須の検査は欠落・空・`無し` だけを拒否し、値の形を見ないためである。受けるのは Pull Request そのものを指す形（`/<owner>/<repo>/pull/<n>`。`/files`・`/commits` とフラグメントは付けない）だけである。承認資料の Pull Request の URL には、確かめた掲載用の URL だけを書く

「判断の材料」節の中の URL は、次のように取り出す。規則の全体は execution.md の「[承認資料](../docs/design/execution.md#承認資料)」の「判断の材料」節の URL の取り出し方にある。

- 節は、読み取り（決定 7）が返した節の文を使う
- 節と、区分・質問・承認ゲートの値と、MVV 判定の助言の中の生の HTML は、`<` を `&lt;` に置き換えてただの文字にしてから確かめ、置き換えた後の本文を保存して配る。HTML の要素を残さないので、`srcset` などの属性を数え上げる必要が無い。置き換えた文字の中の URL は裸の URL として探す
- GFM の解釈でリンク先を取り出す。スキームを省いたリンク先・コードの中の裸の URL も含めて確かめる
- リンク先とは別に、リンクの表示文字列・画像の代替テキスト・リンクと画像と参照の定義のタイトルからも裸の URL を探す。これらは配る本文に文字として残るためである
- スキームの無い裸の文字列を URL とみなすのは、次の 2 つの形だけである。どちらも、直前が行頭・空白・括弧・引用符のときだけ当てる
  - `www.` で始まる形。この形は `http://` を補った後に条件を当てる（下の「ランナーのテストに引き継ぐこと」の表のとおり、`scheme_not_https` になる）
  - ホスト名の形（英数字とハイフンのラベルを `.` でつなぎ、最後のラベルが英字だけ）の直後に `/` が続く形
- `node:fs` や `C/hooks/unattended-report.json` はどちらの形にも当たらないので URL とみなさない
- `docs.example.com/share/abcd` は後者の形に当たる。条件の順 1（スキームを持つ）で `url_not_absolute` として拒否する

### ランナーのテストに引き継ぐこと

区間の失敗と承認資料の受け入れ条件は、ランナー（[#6](https://github.com/devbasex/nd-factory/issues/6)）が実装する。ランナーのテストは、API の呼び出しを差し替えた偽物を使い、次を確かめる。例の値はどれも作り物である。

| 報告 | 偽物の API が受けるもの | 理由と進捗の事象とログ |
| --- | --- | --- |
| 材料の欄が `https://acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf?X-Amz-Signature=0000`・`https://github.com/acme/app/pull/1?token=0000`・`https://user:pass@github.com/acme/app/pull/1`・`https://docs.example.com/share/abcd` のどれか | 承認の依頼・問い・承認資料は 1 件も受けない。区間とレーンを `material_url_rejected` で失敗にする進捗の事象を 1 件受ける | 理由は、位置（材料の欄の何番目か）と拒否の理由のコードだけを持つ。コードは順に `host_not_allowed`・`query_present`・`userinfo_present`・`host_not_allowed` である（S3 の署名付き URL はクエリも持つが、表の上から最初に合わない条件のコードだけを出す）。URL の全体・ホスト名・署名やトークンの値が、理由にも進捗の事象にもログにも出ない |
| `材料: 本文` で、「判断の材料」節に `[計画](https://acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf?X-Amz-Signature=0000)` か `<https://docs.example.com/share/abcd>` か `<a href="https://docs.example.com/share/abcd">計画</a>` か `http://github.com/acme/app/pull/1` を含む | 同上 | 理由は、位置（本文の何番目か）と拒否の理由のコードだけを持つ。コードは `http://github.com/…` だけが `scheme_not_https` で、ほかは `host_not_allowed` である。同上の値が出ない |
| `材料: 本文` で、「判断の材料」節に `[計画](//acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf?X-Amz-Signature=0000)` か `www.example.com/share?token=0000` か参照の定義 `[計画]: docs.example.com/share/abcd` か裸の `docs.example.com/share/abcd` を含む | 同上 | 理由は、位置と拒否の理由のコードだけを持つ。コードは `www.` の自動リンクだけが `scheme_not_https`（`http://` を補った後に当てる）で、ほかは `url_not_absolute` である。ホスト名・`X-Amz-Signature=0000`・`token=0000`・`abcd` が出ない |
| `材料: 本文` で、「判断の材料」節のインラインのコード `` `https://acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf?X-Amz-Signature=0000` `` か、コードブロックの中の同じ URL を含む | 同上 | 理由は、位置と拒否の理由のコード `host_not_allowed` だけを持つ。コードの中の署名付き URL も見つける。ホスト名・`X-Amz-Signature=0000` が出ない |
| 材料の欄が `https://github.com:443/acme/app/pull/1`・`https://github.com/acme/app/./pull/1`・`https://github.com/acme/app/blob/main/0000secret`・`https://github.com/acme/app/pull/1/0000secret`・`https://github.com/acme/app/pull/1#token=0000` のどれか | 同上 | 理由は、位置と拒否の理由のコードだけを持つ。コードは順に `port_present`・`path_not_allowed`・`path_not_allowed`・`path_not_allowed`・`fragment_not_allowed` である（`:443` と `./` は、ブラウザーが開く URL に直すと消えるが、直す前の文字列で拒否する）。`0000secret`・`token=0000` が出ない |
| 材料の欄が `https://github.com/acme/app/blob/0123456789abcdef0123456789abcdef01234567/0000secret` か `https://github.com/ACME/app/pull/1` で、偽物の GitHub の API が前者のファイルを「見つからない」と返し、後者のリポジトリの応答（`GET /repos/ACME/app`）を `full_name` `acme/app` で返す | 同上 | 理由は、位置と拒否の理由のコード `ref_unverified` だけを持つ。パスの形が合っても、GitHub の API で読めないファイルの名前や、応答と違う書き方の URL は載せない。`0000secret` が出ない |
| 材料の欄が `https://github.com/acme/app/blob/0123456789abcdef0123456789abcdef01234567/docs/%e8%a8%ad%e8%a8%88.md`（小文字の 16 進数のパーセントエンコード） | 同上 | 理由は、位置と拒否の理由のコード `path_not_allowed` だけを持つ |
| 材料の欄が `https://github.com/acme/app/pull/1#discussion_r1`・`https://github.com/acme/app/issues/2#issuecomment-3`・`https://github.com/acme/app/commit/0123456789abcdef0123456789abcdef01234567`・`https://github.com/acme/app/blob/0123456789abcdef0123456789abcdef01234567/docs/plan.md#L10-L20`・`https://github.com/acme/app/blob/0123456789abcdef0123456789abcdef01234567/docs/%E8%A8%AD%E8%A8%88%20%E6%9B%B8.md`（日本語と空白を含むファイル名 `docs/設計 書.md`）のどれか、または `材料: 本文` で節の中のリンク先がそれだけ。偽物の GitHub の API は、実際の API の応答の形で返す。`full_name`（`acme/app`）を持つのはリポジトリの応答だけで、コミットとファイルの応答は `full_name` を持たない。Pull Request のレビューのコメントの応答は `.../pulls/1` で終わる `pull_request_url` を、コメントの応答は `.../issues/2` で終わる `issue_url` を持つ。ファイルの応答は `type` `file`・`encoding` `base64` で、20 行以上の `content` を持つ | 承認の依頼を受ける。承認資料の材料の URL の並びと要約値の材料は、報告に書かれた URL と 1 文字も違わない | — |
| 材料の欄が `https://github.com/acme/app/pull/1#discussion_r9`・`https://github.com/acme/app/issues/2#issuecomment-4`・`https://github.com/acme/app/blob/0123456789abcdef0123456789abcdef01234567/docs/plan.md#L30` のどれかで、偽物の GitHub の API が、1 つ目のコメントを「見つからない」と返し、2 つ目のコメントを `.../issues/5` で終わる `issue_url` で返し、ファイルを 20 行の `content` で返す | 承認の依頼・問い・承認資料は受けない。区間とレーンを `material_url_rejected` で失敗にする進捗の事象を 1 件受ける | 理由は、位置と拒否の理由のコード `ref_unverified` だけを持つ。存在しないコメント・別の Issue のコメント・ファイルに無い行を指すリンクを載せない |
| 材料の欄が `https://github.com/acme/app/pull/1/files#diff-0000000000000000000000000000000000000000000000000000000000000000` か `https://github.com/acme/app/commit/0123456789abcdef0123456789abcdef01234567#issuecomment-1` | 同上 | 理由は、位置と拒否の理由のコード `fragment_not_allowed` だけを持つ。差分の中の位置と、付けられない種類の URL へのフラグメントは受け入れない |
| 区分が `ndf-gate:1`・承認ゲートが「設計 Pull Request のマージ」・材料の欄が上の受け入れる URL で、項目「Pull Request」が `https://github.com/acme/app/pull/1?token=0000` か `https://github.com/acme/app/pull/1/files` か `https://github.com/acme/app/pull/1#issuecomment-3` | 同上。偽物の GitHub の API は、その Pull Request を読まれない | 理由は、位置（Pull Request の欄）と拒否の理由のコードだけを持つ。コードは順に `query_present`・`path_not_allowed`・`fragment_not_allowed` である。`token=0000` が出ない |
| 区分が `ndf-gate:1`・承認ゲートが「設計 Pull Request のマージ」・材料の欄が上の受け入れる URL で、項目「Pull Request」が `#34` か `acme/app#34`（読み取りは、必須の項目に値があるので誤りを返さない） | 承認の依頼・問い・承認資料は受けない。区間とレーンを `material_url_rejected` で失敗にする進捗の事象を 1 件受ける。偽物の GitHub の API は、どの Pull Request も読まれない | 理由は、位置（Pull Request の欄）と拒否の理由のコード `url_not_absolute` だけを持つ。項目の値（`#34`・`acme/app#34`）が出ない |
| 上と同じで、項目「Pull Request」が `https://github.com/acme/app/pull/1` | 承認の依頼を受ける。承認資料の Pull Request の URL は `https://github.com/acme/app/pull/1` で、リポジトリの応答の `full_name` と Pull Request の応答の `number` から組み立てた値と同じ | — |
| `材料: 本文` で、「判断の材料」節に `<img srcset="https://docs.example.com/share/a.png 1x, https://docs.example.com/share/b.png 2x">` を含む | 承認の依頼・問い・承認資料は受けない。区間とレーンを `material_url_rejected` で失敗にする進捗の事象を 1 件受ける | 理由は、位置と拒否の理由のコード `host_not_allowed` だけを持つ（2 つの URL のそれぞれで 1 件）。`share` も `a.png` も出ない |
| `材料: 本文` で、「判断の材料」節に受け入れる URL だけと、`<details>` の HTML を含む | 承認の依頼を受ける。承認資料の本文には `<details>` が無く、`&lt;details>` がある | — |
| `材料: 本文` で、応答の文に `## 判断の材料` の見出しが 2 つある。1 つ目の節は、`https://github.com/acme/app/issues/2` と、`## 判断の材料` の行と `https://acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf?X-Amz-Signature=0000` を含むコードブロックを持つ。2 つ目の節は `https://github.com/acme/app/issues/3` だけを含む | 承認の依頼を受ける。承認資料の本文は 2 つ目の節で、読み取りが返した節の文と同じである。`issues/2` の URL も、コードブロックの中の署名付き URL も含まない | — |
| `材料: 本文` で、「判断の材料」節に `[https://docs.example.com/share/abcd](https://github.com/acme/app/issues/2)`（表示文字列に共有 URL）か `![https://docs.example.com/share/abcd](https://github.com/acme/app/issues/2)`（代替テキスト）か `[計画](https://github.com/acme/app/issues/2 "https://docs.example.com/share/abcd")`（タイトル）を含む。偽物の GitHub の API は `issues/2` を読める形で返す | 承認の依頼・問い・承認資料は受けない。区間とレーンを `material_url_rejected` で失敗にする進捗の事象を 1 件受ける | 理由は、位置と拒否の理由のコード `host_not_allowed` だけを持つ。リンク先が受け入れる URL でも、表示文字列・代替テキスト・タイトルの URL を見つける。`share`・`abcd` が出ない |
| 材料の欄が上の受け入れる URL で、項目「質問」が `https://acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf?X-Amz-Signature=0000 を見て承認してよいか` か `[計画](https://docs.example.com/share/abcd) を承認してよいか`、または項目「承認ゲート」が `設計 Pull Request のマージ https://github.com/acme/app/pull/1?token=0000`、または項目「区分」が `ndf-ask:cost docs.example.com/share/abcd` | 同上 | 理由は、位置（質問・承認ゲート・区分のどの欄か）と拒否の理由のコードだけを持つ。コードは順に `host_not_allowed`・`host_not_allowed`・`query_present`・`url_not_absolute` である。承認資料の問いと題にも載せない。`X-Amz-Signature=0000`・`abcd`・`token=0000` が出ない |
| 報告の各欄は受け入れる値だけで、`ask.jsonl` の該当の行の MVV 判定の助言が `https://acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf?X-Amz-Signature=0000 の方針に反する` か `[資料](https://docs.example.com/share/abcd) を参照` を含む | 承認の依頼・問い・承認資料は受けない。区間とレーンを `material_url_rejected` で失敗にする進捗の事象を 1 件受ける | 理由は、位置（MVV 判定の助言）と拒否の理由のコード `host_not_allowed` だけを持つ。URL の全体・ホスト名・`X-Amz-Signature=0000`・`abcd` が、理由にも進捗の事象にもログにも出ない |
| 区分が `ndf-gate:1` で、項目「課題」が `#12 #13 見て`、`plan-progress` に載る課題が #12 と #14 | 承認の依頼を受ける。承認資料の対象の課題番号の並びは #12 と #13 で、`見て` を含まない。外す課題（`--drop`）の候補は #12 だけである | — |
| `材料: 本文` で、応答の文に `<div>` で始まる HTML のブロックがあり、その中に `## 判断の材料` の行と `https://acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf?X-Amz-Signature=0000` の行がある。HTML のブロックの後に、文書の直下の `## 判断の材料` の見出しと `https://github.com/acme/app/issues/3` だけの節がある | 承認の依頼を受ける。承認資料の本文は文書の直下の見出しの節で、`issues/3` だけを含む。HTML のブロックの中の署名付き URL を含まない | — |
| `材料: 本文` で、`## 判断の材料` の行がコードブロックの中にしか無い | 承認の依頼・問い・承認資料は受けない。区間とレーンを `report_item_invalid` で失敗にする進捗の事象を 1 件受ける | 理由は、誤りのコード `material_heading_missing` と項目の名前 `材料` だけを持つ |
| `材料: 本文` で、「判断の材料」節に上の行の受け入れる URL のほか、インラインのコード `` `node:fs` `` と、`import { readFile } from "node:fs/promises";` と `C/hooks/unattended-report.json` を含むコードブロックを含む | 承認の依頼を受ける | — |
| 結果の値が `保留 https://acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf?X-Amz-Signature=0000`（読み取りが `result_value_unknown` を返す） | 承認の依頼・問い・承認資料は受けない。区間とレーンを `result_value_unknown` で失敗にする進捗の事象を 1 件受ける（`result_value_unknown` は区間の失敗の理由 `segmentFailureReason` に今ある値で、この変更では足さない。項目の誤りと違い、結果の値そのものが読めないため、`report_item_invalid` に包まない） | 理由は、コード `result_value_unknown` だけを持つ。`保留` も `X-Amz-Signature=0000` も出ない |
| 材料の欄が `https://acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf?X-Amz-Signature=0000 not-a-url`（読み取りが `material_form_invalid` を返す） | 承認の依頼・問い・承認資料は受けない。区間とレーンを `report_item_invalid` で失敗にする進捗の事象を 1 件受ける | 理由は、誤りのコード `material_form_invalid` と項目の名前 `材料` だけを持つ。`X-Amz-Signature=0000` も `not-a-url` も出ない |

ランナーが組み立てる呼び出しと環境変数も、ランナーの単体テストで契約に照らす。照合の 1 項目目は、判定（`judgeCall`）が契約のサンプルと同じ答えを出すことだけを確かめ、ランナーの組み立ての関数は通さないためである。定期の照合の責務をこのように分けることは、platform.md の検査の表（「NDF の契約の照合（定期）」の行）にも同じ変更で書いた。上流の先端でインタフェースの行（引数の正規表現・環境変数など）が変われば、照合の 6 項目目が生成した行との差として先端の要約に並べる。このため、ランナーの組み立てが先端の契約に合わなくなる変化も、定期の照合で気づける。

- 使うインタフェースのうちランナーが呼び出しを組み立てるもの（`skill-workflow` の Skill の引数・`block-next` のブロックの中身・読むファイルの相対パスなど）と、実行の場（ホステッド・手元のマシン）の組ごとに、ランナーの組み立ての関数の出力を `ndfContractUse.judgeCall` へ渡し、真になることを確かめる
- 渡すのは、組み立てた呼び出し文字列と、ランナーが組んだ環境変数の名前の一覧である。テストの中で呼び出し文字列や名前を手で書かない
- 組み立ての関数に、契約の `args` に合わない引数（たとえば未知の旗）を足す・`env` 列に無い環境変数を足すと、このテストが落ちることも確かめる

読むファイル（`file`）と仕様のファイル（`spec`）の読み取りでは、`judgeCall` が真を返したパスでも、許可範囲の外のファイルを開かないことを確かめる（決定 5 の「パスの境界」）。正常な読み取りが成功することも確かめる。テストは一時ディレクトリに許可範囲とその外のファイルを作る。境界外の対象については、ファイルを開く OS の呼び出しがファイル記述子を返さずに失敗したことを検査する。呼び出しが成功し、その後にランナーが拒否した場合は、テストを失敗にする。時間切れの有無では判定しない。たとえば外のファイルを名前付きパイプ（FIFO）にしても、`O_NONBLOCK` で読み取り用に開けば書き手が無くても成功するため、時間切れだけを見ると、外を開いてから拒否する実装を見逃す。

| 用意するもの | 確かめること |
| --- | --- |
| 保存先の中に、`judgeCall` が真にする相対パス（例: `s1/8-release-request-state/progress.jsonl`）で、保存先の外のファイルを指すシンボリックリンクを置く | `judgeCall` は真を返す。外のファイルを開く OS の呼び出しはファイル記述子を返さずに失敗し、ランナーは読み取りを失敗にする。外のファイルの中身が、戻り値にも進捗の事象にもログにも出ない |
| 保存先の中のディレクトリ（例: `s1`）を、保存先の外のディレクトリを指すシンボリックリンクにし、その下の同じ相対パスを読ませる | 同上（パスの途中の成分のリンクも解決して確かめる） |
| プラグインの根の `target`（例: `contracts/schemas/io`）の下に、`target` の外のファイルを指すシンボリックリンクを置く | 同上 |
| 保存先の中で、保存先の中のファイルを指す相対のシンボリックリンクを置く | 読み取りは成功し、リンク先の中身を返す |
| プラグインの根の `target`（`contracts/schemas/io`）の下に通常のファイル `check.args.schema.json` を置き、正規の `spec-io` の呼び出し文字列 `contracts/schemas/io/check.args.schema.json` を読ませる | `judgeCall` は真を返す。読み取りは成功し、そのファイルの中身を返す（`target` を二重にたどらない） |
| ランナーが NDF を起動した後に、保存先のパスそのものを、保存先の外のディレクトリを指すシンボリックリンクに差し替え、その下の同じ相対パスを読ませる。プラグインの根の `target` のパスでも同じことをする | 読み取りは、起動前に特定した元の保存先（または `target`）の実体のファイルを返すか、失敗する。差し替え先のディレクトリにあるファイルを開く OS の呼び出しは成功しない。差し替え先のファイルの中身が、戻り値にも進捗の事象にもログにも出ない |
| ランナーが NDF を起動した後に、保存先のディレクトリを名前の変更（`rename`）で退け、同じパスに別の通常のディレクトリを置く。新しいディレクトリの下に、同じ相対パスで別の中身のファイルを置いて読ませる。プラグインの根の `target` のパスでも同じことをする | 同上（シンボリックリンクでない通常のディレクトリへの置き換えでも、起点は起動前の実体から変わらない） |
| ランナーが NDF を起動した後に、保存先のディレクトリを中身ごと削除し、同じパスに別のディレクトリを作る。新しいディレクトリの下に、同じ相対パスで別の中身のファイルを置いて読ませる。新しいディレクトリの inode 番号が元のディレクトリと一致することは、テストの条件に含めない。ランナーが元のディレクトリのファイル記述子を持ち続けている間は、その inode 番号が新しいディレクトリに再利用されないためである。プラグインの根の `target` のパスでも同じことをする | 読み取りは失敗する。新しいディレクトリのファイルを開く OS の呼び出しは成功しない。新しいディレクトリのファイルの中身が、戻り値にも進捗の事象にもログにも出ない（起点は起動前に開いた元のディレクトリのままで、新しいディレクトリを起点にしない） |
| 起動前に保存先（または `target`）のディレクトリを開けない実行の場を、偽物で作る | ランナーは NDF を起動せず、理由を返してレーンを始めない |
| ランナーが `NDF_ISSUE_REQUEST_FILE` に指定したファイルに、テストが正常な起票依頼の 1 行（`{repo, title, body, labels}`）を書く。呼び出し文字列は `.` | `judgeCall` は真を返す。読み取りは成功し、その 1 行を返す（他のリポジトリへの起票の承認依頼が組み立てられる） |
| `NDF_ISSUE_REQUEST_FILE` に指定したパスを、別のファイルを指すシンボリックリンクに差し替える | ランナーはファイルを読まず、読み取りを失敗にする。差し替え先の中身が、戻り値にも進捗の事象にもログにも出ない |
| `NDF_ISSUE_REQUEST_FILE` に指定したパスに、別の起票依頼の 1 行を書いた別の通常のファイルを名前の変更（`rename`）で置き直す | ランナーは置き直したファイルを読まず、読み取りを失敗にする。置き直したファイルの依頼が、承認の依頼にも戻り値にも進捗の事象にもログにも出ない |
| ランナーが依頼ファイルを置いた後に、NDF の実行ユーザーで、そのファイルに起票依頼の 1 行を追記する。続けて同じ利用者で、依頼ファイルのパスを構成する各ディレクトリ（直上と、その親のすべて）の差し替え（名前の変更・削除・シンボリックリンクへの置き換え）を試す | 追記は成功し、ランナーはその 1 行を読む。どの差し替えも OS の権限で失敗する |

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
| 受け入れ条件 8 | この表の「決定 7（区間の報告の読み取り）」と「決定 7（誤りの一覧に値を入れない）」の 2 つの行 | その 2 つの行のとおり |
| 決定 4（呼び出しの判定） | 新しい固定の点のサンプルのうち、使うインタフェースの 21 件で、判定が `valid` と同じになる。使わないインタフェースの呼び出しは偽になる。照合の 1 項目目は、使わないインタフェースのサンプルを判定で比べない。参照先の検査は、使うインタフェースのサンプル 1 件（たとえば `block-next` へのサンプル）の `entrypoint` だけを `entrypoints.json` に無い id（たとえば `no-such-entrypoint`）に差し替えた契約で確かめる。`entrypoints.json` のインタフェースの行は消さずに残す。照合は、1 項目目の食い違いとして、そのサンプルの id を含む行（`mismatch: … 1 … entrypoint-cases.json <サンプルの id>: …`）を出す。終了コードが 1 であることだけでは確かめない（行を消すと 6 項目目も食い違いになり、1 項目目の退行と区別できないため） | 参照先の id の検査を絞り込みの後に移す（差し替えた id は使い方のデータの 11 の id にも契約の id にも無いため、どちらで絞ってもサンプルが外れ、1 項目目の行が出ない）。引数の正規表現の全体一致を部分一致にする（`loop-bad-budget`・`unknown-flag` が真になる）。入れてよい環境変数の外の名前を許す（`terminal-env` が真になる）。block の前置きの語を必須にする（`resume` が偽になる） |
| 決定 4（網羅） | 使い方のデータの `entrypoints` の id の集合が、単体テストに置いた 11 の id のリストとちょうど同じになる | データから `block-next` を 1 件消すと、単体テストが落ちて CI が失敗する。リストに無い id（たとえば `file-loop-record`）を足しても落ちる |
| 決定 4（呼び出しの判定の種類ごとの規則） | 決定 5 の表の種類ごとに、valid のサンプルが真になる。とくに `block-next` の `resume`（`/goal ` の前置きが無い）と `resume-loop`（前置きがある）がどちらも真、`spec-io` の `spec-io-args` が真で `spec-outside` が偽、`file-plan-progress` の `plan-progress` が真になる | `target` と `args` をそのまま連結して比べると `resume` が偽になる。`spec` の `target` を完全一致で比べると `spec-io-args` が偽になる |
| 決定 7（区間の報告の読み取り） | 新しい固定の点の `cases` 16 件で、`result` と `errors` の有無がサンプルと同じになる。加えて単体テストで、結果の行の後ろに同じ項目（たとえば `材料`）が 2 行あるとき、戻り値の `items` と `material` が後ろの行の値になる。`材料: 本文` で、コードブロックと HTML のブロックの中の `## 判断の材料` の行を見出しとみなさず、文書の直下の見出しが 2 つあれば最後の見出しの節を `material` に返す。節は次の `#` か `##` の見出しの前で終わる | 最初の `- 結果:` の行を読む（最後のサンプルが `判断が要る` になる）。同じ名前の項目を先勝ちで読む（2 行目の `材料` の URL ではなく 1 行目の値を返す）。必須の項目（たとえば `判断が要る` の `材料`）の `無し` を欠落として扱わず、有効な値として受ける。条件つきで要る項目を見ない。`材料: 本文` で `## 判断の材料` の節を求めない。コードブロックか HTML のブロックの中の見出しの行を見出しとして数える（見出しがコードブロックの中にしか無い報告が誤りにならない。HTML のブロックの中の見出し風の行の節を返す）。最初の見出しの節を返す。空白で区切った複数の URL を誤りにする。材料の要らない `完了`・`できなかった` で `材料: 無し` を誤りにする（契約の `完了` と `できなかった` の有効なサンプルが誤りになる） |
| 決定 7（誤りの一覧に値を入れない） | 単体テストで、材料の欄が `https://acme-bucket.s3.us-west-2.amazonaws.com/plan.pdf?X-Amz-Signature=0000 not-a-url` の報告を読むと、誤りの一覧が `material_form_invalid` と `材料` の 1 件だけになり、一覧を文字列にしても `X-Amz-Signature`・`0000`・`not-a-url` を含まない | 上流と同じく誤りの文に値を入れると、一覧の文字列に署名が出て落ちる |
| `ask-journal` の通知（「#47 と上流の不足 3 件は食い違いにならない」） | 照合のテストで、固定の点の `ndf-files.json` の `ask-journal` に `fields` を足した契約を渡すと、`notice: … の ask-journal が fields を持つ: …` の行が標準出力と要約のファイルの両方に出て、終了コードは 0 のまま、食い違いの件数も 0 のまま | 通知を 4 項目目の食い違いに数えると、終了コードが 1 になって落ちる。通知の処理を消すと、行が出ずに落ちる |
| 決定 5（照合） | 生成したインタフェースの行の項目（`kind`・`target`・`lead`・`args`・`env`・`files`）か、読むファイルの `path` が契約の行と違うと、固定の点で 6 項目目か 4 項目目の食い違いになる。生成した区間の報告の形（たとえば `required` の `判断が要る` の `always`）が契約の `shape` と違うと、5 項目目の食い違いになる。生成のファイルが持つ固定の点が `ndf-pin.json` と違っても、6 項目目の食い違いになる | 比べる項目を 1 つ外すと、その項目だけを変えた契約で食い違いが出ない。`ndf-pin.json` だけを別のコミットに変えて生成し直さないと、食い違いが出る |
| 決定 5（生成） | 照合のテストで、フィクスチャの契約を取得先にして `npm run ndf-contract:sync` の処理を動かすと、手で書いた id の行と `path` と、区間の報告の形（`values` は契約の `shape.values` のキーの並びの文字列の配列、`required` と `material` は契約と同じ値）を持つ生成のファイルができ、コミットした生成のファイルと同じになる。手で書いた id の一覧に契約に無い id を足すと、生成が失敗する | 絞り込みを外すと、使わないインタフェース（`file-loop-record` など）の行が生成のファイルに入って落ちる。契約に無い id を黙って飛ばすと、失敗にならずに落ちる |
| 決定 3 | 照合が読む型が、スキーマの正本の `NdfContractUse` と同じである（型の検査）。書き出しの `acceptedVersions` が `NDF_CONTRACTS.accepted` と同じ値である。照合のテストで、手で書く id の一覧に 1 件足して生成の行と食い違わせた作業ツリーでも、生成のコマンドが起動して生成のファイルを書き直し、0 を返す | 型を照合の側にも書く・受ける組を使い方のデータにコピーすると、片方だけを変えたときに型の検査かテストで落ちる。照合の CLI が zod の形を `ndf-contract-use`（データを読み込んで組み立てるモジュール）から読むと、食い違った作業ツリーで生成のコマンドが起動できずに落ちる |

## 設計の結果

新しく作る関数は 6 つある（`buildContractUse`・`judgeCallWith`・`filePathPattern`・`readReportWith`・`generateContractUse`・`mainNdfContractSync`）。シグネチャを変えるものは、関数が 2 つ（`compareContract`・`checkEntrypoints`）と型が 1 つ（`MainOptions`）ある。このため、ファイルと関数の粒度の設計は別ファイルの詳細設計 [issue-136-design-detail.md](./issue-136-design-detail.md) に書いた。

| 課題 | 扱い | 統合先 | 触るファイル |
| --- | --- | --- | --- |
| #136 | 実装する | — | `ndf-pin.json`、`packages/contracts/data/ndf-contracts.json`、`packages/contracts/data/ndf-contract-use.json`（新設）、`packages/contracts/data/ndf-contract-use.generated.json`（新設。生成のファイル）、`package.json`（`ndf-contract:sync` を足す）、`packages/contracts/src/ndf-contract-use-schema.ts`（新設）、`packages/contracts/src/ndf-contract-use.ts`（新設）、`packages/contracts/package.json`、`packages/contracts/test/ndf-contract-use.test.ts`（新設）、`packages/contracts/test/fixtures/ndf-contract-8d22be7/entrypoint-cases.json`（新設）、`packages/contracts/test/fixtures/ndf-contract-8d22be7/unattended-report.json`（新設）、`packages/contracts/test/data.test.ts`、`tools/checks/src/ndf-contract-check.ts`、`tools/test/ndf-contract-check.test.ts`、`tools/test/fixtures/ndf-contract-752a9cf/entrypoints.json`（消す）、`tools/test/fixtures/ndf-contract-752a9cf/env.json`（消す）、`tools/test/fixtures/ndf-contract-8d22be7/entrypoints.json`（新設）、`tools/test/fixtures/ndf-contract-8d22be7/env.json`（新設）、`tools/test/fixtures/ndf-contract-8d22be7/ndf-files.json`（新設）、`docs/design/execution.md`、`docs/design/platform.md`、`docs/specifications/contracts-and-core.md`、`docs/operations/pipeline-approval.md` |

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
| LIB4 | mdast-util-from-markdown・mdast-util-gfm・micromark-extension-gfm（unified の Markdown の解析器と GFM の拡張） | 2.1.0・3.1.0・3.0.0 | MIT | 2026-10-03・2025-02-10・2023-06-26（npm の更新日） | 無し | 満たす。CommonMark と GFM の構文木を、各要素の元の文の位置つきで返す。決定 7 の規則 6 で文書の直下の見出しを特定し、位置で節を切り出すのに使う。ランナー（#6）が「判断の材料」節の URL を取り出すときも同じ解析器を使う。行を上から追う自前の規則では、HTML のブロックやリストの中の見出し風の行を区別できない | `npm view mdast-util-from-markdown version license time.modified deprecated`・`npm view mdast-util-gfm …`・`npm view micromark-extension-gfm …`（2026-11-25） |
| LIB3 | zod（既存の依存） | 4.6.7 | MIT | 2026-10-12（npm の更新日） | 無し | 満たす。使い方のデータの形と、照合が読む契約のファイルの形を読むのに使う（今の照合と受ける組のデータも zod で読んでいる） | `npm view zod version time.modified`・`packages/contracts/package.json`（2026-11-25） |

### 確認できなかったこと

| 対象 | 試した手段 | 結果と理由 |
| --- | --- | --- |
| Pact で提供する側の参加なしに契約を検証できるか | https://docs.pact.io/ のトップページを読んだ | トップページには、提供する側の検証やブローカーが要るかの記述が無かった。ブローカーの文書は読んでいない |

調べた量: 候補 6 件・取得の試み 9 回。
