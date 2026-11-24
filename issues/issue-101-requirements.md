## 何が起きたか

漏れの検査（CI の `leak-check` のジョブ）を見直すクロスレビュー（ https://github.com/devbasex/nd-factory/pull/100 の指摘 r1-6）で、次の抜けが見つかった。持ち主が実際の値の正規表現を CI の秘密に登録して検査を必須にすると、Dependabot（GitHub が依存のライブラリの更新を Pull Request で出す機能）が作る Pull Request で、漏れの検査が毎回落ちる。Dependabot が起動した CI の実行には、通常の Actions の秘密が渡らないためである。まだ Dependabot の Pull Request は作られておらず、CI を実際に動かしての確認はしていない（ワークフローを読んでの推定）。

## 種類

不具合（秘密を受けられない実行では実際の値の規則を必須にしない、という漏れの検査の設計の約束が、Dependabot の実行で守られていない）

## 今の姿

漏れの検査は、gitleaks で今のファイルと履歴のコミットを探し、値の混入を Pull Request とマージの時に止める。運用する環境の名前などの実際の値を当てる正規表現はリポジトリに置けないので、CI の秘密 `LEAK_CHECK_PATTERN` から受けて規則に重ねる。重ねる探しを必須にするかは変数 `LEAK_CHECK_REQUIRE_PATTERN` で決め、必須にするのは秘密を受けられる実行（main への push と、同じリポジトリのブランチからの Pull Request）だけである。fork からの Pull Request は秘密を受けないので必須にしない。

