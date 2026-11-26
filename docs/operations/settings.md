# 設定のファイル

環境ごとに違う値は、リポジトリの外に置く JSON のファイル（設定のファイル）から受ける。AWS のアカウントとリージョンは設定のファイルに書かず、設置のコマンドへ渡す profile から受ける。秘密の値は設定のファイルにも書かず、秘密の器（Secrets Manager）に入れる。

形の正本は `packages/contracts/src/settings.ts` の zod の定義である。JSON Schema（`packages/contracts/schema/settings.schema.json`）と作り物の値の見本（`infra/settings.example.json`）はそこから `npm run generate` で作る。

## キー

| キー | 必須 | 意味 | 読む構成要素 |
| --- | --- | --- | --- |
| `prefix` | 必須 | 資源の接頭辞。小文字の英数字とハイフンで 3〜20 文字。`aws` で始めない | すべてのスタック（名前と利用者プールのドメイン） |
| `environment` | 必須 | 環境の名前。小文字の英数字で 2〜10 文字 | すべてのスタック（名前とタグ） |
| `login.google` | 必須 | Google でログインを受ける。`client_id` が無い間は IdP を作らず、画面は「設定の待ち」を示す | アプリのスタック |
| `login.google.client_id` | 任意 | Google の Web アプリのクライアントの ID。secret は秘密の器 `<prefix>/<environment>/google-oauth` に入れる。値を入れて確かめた後にだけ書く（[idp-and-apps.md](idp-and-apps.md)） | アプリのスタック |
| `pipeline` | 任意 | あるときだけ反映のパイプラインのスタックを作る | 反映のパイプラインのスタック |
| `pipeline.repository` | `pipeline` があれば必須 | 起点のリポジトリ（`<組織>/<名前>`） | 同上 |
| `pipeline.branch` | `pipeline` があれば必須 | 起点のブランチ。英数字と `.` `_` `-` `/` だけを使う | 同上 |
| `pipeline.notify_emails` | 任意 | 実行の失敗の通知の宛先 | 同上 |
| `network.vpc_cidr` | 任意 | VPC の IPv4 の CIDR。接頭辞の長さは 16〜20 で、ホストの部分を 0 にする。無ければ `10.80.0.0/16` | アプリのスタック（ネットワーク） |
| `progress_db.max_acu` | 任意 | 進行表の DB（Aurora Serverless v2）の最大 ACU。1〜16 の 0.5 刻み。無ければ `2` | アプリのスタック（進行表の DB） |
| `budget.monthly_usd` | 任意 | 月の予算の額（ドル）。1〜100,000 の整数。無ければ `30` | アプリのスタック（費用の見張り） |
| `budget.scope` | 任意 | 予算が数える範囲。`tags` は資源のタグ `app-prefix` と `app-env` で絞り、`account` はアカウント全体を数える。無ければ `tags`。`tags` は 2 つのタグがアカウントのコスト配分タグとして有効なことが前提で、有効でない間は予算が費用を 0 と数え、知らせが来ない。有効にするのは組織に入っていないアカウントか組織の管理のアカウントで、請求の画面の「コスト配分タグ」で `app-prefix`・`app-env` を有効にする（タグの付いた資源ができた後でないと一覧に出ない） | アプリのスタック（費用の見張り）・設置のコマンド（足りない設定の一覧） |
| `ops.notify_emails` | 任意 | 運用の知らせ（予算の超えなど）の宛先。0〜10 件。無ければ空で、メールの購読を作らない | アプリのスタック（費用の見張り） |

未知のキーは誤りになる。読み手の無いキーを先に足さない。キーを足すときは、それを読む構成要素と同じ変更で足す。

資源の名前は `<prefix>-<environment>-<用途>`、秘密の器の名前は `<prefix>/<environment>/<用途>` になる。すべての資源にタグ `app-prefix`（値は接頭辞）と `app-env`（値は環境の名前）が付き、費用をこのタグで分けて読める。

## 見本

```json
{
  "prefix": "acme",
  "environment": "test",
  "login": { "google": {} },
  "pipeline": {
    "repository": "example-org/example-app",
    "branch": "main",
    "notify_emails": ["ops@example.com"]
  },
  "network": { "vpc_cidr": "10.80.0.0/16" },
  "progress_db": { "max_acu": 2 },
  "budget": { "monthly_usd": 30, "scope": "tags" },
  "ops": { "notify_emails": ["ops@example.com"] }
}
```

## 置き場

| 使い方 | 置き場 |
| --- | --- |
| 自分で設置する人 | 自分の手元の、どのリポジトリにも入らない場所（例 `~/.config/nd-factory/<environment>.json`） |
| 反映のパイプラインを使う運用する環境 | 正本は運用する環境のアカウントの SSM のパラメーター `/<prefix>/<environment>/settings`。パイプラインのスタックが、設置のコマンドへ渡した設定のファイルの全文をここへ書き、準備のアクションがここから読む。運用する人の手元のコピーは `~/.config/nd-factory/<environment>.json` に置く |

設定のファイルの実物をこのリポジトリにコミットしない（`.gitignore` が `infra/settings.json` などを外す）。試験と CI は作り物の値の `infra/test/fixtures/settings.json` だけを使う。

## 運用する環境で設定を変える

1. 手元のコピーを直す
2. 設置のコマンドでパイプラインのスタックの差分を見る: `npm run nd-setup -- diff --profile <profile> --settings ~/.config/nd-factory/<environment>.json --out <置き場> --stack pipeline`。差分に SSM のパラメーターの値の変化が出る
3. 差分をリリース承認ゲートで承認する（自動の承認では通さない。[setup.md](setup.md#運用する環境) の「運用する環境」）
4. 承認の後、反映の段への遷移を止め、実行中の反映が終わるまで待つ。止めないまま書き換えると、古い設定で準備した実行が反映の段へ進みうる
5. `deploy` を打つ
6. [pipeline-approval.md の「設定を書き換える手順」](pipeline-approval.md#設定を書き換える手順) の 4 で、古い設定の実行を止める。その後は、参照先の 4 の判定と 5、6 に従う。レビュー済みの Pull Request のマージと遷移の再開は、参照先の 4 で先へ進めると判定した場合だけ行う

パラメーターを書き換えただけでは、アプリのスタックは変わらない。遷移を戻せる環境では、手順 6 のマージで始まる実行が、新しい設定をアプリに反映する。遷移を止めたままにする環境では、アプリに以前の設定が残る。

この版の設定のファイルには、本番の区分（`environment_kind`）と商用利用の開始の宣言（`launch_declared`）を書けない。書くと、`nd-setup diff` が設定の検査で止まる。2 つのキーは、[人の確定の段階を実装する課題](https://github.com/devbasex/nd-factory/issues/181)で足す。2 つのキーを扱える版で商用利用の開始を準備するときは、設計の[「人の確定の段階」の「商用利用の開始」](../design/api.md#人の確定の段階)に従う。人の承認を待たない今の反映のパイプラインは、商用利用を宣言した本番の設定を反映しない。

手元のコピーを失ったら、パラメーターから読み直す（`aws ssm get-parameter --name /<prefix>/<environment>/settings`）。
