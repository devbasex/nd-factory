# IdP のクライアントと App の作り方

ログインと GitHub との連携に使うクライアントと App は、それぞれの環境ごとに新しく作る。ほかの環境やほかのサービスのクライアントを使い回さない。クライアントの secret と App の秘密鍵は秘密の器（Secrets Manager）にだけ入れ、リポジトリ・設定のファイル・課題に書かない。

| 作るもの | 何に使うか | いつ要るか |
| --- | --- | --- |
| Google の OAuth クライアント | 縦の切れ端のログイン（利用者プールの外部の IdP） | 縦の切れ端を初めて反映した後 |
| GitHub の OAuth App | GitHub でのログイン | GitHub のログインを足す変更が入ったとき |
| GitHub App | リポジトリの読み書き | GitHub の連携を足す変更が入ったとき |
| GitHub との接続（AWS CodeConnections） | 反映のパイプラインがリポジトリを取る | 反映のパイプラインのスタックを設置した後 |

## Google の OAuth クライアント

秘密の器は縦の切れ端のスタックが作る。器ができる前にクライアントの ID を設定のファイルへ書かない。値の無い器でクライアントの ID を設定すると、ログインは Google の側で失敗する。

### 順序

1. 設定のファイルに `"login": { "google": {} }` を置き（`client_id` は書かない）、縦の切れ端を反映する。器 `<prefix>/<environment>/google-oauth` が自動で作った値で作られ、画面は「設定の待ち」を示す
2. 設置のコマンドの `diff` が出した「Google のクライアントに登録する戻り先の URL」を控える。形は `https://<prefix>-<environment>-login.auth.<リージョン>.amazoncognito.com/oauth2/idpresponse` である
3. Google Cloud のコンソールの「API とサービス > 認証情報」で、種類「ウェブ アプリケーション」の OAuth クライアントを作る
   - 承認済みの JavaScript 生成元: `https://<prefix>-<environment>-login.auth.<リージョン>.amazoncognito.com`
   - 承認済みのリダイレクト URI: 2 で控えた URL
   - OAuth 同意画面のスコープは `openid`・`email`・`profile`
4. 表示された client secret を、器へ入れる。secret は作った時の 1 回だけ表示されるため、画面を閉じる前に入れる

   ```bash
   aws secretsmanager put-secret-value --profile <profile> \
     --secret-id <prefix>/<environment>/google-oauth \
     --secret-string '<client secret>'
   ```

   シェルの履歴に残したくなければ、`--secret-string file://<一時のファイル>` で渡し、渡した後にファイルを消す
5. 下の「器の値を確かめる」を通す
6. 確かめが通ったときだけ、設定のファイルへ `"login": { "google": { "client_id": "<クライアントの ID>" } }` を書き、縦の切れ端を反映し直す。Google の IdP が作られ、画面はログインへ送るようになる

### 器の値を確かめる

クライアントの ID を書く前に、器に人の値が入っていることを確かめる。スタックも器の版を作る（器の生成の設定を変えると新しい版、器の名前を変えると作り直し）ため、`AWSPREVIOUS` の段があるかだけでは人の上書きと見分けられない。次の 2 つを両方確かめる。

```bash
# (a) 器の版の段と作られた日時
aws secretsmanager list-secret-version-ids --profile <profile> \
  --secret-id <prefix>/<environment>/google-oauth \
  --query 'Versions[].{stages:VersionStages,created:CreatedDate}'

# (b) スタックが器を最後に作った・更新した時刻
aws cloudformation describe-stack-events --profile <profile> \
  --stack-name <prefix>-<environment>-app \
  --query "StackEvents[?ResourceType=='AWS::SecretsManager::Secret' && (ResourceStatus=='CREATE_COMPLETE' || ResourceStatus=='UPDATE_COMPLETE')] | [0].Timestamp"
```

| 確かめること | 合格 |
| --- | --- |
| (a) に `AWSPREVIOUS` の段の版がある | ある |
| (a) の `AWSCURRENT` の段の版の作られた日時が、(b) の時刻より後 | 後 |

どちらかが欠ければクライアントの ID を書かず、設置のコマンドも打たない。値を入れ直してから確かめ直す。どちらの出力にも秘密の値は含まれない。

| 使い方 | 確かめの記録 |
| --- | --- |
| 運用する環境 | (a) と (b) の出力と、値を入れた人の記録を、運用する環境の作業の課題のコメントに残す。クライアントの ID を書く人は、その記録があることも確かめる |
| 自分で設置する人 | (a) と (b) を確かめ、結果を自分の手元に残す。リポジトリと課題には書かない |

値を入れた後の反映で、器の資源が更新されたとき（差分に器の変更が出たとき）は、人の値が残っているとは限らない。値を入れ直してから (a) と (b) を確かめ直す。

## GitHub の OAuth App

1. GitHub の組織の設定の「Developer settings > OAuth Apps」で新しい App を作る。作るのは組織の持ち主である
2. Homepage URL は画面の配信の URL、Authorization callback URL は GitHub のログインを足す変更の文書が示す URL にする
3. client secret を作り、その変更の文書が示す秘密の器へ入れる。secret を設定のファイルとリポジトリに書かない

## GitHub App

1. GitHub の組織の設定の「Developer settings > GitHub Apps」で新しい App を作る。権限は、それを使う変更の文書が示す最小のものだけにする
2. 秘密鍵を作り、その変更の文書が示す秘密の器へ入れる。手元に落とした鍵のファイルは入れた後に消す
3. App を組織へ入れ、対象のリポジトリだけを選ぶ

## GitHub との接続（反映のパイプライン）

パイプラインのスタックは GitHub との接続を作るが、作った直後の接続は `PENDING` で使えない。

1. 組織の持ち主が、AWS のコンソールの「CodePipeline > 設定 > 接続」で接続 `<prefix>-<environment>-github` を開き、「保留中の接続を更新」から AWS の接続の App を組織へ入れ、対象のリポジトリを選ぶ
2. 接続の状態が `AVAILABLE` になったことを確かめる
3. 承認を拒む方針を AI が使う主体へ付けるまで（[pipeline-approval.md](pipeline-approval.md)）、起点のブランチへ push しない
