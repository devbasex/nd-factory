# 反映のパイプラインの承認

運用する環境のアプリのスタックは、反映のパイプラインだけで反映する。パイプラインは、人が差分を読んで承認した合成の結果だけを反映する。AI の主体は承認を送れないようにする。

パイプラインのスタックは、設定のファイルに `pipeline` があるときだけ合成に現れる。パイプラインが反映するのはアプリのスタック（`<prefix>-<environment>-app`）だけである。パイプラインのスタック（`<prefix>-<environment>-pipeline`）自身は、設置のコマンドで `--stack pipeline` を渡して反映する（[setup.md](setup.md)）。パイプラインが自分自身を反映すると、起点のブランチへの push だけで反映の役割の権限を変えられてしまうためである。

## 段

| 段 | アクション | すること |
| --- | --- | --- |
| 取る（`Source`） | GitHub との接続 | 起点のリポジトリ（`pipeline.repository`）の起点のブランチ（`pipeline.branch`）の先頭を取る。起点のブランチへの push で動く |
| 準備（`Prepare`） | CodeBuild `<prefix>-<environment>-prepare` | SSM のパラメーター `/<prefix>/<environment>/settings` から設定のファイルを書き出し、画面をビルドしてアプリのスタックだけを合成する。保存した合成の結果と今のスタックの差分（`cdk diff --method=template`。変更のセットは作らない）を記録と `approval/diff.txt` に残す。合成の結果の要約値を数え、コミット・要約値・スタックの一覧を変数として書き出す |
| 承認（`Approve`） | 手動の承認 | 承認の依頼を知らせの宛先へ送り、人の承認か却下を待つ |
| 反映（`Deploy`） | CodeBuild `<prefix>-<environment>-deploy` | 準備の出力の合成の結果だけを受け、要約値を数え直して準備の値と照らす。同じときだけ `cdk deploy --app cdk.out` で反映する |

