# CI の検査の秘密と持ち主の操作

参照の検査と漏れの検査は、照合の語と実際の値の正規表現をリポジトリの外の秘密から受ける。この文書は、持ち主が GitHub の設定で行う操作と、検査ごとにどの実行が秘密を受け、誰に結果が見えるかをまとめる。設計は [#96・#101 の設計文書](../../issues/issue-96-101-design.md) と [詳細設計](../../issues/issue-96-101-design-detail.md) にある。

この文書の `<非公開リポジトリ>` は、持ち主が作る検査用の非公開リポジトリ（`<所有者>/<名前>`）を指す。実際の名前はリポジトリに書かない。

## 検査ごとの秘密の受け方と結果の見え方

| 検査 | 動く実行 | 受ける秘密 | 結果が見える人 |
| --- | --- | --- | --- |
| `ref-check`（`ci.yml`） | Pull Request と main への push | `REF_CHECK_TERMS`（Actions の秘密。Dependabot の Pull Request では Dependabot の秘密） | 誰でも（公開の記録） |
| `leak-check`（`ci.yml`） | Pull Request だけ | 受けない。既定の規則と `.gitleaks.toml` だけで、今の木と分岐点から head までを探す | 誰でも（公開の記録。必須のチェック） |
| `leak-check-push`（`ci.yml`） | main への push だけ | 環境 `leak-scan` の秘密 `LEAK_CHECK_PATTERN` と変数 `LEAK_CHECK_REQUIRE_PATTERN` | 誰でも（公開の記録）。実際の値の規則 `nd-real-value` の当たりは件数の行（`leak-scan-secret: nd-real-value: <件数> 件`）だけで、場所を出さない。必須のチェックではない |
| 非公開の検査（`leak-check-secret.yml`） | NDF が Pull Request をマージする直前に、`<非公開リポジトリ>` の呼び出しのワークフローを起動したとき（持ち主が手で起動したときも） | `<非公開リポジトリ>` の Actions の秘密 `LEAK_CHECK_PATTERN`（必須。空なら落ちる） | `<非公開リポジトリ>` に読み取りの権限を持つ人と NDF だけ。当たりは規則・`file-<番号>`・行・コミットで出し、ファイルの名前は出さない。公開の Pull Request のチェック・コメント・通知には何も出ない |

- 非公開の検査は、Pull Request のマージコミットの木・分岐点から head までの各コミットのパッチ・その範囲のコミットに現れたすべてのパスの名前と中身を、既定の規則と、`.gitleaks.toml` に `nd-real-value` を重ねた設定で探す。動かすのは、公開のリポジトリの main の先頭（検査のコードのコミット）のスクリプトと設定だけで、Pull Request のコミットは読むだけである
- Pull Request を誰が作ったか（fork・同じリポジトリのブランチ・Dependabot）で、どの検査の振る舞いも変わらない。起動した人で分ける条件は置かない（CI の定義のテストが落とす）
- NDF は非公開の検査の成功を確かめられなければマージしない。結果は公開のリポジトリのチェックにならないので、`.ndf/project.json` の必須のチェック（`required_checks`）には載せない

### 残る経路と持ち主が見張る点

秘密を隔てても、次の経路は残る。

| 経路 | 届くもの | 持ち主がすること |
| --- | --- | --- |
| main に直に push できる人（main にはブランチの保護が無いので、書き込みの権限を持つ人） | main の上のワークフローを書き換えて、環境 `leak-scan` の秘密を読める。`leak-check-secret.yml` かそれが動かすスクリプトに秘密を外へ送る手順を足せば、次に NDF が起動したときに `<非公開リポジトリ>` の秘密つきで動く | main への直の push を見張る |
| 公開のリポジトリに `main` という名前のタグを作れる人 | 呼び出しのワークフローの `@main` の解決をタグへ向けられる（同じ名前のタグはブランチより優先される）。NDF は実際に動いた版を確かめて結果を退けるが、秘密が渡ることは止められない | `main` という名前のタグの作成を見張る |
| `<非公開リポジトリ>` に書き込みの権限を持つ人 | 呼び出しのワークフローを書き換えて秘密を読める | 書き込みの権限を持つ人を最小にする |
| GitHub の画面からのマージ | 非公開の検査を通らずにマージできる（止めるのは NDF が行うマージだけ） | 画面からマージしない |

## 秘密と変数の登録

| 置き場所 | 名前 | 種類 | 値 |
| --- | --- | --- | --- |
| `<非公開リポジトリ>` | `.github/workflows/<呼び出しのワークフローのファイル>` | ファイル | [`leak-check-caller.yml`](leak-check-caller.yml) を写したもの |
| `<非公開リポジトリ>` | `LEAK_CHECK_PATTERN` | Actions の秘密 | 実際の値の正規表現（`'''` と改行を含めない） |
| `<非公開リポジトリ>` | `LEAK_CHECK_GENERATION` | Actions の変数 | 設定の世代（`1` から始める正の整数。`0` は切り替え中） |
| 公開のリポジトリの環境 `leak-scan` | （環境の設定） | 環境 | 使えるブランチ（deployment branch policy）を `main` だけにする |
| 公開のリポジトリの環境 `leak-scan` | `LEAK_CHECK_PATTERN` | 環境の秘密 | `<非公開リポジトリ>` と同じ値 |
| 公開のリポジトリの環境 `leak-scan` か公開のリポジトリ | `LEAK_CHECK_REQUIRE_PATTERN` | 変数 | `1` にすると、秘密が空の `leak-check-push` が落ちる。`1` にする時機は「導入の順序」の手順 4 |
| 公開のリポジトリ | `REF_CHECK_TERMS` | Actions の秘密と Dependabot の秘密の 2 か所 | 照合の語（今のまま） |
| 公開のリポジトリ | `REF_CHECK_REQUIRE_TERMS` | Actions の変数 | 今のまま |

- 公開のリポジトリの Actions の秘密には `LEAK_CHECK_PATTERN` を置かない。登録していれば消す（`pull_request` の実行の Pull Request のコードから読めるため）
- **Dependabot の Pull Request で要る操作は無い。** Pull Request の側の `leak-check` は秘密を受けないので、Dependabot の Pull Request でも秘密の欠けで落ちない。Dependabot の Pull Request の全コミットは、ほかの Pull Request と同じく、NDF のマージの直前に非公開の検査で探す。**Dependabot の秘密には `LEAK_CHECK_PATTERN` を登録しない**（Dependabot が起動した実行で、Pull Request のコードと更新した依存から読めるため）
- 環境 `leak-scan` を使えるのは main への push の `leak-check-push` だけである。Pull Request の側の実行はマージの参照（`refs/pull/<番号>/merge`）で動くので、ワークフローを書き換えて環境を指しても秘密を受けられない

## NDF の認証の権限

NDF の認証は、`<非公開リポジトリ>` に対して次の権限を持つ必要がある。ワークフローの起動の API と変数の取得の API は協力者（collaborator）としての権限を求め、個人のアクセストークン（classic）なら `repo` の範囲が要る。

| 操作 | API |
| --- | --- |
| 変数の読み取り | `GET /repos/<非公開リポジトリ>/actions/variables/LEAK_CHECK_GENERATION` |
| ワークフローの起動 | `POST /repos/<非公開リポジトリ>/actions/workflows/<呼び出しのワークフローのファイル>/dispatches` |
| 実行とジョブの読み取り | `GET /repos/<非公開リポジトリ>/actions/runs/<実行の ID>/attempts/1`・`.../attempts/1/jobs` |

- 認証に権限を足すか、協力者を足すのは、認証と認可の変更なので、人の承認を受けてから行う
- `<非公開リポジトリ>` に読み取りの権限を持つ人を最小にする（実行の記録に当たりの規則・行・コミットが出る）
- この権限は、1 つの記録の置き場所を共有する NDF の認証にだけ与える。マージの要求の排他は置き場所をまたいで効かないためである。**権限を与えた NDF の認証と、その記録の置き場所を控える**（「秘密を変える手順」の手順 2 で使う）

## 秘密を変える手順

`<非公開リポジトリ>` の秘密 `LEAK_CHECK_PATTERN` の値か、呼び出しのワークフローを変えるときは、進行中のマージを終わらせるか止めてから変え、新しいマージは世代 `0` で締め出す。

1. 今の世代の値を控え、`<非公開リポジトリ>` の変数 `LEAK_CHECK_GENERATION` を `0` にする。この後の NDF のマージは人へ戻り、呼び出しのワークフローも探す前に失敗する
2. 手順 1 で世代を `0` にした時刻から、NDF の時間の上限（T）が過ぎるまで待つ。T は、NDF が世代を読んでからマージの API の呼び出しを終えるまでに使える時間で、このリポジトリをマージできる NDF の設定に置かれる
   - 世代を `0` にする前に世代を読んだ NDF は、T の中でマージを終えるか、T を過ぎてマージせずに止まる。T が過ぎれば、旧い秘密の結果で NDF がマージの API を新しく呼ぶことはない（すでに送った要求は、下の未解決の記録で確かめる）
   - T の値は、「NDF の認証の権限」で控えた認証を使うすべての NDF の設定で確かめ、最も長い値だけ待つ（未確認: 設定の名前と確かめ方は、NDF への非公開の検査の機能の依頼で決まる。設計の例は 30 分）。T の値を確かめられなければ、先へ進まない

   T が過ぎたら、控えた記録の置き場所で、NDF の未解決の記録の一覧（結果不明と未検証の状態の記録をリポジトリで絞ったもの）に、このリポジトリの記録が残っていないことを確かめる。権限を与えたのに置き場所を共有しない NDF の認証が見つかれば、その置き場所の記録も確かめ、権限を外す
   - 残っていれば、記録が閉じるまで待つ。**Pull Request が閉じていることや head が変わったことを理由に、記録が残っていても先へ進まない。** 応答を失ったマージの要求は、後から GitHub が処理しうる
   - 秘密が漏れたときなど待てないときは、残した記録を控えて先へ進んでよい。その後に NDF から世代の違いの知らせが来たら、マージでできたコミットを手元で新しい秘密で探し直し（「当たりの場所を手元で引く」）、マージを戻すかを判断する
3. 秘密か呼び出しのワークフローを変える
4. 変数 `LEAK_CHECK_GENERATION` を、控えた値に 1 を足した値にする

公開のリポジトリの環境 `leak-scan` の秘密を変えるときは、この切り替えは要らない（main への push の探しは push のたびに今の秘密で動き、マージを決めない）。2 か所の値は同じにしておく。

## 導入の順序

導入は 2 本の Pull Request に分ける。1 本目（実装）はワークフロー・見本・スクリプト・`ci.yml` の変更・テスト・この文書を入れ、`.ndf/project.json` を変えない。2 本目は `.ndf/project.json` に NDF の非公開の検査を有効にする項目を足す。

1. 作り物の値だけを使う検証用の公開リポジトリと非公開リポジトリで、このワークフローを動かして確かめる（設計文書の決定 10 の手順 1 の項目）
2. 1 本目をマージする前に、公開のリポジトリの環境 `leak-scan`（使えるブランチは main だけ）とその秘密 `LEAK_CHECK_PATTERN` を設定する。変数 `LEAK_CHECK_REQUIRE_PATTERN` は、この時点では `1` にしない
3. 1 本目の Pull Request を、マージの前に持ち主が手元で探す（下の「1 本目を手元で探す」）。**1 本目のマージから、NDF に非公開の検査の機能が入り、手順 6 で NDF の利用者の設定から非公開の検査を有効にするまで、NDF にほかの Pull Request をマージさせない。** 手で起動した探しの結果でもマージしない（今の NDF は、探した Pull Request の番号・head・マージ先・base の先頭の組を確かめずにマージするため）
4. 1 本目のマージで起きた main への push の `leak-check-push` で、秘密の規則を使って当たりなく探し終えたことを確かめる。次の 3 つがすべてそろえば、確かめられたことになる
   - ジョブが成功している
   - `dir` と `git` の両方の探しで、`leak-scan-secret: nd-real-value: 0 件` の行が出ている
   - `leak-scan-secret: 秘密 LEAK_CHECK_PATTERN が空なので .gitleaks.toml だけで探す` の行が出ていない

   3 つのどれかが欠ければ、今の木と履歴の両方で当たりと失敗が無くなるまで次へ進まず、変数 `LEAK_CHECK_REQUIRE_PATTERN` も `1` にしない。
   - 秘密が空の行が出ていれば、手順 2 の設定を直し、同じ `leak-check-push` の実行を GitHub Actions で再実行する（画面の「Re-run jobs」か `gh run rerun <実行の ID>`）。再実行の記録で、上の 3 つがすべてそろうことを確かめる。手元の探し直しは、GitHub Actions が直した後の環境から秘密を受け取れたことを確かめられないので、この確認の代わりにしない
   - 当たりや検査の失敗があれば、原因を解消する（当たりは「当たりの場所を手元で引く」で場所を引く）
   - 当たりや検査の失敗を直した後も、確かめるのは GitHub Actions の `leak-check-push` の記録である。手元の探し（下の「main のコミットを手元で探し直す」）は原因の特定に使い、手元で成功しても先へ進まない。手元の成功では、GitHub Actions でジョブが動き、環境 `leak-scan` から秘密を受け取れたことを確かめられないためである
     - 直すために main へコミットを入れたときは、そのコミットの push で動いた `leak-check-push` の記録で、上の 3 つがすべてそろうことを確かめる。元の実行を再実行しても、探すのは元の SHA のままなので、直した後のコミットを確かめたことにならない（[ワークフローの再実行](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)）
     - コミットを入れずに GitHub の設定だけを直したときも、確かめるのは今の main の先頭を探した記録である。待つ間に、ほかの変更で main が進んでいることがあるためである
       - 元の実行の `head_sha`（`gh api repos/devbasex/nd-factory/actions/runs/<実行の ID> --jq .head_sha`）が今の main の先頭（`gh api repos/devbasex/nd-factory/commits/main --jq .sha`）と同じなら、その実行を再実行する
       - main が進んでいれば、元の実行は再実行しない。今の main の先頭への push で動いた `leak-check-push` の実行を使う
       - どちらの場合も、使った実行の記録で、上の 3 つがすべてそろうことを確かめる

   確かめた後に、変数 `LEAK_CHECK_REQUIRE_PATTERN` を `1` にする
5. `<非公開リポジトリ>` を作り、[`leak-check-caller.yml`](leak-check-caller.yml) を写し、秘密 `LEAK_CHECK_PATTERN` と変数 `LEAK_CHECK_GENERATION`（値は `1`）を登録する。NDF がマージに使う今の認証で、「NDF の認証の権限」の 3 つの API が呼べることを確かめる。続けて、開いている Pull Request の 1 本で探しを手で起動して確かめる（下の「手で起動して確かめる」）。この結果で Pull Request をマージしない
6. NDF に非公開の検査の機能が入った後、NDF の利用者の設定で非公開の検査を有効にしてから、2 本目の Pull Request を出し、NDF にマージさせる。利用者の設定は、2 本目のマージの後も有効のまま残す

**2 本目へ進む条件:** 手順 1・4・5 の確認が済み、手順 2 の設定があり、変数 `LEAK_CHECK_REQUIRE_PATTERN` が `1` で、NDF が非公開の検査の結果を受け入れられる。1 つでも欠ければ 2 本目を出さない。Dependabot の Pull Request での確認は条件にしない（Dependabot を有効にした後に、最初の Dependabot の Pull Request で確かめる）。

### 1 本目を手元で探す

秘密を渡す前に、秘密を受けて動くスクリプトと設定の一式を読んで確かめ、そのコミットに固定する。探す対象のコミットは、データとして取り込むだけで、そのチェックアウトのコードは動かさない。

1. 1 本目の Pull Request の head の SHA を控える（以後「確かめたコミット」）
2. 確かめたコミットの `tools/checks/export-tree.sh`・`tools/checks/leak-scan-secret.sh`・`tools/checks/leak-scan.sh`・`tools/checks/install-gitleaks.sh`・`.gitleaks.toml`・`tools/checks/gitleaks-default.toml` の 6 つを、差分だけでなく全体を読む。秘密を外へ送る処理や、ほかのファイルを動かす処理が無いこと、`install-gitleaks.sh` の版と要約値が main の `ci.yml` の `leak-check` の値と同じことを確かめる
3. 確かめたコミットを、探す対象とは別のディレクトリにチェックアウトする。秘密を渡して動かすのは、このディレクトリのスクリプトと設定だけである。gitleaks は、このディレクトリの `install-gitleaks.sh` で置く（`GITHUB_PATH` を空にして打ち、置いた先を `PATH` に足す）
4. 探す対象は、`refs/pull/<番号>/head` と `refs/pull/<番号>/merge` を取り込んだ別のリポジトリにする。Pull Request の取得の API の `base.ref` で、マージ先のブランチが main であることを確かめる。取り込んだ head が確かめたコミットと同じで、マージコミットの最初の親が今の main の先頭、2 つ目の親が確かめたコミットであることを確かめる。このときの main の先頭の SHA を「探した base」として控える。どれかが違えば手順 1 からやり直す
5. 探す対象のリポジトリで、手順 3 のスクリプトを絶対パスで打つ。マージコミットの木を `export-tree.sh <マージコミット> <空のディレクトリ>` で、分岐点（`git merge-base <探した base> <確かめたコミット>`）から head までの履歴の項目を `export-tree.sh --history <分岐点> <確かめたコミット> <別の空のディレクトリ>` で、作業ツリーの外に取り出す。秘密を `LEAK_CHECK_PATTERN` に、`LEAK_CHECK_REQUIRE_PATTERN=1` を渡し、`leak-scan-secret.sh dir <木>`・`leak-scan-secret.sh history <履歴>`・`leak-scan-secret.sh git --range <分岐点>..<確かめたコミット>` を打つ。設定は、スクリプトが手順 3 のチェックアウトから絶対パスで読む
6. 当たりか失敗があれば、マージしない。NDF にマージさせる直前に、Pull Request の head が確かめたコミット、マージ先が main、main の先頭が探した base のままであることを読み直す。どれかが変わっていれば、マージせずに手順 1 からやり直す
7. NDF がマージした後に、Pull Request を読み、マージ先が main で、マージでできたコミット（`merge_commit_sha`）の最初の親が探した base で、head が確かめたコミットであることを確かめる。外れていれば、マージでできたコミットの木と、その最初の親と head から求めた分岐点から head までを、手順 3 のスクリプトで手元で探し、当たりがあればマージを戻すかを判断する

### 手で起動して確かめる

NDF と同じく、起動した 1 回の実行の初回の試行だけを確かめる。

1. 6 つの入力を取る。Pull Request の番号・head の SHA（`head.sha`）・base の先頭の SHA（`base.sha`）・マージコミットの SHA（`merge_commit_sha`）は、`gh api repos/devbasex/nd-factory/pulls/<番号>` で読む。`mergeable` が `null` なら読み直して待ち、真でなければ別の Pull Request を選ぶ。検査のコードのコミットは `gh api repos/devbasex/nd-factory/commits/main --jq .sha`、設定の世代は `<非公開リポジトリ>` の変数 `LEAK_CHECK_GENERATION` の値である
2. `<非公開リポジトリ>` の呼び出しのワークフローを、ワークフローの起動の API で起動し、応答の `workflow_run_id` を控える。送る本文には、`ref` に `<非公開リポジトリ>` の既定のブランチ（`gh api repos/<非公開リポジトリ> --jq .default_branch` で読む）を、`inputs` に手順 1 の 6 つの値を入れる。API のバージョン `2022-11-28` は、本文に `return_run_details: true` を入れたときだけ実行の ID を返すので、次の例のように入れる（バージョン `2026-03-10` は指定しなくても返す。[起動の API の仕様](https://docs.github.com/en/rest/actions/workflows?apiVersion=2022-11-28#create-a-workflow-dispatch-event)）。応答に `workflow_run_id` が無ければ、手順 3 へ進まない

   ```bash
   gh api --method POST \
     -H "X-GitHub-Api-Version: 2022-11-28" \
     "repos/<非公開リポジトリ>/actions/workflows/<呼び出しのワークフローのファイル>/dispatches" \
     -f ref='<既定のブランチ>' \
     -F return_run_details=true \
     -f 'inputs[pr_number]=<番号>' \
     -f 'inputs[head_sha]=<head の SHA>' \
     -f 'inputs[base_sha]=<base の先頭の SHA>' \
     -f 'inputs[merge_sha]=<マージコミットの SHA>' \
     -f 'inputs[code_sha]=<検査のコードのコミット>' \
     -f 'inputs[generation]=<設定の世代>' \
     --jq .workflow_run_id
   ```
3. 控えた実行の試行 1 が完了したら、次の 4 つを確かめる。1 つでも外れれば、承認していない版か、別の対象か設定で探した結果なので、手順 1 からやり直す
   - 試行 1（`gh api repos/<非公開リポジトリ>/actions/runs/<workflow_run_id>/attempts/1`）の `conclusion` が `success` である
   - 同じ応答の `referenced_workflows` に、`path` が `devbasex/nd-factory/.github/workflows/leak-check-secret.yml@main` の項目がちょうど 1 つあり、その `sha` が手順 1 の検査のコードのコミットと同じである（ジョブの表示名は入力から組むだけで、実際に動いた版を示さない）
   - 試行 1 のジョブの一覧（`gh api --paginate repos/<非公開リポジトリ>/actions/runs/<workflow_run_id>/attempts/1/jobs`）のすべてのジョブの `conclusion` が `success` である
   - 探しのジョブ `leak-check-secret` の表示名の番号・head・base・merge・code・gen の 6 つの値が、手順 1 の値と一致する

## 当たりの場所を手元で引く

非公開の記録と `leak-check-push` の記録には、ファイルの名前を出さない（名前も実際の値を含み得る）。持ち主は、記録の探した対象を手元で探し直してファイルを特定する。

1. 公開のリポジトリを、記録の表示名の検査のコードのコミットでチェックアウトし、`refs/pull/<番号>/head` と `refs/pull/<番号>/merge` を取り込む。取ったコミットが表示名の SHA と同じかを確かめる。マージの参照が進んでいれば、表示名のマージコミットの SHA を直に取る
2. コミットの列が空の当たり（`dir` と `history` の探し）は、`tools/checks/export-tree.sh <マージコミットの SHA> <木の出力先>` と `tools/checks/export-tree.sh --history <分岐点> <head の SHA> <履歴の出力先>` を、別々の空のディレクトリへ打つ。分岐点は `git merge-base <base の SHA> <head の SHA>` で求める。続けて秘密を渡し、`tools/checks/leak-scan-secret.sh dir <木の出力先> --details` と `tools/checks/leak-scan-secret.sh history <履歴の出力先> --details` を打つ
   - 履歴の当たりは、`paths/<通し番号>`（そのファイルの中身がパスの名前）か、`layers/<層の番号>/<元のパス>`・`binary-text/<層の番号>/<元のパス>`（中身）で出る
   - 中身の当たりのコミットは、`git hash-object --no-filters <履歴の出力先>/layers/<層の番号>/<元のパス>` で blob の SHA を求め、`git log --find-object=<blob の SHA> <分岐点>..<head の SHA>` で引く
3. コミットの列がある当たり（`git` の探し）は、`tools/checks/leak-scan-secret.sh git --range <分岐点>..<head の SHA> --details` を打つ
4. main への push（`leak-check-push`）の当たりは、その実行が探したコミットで探し直して引く。main は記録を確かめる間にも進むので、main の先頭では探さない
   - 対象の `leak-check-push` の実行の `head_sha`（`gh api repos/devbasex/nd-factory/actions/runs/<実行の ID> --jq .head_sha`）を控え、そのコミットを下の「main のコミットを手元で探し直す」で、`--details` を付けて探す。いつもの作業ディレクトリでは探さない。未追跡のファイルや別の版の gitleaks が混ざり、CI が出した当たりを引けなかったり、関係の無いファイルを当たりと取り違えたりするためである
   - 実行の後に環境 `leak-scan` の秘密を変えていた場合は、手元で渡す秘密が当時と同じ規則で探せるかを確かめる。同じ規則で探せなければ、元の当たりを引けないことがある
5. 出た実際のファイルの名前と行を、記録の当たりの規則と行と突き合わせる。**`--details` の出力は手元の端末にだけ出し、記録・Issue・Pull Request に貼らない。当たりの理由を公開の Pull Request に書かない。** 直しを頼むときは理由を伏せるか、Pull Request を閉じる

### main のコミットを手元で探し直す

1 つのコミットを、`leak-check-push` と同じ範囲と同じ設定の組み方で手元で探し直す。探す範囲は、そのコミットの木と、そのコミットから到達できる全履歴である。設定は、そのコミットの設定と、そのコミットが固定した gitleaks の版を使う。「導入の順序」の手順 4、上の手順 4、「正当な当たりを規則単位で外す」の表で使う。いつもの作業ディレクトリでは探さない。

当たりが無いかの判断は、`leak-check-push` と同じ `--count-only` で行う。ファイルの特定に使う `--details` は、設定の組み方が `leak-check-push` と違うので、合否の判断に使わない。

| 付ける引数 | 設定の組み方 | 使う場面 |
| --- | --- | --- |
| `--count-only`（`leak-check-push` と同じ） | 既定の規則・`.gitleaks.toml`・`nd-real-value` だけの設定で、1 回ずつ別々に探す | 当たりが無いかの判断 |
| `--details` | 既定の規則と、`.gitleaks.toml` を読み込んで（`[extend]`）`nd-real-value` を足した設定で探す | 当たりのファイルの特定。`.gitleaks.toml` を読み込むので、その内容によっては `--count-only` と結果が変わることがある |

1. 探すコミットの SHA を控える（以後「対象のコミット」）
2. 新しい空のディレクトリに公開のリポジトリを複製し（`git clone https://github.com/devbasex/nd-factory.git <空のディレクトリ>`）、そこへ移る。対象のコミットが main に無いとき（Pull Request のマージコミット）は、`git fetch origin refs/pull/<番号>/merge` で取り込む
3. `git checkout --detach <対象のコミット>` でチェックアウトし、`git rev-parse HEAD` が対象のコミットと同じこと、`git status --porcelain` が何も出さないことを確かめる
4. 対象のコミットがまだ main に無いときは、秘密を渡す前に、「1 本目を手元で探す」の手順 2 に挙げた 6 つのファイルを、差分だけでなく全体を読み、秘密を外へ送る処理や、ほかのファイルを動かす処理が無いことを確かめる。秘密を受けて動くのは、このチェックアウトのスクリプトだからである。gitleaks の版か要約値を変えるコミットでは、対象のコミットの `install-gitleaks.sh` が取る配布物が gitleaks の公式の配布（`github.com/gitleaks/gitleaks` の Releases）で、要約値がその配布物を自分で取って `sha256sum` で求めた値と同じことも確かめてから打つ。main の `ci.yml` の値とは照らし合わせない（1 本目のマージの後の `ci.yml` は `install-gitleaks.sh` を呼ぶだけで、版と要約値を持たない）
5. このチェックアウトの `install-gitleaks.sh` で gitleaks を置き、置いた先を `PATH` の先頭に足す。`install-gitleaks.sh` が失敗したら（取得・要約値の確かめ・取り出しの失敗。終了コードが `0` でない）、先へ進まない。続けて、`command -v gitleaks` が今回置いた先の `gitleaks` を指すことと、`gitleaks version` が `install-gitleaks.sh` の `GITLEAKS_VERSION` と同じことを確かめる。版の番号だけでは、前から入っていた同じ版の gitleaks と見分けられないためである

   ```bash
   dest="<作業用の空のディレクトリ>/gitleaks"
   GITHUB_PATH= tools/checks/install-gitleaks.sh "$dest"; echo "終了コード: $?"   # 0 でなければ先へ進まない
   export PATH="$(cd "$dest" && pwd -P):$PATH"
   command -v gitleaks   # "$dest" の絶対パスの下の gitleaks であること
   gitleaks version
   ```
6. 秘密を `LEAK_CHECK_PATTERN` に、`LEAK_CHECK_REQUIRE_PATTERN=1` を渡し、`tools/checks/leak-scan-secret.sh dir --count-only` と `tools/checks/leak-scan-secret.sh git --count-only` の両方を打つ
7. 両方の終了コードが `0` のときだけ、当たりが無いと判断する。片方でも `0` でなければ、当たりか失敗が残っている
8. 当たりの場所を引くときは、`--count-only` を外し、両方を `--details` を付けて打ち直す。この結果は場所の特定にだけ使い、手順 7 の判断を置き換えない

## 正当な当たりを規則単位で外す

正当な当たり（誤検知）を `[[rules.allowlists]]` で外すときは、許可の変更だけの Pull Request を先に main へマージし、その後に対象を含む Pull Request をマージさせる。非公開の検査は、探す Pull Request の中の設定ではなく、検査のコードのコミット（main の先頭）の `.gitleaks.toml` と `tools/checks/gitleaks-default.toml` で探すためである。対象と許可を同じ Pull Request に入れると、公開の `leak-check`（Pull Request のマージの参照の設定で探す）は通っても、非公開の検査は許可の無い main の規則で探して落ち、NDF はマージしない。

1. 当たりの場所を手元で引き（上の「当たりの場所を手元で引く」）、正当な当たりかを判断する
2. 当てた規則の `[[rules.allowlists]]`（`.gitleaks.toml` か `tools/checks/gitleaks-default.toml`）に、理由を添えて許可を足す Pull Request を出す。この Pull Request には許可の変更だけを入れ、誤検知の対象を入れない。許可の条件に実際の値を書かない
3. 許可の Pull Request をレビューして、NDF にマージさせる。許可は以後のすべての Pull Request と main への push の探しに効くので、広げすぎていないかをレビューで見る
4. 対象を含む Pull Request から同じ許可の変更を外し、NDF にマージさせる。NDF が次に起動する非公開の検査は、許可の入った main の先頭の規則で探す

対象が過去のコミットにあるときは、次のように扱う。

| 対象のある所 | 扱い |
| --- | --- |
| Pull Request の途中のコミットだけ | 上の手順のままでよい。規則単位の許可は、履歴の探し（`history` と `git --range`）にも効く |
| main の木か履歴（規則か gitleaks の版を変えたために、前から在る内容に当たるようになった） | 規則・`tools/checks/gitleaks-default.toml`・gitleaks の版を変える Pull Request に、前から在る内容への許可を同じ Pull Request で入れる。許可を後の Pull Request に分けると、許可の Pull Request のマージコミットの木にも対象があるため、許可の Pull Request 自身が非公開の検査で落ちる。公開の `leak-check` が探すのは、マージコミットの木と、分岐点から head までのコミットだけで、main の過去のコミットにだけ残る内容は探さない。そのため、規則か gitleaks の版を変えるときは、マージの前に、その Pull Request のマージコミット（`refs/pull/<番号>/merge` の SHA）を、「当たりの場所を手元で引く」の「main のコミットを手元で探し直す」で探す。そのコミットの設定と gitleaks の版で、そのコミットから到達できる全履歴（main の過去のコミットを含む）と木を探すことになる。手元の `main` に切り替えて探すと、変更前の設定で探すことになる。探さずにマージすると、マージ後の `leak-check-push` で初めて当たりに気付く。探した後に main か Pull Request の head が進むと、前の結果は新しいマージの候補を確かめていない。マージの直前に、下の「規則を変える Pull Request をマージの直前に確かめる」で、探したマージコミットが今の候補と同じことを確かめる |
| 実際の値の規則 `nd-real-value` の当たり | 許可を足せない（規則は秘密の中にあり、`[[rules.allowlists]]` を持たない）。誤検知なら、「秘密を変える手順」で秘密の正規表現を直す。実際の値なら、マージせずに「当たりの場所を手元で引く」の手順 5 のとおりに扱う |

### 規則を変える Pull Request をマージの直前に確かめる

マージの参照（`refs/pull/<番号>/merge`）を読むだけでは、GitHub がマージの候補を作り直す前の古いコミットでも一致してしまう。そのため、Pull Request の取得の API で候補を作り直させ、作り直した候補が探したマージコミットと同じことを確かめる（[マージできるかの確かめ方](https://docs.github.com/en/enterprise-server%403.21/rest/guides/using-the-rest-api-to-interact-with-your-git-database#checking-mergeability-of-pull-requests)）。

1. `gh api repos/devbasex/nd-factory/pulls/<番号>` を打つ。この呼び出しで、GitHub がマージの候補の作り直しを始める
2. 応答の `mergeable` が `null` なら、少し待って手順 1 を打ち直す。`false` ならマージしない。`true` になるまで先へ進まない
3. `mergeable` が `true` の応答で、次の 3 つを確かめる
   - `merge_commit_sha` が、探したマージコミットの SHA と同じである
   - 探したマージコミットの最初の親（`git rev-parse <探したマージコミット>^1`）が、今の main の先頭（`gh api repos/devbasex/nd-factory/commits/main --jq .sha`）と同じである
   - 探したマージコミットの 2 つ目の親（`git rev-parse <探したマージコミット>^2`）が、応答の `head.sha` と同じである
4. 1 つでも違えば、マージしない。新しいマージコミットを取り込み、「main のコミットを手元で探し直す」で `dir` と `git` の両方を探し直してから、手順 1 からやり直す
5. 3 つがそろっても、この Pull Request のマージを終えるまで main を進めない。手順 3 の確認の後に別の Pull Request が main に入ると、探したのは古い候補になり、新しい main の履歴を変更後の規則で探していないことになる。GitHub のマージの API の `sha` で固定できるのは head だけで、base は固定できないので、main を止めておくしかない（[マージの API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)）
   - マージのコミットを手元で探し直す前から止めておく。NDF にほかの Pull Request をマージさせず、画面からもマージせず、main へ直に push しない
   - 止めている間に main が進んでしまったら、マージせずに手順 4 のとおり探し直す
6. マージの後に、Pull Request を読み直し、マージでできたコミット（`merge_commit_sha`）が探した組み合わせで作られたことを確かめる
   - 最初の親が探したマージコミットの最初の親（探した base）と同じで、2 つ目の親が探した head と同じである
   - 木（`git rev-parse <コミット>^{tree}`）が、探したマージコミットの木と同じである
   - 1 つでも違えば、マージでできたコミットを「main のコミットを手元で探し直す」で探し直す。当たりがあれば、マージを戻すかを判断する

## 見本の写し直し

[`leak-check-caller.yml`](leak-check-caller.yml) を変えたら、`<非公開リポジトリ>` の写しも直す。写しを変えるのは呼び出しのワークフローの変更なので、「秘密を変える手順」の手順 1〜4 で世代を切り替えて写し直す。写しが見本と違っても、公開のリポジトリのテストでは見つからない。

## 振る舞いの変化

- main への push で、gitleaks の設定の結合のテスト（`npm run test:integration -- leak-scan`）を打たなくなった。結合のテストは Pull Request の `leak-check` で打つ。環境 `leak-scan` を持つ `leak-check-push` では依存の導入の処理を動かさないためである
- Pull Request の `leak-check` は、秘密が空でも、同じリポジトリのブランチの Pull Request で落ちなくなった。実際の値の規則での Pull Request の探しは、非公開の検査が行う
- main への push の `nd-real-value` の当たりは、件数の行だけになった。場所は「当たりの場所を手元で引く」で引く
