# 反映のパイプライン

運用する環境のアプリのスタックは、反映のパイプラインだけで反映する。起点のブランチへの push から、準備と反映が人の承認を待たずに続く（持ち主の決定、2026-11-25、[#164](https://github.com/devbasex/nd-factory/issues/164)）。人が差分を読むのは反映の後である。

人の承認の代わりに、次の 3 つで反映する中身を限る。

- 起点のブランチを、レビュー必須の保護があるブランチに限る
- 準備で NDF の契約を照合し、食い違えば反映へ進まない
- 反映の段が `cdk deploy` の直前に検査を打ち、1 つでも満たさなければ反映しない

パイプラインのスタックは、設定のファイルに `pipeline` があるときだけ合成に現れる。パイプラインが反映するのはアプリのスタック（`<prefix>-<environment>-app`）だけである。パイプラインのスタック（`<prefix>-<environment>-pipeline`）自身は、設置のコマンドで `--stack pipeline` を渡して反映する（[setup.md](setup.md)）。パイプラインが自分自身を反映すると、起点のブランチへの push だけで反映のロールの権限を変えられてしまうためである。

この手順は、商用利用の開始前に使う。商用利用を宣言した本番（`launch_declared` が真で `environment_kind` が `production`）へは、このパイプラインでは反映しない。

手順で確かめた実際の値（アカウント ID・主体の名前・ARN・ルールセットの ID・実行の ID）は、アクセスを制限した運用の記録に残す。課題のコメントには判定と未解決の事項だけを書く。

## 段

| 段 | アクション | すること |
| --- | --- | --- |
| 取る（`Source`） | GitHub との接続 | 起点のリポジトリ（`pipeline.repository`）の起点のブランチ（`pipeline.branch`）の先端を取る。実行は起点のブランチへの push のトリガーで始まる |
| 準備（`Prepare`） | CodeBuild `<prefix>-<environment>-prepare` | 下の「準備」の順に打つ |
| 反映（`Deploy`） | CodeBuild `<prefix>-<environment>-deploy` | 準備の出力の合成の結果だけを受け、直前の検査と要約値の照合を通ったときだけ `cdk deploy` で反映する |

実行の扱いは `SUPERSEDED` である。push が続くと、後の実行が段へ来た時点で、その段の前で待つ実行は打ち切られる。

### 準備

1. SSM のパラメーター `/<prefix>/<environment>/settings` の版を読み、その版を指定して値を読む。版と値の SHA-256 を出力の変数（`SETTINGS_VERSION`・`SETTINGS_SHA256`）にする
2. `npm ci` の直後に NDF の契約を照合する（`npm run ndf-contract -- --summary infra/approval/ndf-contract.md`）
3. 画面をビルドしてアプリのスタックだけを合成する。保存した合成の結果と今のスタックの差分（`cdk diff --method=template`。変更のセットは作らない）を記録と `approval/diff.txt` に残す
4. 合成の結果の要約値を数え、コミット・要約値・スタックの一覧を出力の変数にする

照合の結果ごとの扱いは次のとおりである。

| 照合の結果 | 終了コード | 準備 |
| --- | --- | --- |
| 固定の点（`ndf-pin.json` の NDF のコミット）の契約と食い違う、使い方の書き出しが無い | 1 | 止める |
| 固定の点の契約や書き出しを読めない、要約を書けない | 2 | 止める |
| NDF のデフォルトブランチの先端の契約とだけ食い違う、先端だけを読めない | 0 | 反映へ進む。要約に残る |

準備のロールが引き受けられるのは、アプリ専用の bootstrap の lookup のロールだけである。準備は起点のブランチのコードを実行するので、利用者のデータを読めないようにしている。lookup のロールに標準の `ReadOnlyAccess` は付けない。読めるのは、アプリのスタックの状態とテンプレート、bootstrap の版だけである。

### 反映の直前の検査

反映の段は、次を順に打つ。1 つでも満たさないか確かめられなければ、`反映しない: <理由>` を記録に出して失敗する。検査のコードはパイプラインのスタックが持つので、起点のブランチの変更からは変えられない。

| 順 | 検査 |
| --- | --- |
| 1 | 自分の実行が、起点のブランチへの push で始まった（`trigger.triggerType` が `WebhookV2`） |
| 2 | 設定のパラメーターの版と値の SHA-256 が、準備のものと同じ |
| 3 | 設定が宣言した本番でなく、宣言の記録 `/<prefix>/<environment>/launch-declared` が無いと確かめられる |
| 4 | 合成の結果が、許した形のアプリのスタックだけ（アプリ専用の qualifier のロールとバケット。`executable` を持つアセットとイメージのアセットは無い） |
| 5 | テンプレートに変換（`Transform`・`Fn::Transform`）が無く、`ND_CONFIRMATION_STAGE` が設定から決めた段階と食い違わず、IAM のロールがすべて権限の境界を持ち AWS のサービスだけを信頼し、ユーザー・グループ・アクセスキーが無い |
| 6 | アプリ専用の実行のロールの方針が 1 つだけで、その方針と権限の境界の今のデフォルトのバージョンの本文が承認したものと同じで、反映と実行のロールの実効の権限（`iam:SimulatePrincipalPolicy`）が期待のとおり |
| 7 | アプリ専用の bootstrap の版が、合成の結果の求める版以上 |
| 8 | S3 に置かれたテンプレートの中身が、検査したファイルと同じ |

変換があるテンプレートを拒むのは、CloudFormation が変換した後の中身を、この検査が読めないためである。

承認した本文とは、パイプラインのスタックを反映した時点のコードが作る方針と境界である。検査はその要約値を持つ。実行の記録に失敗の理由を出すときは、操作と検査のケースを書き、ロールの名前と ARN は書かない。

その後、要約値を数え直して準備の値（`EXPECTED_DIGEST`）と比べ、同じときだけ `cdk deploy --app cdk.out --require-approval never <prefix>-<environment>-app` を打つ。合成し直さない。要約値の作り方は設置のコマンドと同じで、[setup.md](setup.md) の「確認の値」にシェルの式がある。

反映のプロジェクトのロール（名前は `<prefix>-<environment>-deploy-<region>`）が持つ権限は、アプリ専用の反映・公開・実行のロールの引き受け、2 つのパラメーターの読み取り、このパイプラインの実行の読み取り、アプリ専用の 2 つのロールの IAM の読み取りとシミュレーション、実行の方針と権限の境界の読み取り、成果物とログだけである。

## 反映の後に記録を読む

準備の出力の成果物（パイプラインの成果物のバケット。30 日で消える）に、次の 2 つがある。準備の CodeBuild の記録にも差分が出る。

| 資料 | 読むこと |
| --- | --- |
| `approval/diff.txt` | 足し・変え・消しが反映するつもりの変更だけか。アプリのスタック以外が出ていないか。秘密の値が出ていないか |
| `approval/ndf-contract.md` | 照合の結果。NDF の先端の契約とだけの食い違いは、ここに並ぶ |

秘密の器の資源が変わったときは、器へ入れた値が残っているとは限らない。[idp-and-apps.md](idp-and-apps.md) の「器の値を確かめる」を打ち直す。

## 失敗したとき

実行が失敗すると、失敗の通知が `pipeline.notify_emails` の宛先へ SNS のメールで届く（初めは購読の確認のメールが届くため、リンクを開いて購読を有効にする）。反映の途中で CloudFormation が失敗したときは、前の状態へ戻る。

反映を進め直す経路は 2 つだけで、どちらも起点のブランチへの push で始まった実行のソースを使う。

| 経路 | 使う場面 |
| --- | --- |
| 失敗した段のやり直し（`aws codepipeline retry-stage-execution`） | NDF のリポジトリを読めずに準備が失敗し、読めるように戻った（準備の段）。反映の段が失敗した（反映の段への遷移を止めていないときだけ） |
| 新しい Pull Request を起点のブランチへマージする | コードか設定の直しが要る。古い状態へ戻すときも、戻しの変更をレビューを通して入れる |

手動で始めた実行（`start-pipeline-execution`）は、人が始めたものも反映の段で失敗する。パイプラインを作ったときの最初の実行も反映されない（接続が `PENDING` なら取る段で失敗し、有効でも反映の段で失敗する）。どちらも想定どおりの失敗で、最初の反映はレビュー済みの Pull Request を起点のブランチへマージした push を待つ。

`stop-pipeline-execution --abandon` は打たない。スタックの更新が途中の状態で残りうる。

## 起点のブランチの保護と、反映を始められる主体

### 打ってよい状態の変更

遷移の停止と再開、待つ実行の停止、段のやり直しは、承認を受けた次の場面と条件だけで打つ。表に無い場面の操作、条件を満たさないままの遷移の再開、`--abandon` での停止、手動の実行の開始は打たず、人へ戻す。

| 場面 | 遷移を止める | 待つ実行を止める | 遷移を戻す |
| --- | --- | --- | --- |
| bootstrap の切り替え | アプリ専用の bootstrap を作る前 | 切り替えの前に準備した実行 | 切り替えの順序の 4 の確認と「遷移を戻すとき」を満たしたとき |
| 起点のブランチの要件を満たさない | 満たさないと分かったとき | 「遷移を戻すとき」の 3 の実行 | 「遷移を戻すとき」を満たしたとき |
| 設定のパラメーターを書き換える | 書き換える前 | 入口で待つ古い設定の実行 | 「[設定を書き換える手順](#設定を書き換える手順)」の 4〜6 を満たしたとき |
| AI の主体が設定のパラメーターを書ける | 書けると分かったとき | 比べる前に準備して入口で待つ実行 | 「書けると分かったとき」の条件を満たしたとき |

段のやり直しを打つのは、「失敗したとき」の表の場面だけである。

遷移は次の形で止め、戻す。理由には止めた場面を書き、実際の値を書かない。

```bash
aws codepipeline disable-stage-transition --profile <profile> \
  --pipeline-name <prefix>-<environment>-pipeline --stage-name Deploy \
  --transition-type Inbound --reason "<止めた場面>"

aws codepipeline enable-stage-transition --profile <profile> \
  --pipeline-name <prefix>-<environment>-pipeline --stage-name Deploy \
  --transition-type Inbound
```

### 確かめる時期

既に動いている環境・初めての設置・起点（`pipeline.repository`・`pipeline.branch`）の変更のどれでも、パイプラインのスタックを `--stack pipeline` で反映する前に、この節の確認をすべて行う。保護か迂回できる主体を変えたときと、遷移を戻すときも確かめ直す。前の記録は使わず、取り直す。

保護か迂回できる主体を変える操作と、起点を変える操作は、権限を変える操作である。変える前に人へ戻し、持ち主が中身を承認してから適用する。変えた後に下の要件を満たさなくなるなら、適用の前に遷移を止める。

`pipeline.branch` に使える文字は、英数字と `.` `_` `-` `/` だけである（[settings.md](settings.md)）。

### 起点のブランチの保護

起点のブランチは、存在し、次をすべて満たすものに限る。

- 変更は Pull Request からだけ入る
- マージの前に 1 人以上のレビューの承認が要る
- 差分を変えるコミットが足されたら、それまでの承認が失効する
- 強制 push と削除を許さない。ルールセットなら作成の制限（`creation`）・削除の制限（`deletion`）・強制 push の禁止（`non_fast_forward`）が効いている。従来のブランチの保護には作成を制限する設定が無いので、ブランチが存在し削除を許さないことで代える
- 人を含めて誰も迂回できない

確かめ方は次の順である。権限が足りないなどで確かめきれなければ、満たさないものとして扱う。

1. ブランチが存在することを `gh api repos/<リポジトリ>/branches/<ブランチ>` で確かめる。ルールを返す API は、無いブランチにも名前に当たるルールを返すので、存在の確認にならない
2. `gh api repos/<リポジトリ>/rules/branches/<ブランチ>` で、効いているルールと元のルールセットを並べる
3. 各ルールセットの詳細を、迂回の設定を読める権限（リポジトリか組織の管理者）で読む（`gh api repos/<リポジトリ>/rulesets/<ID>`、組織なら `gh api orgs/<組織>/rulesets/<ID>`）。上のルールを持つルールセットで、迂回できる主体の一覧が空であることを確かめる
4. 従来のブランチの保護（`gh api repos/<リポジトリ>/branches/<ブランチ>/protection`）なら、`enforce_admins` が有効で、Pull Request の必須を迂回できる個別の例外が無く、`allow_force_pushes` と `allow_deletions` が偽であることを確かめる
5. 承認の件数と失効を、実効の値で確かめる。値が無い・読めないときは満たさない

| 方式 | 承認の件数 | 差分を変えるコミットでの承認の失効 |
| --- | --- | --- |
| ルールセット（`rules` の `type` が `pull_request`） | `parameters.required_approving_review_count` が 1 以上 | `parameters.dismiss_stale_reviews_on_push` が真 |
| 従来のブランチの保護 | `required_pull_request_reviews.required_approving_review_count` が 1 以上 | `required_pull_request_reviews.dismiss_stale_reviews` が真 |

ルールセットが複数あるときは、迂回できる主体の無いルールセットの Pull Request のルールのうち、少なくとも 1 つが両方の値を満たせばよい。

### 保護を編集できる主体

ルールセットや従来の保護を編集・無効化できる主体を、持ち主が承認した管理主体だけに絞る。AI が使うアカウントと GitHub App は、承認した管理主体に含めない。確かめるたびに次の一覧をすべて取り直し、承認した管理主体の一覧と比べる。

- `gh api repos/<リポジトリ>/collaborators` の管理者
- 組織のルールセットの管理権限
- リポジトリにインストールされた GitHub App の権限
- 細かい権限の PAT: 組織の設定で承認制にするか禁止する。承認された PAT を `gh api orgs/<組織>/personal-access-tokens` で並べ、承認待ち（`personal-access-token-requests`）も読む
- 従来型の PAT: 組織の設定で禁止し、禁止が有効なことを組織の管理者が確かめて、日時と確かめた人を記録する。禁止できないリポジトリは起点にしない。SAML SSO の組織なら `gh api orgs/<組織>/credential-authorizations` も比べる

一覧に無い主体が保護を編集できるか、一覧を取り切れないとき（API が最後まで返らない・設定を確かめられない・今回確かめていない）は、満たさないものとして遷移を止める。

### 先端に既に入っている変更

保護は、付けた後の変更しか縛らない。パイプラインのスタックを反映する前に、次を確かめる。

1. 信頼する基点を決める。決められなければ起点にしない
   - 既に動いている環境と起点の変更では、次のどちらかの実行が反映したリビジョンのうち、その環境へ最後に反映したものを基点にする
     - 承認の段で人が承認した実行
     - この節の確認をすべて終えた後に、起点のブランチへの push で始まった実行。承認の段が無くても基点にできる
   - 承認の段を外してから（[#165](https://github.com/devbasex/nd-factory/pull/165)）この節の確認を終えるまでに反映したリビジョンは、人の承認もこの確認も経ていないので、基点にしない
   - 初めての設置と、上の条件に当たるリビジョンを確かめられないときは、持ち主が信頼すると決めたコミットを基点にし、決定を記録する
2. 基点から先端までの変更が、すべてレビューの承認を受けた Pull Request から入っていることを確かめる。基点が先端の祖先でなければ、差分のすべてを同じように確かめる。確かめきれない変更があれば起点にしない
3. 確かめた先端のコミットを記録する。反映するまでに先端が進んだら、進んだ分を確かめ直す

承認の段で人が承認したかは、`list-action-executions` の承認のアクションの成功と、同じ時間帯の CloudTrail の `PutApprovalResult` の主体が人であることを照らす。どちらかが無いか照らせなければ、人の承認とみなさない。

### AWS の側から反映を再開する操作と、直に動かす操作

AI エージェントが直に使う主体、引き受けられるロール（その先も含む）、委任の経路（ロールを持つ CodeBuild・Lambda・CloudFormation などを起動・更新できる場合のロール）が、次の操作を許されないことを確かめる。

| 資源 | 操作 |
| --- | --- |
| パイプラインの ARN（`arn:aws:codepipeline:<region>:<account>:<パイプライン>`） | `codepipeline:StartPipelineExecution` |
| 反映の段の ARN（パイプラインの ARN に `/Deploy`） | `codepipeline:EnableStageTransition`・`codepipeline:RetryStageExecution` |
| 反映のプロジェクトの ARN | `codebuild:StartBuild`・`StartBuildBatch`・`RetryBuild`・`RetryBuildBatch`・`UpdateProject`・`DeleteProject`・`CreateWebhook`・`UpdateWebhook` |
| 反映のプロジェクトのロール | `iam:PassRole`・`sts:AssumeRole` |
| bootstrap が作った反映のロールと実行のロール | `sts:AssumeRole` |

確かめは `aws iam simulate-custom-policy` を、操作ごとの資源の ARN を指定して打つ。主体が取り得る条件の値を、すべての文の条件の真偽の組み合わせで区画に分け、区画を網羅する。主体を挙げきれないか区画を網羅できなければ、許されているものとして遷移を止める。

許されていたら、見つけた主体と経路をすぐに人へ戻し、操作と資源を指定した拒否の承認を求める（スタックの外の IAM の変更なので、打つ前に持ち主の承認を受ける）。拒否を付けて同じ判定で拒まれることを確かめるまで、遷移を止めたままにする。反映のプロジェクトを直に動かせた場合は、CloudTrail の `StartBuild`・`UpdateProject` と、起動した主体が `codepipeline/<パイプライン>` でないビルドの履歴を確かめ、確かめられなければ遷移を戻さず人へ戻す。

### 満たさないときと、遷移を戻すとき

満たさないときは起点にしない。既に動いている環境なら反映の段への遷移を止め、確かめ直すまで戻さない。止めている間は反映しない。

止めた直後に `aws codepipeline get-pipeline-state` で反映の段の実行を確かめる。既に入った実行は最後まで進むので、そのソースのリビジョン（`list-pipeline-executions` の `sourceRevisions`）を記録する。レビューを通った変更だけと確かめられなければ人へ戻す。

遷移を戻すと、入口で待つ実行がそのまま反映の段へ進む。

どの場面で止めた遷移でも、次のどれかに当たる間は戻さない。

- 設定が、商用利用を宣言した本番を示す（`launch_declared` が真で `environment_kind` が `production`）
- 宣言の記録（SSM のパラメーター `/<prefix>/<environment>/launch-declared`）がある
- 宣言の記録の有無を確認できない（`aws ssm get-parameter` が `ParameterNotFound` 以外で失敗する）
- 宣言の記録が無く、過去に商用利用を宣言していないことを持ち主に確認できない

宣言の記録が無い場合は、過去に商用利用を宣言していないことを持ち主に確認できるまで遷移を戻さない。過去の宣言が確認できた場合は、次の復旧手順に従う。

持ち主に報告する。復旧の方法と実行する人を持ち主が決め、承認された手順で記録を復旧する。承認の前に記録を書かない。復旧した後も遷移は戻さない。

どれにも当たらないときは、次をすべて満たしてから戻す。

1. 起点のブランチの存在と保護、保護を編集できる主体、AWS の側の 2 つの操作の確認を満たす
2. 信頼する基点から先端までの変更が、すべてレビューの承認を受けた Pull Request から入っている。確かめきれなければ戻さず人へ戻す
3. 入口で待つ実行のうち、ソースが 2 で確かめたコミットでない実行と、照合を持たない前の版の準備で作った実行を `stop-pipeline-execution` で止める
4. 入口で待つ実行が、2 で確かめた起点のブランチへの push で始まり、今の版の準備が成功した実行 1 つだけである。無ければ戻さず、次の Pull Request のマージで始まる実行の準備の成功を待つ

## 設定のパラメーターを書ける主体と、書き換える手順

段階（`launch_declared`・`environment_kind`）を含む設定を変える経路は、運用担当者が打つ設置のコマンド（`--stack pipeline`）だけである。どの段階の変更も、持ち主の承認を受けてから打つ。

### 書ける主体の確認

AI の主体が、設定と宣言の記録の 2 つのパラメーターの ARN へ `ssm:PutParameter`・`ssm:DeleteParameter`・`ssm:DeleteParameters` を許されないことを、上と同じ範囲と判定で確かめる。CloudFormation の経路でも書けないことを確かめる。パイプラインのスタックを更新できる操作（`cloudformation:UpdateStack`・`CreateChangeSet`・`ExecuteChangeSet` など）と、`cdk bootstrap` が作った反映のロール・実行のロールの引き受けである。

### 書けると分かったとき

1. 反映の段への遷移を止める
2. 反映の経路そのもの（上の CloudFormation の経路、`codepipeline:UpdatePipeline`、パイプラインとプロジェクトのロールの IAM の変更、反映のプロジェクトの直の起動と変更）を使えるなら、先にその経路への拒否の承認を受けて付ける。付けた後に、パイプラインの定義（`get-pipeline`）・パイプラインのスタック（`detect-stack-drift` と承認済みの版のテンプレートとの比較）・パイプラインとプロジェクトのロールの権限・設定の値を、リリースで承認した状態と照合する。違えば遷移を戻さず人へ戻す。あわせて、経路を変えられた期間の CloudTrail とパイプラインの実行の履歴で、動いているアプリが承認済みの版のままかを確かめる。確かめられなければ遷移を戻さない
3. パラメーターと CloudFormation の経路への拒否の承認を受けて付け、同じ判定で拒まれることを確かめ直す

遷移を戻す条件は次の 5 つである。SHA-256 が一致しても、3 の更新記録の確認は省かない。

1. 書き込みの拒否の確認: 拒否を付けた後、同じ判定で拒まれる
2. 承認済みの設定と現在値の SHA-256 の比較: 比べる相手は、承認済みの合成の結果のパイプラインのスタックのテンプレートにある、設定のパラメーターの `Value` である（設定のファイルそのものとは比べない）。どちらも改行を足さずに数える。宣言の記録は「遷移を戻すとき」の分け方で確かめる
3. 書き込めた期間以降の更新記録の確認: 期間は、権限が付いた時点（分からなければ、前に書けないと確かめた時点、それも分からなければパラメーターを作った時点）から、1 で拒まれると確かめた時点までである。次を確かめる
   - CloudTrail の `PutParameter`・`DeleteParameter`・`DeleteParameters` とパラメーターの版の履歴（`get-parameter-history`）の、どの版も CloudFormation が書いた
   - アプリのスタックのイベント（`describe-stack-events`）と CloudTrail の `UpdateStack`・`CreateChangeSet`・`ExecuteChangeSet` で挙げた更新が、パイプラインの実行（`list-pipeline-executions`・`list-action-executions`）の反映に結び付く
   - 結び付いた実行の準備の `SETTINGS_SHA256` がその時点の承認済みの値で、ソースがレビュー済みのコミットである
   - 動いているアプリのスタックが、その確かめた反映の結果のままである
4. 経路が変わったときの追加の照合: 上の「書けると分かったとき」の 2 の照合と記録の確認が通っている
5. 決定した条件をすべて満たしてから再開する: 入口で待つ古い実行を止め、比べた後の push の実行の準備が成功してから、「遷移を戻すとき」に従う

値が一致して更新記録が食い違うときは、遷移を戻さず、稼働中のアプリの復旧方法を持ち主が決める。現在値が違うときは、遷移を戻さず、設定の復旧方法を持ち主が決める。設置のコマンドを打ち直しても、直に書き換えられた値は書き直されない。

### 設定を書き換える手順

1. 反映の段への入口の遷移を止める
2. 反映の段をやり直さず、`get-pipeline-state` で反映の段の実行が終わるのを待つ
3. 設置のコマンドでパイプラインのスタックを反映して書き換える（[settings.md](settings.md) の「運用する環境で設定を変える」）
4. 入口で待つ古い設定の実行を `stop-pipeline-execution` で止める。その後、書き換えた後の設定と宣言の記録を、「[遷移を戻すとき](#満たさないときと遷移を戻すとき)」の戻さない場合に照らす。当たる場合は、遷移を止めたままにして、5 へ進まない。当たらない場合は 5、6 に進む
5. 遷移を止めたまま、レビュー済みの Pull Request を起点のブランチへマージする。その実行が新しい設定で準備を通り、反映の段の入口で待つことを確かめる
6. 「遷移を戻すとき」の条件を満たしてから遷移を戻す

## 承認の段を持っていた版から上げるとき

前の版のパイプラインのスタックは、`codepipeline:PutApprovalResult` を拒む管理の方針 `<prefix>-<environment>-deny-approval` を作っていた。今の版は方針を持たない。主体に付いたままだと方針を消す反映が失敗しうるので、パイプラインのスタックを反映し直す前に外す。方針を付けていなければ、手順 4 の確認だけを行う。

### 1. 外してよいかを確かめる

この方針の拒否は `Resource` が `*` なので、ほかのパイプラインの承認の段にも効いている。確かめ終わらない対象が 1 つでも残れば、手順 2・3 へ進まない。

- 対象は、方針があるアカウントと、手順 3 で参照を外す許可セットを割り当てたすべてのアカウントである。リージョンは、各アカウントで有効なすべてのリージョンである
- アカウントごとに、方針のデフォルトのバージョンの本文（`get-policy-version`）が、`Effect` が `Deny`、`Action` が `codepipeline:PutApprovalResult` だけ、`Resource` が `*` だけ、`Condition` 無しの 1 文であることを確かめる。違えばそのアカウントは手順 2・3 へ進まず人へ戻す
- `aws iam list-entities-for-policy` を `--policy-usage-filter PermissionsPolicy` と `PermissionsBoundary` の 2 回打ち、許可セットは `aws sso-admin get-permissions-boundary-for-permission-set` で確かめる。方針を境界として使う主体か許可セットがあれば、そのアカウントは手順 2・3 へ進まず人へ戻す。境界の移行は持ち主の承認を受ける
- リージョンごとに `aws codepipeline list-pipelines` と `get-pipeline` で、手動の承認のアクションを持つパイプラインを並べる
- 実際に権限を使うユーザーとロール（グループなら所属ユーザー、許可セットなら各アカウントのロール）ごとに、この方針を除いた残りの方針と境界で、承認の送信が拒まれたままかを `aws iam simulate-custom-policy --action-names codepipeline:PutApprovalResult` で確かめる。すべての文の条件の真偽で分けた区画を網羅する
- すべての承認のアクションとすべての区画で `allowed` でなく `MissingContextValues` が空なら、外してよい。`allowed` になる主体からは外さず、そのパイプラインの持ち主が別の拒否を付けるまで待つ。区画を網羅できない・判定できないときは止めて人へ戻す
- 判定に使った情報（か SHA-256）を運用の記録に残す

外す対象のアカウント・方針・主体と許可セット・外す順序・外した後の権限の差分の一覧を運用の記録にまとめる。リリース承認ゲートで持ち主がその一覧を承認するまで、手順 2 へ進まない。一覧に無い対象と、承認の後に付いた主体や本文が変わった対象は外さない。

外す直前に、主体ごとの残りの方針・境界・許可セットの方針・承認のアクションの一覧を取り直す。承認のときと違えば外さず、判定と承認をやり直す。

### 2. 直に付けた方針を外す

`list-entities-for-policy --policy-usage-filter PermissionsPolicy` で並べた主体から、`detach-user-policy`・`detach-role-policy`・`detach-group-policy` で外す。IAM Identity Center が管理するロール（名前が `AWSReservedSSO_` で始まるもの）は除き、手順 3 で外す。

### 3. 許可セットの参照を外す

`aws sso-admin list-customer-managed-policy-references-in-permission-set` で参照のある許可セットを探し、`detach-customer-managed-policy-reference-from-permission-set` で外す。割り当てたすべてのアカウントへ `provision-permission-set` で再プロビジョニングし、`describe-permission-set-provisioning-status` で完了を待つ。

### 4. 確かめて反映し直す

`aws iam list-entities-for-policy` を絞らずに打ち、ユーザー・ロール・グループのどれも返さないことを確かめてから、パイプラインのスタックを反映し直す。方針の本体は手で消さず、CloudFormation に消させる。

## アプリ専用の bootstrap への移行と切り替えの順序

反映のパイプラインがある設置のアプリのスタックは、設置ごとのアプリ専用の bootstrap を使う。qualifier は `prefix` と `environment` から決まる 10 文字である。反映のロールと公開のロールは、反映のプロジェクトのロール（と `--direct-role` で渡したロール）だけが引き受けられる。実行のロールは、アプリの反映に要る権限だけを持ち、アプリのロールは権限の境界 `<prefix>-<environment>-app-boundary` を必須にする。実行のロールと権限の境界は、別の設置のタグ（`app-prefix`・`app-env`）が付いた資源への操作を拒否する。タグで限れない資源は残る。bootstrap を作る承認の前に、[反映のパイプラインの仕様の「別の設置の資源をタグで限る」](../specifications/deploy-pipeline.md#別の設置の資源をタグで限る)を読む。人の `--stack pipeline` が使う既定の bootstrap は変えない。

自分で設置してパイプラインを併設している人は、この版へ上げる前に、自分のアカウントでこの手順を行う。新しく併設する人も同じである。

### bootstrap を作る・版を上げる

アプリ専用の bootstrap を作る前と更新する前（CDK の版を上げる場合を含む）に、毎回行う。承認を受けてから打つ（権限を持つロールを作る操作である）。

1. qualifier が別の設置と衝突しないことを確かめる。成功しなければ先の設置の bootstrap を変えずに人へ戻す。まだ設置していなければ、`prefix` か `environment` を変えて避けられる

   ```bash
   npm run app-bootstrap -- check --profile <profile> --settings <設定のファイル>
   ```

2. 制約を当てたテンプレートを、リポジトリの外へ書き出す。下の `app-bootstrap template` はテンプレートを書き出し、実行する `cdk bootstrap` コマンドを表示するだけで、bootstrap は実行しない。表示された `cdk bootstrap` コマンドは、手順 3 で承認を受けてから実行する

   テンプレートはアカウントの値を持つので、このリポジトリのメインの作業ディレクトリと登録済みの worktree の中には書き出せない。既にあるファイルも上書きしないので、書き出すたびに新しいファイル名を指定する

   ```bash
   npm run app-bootstrap -- template --profile <profile> --settings <設定のファイル> --out <リポジトリの外のファイル> [--direct-role <ARN>]...
   ```

   `--direct-role` は、反映のロールを直接引き受けてよい人のロールである。自分で設置する人が商用利用の開始前に使うときだけ渡し、運用する環境では渡さない

3. 表示された `cdk bootstrap` のコマンドと、テンプレートの実行の方針と境界の中身を見て承認を受け、打つ。後日に打つときは 1 を打ち直す

設置のコマンドは、アプリ専用の qualifier の成果物が求める版も、既定の bootstrap の版と比べる。2 つの bootstrap の両方を、求める版以上にする。アプリに新しい権限が要る変更は、この境界の更新を先に行う。

実行の方針か権限の境界を変える版では、bootstrap の更新と、パイプラインのスタックの反映（`--stack pipeline`）の両方を行う。反映の直前の検査は、パイプラインのスタックが持つ要約値と、AWS にある本文を比べる。片方だけを更新した間は、反映が失敗する。

### 既にある環境の切り替えの順序

最初に、アプリのスタックのロールの物理名を確かめる。すべてが `<prefix>-<environment>-app-` で始まらなければ、切り替えを始めず人へ戻す。

```bash
aws cloudformation list-stack-resources --profile <profile> --stack-name <prefix>-<environment>-app \
  --query "StackResourceSummaries[?ResourceType=='AWS::IAM::Role'].[LogicalResourceId,PhysicalResourceId]"
```

確認が通ったら、反映の段への遷移を止め、次の順に進める。

- 0: 実装の Pull Request は 1 つのままにする。手順 2 で合成・反映するコミットは、リリース承認ゲートで承認した Pull Request のブランチの先端で、起点のブランチの先端を取り込んでおく。2 つの SHA を記録する
- 1: 上の手順でアプリ専用の bootstrap を作る
- 2: `get-pipeline-state` で反映の段の実行が無くなり、アプリのスタックが `*_IN_PROGRESS` でなくなるまで待つ。最後の反映の実行が成功し、アプリのスタックが `UPDATE_COMPLETE` か `CREATE_COMPLETE` であることを確かめる。ロールの物理名の一覧を採り直して判定し直す（切り替え後の比較元にする）。どれかを確かめられなければ、権限を替えず遷移を止めたまま人へ戻す。満たしたら、0 のコミットを取り出し、設置のコマンドでパイプラインのスタックを反映する（反映と準備のロールの引き受け先がアプリ専用の qualifier に替わる）
- 3: 切り替えの前に準備した実行を止める。マージの直前に、起点のブランチの先端と Pull Request の先端が 0 の SHA のままであることを確かめる（`gh pr merge --match-head-commit <SHA>`）。進んでいればマージせず、取り込んで承認を受け直し、0 と 2 をやり直す。マージの後に `git diff <承認されたコミット> <マージのコミット>` が空であることを確かめる（空でなければ遷移を戻さず持ち主に判断を求める）。そのコミットの実行を特定し、SHA と実行の ID を組で記録して、準備が成功し反映の段の入口で待つことを確かめる
- 4: 反映のロール・実行のロール・反映のプロジェクトのロールの権限と信頼ポリシー、権限の境界、公開のロールの信頼ポリシー、アセットのバケットのポリシーを確かめる。同じアカウントとリージョンに別の設置があれば、その設置のアプリのスタックへの書き込みと、その反映のロールの引き受けが拒否になることも確かめる。あわせて、下の「別の設置の資源への拒否の確認」を行う。運用する環境では下の「直接の反映の拒否」も確かめる。決めた条件（「遷移を戻すとき」）を満たしたら遷移を戻す
  - 最初の反映の後に、実行が成功してアプリのスタックが `UPDATE_COMPLETE`、ロールの物理名が 2 の一覧から変わっていない、すべてのロールの `aws iam get-role` の境界が `<prefix>-<environment>-app-boundary` であることを確かめて記録する。1 つでも違えば遷移を止めて人へ戻す。境界を外す操作は拒否されるので、巻き戻しが失敗することがある

初めての設置では、パイプラインのスタックより先にこの bootstrap を作ってよい。

### 別の設置の資源への拒否の確認

指定した資源の ARN とタグを与えたときに、アプリ専用の実行のロールの権限が操作を許可しないことを、`aws iam simulate-principal-policy` で確かめる。対象の操作は `cognito-idp:DeleteUserPool`・`cloudfront:DeleteDistribution`・`ec2:DeleteVpc`・`apigateway:DELETE` である。別の設置の資源の ARN と、その `aws:ResourceTag/app-prefix`・`aws:ResourceTag/app-env` の値を入力し、結果が許可（`allowed`）でないことを見る。

同じアカウントに別の設置がある場合は、その資源の ARN とタグを渡す。ない場合は、操作ごとに別の設置を表す架空の ARN とタグを入力し、シミュレーション結果を記録する。架空の ARN でも、`<account>` と `<region>` にはこの設置のアカウント ID とリージョンを入れる。変えるのは資源の ID の部分だけである。

| 操作（`--action-names`） | 架空の ARN の例（`--resource-arns`） |
| --- | --- |
| `cognito-idp:DeleteUserPool` | `arn:aws:cognito-idp:<region>:<account>:userpool/<region>_EXAMPLE` |
| `cloudfront:DeleteDistribution` | `arn:aws:cloudfront::<account>:distribution/EXAMPLE` |
| `ec2:DeleteVpc` | `arn:aws:ec2:<region>:<account>:vpc/vpc-EXAMPLE` |
| `apigateway:DELETE` | `arn:aws:apigateway:<region>::/apis/EXAMPLE` |

架空のタグは、`app-prefix` を `acme-other`、`app-env` を `test` にする。この設置の `prefix` が `acme-other` の場合は、別の値にする。コマンドは次の形で、4 つの操作を 1 つずつ打つ。別の設置がある場合は、`--resource-arns` とタグの値をその設置のものに替える。`<実行のロールの ARN>` は、アプリ専用の bootstrap が作った実行のロール（`cdk-<qualifier>-cfn-exec-role-<account>-<region>`）の ARN である。

```bash
aws iam simulate-principal-policy --profile <profile> --policy-source-arn <実行のロールの ARN> \
  --action-names <操作> --resource-arns <資源の ARN> \
  --context-entries \
    ContextKeyName=aws:ResourceTag/app-prefix,ContextKeyValues=acme-other,ContextKeyType=string \
    ContextKeyName=aws:ResourceTag/app-env,ContextKeyValues=test,ContextKeyType=string \
  --query "EvaluationResults[].[EvalActionName,EvalResourceName,EvalDecision]"
```

この確認が通っても、AWS の上で設置どうしが分離できていると確かめたことにはならない。シミュレーターは手で渡したタグで判定するだけである（[IAM ポリシーシミュレーター](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_testing-policies.html)）。次の 2 つは、この確認では分からないまま残るリスクである。

- 実際の操作で、対象のサービスがそのタグを IAM に渡し、拒否が効くか。AWS の上では確かめていない
- タグの無い資源への操作。この手順では調べない。一部の操作は許可される

遷移を戻す前に、この 2 つの残るリスクを、反映のパイプラインの仕様の[「別の設置の資源をタグで限る」](../specifications/deploy-pipeline.md#別の設置の資源をタグで限る)と[「未確認のまま残ること」](../specifications/deploy-pipeline.md#未確認のまま残ること)で読む。残るリスクは、持ち主がリリース承認ゲートで承認する。承認されていなければ、遷移を戻さない。

### 運用する環境の直接の反映の拒否

運用する環境では、商用利用の開始前から、反映のロールのほかの主体がアプリのスタックを書き換えることを AWS の側の権限で拒む。打つ人が設定のパラメーターを読めるかによらず効く。

- アプリ専用の反映のロールの信頼ポリシーは、反映のプロジェクトのロールだけを許す
- 反映のロール以外のすべての主体（既定の qualifier の反映のロールと、人と AI のユーザーとロールを含む）に、アプリのスタックの ARN への次の操作を拒否する: `cloudformation:CreateChangeSet`・`DeleteChangeSet`・`ExecuteChangeSet`・`CreateStack`・`UpdateStack`・`RollbackStack`・`ContinueUpdateRollback`・`DeleteStack`・`UpdateTerminationProtection`・`SetStackPolicy`・`CreateStackRefactor`・`ExecuteStackRefactor`
- 拒否の実現の仕方と対象を運用の記録にまとめ、持ち主の承認を受けてから打つ
- `cloudformation:RoleArn` の値が無い・既定の実行のロール・アプリ専用の実行のロールのどの場合も、設定のパラメーターを読めない主体を含めて拒否になることを確かめる。進行中の直接の反映が無い（アプリのスタックが `*_IN_PROGRESS` でなく、`list-stack-refactors` の実行中の再構成にアプリのスタックが無い）ことも確かめる。満たすまで遷移を戻さない

反映が失敗してアプリのスタックを人が直すときも、拒否を一時的に外すには持ち主の承認が要る。

## 接続を有効にする

パイプラインのスタックが作る GitHub との接続 `<prefix>-<environment>-github` は、作った直後は `PENDING` で使えないので、有効にする。手順は [idp-and-apps.md](idp-and-apps.md) の「GitHub との接続（反映のパイプライン）」にある。

## 順序のまとめ

1. 起点のブランチの存在と保護、保護を編集できる主体、先端に既に入っている変更、反映を再開・直に動かせる主体、設定のパラメーターを書ける主体を確かめる。満たさなければ先へ進まない（動いている環境なら遷移を止める）
2. アプリ専用の bootstrap を作る（`check` → `template` → `cdk bootstrap`）。承認の段を持っていた版からは、先に方針を外す
3. 設置のコマンドでパイプラインのスタックの差分を示し、リリース承認ゲートで承認した後にだけ反映する（`--stack pipeline`。[setup.md](setup.md#運用する環境)）。初回設置では、接続を許すリポジトリも差分と一緒に示す
4. 接続を有効にする。許すのは 3 で承認されたリポジトリだけにする
5. 1 の確認を満たした状態で、レビュー済みの Pull Request を起点のブランチへマージする。準備、反映の順に人を待たずに進む。運用する環境では、最初の push（このマージ）より前に[運用する環境の直接の反映の拒否](#運用する環境の直接の反映の拒否)も完了する。持ち主の承認を受けて拒否を設定し、反映のロールのほかは直接の反映ができないことと、実行中の直接の反映が無いことを確かめてからマージする
6. 反映の後に、`approval/diff.txt` と `approval/ndf-contract.md` を読む