- 設計: [#1 の設計の決定 3](https://github.com/devbasex/nd-factory/blob/main/docs/design-process/issue-1/design.md)（「実際の値の正規表現」の行と、承認の要る操作の行）
- 指示書: [AGENTS.md の「秘密とインフラの値を置かない」](https://github.com/devbasex/nd-factory/blob/main/AGENTS.md)
- ワークフロー: `.github/workflows/ci.yml` の `leak-check` の手順「今の木と履歴のコミットを探す」（コミット fa6aa1b の 146〜184 行目）

2026-11-24 の時点のリポジトリの設定は次のとおりである（`gh secret list`・`gh variable list`・`gh api` で確認した）。

| 項目 | 状態 |
| --- | --- |
| Actions の秘密 | `REF_CHECK_TERMS` だけ。`LEAK_CHECK_PATTERN` はまだ登録していない |
| Actions の変数 | `REF_CHECK_REQUIRE_TERMS` だけ。`LEAK_CHECK_REQUIRE_PATTERN` はまだ設定していない |
| Dependabot の秘密 | `REF_CHECK_TERMS` だけ |
| Dependabot の設定のファイル（`.github/dependabot.yml`） | 無い |
| Dependabot の脆弱性のアラート | 有効 |
| Dependabot のセキュリティ更新（脆弱性を直す Pull Request を自動で作る機能） | 無効 |

参照の検査（`ref-check` のジョブ）も同じ形で秘密 `REF_CHECK_TERMS` を必須にしているが、こちらは Dependabot の秘密にも同じ名前で登録してある。

## 事象

`leak-check` の手順は、変数 `LEAK_CHECK_REQUIRE_PATTERN` が `1` で、main への push か同じリポジトリのブランチからの Pull Request なら、秘密 `LEAK_CHECK_PATTERN` が空のとき次の行を出して終了コード 1 で落ちる（`.github/workflows/ci.yml` の 151 行目の式と 167〜169 行目）。

```text
::error::秘密 LEAK_CHECK_PATTERN が無い（変数 LEAK_CHECK_REQUIRE_PATTERN で必須にしている）
```

Dependabot の Pull Request は同じリポジトリのブランチから出るので、この条件に当たる。Dependabot が起動した実行には通常の Actions の秘密が渡らず、Dependabot の秘密だけが渡る（[GitHub の文書: Troubleshooting Dependabot on GitHub Actions](https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-on-actions)）。そのため、Dependabot の秘密に `LEAK_CHECK_PATTERN` が無い限り、秘密は空になる。

手順の本文を取り出して手元の bash で動かし、秘密の有無と変数の組み合わせで次の結果になることを確認した（2026-11-24、コミット fa6aa1b）。

| 秘密 `LEAK_CHECK_PATTERN` | 変数 `LEAK_CHECK_REQUIRE_PATTERN` | 結果 |
| --- | --- | --- |
| 空 | `1` | 上の行を出して終了コード 1 |
| 空 | 空 | 落ちずに探しへ進む |
| 値あり | `1` | 落ちずに探しへ進む |

## 期待する結果

Actions の秘密に `LEAK_CHECK_PATTERN` を登録して必須にした後も、Dependabot の Pull Request で必須のチェック `leak-check` が、秘密が無いという理由だけでは落ちない。

## 再現手順

1. Actions の秘密に `LEAK_CHECK_PATTERN`、変数に `LEAK_CHECK_REQUIRE_PATTERN=1` を設定する（#1 の設計の承認の要る操作の行の手順どおり）。Dependabot の秘密には登録しない
2. Dependabot が依存の版の更新か脆弱性の更新の Pull Request を作る
3. その Pull Request の `leak-check` が、事象の行を出して落ちる

手順 1〜3 は実際には行っていない。手順 3 の結果は、ワークフローの読み取りと、事象に書いた手元での手順の実行からの推定である。

## 環境

nd-factory の main（コミット fa6aa1b）。`leak-check` のジョブは https://github.com/devbasex/nd-factory/pull/91 で入った。gitleaks 8.30.1、ランナーは ubuntu-24.04。

## なぜ困るか

Dependabot を有効にすると、依存の更新の Pull Request で必須のチェックが毎回落ち、マージできない。依存を新しく保ち、脆弱性のアラートに早く応じるという開発の基準（MVV の Value 14、MVV 版 3）が守れなくなる。更新のたびに、持ち主が手で秘密を足すか、チェックを外してマージすることになる。

## 目的

漏れの検査を必須にしたまま、Dependabot の Pull Request が漏れの検査を通ってマージできる状態にする。あわせて、Dependabot の Pull Request のコミットがいつ実際の値の規則で探されるのかを決め、設計書に残す（値の混入を検査で止めるという MVV の Value 7 を、Dependabot の Pull Request でも保つ）。

## 対象範囲

含む:

- Dependabot が起動した `leak-check` の実行で、実際の値の規則をどう扱うか（Dependabot の秘密に `LEAK_CHECK_PATTERN` を登録して探すか、fork と同じく必須にしないか）と、その実装
- 選んだ扱いに合わせた、必須にするための持ち主の操作の手順（#1 の設計の承認の要る操作の行・`AGENTS.md`・`docs/operations/`）の更新
- Dependabot の実行を見分ける条件を使う場合の、Dependabot 以外の実行が Dependabot として扱われないことの担保

含まない:

- Dependabot を有効にすること（`.github/dependabot.yml` を置く・セキュリティ更新を有効にする）
- 秘密 `LEAK_CHECK_PATTERN` の登録と変数 `LEAK_CHECK_REQUIRE_PATTERN` の設定そのもの（持ち主が GitHub の設定で行う。#1 の範囲）
- 参照の検査（`ref-check`）。Dependabot の秘密に `REF_CHECK_TERMS` が登録済みのため
- fork からの Pull Request の途中のコミットを秘密の正規表現で探すこと（ https://github.com/devbasex/nd-factory/issues/96 の範囲）

## 受け入れ条件

- [ ] 1. 前提: Actions の秘密に `LEAK_CHECK_PATTERN`、変数に `LEAK_CHECK_REQUIRE_PATTERN=1` がある。操作: Dependabot が同じリポジトリのブランチから Pull Request を作る。結果: `leak-check` が `秘密 LEAK_CHECK_PATTERN が無い` の誤りで落ちない
- [ ] 2. Dependabot 以外が起動した、同じリポジトリのブランチからの Pull Request と main への push は、今と同じく、変数 `LEAK_CHECK_REQUIRE_PATTERN` が `1` で秘密が空なら終了コード 1 で落ちる（退行しない）
      前提の確認: 事象の表の 1 行目（手元で手順の本文を動かし、終了コード 1。2026-11-24、コミット fa6aa1b）
- [ ] 3. fork からの Pull Request は、今と同じく、秘密が空でも実際の値の規則を必須にしない（退行しない）
      前提の確認: 151 行目の式は、Pull Request の head のリポジトリがこのリポジトリと違うとき必須の値を空にする（コミット fa6aa1b を読んで確認。実行はしていない）
- [ ] 4. Dependabot の実行を見分ける条件を使う場合、Dependabot が作ったブランチに人がコミットを push して起動した実行は、Dependabot の実行として扱われない
- [ ] 5. Dependabot の Pull Request のコミットが実際の値の規則で探される時点（Pull Request の時か、main への push の時か）が設計書に書いてある。Pull Request の時に探さない場合は、squash マージで main から辿れなくなる途中のコミットが探されないことと、その抜けを扱う課題（ https://github.com/devbasex/nd-factory/issues/96 ）へのリンクが書いてある
- [ ] 6. 必須にするための持ち主の操作の手順に、Dependabot の Pull Request で `leak-check` を通すのに要る操作（要るなら Dependabot の秘密の登録）が書いてある
- [ ] 7. CI の定義のテスト（`tools/test/ci-definition.test.ts`）が、受け入れ条件 1〜3 の条件分けを `leak-check` の定義から読んで確認する

## 非機能の条件

| 大項目 | 条件 |
| --- | --- |
| セキュリティ | 実際の値の正規表現は、Dependabot の秘密に登録する場合も、リポジトリ・CI の記録・課題に出ない（今の `leak-check` の出力の決まりのまま） |

## 影響

| 対象 | 影響 |
| --- | --- |
| 公開インタフェース | 変わらない（CI のワークフローと持ち主の操作の手順だけが変わる） |
| 重さ | Dependabot を有効にした後、依存の更新の Pull Request がすべてマージできない。今は Dependabot の Pull Request が作られない設定なので、まだ起きていない。回避はチェックを手で外すか、持ち主が Dependabot の秘密を手で足すこと |
| データ | 無い |
| 既存の振る舞い | `leak-check` のジョブの、秘密を必須にする条件。持ち主が登録する秘密の種類が増える場合がある |

## ドメインイベント

| # | イベント | 引き金 | 失敗したとき | 順序の前提 |
| --- | --- | --- | --- | --- |
| E1 | 持ち主が実際の値の秘密を登録し、漏れの検査で必須にした | 持ち主が GitHub の設定を変えた | 登録を忘れると、同じリポジトリの Pull Request と main への push が落ちる（受け入れ条件 2 のとおり） | — |
| E2 | Dependabot が依存の更新の Pull Request を作った | Dependabot の設定のファイルの予定か、脆弱性のアラート（Dependabot を有効にした後） | — | E1 |
| E3 | Dependabot が起動した `leak-check` が、Dependabot の秘密だけを受けて始まった | E2 の Pull Request の作成か更新 | — | E2 |
| E4 | `leak-check` が、実際の値の規則を重ねて探すか、必須にせずに進むかを決めた | E3 | 秘密が無いと落ちる（今の事象。受け入れ条件 1） | E3 |
| E5 | 人がその Pull Request を squash でマージし、main への push の `leak-check` が到達できるすべてのコミットを探した | 人のマージ | 途中のコミットは main から辿れず探されない（受け入れ条件 5） | E4 |

## 検証手段

| 項目 | 手段 |
| --- | --- |
| テスト | `npm run check`（CI の定義のテスト `tools/test/ci-definition.test.ts` を含む）。`npm run test:integration -- leak-scan` |
| 静的解析・型検査 | `npm run check`。CI の `workflow-audit` のジョブ（ワークフローの点検） |
| 手動確認 | 持ち主が秘密を登録して必須にし、Dependabot を有効にした後に、最初の Dependabot の Pull Request で `leak-check` が通ることを見る（受け入れ条件 1） |

## リリース後の確認の計画

| 条件 | 経路を動かすバージョン | 確かめる時点 |
| --- | --- | --- |
| 1. Dependabot の Pull Request で `leak-check` が秘密の欠けで落ちない | 配ったバージョン | このリリースの後（持ち主が秘密を登録し、Dependabot を有効にした後） |

## 境界

| 区分 | 内容 |
| --- | --- |
| 常に行う | 既存の CI の定義のテストと gitleaks の結合のテストを通す |
| 確認してから行う | 持ち主が登録する秘密の種類を増やすこと（設計の承認で人が見る） |
| 行わない | Dependabot を有効にすること。秘密の値をリポジトリに置くこと |

## 起票者の推定

| # | 条件 | 推した出所 | この要求での扱い |
| --- | --- | --- | --- |
| S1 | Dependabot を有効にする見込みがある | 起票者。`.github/dependabot.yml` はまだ無いが、MVV の Value 14 が依存の更新と脆弱性への対応を求める | 「なぜ困るか」の前提。Dependabot を有効にすることは含まない |
| S2 | 直し方は、Dependabot の秘密に `LEAK_CHECK_PATTERN` を登録するか、Dependabot の実行を fork と同じく必須にしないかの 2 つ | https://github.com/devbasex/nd-factory/pull/100 のクロスレビューの指摘 r1-6 | 対象範囲の「含む」の 1 行目。どちらにするかは設計で決める。受け入れ条件は両方で成り立つ形にした |
| S3 | 後者を選ぶなら、Dependabot の Pull Request の途中のコミットが探されない抜けを設計に書く | 起票者 | 受け入れ条件 5 |
| S4 | 参照の検査（`ref-check`）は範囲に入れない | 要求を書いた AI。Dependabot の秘密に `REF_CHECK_TERMS` が登録済み（2026-11-24 に `gh secret list --app dependabot` で確認） | 含まない |
| S5 | Dependabot の実行を見分ける条件を使うなら、人が Dependabot のブランチへ push した実行を Dependabot として扱わない | 要求を書いた AI。起動した人で見分ける条件は、人が同じブランチへ push すると外れるため | 受け入れ条件 4 |

## リクエスト（原文）

<details>
<summary>課題の元の本文（書き手: 起票者、日付: 2026-11-21）</summary>

> ## 事象
>
> `ci.yml` の `leak-check` の手順「今の木と履歴のコミットを探す」は、変数 `LEAK_CHECK_REQUIRE_PATTERN` が `1` で、main への push か同じリポジトリの枝からの Pull Request なら、秘密 `LEAK_CHECK_PATTERN` が無いと `::error::秘密 LEAK_CHECK_PATTERN が無い` で失敗する（`.github/workflows/ci.yml` の 118 行目の式）。Dependabot が同じリポジトリの枝に作る Pull Request もこの条件に当たる。Dependabot が起動した実行には通常の Actions の秘密が渡らず、Dependabot の秘密だけが渡る（[GitHub の Dependabot on Actions の仕様](https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-on-actions)）。
>
> ## 期待する結果
>
> Actions の秘密に `LEAK_CHECK_PATTERN` を登録して必須にしたあとも、Dependabot の Pull Request で必須のチェック `leak-check` が、秘密が無いという理由だけでは落ちない。
>
> ## 再現手順
>
> 1. Actions の秘密に `LEAK_CHECK_PATTERN`、変数に `LEAK_CHECK_REQUIRE_PATTERN=1` を設定する（#1 の設計の承認の要る操作の行の手順どおり）。Dependabot の秘密には登録しない
> 2. Dependabot の版の更新か脆弱性の更新の Pull Request が作られる
> 3. `leak-check` が秘密が無いとして失敗する（コードを読んでの推定。実行しての確かめはしていない）
>
> ## 環境
>
> nd-factory の `sprint/issue-1`（PR #91 でマージした U4 の `leak-check`）。gitleaks 8.30.1
>
> ## 影響
>
> Dependabot を有効にすると、依存の更新の Pull Request の必須のチェックが落ち、マージできない。MVV の Value 14（依存を新しく保ち、脆弱性の知らせに早く応じる）を妨げる。直し方は、必須化の手順に Dependabot の秘密 `LEAK_CHECK_PATTERN` の登録を含める（`issues/issue-1-design.md` の承認の要る操作の行と `AGENTS.md`）か、`github.actor == 'dependabot[bot]'` の実行を fork と同じく必須にしない条件へ変えるかのどちらか。後者を選ぶなら、その実行のコミットは main への push の探しで実際の値の規則に掛かる（Dependabot の Pull Request の途中のコミットの扱いは #96 と同じ形の抜けになる）ことを設計に書く。
>
> ## 起票者の推定
>
> - Dependabot を有効にする見込みがある（推した出所: 起票者。`.github/dependabot.yml` はまだ無いが、MVV の Value 14 が依存の更新と脆弱性の知らせへの対応を求める）
> - 直し方の 2 案（Dependabot の秘密の登録・Dependabot の実行を必須にしない条件）（推した出所: PR #100 のクロスレビューの指摘 r1-6）
>
> ## 由来
>
> PR #100（#1 U6。NDF の契約の照合）のクロスレビューの指摘 r1-6（`.github/workflows/ci.yml:118`）。#100 は `ci.yml` を変えず、`leak-check` は U4（#91、マージ済み）の範囲なので、U6 の範囲外とした。#1 の受け入れ条件（漏れ）に当たる。根拠: MVV の Value 7・14（MVV バージョン 3）

</details>

（書き手: 起票者、日付: 2026-11-21。書き手が利用者でないので、利用者の指示の原文としては扱わない）

