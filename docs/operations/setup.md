# 設置の手順

AWS へ設置するときは、設置のコマンド `npm run nd-setup` を使う。コマンドは 2 つの段に分かれる。

| 段 | すること | AWS へ書くか |
| --- | --- | --- |
| `diff` | 確かめ・合成・差分を作り、合成の結果を置き場へ保存して、確認の値を出して止まる | 書かない |
| `deploy` | `diff` が保存した合成の結果を、確認の値が同じときだけ反映する。合成し直さない | 書く |

差分を見たものと同じものだけを反映するため、`deploy` は `diff` の置き場と確認の値の組でしか動かない。`cdk deploy` をこのコマンドの外で直に打たない。

## 前提

| 要るもの | 中身 |
| --- | --- |
| Node | 24（`.node-version`）。最上位で `npm ci` を打っておく |
| AWS の profile | 反映する先のアカウントへ入れる profile。アカウントは profile の主体（`sts get-caller-identity`）から、リージョンは profile の `region` から読む。資格情報は profile だけから受け、環境変数の資格情報を混ぜない。環境変数 `AWS_REGION` を置いているとそちらのリージョンが先になるため、外して打つ |
| 設定のファイル | リポジトリの外に置く JSON。キーと置き場は [settings.md](settings.md) にある |
| CDK の bootstrap | 反映する先のアカウントとリージョンに、既定の qualifier（`hnb659fds`）の bootstrap があり、その版が合成の結果の求める版以上であること |

bootstrap が無いか版が足りないと、コマンドは求める版と今の版を示して終了コード 5 で止まる。コマンドは bootstrap を自分では打たない。

- 自分で設置する人: 自分のアカウントで次を打ってから、`diff` を打ち直す

  ```bash
  npx cdk bootstrap aws://123456789012/us-west-2 --profile <profile>
  ```

- 運用する環境: bootstrap はほかのサービスと共有していることがある。上げるかどうかはリリース承認で決める。承認では、コマンドが示した求める版と今の版、打つ bootstrap のコマンド（上と同じ形）を示す。承認の後にその bootstrap を打ち、`diff` を打ち直す。`diff` は bootstrap が足りない間は差分と確認の値を出さないため、この承認は `diff` の差分の承認より先に取る

## diff: 差分と確認の値を出す

```bash
npm run nd-setup -- diff --profile <profile> --settings <設定のファイル> --out <合成の結果の置き場> [--stack app|pipeline]...
```

| 引数 | 必須 | 意味 |
| --- | --- | --- |
| `--profile` | 必須 | 反映する先の AWS の profile |
| `--settings` | 必須 | 設定のファイルのパス |
| `--out` | 必須 | 合成の結果を保存する置き場。打つたびに中身を消してから書く。`cdk.out/` の下（例 `cdk.out/test`）に置けばリポジトリに入らない |
| `--stack` | 任意 | 合成して差分を見るスタック。`app`（縦の切れ端）か `pipeline`（反映のパイプライン）で、繰り返して渡せる。無ければ設定のファイルで作るスタックのすべて（`app` と、`pipeline` があれば `pipeline`） |

相対パスは、コマンドを打った場所から解く。

確かめは次の順に行い、どこかで欠ければその段の終了コードで止まる。どの段で止まっても AWS へは書かない。

1. 引数（終了コード 2）。設定のファイルに `pipeline` が無いのに `--stack pipeline` を渡したときもここで止まる
2. 設定のファイル（3）。足りない・誤ったキーを 1 件 1 行で示す
3. profile（4）
4. 画面のビルドと合成（6）
5. bootstrap の版（5）。求める版は合成の結果にしか無いため、合成の後に読む
6. 差分の作成（6）。`cdk diff --method=template` で、保存した合成の結果と今のスタックのテンプレートを比べる。変更のセットは作らない

通ると、次を出して終了コード 0 で止まる。

| 出すもの | 中身 |
| --- | --- |
| 差分 | スタックごとの資源の足し・変え・消し |
| 作る資源の名前 | スタックの名前と、利用者プール・利用者の表・秘密の器・接続・承認を拒む方針などの名前。名前はすべて `<prefix>-<environment>-<用途>`（秘密の器とパラメーターは `<prefix>/<environment>/<用途>`）になる |
| 戻り先の URL | `app` を選んだときだけ。Google のクライアントに登録する URL（例 `https://acme-test-login.auth.us-west-2.amazoncognito.com/oauth2/idpresponse`）。使い方は [idp-and-apps.md](idp-and-apps.md) にある |
| 確認の値 | 下の「確認の値」の形。`deploy` に渡す |
| 次に打つコマンド | 確認の値を入れた `deploy` のコマンド |

## 確認の値

```text
<合成の結果の要約値の先頭 12 桁>:<アカウント>:<リージョン>:<スタックの一覧>
```

例: `3f2a9c0d1b7e:123456789012:us-west-2:app,pipeline`。スタックの一覧は渡した順に依らず `app`・`pipeline` の順に並ぶ。