- 準備の役割は読むだけで、引き受けられるのは CDK の bootstrap の lookup の役割だけである。反映の役割が引き受けられるのは bootstrap の deploy と file-publishing の役割だけである
- 実行の扱いは `SUPERSEDED` である。1 つの段に入れる実行は 1 つだけで、承認を待つ実行は `Approve` の段を占める。承認を待つ実行は新しい push では打ち切られない。承認されるか、却下されるか、7 日の期限が切れるまで段を占め続け、その間に push で始まった実行は準備を終えて `Approve` の段の手前で待つ。打ち切られる（`Superseded`）のは、段の手前で待つ実行のうち新しい実行より古いものだけである
- 承認を待つコミットが起点のブランチの先頭でないときは、そのコミットを承認せずに却下して、次の実行を承認の段へ進める（「[古いコミットを却下して次の実行へ進める](#古いコミットを却下して次の実行へ進める)」）。古いコミットを承認すると、古いコミットが反映された後に新しいコミットの差分を読むことになり、読む差分が増えるうえ、その差分の基準も古くなる（「[差分の基準が変わったとき](#差分の基準が変わったとき)」）
- パイプラインを作った直後に 1 回目の実行が自動で始まるが、接続がまだ `PENDING` のため取る段で失敗する。反映はされない

## 承認する人が読むもの

承認の依頼は、`pipeline.notify_emails` の宛先へ SNS のメールで届く（初めは購読の確かめのメールが届くため、リンクを開いて購読を有効にする）。承認の画面は CodePipeline のコンソールの `<prefix>-<environment>-pipeline` の `Approve` の段にある。

| 資料 | 中身 | 読むこと |
| --- | --- | --- |
| `CustomData`（承認の画面の注記） | 準備が書き出したコミット・合成の結果の要約値の先頭 12 桁・スタックの名前 | コミットが、反映するつもりの起点のブランチの先頭か |
| `ExternalEntityLink`（承認の画面のリンク） | 準備の実行の記録（CodeBuild のビルドの頁）。差分の全文がある | 差分の全文 |
| `CustomData` のコミットの NDF の契約の照合 | そのコミットで動いた `.github/workflows/ndf-contract.yml` の実行（起点のブランチへの push か、起点のブランチを選んだ手動の起動）のジョブ `ndf-contract` の結論と記録 | 下の「[NDF の契約の照合を確かめる](#ndf-の契約の照合を確かめる)」の判定で承認してよいか（[実行の文書の決定 79](../design/execution.md#決定の記録)） |
| 実行の一覧とアプリのスタックの最後の更新 | 先に始まった実行が動いているか、準備の後にアプリのスタックが変わったか | 下の「[差分の基準が変わったとき](#差分の基準が変わったとき)」の 2 つの条件を満たすか |

差分を読むときは次を確かめる。

- 足し・変え・消しが、反映するつもりの変更だけである
- アプリのスタック以外のスタック（旧い側の資源やほかのサービスのスタック）が出ていない
- 秘密の値が出ていない（Google の secret は秘密の器への動的な参照としてだけ現れる）
- 秘密の器の資源が変わるときは、器へ入れた値が残っているとは限らない。反映の後に [idp-and-apps.md](idp-and-apps.md) の「器の値を確かめる」を打ち直す

納得できなければ却下する。却下すると実行は止まり（失敗の知らせが届く）、何も反映されない。

### NDF の契約の照合を確かめる

パイプラインは CI の結果を読まないので、承認する人が、承認するコミットで NDF の契約の照合（固定の点の照らし 1〜6。[実行の文書の契約の照合の定期の検査](../design/execution.md)）が実行されて通ったことを確かめる。名前が `ndf-contract` のチェックだけを見ると、別のワークフローが同じ名前のチェックを出しても、`skip: no-contract-use` で 1〜6 を飛ばして通っても、区別できない。そこで、ワークフローのファイルで実行を絞り、その実行の記録の行まで読む。

1. 承認するコミットにひも付く `ndf-contract.yml` の実行を探す。Pull Request の実行はマージした結果のコミットを照らすので数えない。手動の起動はそのときの枝の先端を照らすので、`head_sha` が承認するコミットと同じものだけを数える

   ```bash
   gh api "repos/<起点のリポジトリ>/actions/workflows/ndf-contract.yml/runs?head_sha=<コミット>" \
     --jq '.workflow_runs[]
       | select(.path == ".github/workflows/ndf-contract.yml"
           and (.event == "push" or .event == "workflow_dispatch")
           and .head_branch == "<起点のブランチ>")
       | [.id, .event, .run_attempt, .status, .conclusion] | @tsv'
   ```

   実行の `status` と `conclusion` は、その実行の最後の試み（打ち直した後なら打ち直しの結果）だけを表す。前の試みの失敗は返らない。名前でチェックを読む `gh api repos/<起点のリポジトリ>/commits/<コミット>/check-runs` も、`filter` の既定が `latest` で、同じ名前のチェックの最新の結論だけを返す。どちらも今の結論を読むためのもので、打ち直す前に失敗したことは記録として残らない
2. `completed` で `success` の実行について、ジョブ `ndf-contract` の ID を読み、記録から照合の行を取り出す

   ```bash
   gh api "repos/<起点のリポジトリ>/actions/runs/<実行の ID>/jobs" \
     --jq '.jobs[] | select(.name == "ndf-contract") | [.id, .conclusion] | @tsv'
   gh run view <実行の ID> --repo <起点のリポジトリ> --job <ジョブの ID> --log \
     | grep -E '(checked|skip|fail): (fixed|no-contract-use)'
   ```

3. そのコミットの固定の点を読む

   ```bash
   gh api "repos/<起点のリポジトリ>/contents/ndf-pin.json?ref=<コミット>" --jq .content | base64 -d
   ```

| 読んだ結果 | すること |
| --- | --- |
| `success` で、記録に `checked: fixed <固定の点> 1-6` があり、その固定の点が 3 で読んだ固定の点の値と同じ | 照合は通っている。ほかの資料を読んで承認するか決める |
| `success` で、記録に `skip: no-contract-use <固定の点>` があり `checked: fixed` が無い | 1〜6 は照らされておらず、契約のファイルを読めたことだけが確かめられている。NDF の契約の使い方の書き出しを形の正本に置く #2 の Pull Request が入る前（そのコミットの `tools/checks/src/ndf-contract-check.ts` の `CONTRACT_USE_REQUIRED` が偽）だけ、この結果で承認してよい。そのときは承認の注記に「`skip: no-contract-use`。照合 1〜6 は未実施」と書く。#2 が入った後は定数が真で `skip` は出ない（出ずに `fail: no-contract-use` で落ちる）。定数を真から偽へ戻したコミットは承認しない |
| `failure`・`cancelled`・`timed_out` | 承認しない。記録を読み、固定の点の取得の失敗（GitHub や ai-plugins の取得の一時的な失敗。打ち直しで通る）なら、同じ実行を打ち直す（`gh run rerun <実行の ID> --repo <起点のリポジトリ> --failed`。同じコミットを照らす）。固定の点の食い違い（`fail:` の行）なら、直したコミットを起点のブランチへ push する。この承認は却下する |
| `queued`・`in_progress` | 終わるまで待つ（`gh run watch <実行の ID> --repo <起点のリポジトリ> --exit-status`）。終わったら 1 から読み直す |
| 1 で実行が 1 つも無い（起点のブランチが main でなく push の実行が無い、push の実行が起きなかった） | 起点のブランチを選んで手動で起こす（`gh workflow run ndf-contract.yml --repo <起点のリポジトリ> --ref <起点のブランチ>`。main のときも同じ）。手動の起動はそのときの枝の先端を照らすので、承認するコミットが先端のままのときだけ使える。先端が進んでいたら、このコミットは「[古いコミットを却下して次の実行へ進める](#古いコミットを却下して次の実行へ進める)」で却下する |

打ち直しか手動の起動が成功したら、1 から読み直し、上の表の 1 行目（#2 の前なら 2 行目）を満たしてから承認する。

### 古いコミットを却下して次の実行へ進める

承認を待つ実行が `Approve` の段を占める間、後の push の実行は段の手前で待つ（「段」）。古いコミットを承認せずに、新しい実行へ進める。

1. 承認の画面の `CustomData` のコミットと、起点のブランチの先頭（`gh api repos/<起点のリポジトリ>/commits/<起点のブランチ> --jq .sha`）を比べる
2. 違えば承認せずに「却下」を選び、注記に「先頭 `<先頭のコミット>` の実行へ進めるため」と書く。却下した実行は失敗で止まり、失敗の知らせが届くが、何も反映されない
3. 段が空くと、手前で待っていた実行のうち最も新しいものが `Approve` の段へ入り、新しい承認の依頼が届く。その実行の資料を初めから読む
4. 待っていた実行が無いとき（先頭の実行が準備で失敗した、など）は、原因を直して push するか、`aws codepipeline start-pipeline-execution --profile <承認する人の profile> --name <prefix>-<environment>-pipeline` で起点のブランチの先頭から起こし直す

承認するのは人だけである。承認する人の主体と、設置のコマンドを打つ AI の主体を別にする。

## 承認の後

反映のアクションは、受けた合成の結果の要約値を同じ作り方で数え直し、準備が書き出した値（`#{Prepare.ASSEMBLY_DIGEST}`）と比べる。

| 照らした結果 | 振る舞い |
| --- | --- |
| 同じ | `cdk deploy --app cdk.out --require-approval never <prefix>-<environment>-app` で反映する。合成し直さない |
| 違う | 反映せずにアクションが失敗で止まる（`exit 1`） |

要約値の作り方は設置のコマンドと同じで、[setup.md](setup.md) の「確認の値」にシェルの式がある。

実行が失敗すると、失敗の知らせが同じ宛先へ届く。反映が失敗したときは CloudFormation の戻しで前の状態へ戻る。原因を直して起点のブランチへ push し直す。

### 差分の基準が変わったとき

準備の差分は、準備が動いた時点のアプリのスタックを基準にする。`Prepare` の段は、先の実行が `Approve` や `Deploy` にいる間も後の実行を受けるため、先の実行の反映が後の実行の準備より後に終わると、後の実行の差分の基準は古くなる。たとえば、先の実行が資源を足す前に、その資源を取り消した後のコミットが差分を取ると、後の承認の資料にはその資源の消しが出ない。反映のアクションが照らす要約値は合成の結果だけを表すので、基準が変わったことは照らせない。

そこで、承認する人は承認の直前に次の 2 つを確かめる。どちらかを満たさなければ承認しない。

1. この実行より先に始まった実行で、`InProgress` のものが無い（先の実行が `Deploy` にいるか、`Deploy` の手前で待っていない）

   ```bash
   aws codepipeline list-pipeline-executions --profile <承認する人の profile> \
     --pipeline-name acme-test-pipeline \
     --query "pipelineExecutionSummaries[?status=='InProgress'].[pipelineExecutionId,startTime]"
   ```

2. アプリのスタックが `_COMPLETE` で終わっていて、最後に変わった時刻（`LastUpdatedTime`。1 度も更新していなければ `CreationTime`）が、この実行の準備のビルド（`ExternalEntityLink` のビルド）の始まりより前である。スタックがまだ無い（初めての反映）ときは満たす

   ```bash
   aws cloudformation describe-stacks --profile <承認する人の profile> \
     --stack-name acme-test-app \
     --query 'Stacks[0].[StackStatus,LastUpdatedTime,CreationTime]'
   aws codebuild batch-get-builds --profile <承認する人の profile> \
     --ids <準備のビルドの ID> --query 'builds[0].startTime'
   ```

満たさないときは、先の実行が終わるのを待ち、この実行を却下して、`aws codepipeline start-pipeline-execution` で起点のブランチの先頭から起こし直す。新しい実行の準備が、変わった後のスタックを基準に差分を作り直すので、その差分を読み直して承認する。承認の後は、この実行が `Approve` から `Deploy` へ進むまでの間に別の実行が反映することは無い（先に始まった実行が残っていないことを 1 で確かめ、後の実行は `Approve` の手前で待つ）。

## 承認を拒む方針を AI の主体へ付ける

パイプラインのスタックは、承認の結果を送る操作（`codepipeline:PutApprovalResult`）を拒む管理の方針 `<prefix>-<environment>-deny-approval` を作る。スタックは方針を作るだけで、どの主体にも付けない。付けるのは、パイプラインのスタックを初めて反映した後、GitHub との接続を有効にする前である。接続が `PENDING` の間は、誰が起点のブランチへ push しても実行は取る段で失敗するので、承認の段へ進む実行は起きない。接続を有効にした時点から、起点のブランチへの push は誰のもの（チームの通常のマージを含む）でもパイプラインを動かすため、拒否を確かめる前に有効にすると、AI の主体が承認を送れる状態で承認の段へ進む実行が起こりうる。

1. 次の 2 つを、同じ重さで確かめる。どちらかを満たさなければ、方針を付けても拒否は迂回できるので、先に主体の権限を直す
   - AI が使う profile の主体と、承認する人の主体が別である。同じ主体なら、AI のための別の主体を先に作る
   - AI の主体が、拒否を外す操作・拒否の外の主体へ移る操作・パイプラインの定義を直す操作を持たない。具体的には、方針を外す（`iam:DetachUserPolicy`・`iam:DetachRolePolicy`）、方針の中身を替える（`iam:CreatePolicyVersion`・`iam:SetDefaultPolicyVersion`）、別の主体を作るか承認する人の主体へ移る（`iam:CreateUser`・`iam:CreateRole`・`iam:CreateAccessKey`・`iam:UpdateAssumeRolePolicy`、承認する人のロールへの `sts:AssumeRole`）、パイプラインを直す（`codepipeline:UpdatePipeline`・`codepipeline:DeletePipeline`・`codepipeline:CreatePipeline`）。IAM Identity Center の許可セットから入る主体なら、許可セットを変える操作（`sso:DetachCustomerManagedPolicyReferenceFromPermissionSet`・`sso:ProvisionPermissionSet`・`sso:CreateAccountAssignment`）も、Identity Center を管理するアカウントで持たない。持たせる必要があるなら、権限の境界（permissions boundary）か SCP でこれらを拒む。確かめ方は 3 にある
2. AI の主体へ方針を付ける。方針の ARN は `arn:aws:iam::<アカウント>:policy/<prefix>-<environment>-deny-approval` である

   ```bash
   # IAM ユーザーのとき
   aws iam attach-user-policy --profile <管理者の profile> \
     --user-name <AI のユーザー> \
     --policy-arn arn:aws:iam::123456789012:policy/acme-test-deny-approval

   # IAM ロールのとき
   aws iam attach-role-policy --profile <管理者の profile> \
     --role-name <AI のロール> \
     --policy-arn arn:aws:iam::123456789012:policy/acme-test-deny-approval
   ```

   IAM Identity Center の許可セットから入る主体なら、ロールへ直に付けず、許可セットの「カスタマー管理ポリシー」に `acme-test-deny-approval` を足す
3. 拒まれることを確かめる。`--policy-source-arn` には AI の主体の IAM ユーザーかロールの ARN を渡す（`aws sts get-caller-identity` が返す `assumed-role` の ARN ではなく、元のロールの ARN）

   ```bash
   aws iam simulate-principal-policy --profile <管理者の profile> \
     --policy-source-arn arn:aws:iam::123456789012:role/<AI のロール> \
     --action-names codepipeline:PutApprovalResult \
     --resource-arns arn:aws:codepipeline:us-west-2:123456789012:acme-test-pipeline/Approve/Approve \
     --query 'EvaluationResults[].EvalDecision'
   ```

   AI の主体で `explicitDeny` が返れば合格である。承認する人の主体で同じ式を打ち、`allowed` が返ることも確かめる

   続けて、1 の 2 つ目の操作を AI の主体で評価する。すべてが `implicitDeny` か `explicitDeny` なら合格で、1 つでも `allowed` があれば不合格である

   ```bash
   aws iam simulate-principal-policy --profile <管理者の profile> \
     --policy-source-arn arn:aws:iam::123456789012:role/<AI のロール> \
     --action-names iam:DetachUserPolicy iam:DetachRolePolicy \
       iam:CreatePolicyVersion iam:SetDefaultPolicyVersion \
       iam:CreateUser iam:CreateRole iam:CreateAccessKey iam:UpdateAssumeRolePolicy \
       sts:AssumeRole \
       codepipeline:UpdatePipeline codepipeline:DeletePipeline codepipeline:CreatePipeline \
     --resource-arns \
       arn:aws:iam::123456789012:policy/acme-test-deny-approval \
       arn:aws:iam::123456789012:role/<AI のロール> \
       arn:aws:iam::123456789012:role/<承認する人のロール> \
       arn:aws:codepipeline:us-west-2:123456789012:acme-test-pipeline \
     --query 'EvaluationResults[].[EvalActionName,EvalResourceName,EvalDecision]' --output table
   ```

   許可セットから入る主体なら、Identity Center を管理するアカウントで、AI の主体が引き受けられるロールについて `sso:` の 3 つの操作を同じように評価する。なお、設置のコマンドがパイプラインのスタックを反映する経路（CDK の bootstrap の deploy の役割と CloudFormation）は、パイプラインの定義も IAM も変えられる。この経路は方針では止めず、パイプラインのスタックの差分をリリース承認ゲートで人が承認してから反映することで止める（「順序のまとめ」の 1）
4. 運用する環境では、3 の結果（承認を拒む評価の 2 つと、迂回の操作の評価）を運用する環境の作業の課題のコメントに残す

3 で合格するまで、GitHub との接続を有効にしない。

## 接続を有効にする

パイプラインのスタックが作る GitHub との接続 `<prefix>-<environment>-github` は、作った直後は `PENDING` で使えないので、有効にする。有効にするのは、承認を拒む方針を AI の主体へ付け、上の 3 で合格した後だけである（`PENDING` の間は、push があっても取る段で失敗し、承認の段へ進まない）。手順は [idp-and-apps.md](idp-and-apps.md) の「GitHub との接続（反映のパイプライン）」にある。

## 順序のまとめ

1. 設置のコマンドでパイプラインのスタックの差分を示し、リリース承認ゲートで承認した後にだけ反映する（`--stack pipeline`。自動の承認では通さない。[setup.md](setup.md#運用する環境)）。初回設置では、手順 2 で承認を拒む方針を付ける主体と、手順 3 で接続を許すリポジトリも、パイプラインのスタックの差分と一緒にリリース承認ゲートで示す。スタックの差分だけの承認では、反映の後に選ぶ方針の付け先とリポジトリは承認されていない。反映の直後の 1 回目の実行は、接続が `PENDING` のため取る段で失敗する
2. 承認を拒む方針を、1 で承認された AI の主体へ付け、拒まれることと迂回の操作を持たないことを確かめる（「[承認を拒む方針を AI の主体へ付ける](#承認を拒む方針を-ai-の主体へ付ける)」の 1〜4）。承認されていない主体へは付けない。この間、接続は `PENDING` のままなので、誰が起点のブランチへ push しても承認の段へ進む実行は起きない
3. 2 で合格した後に、接続を有効にする。接続を許すのは、1 で承認されたリポジトリだけにする。この時点から、起点のブランチへの push は誰のものでもパイプラインを動かす
4. 起点のブランチへ push する（3 の後に入った push が先に動いていれば、その実行を読む）。準備・承認・反映の順に進み、人が差分を読んで承認する
