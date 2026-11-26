## 何が起きたか

2026-11-21、スキーマの正本（`packages/contracts/`）の往復のテストを足す Pull Request（ https://github.com/devbasex/nd-factory/pull/95 ）の AI によるクロスレビューで、Pull Request の漏れの検査（必須のチェック `leak-check`。 https://github.com/devbasex/nd-factory/pull/91 で導入）に検出の抜けが 3 つと、設計書の記述の食い違いが 1 つ見つかった。同じ日、NDF の契約の照合を足す Pull Request（ https://github.com/devbasex/nd-factory/pull/100 ）のクロスレビューで、抜けの 1 つ（バイナリと判定されるファイル）が履歴だけでなく今の木（作業ツリーのファイル）のスキャンでも起きることが分かった。どちらの Pull Request も該当のファイルを変えない範囲だったため、この課題に残した。

2026-11-25 に手元で再現し、3 つの抜けがどれも今の main（コミット `69fd0b9`）で起きることを確認した（「事象」）。

## 種類

不具合（漏れの検査は、公開のリポジトリに入れてはいけない値を止めると約束している。3 つの形の値でこの約束を守れていない。設計書の食い違いは、今のコードが持つ役割の記述漏れである）

## 今の姿

漏れの検査は、gitleaks で今の木と、分岐点から head までのコミットをスキャンし、秘密の値とインフラの実際の値がリポジトリに入るのを止める。Pull Request では `leak-check` が、gitleaks の既定の規則（`tools/checks/gitleaks-default.toml`）と nd-factory の規則（`.gitleaks.toml`）で、`tools/checks/leak-scan.sh` を今の木（`dir`）と履歴（`git --range`）について実行する。main への push のスキャン（`leak-check-push`）も、同じスクリプトを通して履歴をスキャンする。仕組みの全体は [漏れの検査の仕様](https://github.com/devbasex/nd-factory/blob/main/docs/specifications/leak-check.md) にある。

約束は次の 2 か所にある。

- [AGENTS.md](https://github.com/devbasex/nd-factory/blob/main/AGENTS.md) の「秘密とインフラの値を置かない」: 秘密の値（token・鍵など）とインフラの実際の値（端点など）をリポジトリに置かない
- [プロジェクト MVV](https://github.com/devbasex/nd-factory/blob/main/.ndf/mvv.md) の Value 7: 混入は検査（漏れの検査など）で機械的に止める

今のつくりは次のとおりである。

- サービス自身が発行する 2 種類の token（委任の token `ndfd_…`・手元のマシンの登録の token `ndfm_…`。形は [API の設計の「認証と主体」](https://github.com/devbasex/nd-factory/blob/main/docs/design/api.md) ）に当たる規則は、既定の規則にも `.gitleaks.toml` にも無い。`.gitleaks.toml` の規則は、アカウント ID・ARN・資源の ID・端点の 4 種類の AWS の値だけを対象にする
- 履歴のスキャンは、gitleaks が `git log -p` で作るパッチを読む。gitleaks 8.30.1 は、Git がバイナリと判定したファイルを、アーカイブでなければ警告を出さずに飛ばす（[sources/git.go](https://github.com/gitleaks/gitleaks/blob/v8.30.1/sources/git.go)）。今の木のスキャンも、バイナリと判定したファイルを警告を出さずに飛ばす（[sources/file.go](https://github.com/gitleaks/gitleaks/blob/v8.30.1/sources/file.go)）。`leak-scan.sh` は gitleaks の警告（WRN・ERR・FTL）があれば失敗にするが、この 2 つは警告が出ないので失敗にならない
- 端点の規則（`nd-aws-endpoint`）は、作り物の値の許可として `example\.com` などを部分一致で持つ。資源の名前のどこかに `example.com` を含めば、端点の全体が許される
- 非公開の検査（`leak-check-secret`。 https://github.com/devbasex/nd-factory/issues/96 と https://github.com/devbasex/nd-factory/issues/101 で導入）は、履歴の各コミットのファイルを書き出し、NUL を含むファイルを文字列だけに変えてスキャンする（`export-tree.sh` の `binary-text/`）。Pull Request の `leak-check` と main への push のスキャンは、この仕組みを使わない

設計書の食い違い:

- [詳細設計](https://github.com/devbasex/nd-factory/blob/main/docs/design/detail.md) の「秘密の形のデータ」の行は「読むのは実行時の `redact` だけ」と書く。実際には、生成物を作るスクリプト（`packages/contracts/scripts/artifacts.ts`）も同じデータ（`SECRET_SHAPES`）で公開用のダミーデータを検査し、当たれば生成を止める（ https://github.com/devbasex/nd-factory/issues/2 で導入）

## 事象

作り物の値だけを置いた使い捨てのリポジトリで、`leak-scan.sh` を実行した結果である。値はその場で乱数から作り、記録に残していない。

1. サービスの token が当たらない。`docs/t.md` に `ndfd_<英数字>.<英数字>.<英数字>` と `ndfm_<英数字>.<英数字>.<英数字>` の 2 行を置いた木で、既定の規則・`.gitleaks.toml` のどちらでも、このファイルの当たりは 0 件だった

   ```text
   $ leak-scan.sh dir tools/checks/gitleaks-default.toml
   （出力なし）
   exit=0
   ```

2. 途中のコミットの、バイナリと判定されるファイルの中の秘密が当たらない。1 つのコミットで、`aws_secret_access_key = "<40 文字>"` の行を持つテキストのファイル（`text.txt`）と、同じ形の行の前に NUL を置いたファイル（`blob.bin`）を足し、次のコミットで 2 つとも消した。履歴のスキャンの当たりは `text.txt` の 1 件だけで、`blob.bin` は当たらず、警告も出なかった

   ```text
   $ leak-scan.sh git tools/checks/gitleaks-default.toml --range "<足す前>..HEAD" --paths
   leak-scan: 当たり generic-api-key text.txt:2 <コミット>
   leak-scan: 当たり 1 件
   ```

3. 資源の名前に `example.com` を含む S3 の端点が当たらない。`data-example.com-logs` に `.s3.amazonaws.com` を続けた端点を置いた `docs/e.md` と、置き場の名前 `datalogs` に `.s3.amazonaws.com` を続けた端点を置いた `docs/e2.md` の木で、`.gitleaks.toml` の当たりは `docs/e2.md` だけだった

   ```text
   $ leak-scan.sh dir .gitleaks.toml --paths
   leak-scan: 当たり nd-aws-endpoint docs/e2.md:1
   leak-scan: 当たり 1 件
   ```

4. 設計書の食い違いは、[詳細設計](https://github.com/devbasex/nd-factory/blob/main/docs/design/detail.md) の「秘密の形のデータ」の行（291 行目）と、`packages/contracts/scripts/artifacts.ts` の 453 行目（`SECRET_SHAPES.valuePatterns` から検査の正規表現を作る行）の食い違いである

## 期待する結果

- 1〜3 の値を置いた木と履歴で、`leak-scan.sh` が当たりを報告し、終了コード 1 で終える
- 中身をスキャンできなかったファイルがあれば、当たりが無くても成功にしない
- 詳細設計の「秘密の形のデータ」の行が、データを読む 2 つの処理（実行時の伏せ字と、生成時のダミーデータの検査）を両方書く

## 再現手順

1. `tools/checks/install-gitleaks.sh <インストール先>` で gitleaks 8.30.1 を入れ、`PATH` に足す
2. 空のディレクトリで `git init` し、「事象」の 1 と 3 のファイルを `docs/` に置いてコミットする
3. リポジトリの最上位で `leak-scan.sh dir <nd-factory>/tools/checks/gitleaks-default.toml --paths` と `leak-scan.sh dir <nd-factory>/.gitleaks.toml --paths` を実行する
4. 「事象」の 2 のとおり、`text.txt` と `blob.bin` を足すコミットと消すコミットを作る
5. `leak-scan.sh git <nd-factory>/tools/checks/gitleaks-default.toml --range "<足す前のコミット>..HEAD" --paths` を実行する

毎回再現する。

## 環境

- nd-factory: main のコミット `69fd0b9`
- gitleaks: 8.30.1（`tools/checks/install-gitleaks.sh` が固定するバージョン）
- OS: Linux（Ubuntu）、bash

## なぜ困るか

公開のリポジトリに、サービスの token・途中のコミットにだけ入れたバイナリのファイルの中の秘密・実在の S3 の端点が入っても、必須のチェック `leak-check` が成功する。`leak-check` は push 後に動き、検出した問題がある変更の main への取り込みを止める。現行の検査では、サービスの token、途中のコミットのバイナリにだけある秘密、実在の S3 の端点の 3 つの事例を見逃す。公開ブランチへの push で公開された値は、履歴から削除しても複製や検索結果に残り得る。設計書の食い違いを放置すると、記述どおりに作り直したときに、ダミーデータに秘密の形の値が入るのを止める検査が外れる。

## 目的

- 漏れの検査が、サービス自身の token・バイナリと判定されるファイルの中の秘密・資源の名前に許可の文字列を含む端点を、今の木と履歴の両方で止める
- 中身をスキャンできなかったファイルがあるとき、検査を成功にしない
- 秘密の形のデータを読む処理が、設計書の記述とコードで一致する

## 対象範囲

含む:

- nd-factory の規則（`.gitleaks.toml`）への、委任の token と手元のマシンの登録の token の規則の追加
- `leak-scan.sh` の今の木と履歴のスキャンで、バイナリと判定されるファイルをスキャンの対象に入れること。中身をスキャンできなかったファイルを失敗にすること
- 端点の規則（`nd-aws-endpoint`）の作り物の値の許可を、資源の部分の一部ではなく全体に当てること
- 上の 3 つを確認する結合テスト（`tools/test/leak-scan.integration.test.ts`）
- 詳細設計（`docs/design/detail.md`）の「秘密の形のデータ」の行
- 漏れの検査の仕様（`docs/specifications/leak-check.md`）と CI の検査の手順（`docs/operations/ci-checks.md`）のうち、上の変更で記述が変わる箇所

含まない:

- fork の Pull Request と、秘密の正規表現（`LEAK_CHECK_PATTERN`）の扱い（ https://github.com/devbasex/nd-factory/issues/96 ）
- 非公開の検査（`leak-check-secret.yml`・`leak-scan-secret.sh`・`export-tree.sh`）の流れの変更。`leak-scan.sh` の変更によって非公開の検査の結果が変わることは含む
- 秘密の形のデータ（`packages/contracts/data/`）の中身と、実行時の伏せ字（`redact`）の変更
- gitleaks のバージョンの変更

## 前提

- 前提 1: サービスの token の形は、API の設計の「認証と主体」の形（`ndfd_<利用者の ID>.<委任の ID>.<秘密の部分>`・`ndfm_<チームの ID>.<マシンの ID>.<秘密の部分>`）のとおりとする。形が変わったときは別の課題で規則を直す
- 前提 2: テストに置く token と秘密は、テストの実行中に乱数から作り、リポジトリのファイルに書かない（書けばこのリポジトリ自身の漏れの検査が当たる）

## 受け入れ条件

- [ ] 1. テストの実行中に作った架空の委任の token（`ndfd_` で始まる形）と手元のマシンの登録の token（`ndfm_` で始まる形）を置いた木で、`leak-scan.sh dir .gitleaks.toml` がそれぞれを当たりとして報告し、終了コード 1 で終える。同じ値を途中のコミットで足して後で消した履歴でも、`leak-scan.sh git .gitleaks.toml --range` が当たりを報告する（結合テストがある）
- [ ] 2. 途中のコミットで、NUL を含みバイナリと判定されるファイルに架空の秘密を入れ、後のコミットで消した履歴を `leak-scan.sh git --range` でスキャンすると、当たりを報告して終了コード 1 で終える。スキャンの対象は `git log -p` のパッチの表示に頼らずに決める（結合テストがある）
- [ ] 3. NUL を含みバイナリと判定されるファイルに架空の秘密を入れた今の木を `leak-scan.sh dir` でスキャンすると、当たりを報告して終了コード 1 で終える（結合テストがある）
- [ ] 4. 今の木と履歴のスキャンで、対象のファイルのうち 1 つでも中身をスキャンできなかったときは、当たりが 0 件でも終了コード 0 で終えない。`--paths` を渡さなければ、出力にファイルの名前を出さない（結合テストがある）
- [ ] 5. 資源の名前の一部に `example.com` を含む架空の S3 の端点（`data-example.com-logs` に `.s3.amazonaws.com` を続けた形）を置いた木で、`leak-scan.sh dir .gitleaks.toml` が `nd-aws-endpoint` の当たりを報告する。端点を例外として許すのは、端点の名前の全体が次の「許す形」のどれかのときだけで、実際の資源の名前の一部を含む端点は検出する（結合テストがある。理由は[設計書の端点と S3 の置き場の許可の決定](./issue-98-design-decisions.md)）
  - プレースホルダー（`<名前>`・`${名前}`）と区切り（`.`・`-`）だけでできた名前
  - S3: `amzn-s3-demo-` で始まり、後ろが小文字と数字だけの名前
  - CloudFront: `EXAMPLE` と数字だけの名前
  - Cognito: `<prefix>-<environment>-login`（`login` は固定の語）か、小文字・数字・`-` だけで `cognito` を含む名前（AWS がこの語を含む名前を作らせない）。リージョンは `<リージョン>` か `us-west-2`
  - main の履歴に残る旧い作り物の値: 値と、それを足したコミットの組が一致するときだけ
- [ ] 6. 今の結合テストのうち、作り物の値とプレースホルダーを許す場合（`<名前>`・`${名前}`・作り物の端点など）が、変更の後も当たり無しで通る。端点の例は、条件 5 の「許す形」（旧い値の組を除く）に書き換えてから通す。S3 の置き場の例は、プレースホルダーの形か `amzn-s3-demo-` の形に書き換えてから通す。`acme` で始まるだけの名前は許さない
- [ ] 7. この課題の Pull Request で、`leak-check` が成功する（新しい規則とスキャンの方法で、今のリポジトリの木と、分岐点から head までの履歴に当たりが出ない）
- [ ] 8. 詳細設計の「秘密の形のデータ」の行が、データを読む処理として、実行時の `redact` と、生成時のダミーデータの検査（`packages/contracts/scripts/artifacts.ts`）の両方を書く。CI の漏れの検査（gitleaks）の設定はこのデータを読まず、このデータから生成もしない、という記述は残す

## 影響

| 対象 | 影響 |
| --- | --- |
| 公開インタフェース | 変わらない。`leak-scan.sh` の引数と終了コードの意味（0 当たり無し・1 当たりかスキャンの失敗・2 引数の誤り）は変えない |
| 重さ | 公開のリポジトリに 3 種類の値が入っても、必須のチェックが成功する。値が一度公開されると取り消せない。回避の手段は、レビューする人が目で見つけることだけである |
| データ | 変わらない |
| 既存の振る舞い | `leak-check`・`leak-check-push`・非公開の検査が `leak-scan.sh` を通してスキャンする範囲が広がる。今まで通っていた Pull Request が、新しい当たりで落ちることがある。スキャンの対象が増えるので、検査にかかる時間が延びる |

## ドメインイベント

| # | イベント | 引き金 | 失敗したとき | 順序の前提 |
| --- | --- | --- | --- | --- |
| E1 | Pull Request にコミットが積まれた | 作者の push | — | — |
| E2 | 今の木をスキャンした | `leak-check` の起動 | 中身をスキャンできなかったファイルがあれば失敗で終える（受け入れ条件 4） | E1 |
| E3 | 分岐点から head までの各コミットで足した・変えたファイルをスキャンした | `leak-check` の起動 | 中身をスキャンできなかったファイルがあれば失敗で終える（受け入れ条件 4） | E1 |
| E4 | 当たりを規則・ファイル・行・コミットで報告した | E2・E3 の当たり | gitleaks の報告を読めなければ失敗で終える（今の振る舞い） | E2・E3 |

## 検証手段

| 項目 | 手段 |
| --- | --- |
| テスト | `npm run test:integration -- leak-scan`（gitleaks を `PATH` に置いて実行する） |
| 静的解析・型検査 | `npm run check` |
| 手動確認（マージ前） | この課題の Pull Request のチェックの一覧で、`leak-check` が成功していることを見る（受け入れ条件 7） |

## 未決

| 項目 | 誰が決めるか | 期限 |
| --- | --- | --- |
| 端点の規則のほかに、同じ部分一致の許可（`example\.com` など）を持つ規則（アカウント ID・ARN・S3 の ARN・資源の ID）も、この課題で全体に当てる形へ直すか | 設計者（設計の「同じ形の箇所」で調べて決める） | 設計の承認まで |
| バイナリと判定されるファイルのスキャンの方法（非公開の検査と同じく文字列だけに変えてスキャンするか、鍵の格納ファイルの拡張子 `.p12`・`.pfx`・`.jks`・`.keystore` などを拒むか、その両方か） | 設計者 | 設計の承認まで |

## 起票者の推定

| # | 条件 | 推した出所 | この要求での扱い |
| --- | --- | --- | --- |
| S1 | 4 つの抜けと食い違いを 1 つの課題にまとめる | 起票者（どれも漏れの検査と秘密の形の扱いで、同じ Pull Request で直せる） | 対象範囲 |
| S2 | `ndfd_`・`ndfm_` の規則を置く先は `.gitleaks.toml` の nd-factory の規則とする | 起票者（`.gitleaks.toml` の冒頭のコメントが、nd-factory の規則を置く先をこのファイルにしている） | 受け入れ条件 1 |
| S3 | バイナリと判定されるファイルの抜けを、履歴だけでなく今の木のスキャンでも直す | 起票者のコメント（ https://github.com/devbasex/nd-factory/issues/98#issuecomment-7066963638 。gitleaks 8.30.1 の今の木のスキャンも、バイナリと判定したファイルを警告なしで飛ばす） | 受け入れ条件 3 |
| S4 | 直し方の候補として、鍵の格納ファイルの拡張子を拒む・バイナリの形を別にスキャンする、の 2 つを挙げる | 起票者のコメント（同上） | 未決 |
| S5 | 中身をスキャンできなかったファイルの扱いを、今の木と履歴の両方に当てる（元の受け入れ条件は履歴のスキャンについて書いている） | 要求を書いた AI（S3 で今の木も対象にしたため、同じ条件をそろえた） | 受け入れ条件 4 |
| S6 | 結合テストのほか、変更の後のリポジトリ自身が新しい規則で通ることを条件にする | 要求を書いた AI（新しい規則が今のリポジトリの作り物の値に当たると、マージした時点で必須のチェックが落ちるため） | 受け入れ条件 6・7 |

## リクエスト（原文）

<details>
<summary>課題の元の本文（書き手: 起票者、日付: 2026-11-21）</summary>

> ## 目的
>
> `leak-check`（#1 の U4、PR #91）の規則と探し方に、検出の抜けが 3 つと、設計文書の食い違いが 1 つある。直すと MVV の Value 7（混入は検査で機械的に止める）が、サービス自身の認証の token・途中のコミットのバイナリ扱いのファイル・実在の S3 の端点でも成り立つ。
>
> ## 影響
>
> 公開のリポジトリに次の値が入っても、必須のチェック `leak-check` が通る。
>
> 1. 委任の token（`ndfd_<利用者の ID>.<委任の ID>.<秘密の部分>`）と手元のマシンの登録の token（`ndfm_<チームの ID>.<マシンの ID>.<秘密の部分>`。`docs/design/api.md` の「認証と主体」）。gitleaks の既定の規則にも `.gitleaks.toml` の `nd-*` の規則（AWS の値だけ）にも当たらない
> 2. 途中のコミットにだけ含まれ、Git がバイナリと見たファイルの中の秘密。`tools/checks/leak-scan.sh` の履歴の探しは `git log -p` のパッチに頼り、gitleaks はバイナリ扱いのファイルを警告なしで飛ばすので、今の木と履歴のどちらでも見逃しうる（今の WRN・ERR・FTL の照らしにも掛からない）
> 3. 資源の名前に `example.com` などの許可の文字列を含む S3 の端点。`.gitleaks.toml` の `nd-aws-endpoint` の許可は部分一致で、バケットの名前の一部に `example.com` がある架空の S3 の端点（`data-example.com-logs` に `.s3.amazonaws.com` を続けた形）が当たらない。実在のバケットの名前にも同じ文字列を含められる
>
> 設計文書の食い違い:
>
> 4. `docs/design/detail.md` の「秘密の形のデータ」の行は「読むのは実行の時の `redact` だけ」と書くが、#2 の生成物の作り方（`packages/contracts/scripts/artifacts.ts`）は同じ `SECRET_SHAPES` で公開用のダミーデータを照らし、当たれば生成を止める。この記述どおりに作ると、ダミーデータの漏れの防ぎが外れる
>
> ## 対象範囲
>
> - 含む: `.gitleaks.toml`・`tools/checks/leak-scan.sh`・`tools/test/leak-scan.integration.test.ts`・`docs/design/detail.md` の「秘密の形のデータ」の行
> - 含まない: fork の PR と秘密の正規表現の扱い（#96）
>
> ## 受け入れ条件
>
> - 実行の時に生成した架空の `ndfd_`・`ndfm_` の token を置いた木で、`leak-scan.sh` が当たりを報告する（結合のテストがある）
> - 履歴の探しの対象をパッチの表示の形に頼らず、バイナリ扱いのファイルを含めて探す。探せなかった対象があれば当たり無しとして通さない（途中のコミットにだけバイナリ扱いのファイルで入れた架空の値で落ちる結合のテストがある）
> - `nd-aws-endpoint` の許可は、作り物の資源の名前の全体か、実際の値を含まない置き場所の記号の全体にだけ当たる（資源の名前の一部に `example.com` を含む架空の S3 の端点が当たる結合のテストがある）
> - `docs/design/detail.md` の「秘密の形のデータ」の行が、データの利用者として実行の時の `redact` と生成の時のダミーデータの照らしの両方を書き、CI の gitleaks の設定とは分けたままにする
>
> ## 起票者の推定
>
> - 4 つを 1 つの課題にまとめた（推した出所: 起票者。どれも U4 の `leak-check` と秘密の形の扱いで、同じ PR で直せる）
> - `ndfd_`・`ndfm_` の規則を置く先は `.gitleaks.toml` の `nd-*` の規則とする（推した出所: 起票者。`.gitleaks.toml` の冒頭の注は nd-factory の規則の置き場をここにしている）
>
> ## 由来
>
> PR #95（#1 U5。形の正本の往復のテスト）のクロスレビューの指摘 r1-3（`.gitleaks.toml:7`）・r1-4（`tools/checks/leak-scan.sh:154`）・r1-5（`.gitleaks.toml:90`）・r1-8（`docs/design/detail.md:283`）。#95 はこれらのファイルを変えず、`leak-check` と `docs/design/detail.md` の該当の行は U4（#91、マージ済み）の範囲なので、U5 の範囲外とした。#1 の受け入れ条件 1〜3（漏れ）に当たる。根拠: MVV の Value 7（MVV バージョン 3）

</details>

<details>
<summary>課題のコメント（書き手: 起票者、日付: 2026-11-21）</summary>

> 由来: PR #100（#1 U6）のクロスレビューの指摘 r1-5（`tools/checks/leak-scan.sh:139`）。gitleaks v8.30.1 の履歴の探しはアーカイブでないバイナリを無条件に飛ばし（[sources/git.go](https://github.com/gitleaks/gitleaks/blob/v8.30.1/sources/git.go)）、今の木の探しもバイナリと見たファイルを警告なしで飛ばす（[sources/file.go](https://github.com/gitleaks/gitleaks/blob/v8.30.1/sources/file.go)）。警告を失敗にする包みを通してもバイナリの形の鍵を含むコミットが通りうる。この課題の 2 つ目の抜けと同じ原因で、今の木の側も含む。直し方の案として、追跡する鍵の器（`.p12`・`.pfx`・`.jks`・`.keystore` など）を拒む、秘密を含みうるバイナリの形を別に探す処理を足す、が挙がった。#100 は `leak-scan.sh` を変えないので U6 の範囲外とした。

</details>
