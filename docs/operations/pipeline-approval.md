# 反映のパイプラインの承認

運用する環境の縦の切れ端は、反映のパイプラインだけで反映する。パイプラインは、人が差分を読んで承認した合成の結果だけを反映する。AI の主体は承認を送れないようにする。

パイプラインのスタックは、設定のファイルに `pipeline` があるときだけ合成に現れる。パイプラインが反映するのは縦の切れ端のスタック（`<prefix>-<environment>-app`）だけである。パイプラインのスタック（`<prefix>-<environment>-pipeline`）自身は、設置のコマンドで `--stack pipeline` を渡して反映する（[setup.md](setup.md)）。パイプラインが自分自身を反映すると、起点のブランチへの push だけで反映の役割の権限を変えられてしまうためである。

## 段

| 段 | アクション | すること |
| --- | --- | --- |
| 取る（`Source`） | GitHub との接続 | 起点のリポジトリ（`pipeline.repository`）の起点のブランチ（`pipeline.branch`）の先頭を取る。起点のブランチへの push で動く |
| 準備（`Prepare`） | CodeBuild `<prefix>-<environment>-prepare` | SSM のパラメーター `/<prefix>/<environment>/settings` から設定のファイルを書き出し、画面をビルドして縦の切れ端だけを合成する。保存した合成の結果と今のスタックの差分（`cdk diff --method=template`。変更のセットは作らない）を記録と `approval/diff.txt` に残す。合成の結果の要約値を数え、コミット・要約値・スタックの一覧を変数として書き出す |
| 承認（`Approve`） | 手動の承認 | 承認の依頼を知らせの宛先へ送り、人の承認か却下を待つ |
| 反映（`Deploy`） | CodeBuild `<prefix>-<environment>-deploy` | 準備の出力の合成の結果だけを受け、要約値を数え直して準備の値と照らす。同じときだけ `cdk deploy --app cdk.out` で反映する |

- 準備の役割は読むだけで、引き受けられるのは CDK の bootstrap の lookup の役割だけである。反映の役割が引き受けられるのは bootstrap の deploy と file-publishing の役割だけである
- 実行の扱いは `SUPERSEDED` である。push が続くと、後の実行が承認の段へ来た時点で前の実行は打ち切られる。打ち切られた実行の承認は送れないため、承認する人は新しい実行の差分を読む
- パイプラインを作った直後に 1 回目の実行が自動で始まるが、接続がまだ `PENDING` のため取る段で失敗する。反映はされない

## 承認する人が読むもの

承認の依頼は、`pipeline.notify_emails` の宛先へ SNS のメールで届く（初めは購読の確かめのメールが届くため、リンクを開いて購読を有効にする）。承認の画面は CodePipeline のコンソールの `<prefix>-<environment>-pipeline` の `Approve` の段にある。

| 資料 | 中身 | 読むこと |
| --- | --- | --- |
| `CustomData`（承認の画面の注記） | 準備が書き出したコミット・合成の結果の要約値の先頭 12 桁・スタックの名前 | コミットが、反映するつもりの起点のブランチの先頭か |
| `ExternalEntityLink`（承認の画面のリンク） | 準備の実行の記録（CodeBuild のビルドの頁）。差分の全文がある | 差分の全文 |

差分を読むときは次を確かめる。

- 足し・変え・消しが、反映するつもりの変更だけである
- 縦の切れ端のスタックのほかのスタック（旧い側の資源やほかのサービスのスタック）が出ていない
- 秘密の値が出ていない（Google の secret は秘密の器への動的な参照としてだけ現れる）
- 秘密の器の資源が変わるときは、人が器へ入れた値が残っているとは限らない。反映の後に [idp-and-apps.md](idp-and-apps.md) の「器の値を確かめる」を打ち直す

納得できなければ却下する。却下すると実行は止まり、何も反映されない。

承認するのは人だけである。承認する人の主体と、設置のコマンドを打つ AI の主体を別にする。

## 承認の後

反映のアクションは、受けた合成の結果の要約値を同じ作り方で数え直し、準備が書き出した値（`#{Prepare.ASSEMBLY_DIGEST}`）と比べる。

| 照らした結果 | 振る舞い |
| --- | --- |
| 同じ | `cdk deploy --app cdk.out --require-approval never <prefix>-<environment>-app` で反映する。合成し直さない |
| 違う | 反映せずにアクションが失敗で止まる（`exit 1`） |

要約値の作り方は設置のコマンドと同じで、[setup.md](setup.md) の「確認の値」にシェルの式がある。

実行が失敗すると、失敗の知らせが同じ宛先へ届く。反映が失敗したときは CloudFormation の戻しで前の状態へ戻る。原因を直して起点のブランチへ push し直す。

## 承認を拒む方針を AI の主体へ付ける

パイプラインのスタックは、承認の結果を送る操作（`codepipeline:PutApprovalResult`）を拒む管理の方針 `<prefix>-<environment>-deny-approval` を作る。スタックは方針を作るだけで、どの主体にも付けない。付けるのは人で、パイプラインのスタックを初めて反映した後、縦の切れ端を初めて反映する前に行う。

1. AI が使う profile の主体と、承認する人の主体が別であることを確かめる。同じ主体なら、AI のための別の主体を先に作る
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
4. 運用する環境では、3 の 2 つの結果を運用する環境の作業の課題のコメントに残す

3 で合格するまで、起点のブランチへ push しない。push するとパイプラインが動き、AI の主体が承認を送れる状態で承認の段へ進んでしまう。

## 接続を有効にする

パイプラインのスタックが作る GitHub との接続 `<prefix>-<environment>-github` は、作った直後は `PENDING` で使えない。組織の持ち主がコンソールで有効にする。手順は [idp-and-apps.md](idp-and-apps.md) の「GitHub との接続（反映のパイプライン）」にある。

## 順序のまとめ

1. 設置のコマンドでパイプラインのスタックの差分を見て、人が承認した後に反映する（`--stack pipeline`）
2. 人が接続を有効にする
3. 人が承認を拒む方針を AI の主体へ付け、拒まれることを確かめる
4. 起点のブランチへ push する。準備・承認・反映の順に進み、人が差分を読んで承認する