要約値は、置き場のすべてのファイル（テンプレート・manifest・画面と Lambda の資産・選んだスタックの一覧 `nd-setup-stacks.json`）の中身から作る SHA-256 である。そのため、次のどれかで値が変わり、`deploy` は終了コード 7 で止まる。

- 置き場のファイルを 1 バイトでも書き換えた・足した・消した
- `diff` と違うアカウントかリージョンの profile を `deploy` へ渡した
- 別の `diff` で同じ置き場を上書きした（後の `diff` の確認の値だけが通る）

要約値は次のシェルの式と同じ値である。反映のパイプラインも同じ式で数える。

```bash
cd <合成の結果の置き場> && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-64
```

## deploy: 保存した合成の結果を反映する

```bash
npm run nd-setup -- deploy --profile <profile> --assembly <合成の結果の置き場> --confirm <確認の値>
```

| 引数 | 必須 | 意味 |
| --- | --- | --- |
| `--profile` | 必須 | 反映する先の AWS の profile。`diff` と同じアカウントとリージョンでなければ確認の値が合わない |
| `--assembly` | 必須 | `diff` の `--out` に渡した置き場 |
| `--confirm` | 必須 | `diff` が出した確認の値 |

`deploy` は `--stack` を受けない。反映するスタックは `diff` で選んで置き場に保存した一覧に従う。

確かめは次の順に行う。どこかで欠ければ、AWS へ書かずに止まる。

1. 置き場と、その中の `nd-setup-stacks.json`（3）
2. profile（4）
3. bootstrap の版（5）
4. 確認の値を数え直し、`--confirm` と比べる（7）

同じときだけ、置き場をそのまま `cdk deploy --app <置き場>` で反映する。合成し直さない。反映が失敗すると終了コード 8 で、CloudFormation の戻しで前の状態へ戻る。原因を直して `diff` から打ち直す。

## 使い方の場面

### 自分で設置する人

1. 設定のファイルに `"login": { "google": {} }` を置く（`client_id` は書かない）
2. `diff` を打ち、差分と資源の名前を読む
3. 差分に納得したら、出た確認の値で `deploy` を打つ。秘密の器ができ、画面は「ログインの設定を待っています」を示す
4. [idp-and-apps.md](idp-and-apps.md) の順で Google のクライアントを作り、器へ secret を入れて確かめる
5. 設定のファイルへ `client_id` を書き、`diff` と `deploy` を打ち直す

### 運用する環境

- 設置のコマンドで反映するのはパイプラインのスタックだけにする。`diff` に `--stack pipeline` を渡す。縦の切れ端は反映のパイプラインが、人の承認の後に反映する（[pipeline-approval.md](pipeline-approval.md)）
- `diff` の差分の承認の後にだけ `deploy` を打つ
- パイプラインのスタックを初めて反映した後は、GitHub との接続を有効にし、承認を拒む方針を AI の主体へ付けて確かめるまで、起点のブランチへ push しない（[pipeline-approval.md](pipeline-approval.md)）
- 設定を変えるときの手順は [settings.md](settings.md) にある

## 終了コード

0 と 8 のほかは、AWS へ何も書いていない。そのため 2〜7 で止まったときは、表の意味の原因を直して同じコマンドを打ち直せばよい。7 で止まったときは置き場か profile が `diff` のときと違うため、`diff` から打ち直し、新しい差分を読んでから `deploy` を打つ。8 は書いた後に CloudFormation が戻した状態である。

表は `packages/contracts/data/exit-codes.json` から `npm run generate` で作る。直に書き換えない。

<!-- exit-codes:begin -->
| 終了コード | 名前 | 意味 | AWS へ書いたか |
| --- | --- | --- | --- |
| 0 | `OK` | `diff` は差分を示して止まった。`deploy` は反映した | `deploy` だけ書いた |
| 2 | `USAGE` | 引数の誤り（サブコマンド・必須の引数が無い・未知の引数） | 書いていない |
| 3 | `SETTINGS` | 設定のファイルが無い・JSON でない・形に合わない（足りない・誤ったキーを 1 件 1 行で示す）。`deploy` では合成の結果の置き場が無い・読めない | 書いていない |
| 4 | `PROFILE` | profile が無い・資格情報を得られない・リージョンが無い | 書いていない |
| 5 | `BOOTSTRAP` | bootstrap が無いか版が足りない（求める版と今の版を示す） | 書いていない |
| 6 | `BUILD` | 画面のビルド・合成・差分の作成が失敗した | 書いていない |
| 7 | `CONFIRM_MISMATCH` | 確認の値が `--confirm` と違う（保存した合成の結果が書き換わった・アカウントかリージョンが違う） | 書いていない |
| 8 | `DEPLOY_FAILED` | 反映が失敗した。CloudFormation の戻しで前の状態へ戻る | 書いて戻した |
<!-- exit-codes:end -->
