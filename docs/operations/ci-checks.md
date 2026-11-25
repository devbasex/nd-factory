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
4. 1 本目のマージで起きた main への push の `leak-check-push` の記録で、`dir` と `git` の両方の探しで `leak-scan-secret: nd-real-value: <件数> 件` の行（当たりが無ければ `0 件`）が出ており、`leak-scan-secret: 秘密 LEAK_CHECK_PATTERN が空なので .gitleaks.toml だけで探す` の行が出ていないことを確かめる。確かめられなければ、手順 2 の設定を直し、手元で秘密を渡して `tools/checks/leak-scan-secret.sh git` を打ち、main の到達できるすべてのコミットを探す。確かめた後に、変数 `LEAK_CHECK_REQUIRE_PATTERN` を `1` にする
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
4. main への push（`leak-check-push`）の当たりも、main の先頭のチェックアウトで `tools/checks/leak-scan-secret.sh dir --details` と `tools/checks/leak-scan-secret.sh git --details` を打って同じく引く
5. 出た実際のファイルの名前と行を、記録の当たりの規則と行と突き合わせる。**`--details` の出力は手元の端末にだけ出し、記録・Issue・Pull Request に貼らない。当たりの理由を公開の Pull Request に書かない。** 直しを頼むときは理由を伏せるか、Pull Request を閉じる

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
| main の木か履歴（規則か gitleaks の版を変えたために、前から在る内容に当たるようになった） | 規則・`tools/checks/gitleaks-default.toml`・gitleaks の版を変える Pull Request に、前から在る内容への許可を同じ Pull Request で入れる。許可を後の Pull Request に分けると、許可の Pull Request のマージコミットの木にも対象があるため、許可の Pull Request 自身が非公開の検査で落ちる。規則を変える Pull Request に許可が欠けていれば、公開の `leak-check` が Pull Request の設定で前から在る内容を探して落ちるので、マージの前に気付ける |
| 実際の値の規則 `nd-real-value` の当たり | 許可を足せない（規則は秘密の中にあり、`[[rules.allowlists]]` を持たない）。誤検知なら、「秘密を変える手順」で秘密の正規表現を直す。実際の値なら、マージせずに「当たりの場所を手元で引く」の手順 5 のとおりに扱う |

## 見本の写し直し

[`leak-check-caller.yml`](leak-check-caller.yml) を変えたら、`<非公開リポジトリ>` の写しも直す。写しを変えるのは呼び出しのワークフローの変更なので、「秘密を変える手順」の手順 1〜4 で世代を切り替えて写し直す。写しが見本と違っても、公開のリポジトリのテストでは見つからない。

## 振る舞いの変化

- main への push で、gitleaks の設定の結合のテスト（`npm run test:integration -- leak-scan`）を打たなくなった。結合のテストは Pull Request の `leak-check` で打つ。環境 `leak-scan` を持つ `leak-check-push` では依存の導入の処理を動かさないためである
- Pull Request の `leak-check` は、秘密が空でも、同じリポジトリのブランチの Pull Request で落ちなくなった。実際の値の規則での Pull Request の探しは、非公開の検査が行う
- main への push の `nd-real-value` の当たりは、件数の行だけになった。場所は「当たりの場所を手元で引く」で引く
