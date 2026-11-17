# 設定のファイル

環境ごとに違う値は、リポジトリの外に置く JSON のファイル（設定のファイル）から受ける。AWS のアカウントとリージョンは設定のファイルに書かず、設置のコマンドへ渡す profile から受ける。秘密の値は設定のファイルにも書かず、秘密の器（Secrets Manager）に人が入れる。

形の正本は `packages/contracts/src/settings.ts` の zod の定義である。JSON Schema（`packages/contracts/schema/settings.schema.json`）と作り物の値の見本（`infra/settings.example.json`）はそこから `npm run generate` で作る。

## キー

| キー | 必須 | 意味 | 読む構成要素 |
| --- | --- | --- | --- |
| `prefix` | 必須 | 資源の接頭辞。小文字の英数字とハイフンで 3〜20 文字。`aws` で始めない | すべてのスタック（名前と利用者プールのドメイン） |
| `environment` | 必須 | 環境の名前。小文字の英数字で 2〜10 文字 | すべてのスタック（名前とタグ） |
| `login.google` | 必須 | Google でログインを受ける。`client_id` が無い間は IdP を作らず、画面は「設定の待ち」を示す | 縦の切れ端のスタック |
| `login.google.client_id` | 任意 | Google の Web アプリのクライアントの ID。secret は秘密の器 `<prefix>/<environment>/google-oauth` に人が入れる。値を入れて確かめた後にだけ書く（[idp-and-apps.md](idp-and-apps.md)） | 縦の切れ端のスタック |
| `pipeline` | 任意 | あるときだけ反映のパイプラインのスタックを作る | 反映のパイプラインのスタック |
| `pipeline.repository` | `pipeline` があれば必須 | 起点のリポジトリ（`<組織>/<名前>`） | 同上 |
| `pipeline.branch` | `pipeline` があれば必須 | 起点のブランチ | 同上 |
| `pipeline.notify_emails` | 任意 | 承認の依頼と失敗の知らせの宛先 | 同上 |

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
  }
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
3. 人が差分を承認した後に `deploy` を打つ（[setup.md](setup.md)）
4. パラメーターを書き換えても縦の切れ端はまだ変わらない。次のパイプラインの実行（起点のブランチへの push か実行の開始）と、承認のアクションでの人の承認で反映される

手元のコピーを失ったら、パラメーターから読み直す（`aws ssm get-parameter --name /<prefix>/<environment>/settings`）。
