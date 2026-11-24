# 漏れの検査: 実際の値の規則での探しを Pull Request のコードから隔て、fork と Dependabot の Pull Request もマージの前に探す（#96 #101）

漏れの検査（CI の `leak-check`）は、実際の値の正規表現（CI の秘密 `LEAK_CHECK_PATTERN`）を Pull Request の側の実行の中で使っている。そのため、fork の Pull Request は探されず、Dependabot の Pull Request は秘密が無いために落ち、同じリポジトリのブランチの Pull Request では秘密が Pull Request のコードから読める。秘密を使う探しを、既定のブランチのワークフロー・スクリプト・設定だけで動く新しいジョブ（`pull_request_target` で起動し、Pull Request のコミットは git のデータとして取るだけにする）へ移し、Pull Request の側の `leak-check` には秘密を渡さない。採らなかった起動の形（`workflow_run`・マージキュー・GitHub の secret scanning など）は決定 1・2 に、調べた文書と実測は末尾の「外部の調査」にある。

## 今の姿

何が起きたか・目的・受け入れ条件は要求仕様（[issue-96-requirements.md](./issue-96-requirements.md)、正は #96 の本文。[issue-101-requirements.md](./issue-101-requirements.md)、正は #101 の本文）にある。この文書は「どう解くか」と「なぜその解き方か」だけを書く。

```mermaid
flowchart TB
    subgraph PR["Pull Request の実行（pull_request。ワークフローとスクリプトは Pull Request のマージコミットのもの）"]
        step["leak-check の手順「今の木と履歴のコミットを探す」"]
        conf["一時の設定のファイル（秘密の正規表現を書く）"]
        scan["Pull Request のチェックアウトにある leak-scan.sh"]
        step -->|秘密を書く| conf
        step -->|動かす| scan
        scan -->|読める| conf
    end
    subgraph PUSH["main への push の実行"]
        pstep["同じ手順。到達できるすべてのコミットを探す"]
    end
    secA["Actions の秘密 LEAK_CHECK_PATTERN"] -->|同じリポジトリのブランチだけ| step
    secA --> pstep
    secD["Dependabot の秘密（LEAK_CHECK_PATTERN は無い）"] -->|Dependabot の実行| step
```

変更する位置は、`.github/workflows/ci.yml` の `leak-check` の手順「今の木と履歴のコミットを探す」（コミット fa6aa1b の 146〜184 行目）である。設計に要る今の構造は次のとおり。

| 実行 | 受ける秘密 | 秘密の正規表現での探し | 必須にする条件（変数 `LEAK_CHECK_REQUIRE_PATTERN` が `1` のとき） |
| --- | --- | --- | --- |
| 同じリポジトリのブランチからの Pull Request | Actions の秘密 | 分岐点から head までの全コミット。秘密を書いた設定のファイルを、Pull Request のチェックアウトのスクリプトが読む | 必須 |
| fork からの Pull Request | 無し | 探さない | 必須にしない |
| Dependabot が起動した Pull Request | Dependabot の秘密だけ | 秘密が空なので探せない | 必須（そのため毎回落ちる） |
| main への push | Actions の秘密 | 到達できるすべてのコミット | 必須 |

マージの方法は squash である（`.ndf/project.json` の `merge.commit`）。squash では Pull Request の途中のコミットは main に入らないので、Pull Request の時に探さなかったコミットは main への push でも探されない。

**2 つの課題を 1 本にまとめたのは、原因が同じ 1 か所にあるためである。** 秘密を使う探しが Pull Request の側の実行（`pull_request`）の中にあり、秘密を受けられるかと、動くコードを信頼できるかが、Pull Request の出所（fork・Dependabot・同じリポジトリのブランチ）で変わる。#96 は fork で秘密を受けられないことと、同じリポジトリのブランチで秘密が Pull Request のコードに渡ることを、#101 は Dependabot で秘密を受けられないことを扱う。探しを出所に左右されない信頼できる側の実行へ移すと、両方が同じ変更で直る。#96 の要求も「Dependabot が起動した実行で秘密を使う探しがどう動くかは、この課題の仕組みを決めるときに #101 とそろえる」としている。

## 文脈と制約

- リポジトリは公開で、fork から誰でも Pull Request を出せる。実際の値の正規表現そのもの（運用する環境の名前などを含む）を、リポジトリ・CI の記録・Pull Request の作者が書いたコードに渡さない（MVV の Value 7）
- CI は AWS の資格情報を持たない。ワークフローの `permissions` は最上位を `contents: read` だけにし、ジョブで広げない（`tools/test/ci-definition.test.ts` が落とす）
- 動作（`uses:`）はコミットの SHA で固定し、gitleaks はバージョンと要約値で固定して取る（#1 の決定 3・5）
- ワークフローの点検（zizmor v1.32.0）は `--offline --no-ignores --config .github/zizmor.yml` で打つ。`--no-ignores` の下では、行の中の `zizmor: ignore` も設定の `rules.<id>.ignore` も効かない。効くのは、点検を丸ごと外す `rules.<id>.disable` だけである（2026-11-24 に v1.32.0 を手元で打って確認した。外部の調査の LIB2）
- main にはブランチの保護もルールセットも無い。2026-11-24 に、`gh api repos/devbasex/nd-factory/branches/main/protection` は 404 を返し、`gh api repos/devbasex/nd-factory/rulesets` は空だった。必須のチェックは `.ndf/project.json` の `required_checks` の宣言だけで効く。GitHub はマージを止めず、NDF（このリポジトリの開発を進めるツール）がマージの前に head のコミットのチェックを見る
- 公開のリポジトリでは、GitHub の既定のイベントポリシーが `pull_request_target` を止める。今は評価のモード（実行は止めず記録だけ）で、2026-12-02 から適用される（STD2）
- Dependabot を有効にすること・秘密と変数の登録そのものは範囲の外である（両課題の「含まない」）

## 解き方の全体像

```mermaid
flowchart TB
    subgraph PRSIDE["Pull Request の実行（pull_request）"]
        lc["leak-check: 既定の規則と nd-factory の規則だけで、今の木と分岐点から head までを探す。秘密を受けない"]
    end
    subgraph TRUSTED["信頼できる側の実行（pull_request_target。ワークフロー・スクリプト・設定は既定のブランチのもの）"]
        ls["leak-check-secret: Pull Request の head のコミットを git のデータとして取り、分岐点から head までを、既定の規則と、nd-factory の規則に秘密の正規表現を重ねた設定で探す"]
    end
    subgraph PUSH["main への push の実行"]
        lp["leak-check: 到達できるすべてのコミットを、秘密の正規表現を重ねた設定で探す（今のまま）"]
    end
    secA["Actions の秘密 LEAK_CHECK_PATTERN"] --> ls
    secA --> lp
    secD["Dependabot の秘密 LEAK_CHECK_PATTERN（同じ名前で登録する）"] -->|Dependabot の実行| ls
    shared["秘密を使う探しのスクリプト（新設）"]
    ls --> shared
    lp --> shared
```

- Pull Request ごとに、新しい必須のチェック `leak-check-secret` が既定のブランチのコードだけで動く。fork・同じリポジトリのブランチ・Dependabot のどの Pull Request でも、途中のコミットを含む全コミットを、実際の値の規則でマージの前に探す
- Pull Request の側の `leak-check` は秘密を一切受けない。秘密の正規表現を書いた設定のファイルを、Pull Request のコードが読む経路が無くなる
- 秘密を必須にする条件は、Pull Request の出所と起動した人で分けない。変数が `1` で秘密が空なら、どの Pull Request でも `leak-check-secret` が落ちる。Dependabot の実行には同じ名前の Dependabot の秘密が渡るので、秘密の欠けでは落ちない
- 秘密の正規表現を重ねる処理と必須の判定は、新設する 1 本のスクリプトにまとめ、main への push の `leak-check` と `leak-check-secret` の両方がそれを呼ぶ
- 持ち主の操作（Dependabot の秘密の登録・`pull_request_target` を許すイベントポリシー）は、新設する運用の文書（`docs/operations/ci-checks.md`）と `AGENTS.md` に書く

## 構成要素

| 要素 | 責務 |
| --- | --- |
| 信頼できる側の漏れの検査のワークフロー（`.github/workflows/leak-check-secret.yml`、新設） | `pull_request_target` で起動し、既定のブランチをチェックアウトする。Pull Request の head を `refs/pull/<番号>/head` から git の参照として取り、event の head の SHA と一致することを確認してから、秘密を使う探しのスクリプトに分岐点から head までの範囲を渡す。Pull Request のコミットのファイルを動かさず、依存を入れない（`npm ci`・`setup-node` を持たない） |
| 秘密を使う探しのスクリプト（`tools/checks/leak-scan-secret.sh`、新設） | 秘密の正規表現と必須の変数を環境変数で受ける。秘密があれば、一時の設定のファイルを、探す作業ツリーの外に作る。その設定は `.gitleaks.toml` を `[extend] path` で読み、規則 `nd-real-value` を足す。秘密が無ければ、必須なら失敗し、必須でなければ `.gitleaks.toml` だけで進む。続けて `leak-scan.sh git` を 2 回打つ。1 回目は既定の規則で、2 回目はその設定で探す。範囲を受ければその範囲、受けなければ到達できるすべてのコミットを探す。正規表現を記録に出さない |
| 今の木と履歴の探しのスクリプト（`tools/checks/leak-scan.sh`） | 変えない。gitleaks の 1 回の探しと、当たりを規則・ファイル・行・コミットだけで出す |
| CI の `leak-check` のジョブ（`.github/workflows/ci.yml`） | Pull Request の実行では秘密を受けず、既定の規則と `.gitleaks.toml` だけで今の木と分岐点から head までを探す（今の既定の規則と nd-factory の規則の探しのまま）。main への push の実行では、秘密を使う探しのスクリプトで到達できるすべてのコミットを探す |
| ワークフローの点検の設定（`.github/zizmor.yml`） | `dangerous-triggers` の点検を外し、理由と課題の番号を注に書く。外した点検の代わりは CI の定義のテストが持つ |
| CI の定義のテスト（`tools/test/ci-definition.test.ts`） | 必須のチェックの宣言と、Pull Request で起動するジョブ（`pull_request` と `pull_request_target`）の集合の一致を見る。`pull_request_target`・`workflow_run`・`issue_comment` を使うワークフローが信頼できる側の漏れの検査の 1 本だけであること、その形（決定 4）、秘密を受ける手順と必須の条件の分け方（決定 3）を、ワークフローの定義から読んで落とす |
| 漏れの検査の結合のテスト（`tools/test/leak-scan.integration.test.ts`） | 秘密を使う探しのスクリプトを、作り物の正規表現と、途中のコミットで足して後で消した作り物のリポジトリで動かす |
| ワークフローの点検の結合のテスト（`tools/test/workflow-audit.integration.test.ts`） | `dangerous-triggers` 以外の点検が今の設定で外れていないことを保つ |
| 必須のチェックの宣言（`.ndf/project.json`） | `required_checks` に `leak-check-secret` を足し、`ci.workflows` に新しいワークフローを足す |
| 運用の文書（`docs/operations/ci-checks.md`、新設）と指示書（`AGENTS.md`） | 持ち主が秘密を登録して検査を必須にする手順（Actions の秘密・同じ名前の Dependabot の秘密・変数・`pull_request_target` を許すイベントポリシー）と、秘密を使う探しがどこで動くか |
| プラットフォームの設計（`docs/design/platform.md` の「設計の決まりを縛る検査」） | 漏れの検査の行に、実際の値の規則での探しが Pull Request ごとに信頼できる側で動くことを足す |

```mermaid
flowchart LR
    subgraph EVENTS["GitHub のイベント"]
        prt["pull_request_target"]
        pr["pull_request"]
        push["main への push"]
    end
    subgraph WF["ワークフロー（.github/workflows/）"]
        wls["leak-check-secret（新設）"]
        wlc["ci.yml の leak-check"]
    end
    subgraph SCRIPTS["スクリプト（tools/checks/）"]
        sec["leak-scan-secret.sh（新設）"]
        scan["leak-scan.sh"]
    end
    subgraph CONF["設定"]
        nd[".gitleaks.toml"]
        def["gitleaks-default.toml"]
    end
    prt --> wls
    pr --> wlc
    push --> wlc
    wls --> sec
    wlc -->|push のとき| sec
    wlc -->|Pull Request のとき| scan
    sec --> scan
    scan --> nd
    scan --> def
```

図には CI の中で動くものだけを描き、テスト・点検の設定・宣言・文書の行は含めない。`leak-check-secret` が読む `.gitleaks.toml`・`gitleaks-default.toml`・2 本のスクリプトは、どれも既定のブランチのチェックアウトにあるものである。Pull Request のコミットは git の参照としてだけ取り込まれ、作業ツリーに出ない。

## 処理の流れ

```mermaid
sequenceDiagram
    participant A as Pull Request の作者
    participant G as GitHub
    participant J as leak-check-secret（既定のブランチのワークフロー）
    participant S as leak-scan-secret.sh（既定のブランチ）
    participant L as leak-scan.sh と gitleaks
    A->>G: Pull Request を出す・push する
    G->>J: pull_request_target（opened・synchronize・reopened）
    Note over J: 同じ Pull Request の前の実行はキャンセルする
    J->>J: 既定のブランチをチェックアウトし、gitleaks をバージョンと要約値で置く
    J->>G: refs/pull/番号/head を取る（ファイルは出さない）
    alt 取れない・head の SHA が event と違う
        J-->>G: 失敗（チェックは通らない）
    end
    J->>S: 分岐点..head の範囲と、秘密・必須の変数
    alt 秘密が空で必須
        S-->>J: 終了コード 1
    end
    S->>L: 既定の規則で範囲を探す
    S->>L: 重ねた設定（秘密があるとき）か .gitleaks.toml で範囲を探す
    L-->>S: 当たりは規則・ファイル・行・コミットだけ
    S-->>J: 当たり・失敗なら 1、当たり無しなら 0
    J-->>G: head のコミットに leak-check-secret の結果
```

新しいコミットが push されると、GitHub が `synchronize` で同じワークフローを起こし、新しい head で探しをやり直す。必須のチェックは最新のコミットの結果だけが数えられる（STD4）。NDF もマージの前に head のコミットのチェックを見るので、前の head の結果ではマージできない。

## 非機能の実現方式

| 大項目 | 要求の条件 | 実現方式 | 確かめ方 |
| --- | --- | --- | --- |
| セキュリティ | 秘密の正規表現と書き込みの権限が、Pull Request の作者が書いたコードに渡らない（#96 の受け入れ条件 3・4） | 秘密は `leak-check-secret`（既定のブランチのワークフロー）と main への push の `leak-check` の、秘密を使う探しの手順の環境変数だけで受ける。`leak-check-secret` は既定のブランチをチェックアウトし、Pull Request の head は git の参照として取るだけで、依存を入れずにファイルを動かさない。Pull Request から来る値（番号・SHA）は環境変数で渡し、形を検査してから使う。`permissions` は `contents: read` だけ | CI の定義のテスト（決定 3・4 の行） |
| セキュリティ | 秘密を使う探しが失敗したときは通さない側に倒す（#96 の受け入れ条件 6） | `leak-check-secret` のジョブと手順に `if:` と `continue-on-error` を置かない（条件で飛ばしたジョブは成功と報告されるため。STD4）。取り込み・SHA の一致・範囲の読み取り・gitleaks のどこで失敗しても、終了コード 0 以外で終える | CI の定義のテストと、結合のテストの失敗の経路の行 |
| セキュリティ | 実際の値の正規表現は、Dependabot の秘密に登録する場合も、リポジトリ・CI の記録・課題に出ない（#101） | 正規表現は探す木の外の一時の設定のファイルにだけ書き、終了時に消す。出力は今の `leak-scan.sh` の形（規則・ファイル・行・コミット）だけにする | 結合のテスト（出力に作り物の正規表現と当たった値が現れない） |
| 運用・保守性 | 当たりの出力は今の `leak-scan.sh` の形（規則・ファイル・行・コミット）のままにし、持ち主が当たりの場所を引ける（#96） | 当たりを出すのは今の `leak-scan.sh` だけで、新しいスクリプトは出力の形を足さない | 結合のテスト |

## 決定の記録

### 決定 1: 秘密の正規表現を Pull Request のコードから隔てたままマージの前に全コミットを探すため、`pull_request_target` の新しいジョブで、既定のブランチのコードだけを動かし、Pull Request のコミットは git のデータとして取る

- **質問**: fork の Pull Request でも秘密を受け、同じリポジトリのブランチの Pull Request でも秘密を Pull Request のコードに渡さずに、途中のコミットを含む全コミットをマージの前に探すには、どの起動の形を使うか
- **選んだ案**: ワークフロー `.github/workflows/leak-check-secret.yml` を新設し、`pull_request_target`（既定の `opened`・`synchronize`・`reopened`）で起動する。ジョブ `leak-check-secret` は `actions/checkout` を `ref` なし（既定のブランチ）・`fetch-depth: 0`・`persist-credentials: false` で打つ。続けて `git fetch` で `refs/pull/<番号>/head` を参照として取り込む。取り込んだ head が event の head の SHA と一致することを確かめてから、分岐点から head までを、既定のブランチの `tools/checks/leak-scan-secret.sh` で探す。分岐点は `git merge-base <base.sha> <head.sha>` で求める。`concurrency` は Pull Request の番号ごとにし、前の実行をキャンセルする
- 採らなかった案: `workflow_run` で Pull Request の CI の後に信頼できる側で探す（`workflow_run` のチェックは、Pull Request の必須のチェックとして数えられない（STD4）。結果を Pull Request に付けるには `statuses: write` の権限が要り、#96 の受け入れ条件 4 に反する。zizmor の `dangerous-triggers` にも当たる）
- 採らなかった案: マージキュー（`merge_group`）で探す（マージキューの実行は Pull Request のコードを秘密つきで動かすので、#96 の受け入れ条件 3 に反する。squash のキューでは途中のコミットが残らない）
- 採らなかった案: GitHub の secret scanning の独自のパターンと push protection に正規表現を置く（fork への push は fork のリポジトリで受けるので、このリポジトリの push protection が掛からない。当たりは警告で、マージの前のチェックにならない。PRD1）
- 採らなかった案: マージの方法を rebase かマージのコミットに変え、途中のコミットを main への push で探す（マージの前に止めるという #96 の目的を満たさない。同じリポジトリのブランチで、秘密が Pull Request のコードに渡る経路も残る）
- **代償**: zizmor が「ほぼ常に危険」とする起動のきっかけを 1 つ持つ。Pull Request のファイルを動かさなくても、引数や環境変数への注入でコードを動かされる経路があり得る（LIB2）。そのため、決定 4 の形を CI の定義のテストで縛り続ける。2026-12-02 に既定のイベントポリシーが適用された後は、持ち主が `pull_request_target` を許すイベントポリシーを作るまで、このチェックは起動されない。チェックが保留のままになるので、マージは止まる
- 作り方: 標準に倣う・自前で作る
- 比べた候補: STD1 / STD2 / STD4 / PRD1 / PRD2 / LIB1
- 根拠: Value 7「混入は検査（漏れの検査・秘密の形の検査・境界の検査）で機械的に止める」・Value 17（MVV バージョン 3）。STD1・STD2

### 決定 2: Dependabot の Pull Request も同じ探しを通してマージできるよう、`LEAK_CHECK_PATTERN` を同じ名前で Dependabot の秘密にも登録し、起動した人で分ける条件を置かない

- **質問**: Dependabot が起動した実行で、実際の値の規則をどう扱うか（Dependabot の秘密に登録して探すか、fork と同じく必須にしないか）
- **選んだ案**: 持ち主が Actions の秘密と同じ名前・同じ値で Dependabot の秘密 `LEAK_CHECK_PATTERN` を登録する。ワークフローは `secrets.LEAK_CHECK_PATTERN` を 1 か所で読み、`github.actor` や `dependabot[bot]` で分ける条件を持たない。Dependabot の Pull Request の全コミットは、ほかの Pull Request と同じく Pull Request の時（`leak-check-secret`）に探す。人が Dependabot のブランチへ push して起動した実行は、Actions の秘密を受けて同じ探しをする
- 採らなかった案: `github.actor == 'dependabot[bot]'` の実行を fork と同じく必須にしない（Dependabot の Pull Request の途中のコミットがマージの前に探されず、squash の後は main からも辿れない。起動した人での判定は、人が同じブランチへ push すると外れる）
- 採らなかった案: `pull_request_target` の実行には Dependabot でも Actions の秘密が渡ると見て、Dependabot の秘密を登録しない（GitHub の文書は、Dependabot が起動した実行で使える秘密は Dependabot の秘密だけと書く。一方で、`pull_request_target` はこの制限を持たないとも書く。どちらが当たるかを文書から決められない。STD3）
- **代償**: 持ち主が同じ値を 2 か所に登録し、値を変えるときも 2 か所を直す。参照の検査の秘密 `REF_CHECK_TERMS` と同じ運用になる
- 根拠: Value 7・Value 14（MVV バージョン 3）。STD3

### 決定 3: Pull Request のコードが秘密を読めないよう、Pull Request の側の `leak-check` には秘密を渡さず、必須にする条件は出所で分けない

- **質問**: 今の `leak-check` の、秘密を受ける手順と必須にする条件を、新しいジョブとどう分けるか
- **選んだ案**: `ci.yml` の `leak-check` を、Pull Request の実行の手順（秘密を受けない。既定の規則と `.gitleaks.toml` で今の木と分岐点から head までを探す）と、main への push の手順（`if: github.event_name == 'push'`。秘密と必須の変数を受け、秘密を使う探しのスクリプトで到達できるすべてのコミットを探す）の 2 つに分ける。今の式の `github.event.pull_request.head.repo.full_name == github.repository` の条件は消す。`leak-check-secret` では、変数 `LEAK_CHECK_REQUIRE_PATTERN` が `1` で秘密が空なら、Pull Request の出所によらず終了コード 1 で落ちる。`pull_request_target` では fork の Pull Request も秘密を受けるので、秘密が空なのは持ち主が登録していないときだけである
- 採らなかった案: 同じリポジトリのブランチの Pull Request では、今の手順で秘密を受け続ける（Pull Request のチェックアウトのスクリプトが秘密の正規表現を読め、#96 の受け入れ条件 3 に反する）
- 採らなかった案: `leak-check-secret` でも fork の Pull Request は必須にしない（fork も秘密を受けられるので分ける理由が無く、登録を忘れたときに fork の Pull Request だけが探されずに通る。#96 の受け入れ条件 6 の、通さない側に倒す約束に反する）
- **代償**: 秘密が空で必須のときに落ちるチェックが、同じリポジトリのブランチの Pull Request では `leak-check` から `leak-check-secret` に移る。`leak-check` の手順が、Pull Request の実行の手順と main への push の手順に分かれ、条件で分ける箇所が 1 つ増える
- 根拠: Value 7（MVV バージョン 3）

### 決定 4: 危険な起動のきっかけの点検を外しても同じ危険を止めるため、zizmor の `dangerous-triggers` を設定で外し、使える場所と形を CI の定義のテストで縛る

- **質問**: `pull_request_target` は zizmor の `dangerous-triggers` に当たる（v1.32.0 で終了コード 14。LIB2）。ワークフローの点検（#96 の受け入れ条件 10）を通すために、点検をどう扱うか
- **選んだ案**: `.github/zizmor.yml` で `dangerous-triggers` を `disable: true` にし、理由と課題の番号（#96）を注に書く。代わりに、CI の定義のテストが次のどれかに当たる定義を落とす
  - `pull_request_target`・`workflow_run`・`issue_comment` を使うワークフローが `leak-check-secret.yml` のほかにある
  - そのワークフローが `pull_request` か `push` も持つ
  - `actions/checkout` に `ref`・`repository`・`allow-unsafe-pr-checkout` を渡す
  - `persist-credentials` が偽でない
  - `setup-node`・`npm`・`npx` を使う
  - `GITHUB_ENV`・`GITHUB_OUTPUT` に書く
  - gitleaks を置く手順を除いて、`GITHUB_PATH` に書く
  - `${{ github.event.* }}` を `run:` の中に直に書く
  - `if:` か `continue-on-error` がある
  - `permissions` が `contents: read` だけでない
  - 秘密を受ける手順が探しの手順のほかにある
- 採らなかった案: `--no-ignores` をやめ、`rules.dangerous-triggers.ignore` でこの 1 本だけを外す（行の中の `zizmor: ignore` も効くようになり、#1 の決定 5 が `--no-ignores` で塞いだ、点検を行の注で外す経路が戻る）
- 採らなかった案: 点検の当たりを残したまま通す（`workflow-audit` が落ち、#96 の受け入れ条件 10 に反する）
- **代償**: `dangerous-triggers` が将来足す当たりの種類（v1.31.0 で `issue_comment` が足された）は、CI の定義のテストに手で足すまで落ちない。zizmor のバージョンを上げるときに、点検の文書の対象の一覧とテストの一覧を見比べる
- 作り方: ライブラリやサービスを使う・自前で作る
- 比べた候補: LIB2 / STD1
- 根拠: Value 8・Value 14（MVV バージョン 3）。LIB2

### 決定 5: 秘密を重ねる処理を 1 か所に置くため、重ねた設定を組んで探す処理を新しいスクリプトにまとめ、push と `leak-check-secret` の両方から呼ぶ

- **質問**: 秘密の正規表現を重ねた一時の設定を組む処理と必須の判定（今は `ci.yml` の手順の中のシェル）を、2 つのジョブでどう持つか
- **選んだ案**: `tools/checks/leak-scan-secret.sh` を新設し、今の手順の中のシェル（`'''` を含む正規表現を拒む・重ねた設定を組む・必須の判定・一時のファイルを消す）を移す。`--range <範囲>` を受ければその範囲、受けなければ到達できるすべてのコミットを、既定の規則と重ねた設定（秘密が無ければ `.gitleaks.toml`）の 2 回で探す。`leak-check-secret` も既定の規則と nd-factory の規則で範囲を探すので、Pull Request が `.gitleaks.toml` の許可を書き換えても、既定のブランチの設定で探される
- 採らなかった案: 2 つのワークフローの手順に同じシェルをコピーする（同じ処理を 2 か所に持ち、片方だけを直す食い違いが起きる。Value 13）
- 採らなかった案: `leak-check-secret` では秘密の正規表現の規則だけで探す（Pull Request が `.gitleaks.toml` に足した許可で nd-factory の規則の当たりを外したとき、マージの前に既定のブランチの設定で探す実行が無くなる）
- **代償**: スクリプトが 1 本増え、結合のテストの対象が増える
- 根拠: Value 13・Value 7（MVV バージョン 3）

### 決定 6: 持ち主の操作の手順を今の設定と一緒に読めるよう、運用の文書 `docs/operations/ci-checks.md` を新設し、`AGENTS.md` の行を直す

- **質問**: 秘密を登録して検査を必須にする持ち主の操作（#101 の受け入れ条件 6）を、どこに書くか
- **選んだ案**: `docs/operations/ci-checks.md` を新設し、次の 2 つを書く。`AGENTS.md` の「秘密とインフラの値を置かない」の行を、秘密を使う探しが `leak-check-secret` と main への push で動くことに直し、運用の文書へリンクする
  - 参照の検査と漏れの検査で、持ち主が GitHub の設定で行う操作（Actions の秘密 `LEAK_CHECK_PATTERN`・同じ名前の Dependabot の秘密・変数 `LEAK_CHECK_REQUIRE_PATTERN`・`pull_request_target` を許すイベントポリシー・今ある `REF_CHECK_TERMS` の 2 か所の登録）
  - それぞれの検査が、どの実行で秘密を受けるか
- 採らなかった案: #1 の設計（`docs/design-process/issue-1/design.md`）の「人へ残す判断」の行を直す（その文書は経緯の記録である。検査を足した後はその文書を更新しないと、`docs/design-process/issue-1/README.md` が決めている）
- **代償**: `docs/operations/` の文書が 1 本増える
- 根拠: Value 7・Value 13（MVV バージョン 3）

## 影響と危険

- **働く範囲**: このリポジトリの CI だけ。画面・API・設置のコマンド・利用者のプロジェクトのリポジトリは変わらない
- **プロジェクトごとに違うもの**: 実際の値の正規表現は Actions の秘密と Dependabot の秘密（同じ名前）、必須にするかは変数で受け、リポジトリに置かない
- **当たるモード**: このリポジトリに出るすべての Pull Request（fork・同じリポジトリのブランチ・Dependabot）と main への push

壊れうる箇所と扱い:

| 箇所 | 起きること | 扱い |
| --- | --- | --- |
| 実装の Pull Request 自身 | `pull_request_target` は既定のブランチのワークフローを動かすので、新しいワークフローを足す Pull Request ではまだ `leak-check-secret` が起動されない。`required_checks` に足した宣言だけが先に効き、NDF のマージがチェックの欠けで止まり得る | 実装の Pull Request では、`leak-check-secret` の欠けを持ち主が承認の時に見て、マージの後に次の Pull Request で動くことを確認する（リリース後の確認） |
| イベントポリシーの適用（2026-12-02） | 持ち主が `pull_request_target` を許すポリシーを作らないと、`leak-check-secret` が起動されず保留のままになり、すべての Pull Request のマージが止まる | 通さない側に倒れるので漏れは起きない。運用の文書の手順の最初に置く |
| 同じリポジトリのブランチで `ci.yml` を書き換える Pull Request | 書き込みの権限を持つ人は、`pull_request` のワークフローを書き換えて Actions の秘密を読む手順を足せる。これは GitHub の権限の設計による経路で、この変更の前から同じである | この変更の範囲の外。#96 が塞ぐのは、レビューの前に既存の手順が秘密を Pull Request のコードへ渡す経路である |
| `refs/pull/<番号>/head` の取り込みの間の push | event の後に作者が push すると、取り込んだ head が event の SHA と違う | その実行は失敗し、新しい push の `synchronize` の実行が新しい head で探す |
| 既定の規則と nd-factory の規則の探し | `leak-check` は今と同じ範囲を探し、`leak-check-secret` も既定のブランチの設定で同じ範囲を探すので、同じ当たりが 2 つのチェックに出る | 二重に出ても通さない側なので残す（決定 5） |

受け入れ条件の読み方を 3 つ書く。どれも条件の文そのものは変えない。

- #101 の受け入れ条件 2 の「今と同じく…落ちる」は、同じリポジトリのブランチの Pull Request では `leak-check-secret` が落ちることで満たす（決定 3）。main への push は今と同じく `leak-check` が落ちる
- #101 の受け入れ条件 3 の「fork からの Pull Request は、秘密が空でも実際の値の規則を必須にしない」は、`leak-check`（Pull Request の側の実行）で満たす。`leak-check` はどの出所でも秘密を受けず、実際の値の規則を必須にしない。`leak-check-secret` では fork の Pull Request も秘密を受けるので、秘密が空で必須なら落とす（#96 の受け入れ条件 6、決定 3）
- #101 の受け入れ条件 4 は「Dependabot の実行を見分ける条件を使う場合」の条件で、決定 2 はその条件を使わない。CI の定義のテストが、漏れの検査のワークフローに起動した人で分ける条件が無いことを落とす

## テスト設計

| 受け入れ条件・不変条件 | どの振る舞いで縛るか | どう壊したら落ちるべきか |
| --- | --- | --- |
| #96-1・#96-2: 途中のコミットで足して後で消した、秘密の正規表現にだけ当たる値がマージの前に落ちる | 結合のテストで、作り物の正規表現と、その値を足すコミットと消すコミットを持つ作り物のリポジトリを作り、秘密を使う探しのスクリプトに分岐点から head の範囲を渡すと、終了コード 1 で当たりが出る。CI の定義のテストで、`leak-check-secret` が `pull_request_target` で起動し、分岐点から head の範囲をそのスクリプトに渡し、出所で分ける条件を持たない | 範囲を head の木だけにする・`-m`（`leak-scan.sh` が gitleaks に渡す、マージのコミットの差分も出す指定）を外す・fork の Pull Request を飛ばす条件を足すと落ちる |
| #96-3: 秘密を使う手順は既定のブランチのワークフロー・スクリプト・設定だけを動かす | CI の定義のテストで、決定 4 の形（`checkout` の `ref` なし・`setup-node` と `npm` なし・Pull Request の値を `run:` に直に書かない・危険な起動のきっかけはこの 1 本だけ）と、`ci.yml` の Pull Request の実行の手順が `secrets.LEAK_CHECK_PATTERN` を受けないこと | `checkout` に `ref: ${{ github.event.pull_request.head.sha }}` を足す・`npm ci` を足す・Pull Request の手順に秘密を戻すと落ちる |
| #96-4: 秘密を使うジョブのトークンは書き込みの権限を持たない | CI の定義のテストの、最上位とジョブの `permissions` が `contents: read` だけの検査が、新しいワークフローにも掛かる | `pull-requests: write` を足すと落ちる |
| #96-5: 新しい push で探しがやり直され、前の head の結果でマージできない | CI の定義のテストで、`pull_request_target` の `types` を絞らない（既定の 3 つ）か `synchronize` を含み、`concurrency` が Pull Request の番号ごとであること。実際の Pull Request での振る舞いはリリース後に確認する | `types: [opened]` にすると落ちる |
| #96-6: コミットを取れない・探しが途中で失敗すると通らない | 結合のテストで、読めない範囲・gitleaks の失敗で終了コードが 0 以外。CI の定義のテストで、ジョブと手順に `if:` と `continue-on-error` が無く、head の SHA の一致を確認する手順がある | `continue-on-error: true` を足す・範囲の読み取りの失敗を 0 で終えると落ちる |
| #96-7・#101 の非機能: 出力に秘密の正規表現と当たった値が出ない | 結合のテストで、秘密を使う探しのスクリプトの標準出力と標準エラーに、作り物の正規表現の文字列と当たった値が現れない | 重ねた設定のファイルの中身を出す・`--paths` を渡すと落ちる |
| #96-8: 既定の規則と nd-factory の規則で fork の Pull Request の全コミットを探す | CI の定義のテストで、`ci.yml` の `leak-check` の Pull Request の手順が、出所の条件なしに分岐点から head の範囲を既定の規則と `.gitleaks.toml` で探す。今の結合のテストを残す | 範囲を外す・fork で飛ばす条件を足すと落ちる |
| #96-9: main への push は到達できるすべてのコミットを両方の規則で探す | CI の定義のテストで、push の手順が範囲なしで秘密を使う探しのスクリプトを呼ぶ。結合のテストで、範囲なしのときに履歴のすべてを探す | push の手順に `before..after` の範囲を渡すと落ちる |
| #96-10: ワークフローの点検が当たり無しで通る | `workflow-audit` のジョブ。ワークフローの点検の結合のテストで、`dangerous-triggers` のほかの点検（`unpinned-uses` など）が今の設定で当たる | `.github/zizmor.yml` でほかの点検を外すと落ちる |
| #101-1: Dependabot の Pull Request で `秘密 LEAK_CHECK_PATTERN が無い` の誤りで落ちない | 結合のテストで、秘密あり・必須の組では落ちずに探しへ進む。CI の定義のテストで、秘密の名前が `LEAK_CHECK_PATTERN` の 1 つだけ（Dependabot の秘密と同じ名前）。実際の Dependabot の Pull Request ではリリース後に確認する | 秘密の名前を Dependabot 用に分ける・Pull Request の側の `leak-check` に秘密と必須の判定を戻すと落ちる |
| #101-2: Dependabot 以外の同じリポジトリのブランチの Pull Request と main への push は、必須で秘密が空なら終了コード 1 | 結合のテストで、秘密が空・必須の組で終了コード 1 と誤りの行。CI の定義のテストで、push の手順と `leak-check-secret` が必須の変数を受ける | 必須の判定を外す・push の手順から必須の変数を外すと落ちる |
| #101-3: fork の Pull Request は秘密が空でも `leak-check` で実際の値の規則を必須にしない | CI の定義のテストで、`ci.yml` の `leak-check` の Pull Request の手順が秘密も必須の変数も受けない | Pull Request の手順に必須の変数を足すと落ちる |
| #101-4: 人が Dependabot のブランチへ push した実行は Dependabot の実行として扱われない | CI の定義のテストで、漏れの検査の 2 つのワークフローに `github.actor`・`github.triggering_actor`・`dependabot` を使う条件が無い | `if: github.actor != 'dependabot[bot]'` を足すと落ちる |
| #101-5: Dependabot の Pull Request のコミットが探される時点が設計書に書いてある | この設計の決定 2（Pull Request の時に `leak-check-secret` で探す） | — |
| #101-6: 持ち主の操作の手順に Dependabot の秘密の登録が書いてある | 運用の文書 `docs/operations/ci-checks.md` と `AGENTS.md`（決定 6）。文書の検査は持たず、レビューで見る | — |
| #101-7: CI の定義のテストが受け入れ条件 1〜3 の条件分けを定義から読む | 上の #101-1〜3 の CI の定義のテストの行 | — |

## 設計の結果

| 課題 | 扱い | 統合先 | 触るファイル |
| --- | --- | --- | --- |
| #96 | 実装する | — | `.github/workflows/leak-check-secret.yml`（新設）、`.github/workflows/ci.yml`、`.github/zizmor.yml`、`tools/checks/leak-scan-secret.sh`（新設）、`tools/test/ci-definition.test.ts`、`tools/test/leak-scan.integration.test.ts`、`tools/test/workflow-audit.integration.test.ts`、`.ndf/project.json`、`AGENTS.md`、`docs/operations/ci-checks.md`（新設）、`docs/design/platform.md` |
| #101 | マージする | #96 | — |

## 人へ残す判断

| 判断 | 当たるレッドライン | なぜ当たるか |
| --- | --- | --- |
| Dependabot の秘密 `LEAK_CHECK_PATTERN` を Actions の秘密と同じ値で登録する（実装のマージの後に持ち主が GitHub の設定で行う） | C1 | 運用する環境の実際の値という秘密を、もう 1 か所に置く |
| `pull_request_target` を許す Actions のイベントポリシーを作る（持ち主が GitHub の設定で行う） | C1 | fork から起こせる実行が、Actions の秘密を受けられるようになる |
| `.ndf/project.json` の必須のチェックに `leak-check-secret` を足し、`AGENTS.md` の「秘密とインフラの値を置かない」の行を直す（実装の中でコミットする） | C7 | 利用者の設定と指示書を書き換える |

## 未確認のまま残ること

| 項目 | 内容 |
| --- | --- |
| Dependabot が起動した `pull_request_target` の実行が受ける秘密 | GitHub の文書からは、Actions の秘密か Dependabot の秘密かを決められない（STD3）。決定 2 はどちらでも同じ値が渡る形にした。最初の Dependabot の Pull Request の `leak-check-secret` が秘密の欠けで落ちないことで分かる（リリース後の確認） |
| このリポジトリのイベントポリシーの今の状態 | 既定のポリシーが当たっているか、持ち主が作ったポリシーがあるかを、API で確認していない。持ち主が運用の文書の手順を行うときに、設定の画面で分かる |
| `leak-check-secret` の結果が Pull Request の head のコミットに付き、新しい push で保留に戻ること | `pull_request_target` のチェックが Pull Request で数えられることは文書にある（STD4）が、実物の Pull Request ではまだ動かしていない。実装のマージの後の最初の Pull Request で分かる（リリース後の確認） |
| fork の Pull Request の `refs/pull/<番号>/head` を、資格情報を残さないチェックアウトから取り込めること | 公開のリポジトリなので取り込めると見ているが、実行していない。実装のマージの後の最初の Pull Request の記録で分かる |

## 外部の調査

| 種類 | 調べるか | 理由 |
| --- | --- | --- |
| 標準・仕様 | 調べる | GitHub Actions の `pull_request_target`・Dependabot の実行・必須のチェックの数え方は、GitHub の文書が決める |
| 主要な製品 | 調べる | 秘密のパターンでの探しを GitHub と GitLab がマージの前にどう掛けているかを比べる |
| ライブラリとサービス | 調べる | 今使う gitleaks と zizmor が、この起動の形で使えるか・点検がどう当たるかを決める |

### 標準・仕様

| # | 標準・仕様 | 何を定めているか | 設計への反映 | 出典 |
| --- | --- | --- | --- | --- |
| STD1 | GitHub Docs「Events that trigger workflows」の `pull_request_target` と「Securely using pull_request_target」 | `pull_request_target` は既定のブランチの文脈で動き、ワークフローと `ref` なしの `actions/checkout` は既定のブランチのもの。秘密と既定のブランチの `GITHUB_TOKEN` を受ける。既定の起動は `opened`・`synchronize`・`reopened`。Pull Request のコードを（`git fetch` で取ったものも含め）動かすと危険で、取ったコードはデータとして扱う。トークンの権限は最小にする | 決定 1・4（既定のブランチのチェックアウト、取り込んだコミットを動かさない、`contents: read`） | https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows ・ https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target （2026-11-24） |
| STD2 | 同「Default policy for `pull_request_target`」 | 公開のリポジトリで、既定のイベントポリシーが `pull_request_target` を止める。今は評価のモードで、2026-12-02 から適用する。続けて使うには、明示して許すイベントポリシーを作る | 決定 1 の代償・影響と危険・人へ残す判断（持ち主がポリシーを作る） | https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target （2026-11-24） |
| STD3 | GitHub Docs「Troubleshooting Dependabot on GitHub Actions」 | Dependabot が起動した `push`・`pull_request` などの実行は fork と同じ扱いで、読み取りだけのトークンを受け、使える秘密は Dependabot の秘密だけ。直し方として `pull_request_target` を含む 2 つのワークフローに分ける形と、同じ名前で Dependabot の秘密を登録する形を挙げる | 決定 2（同じ名前で 2 か所に登録し、起動した人で分けない） | https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-on-actions （2026-11-24） |
| STD4 | GitHub Docs「Troubleshooting required status checks」 | 必須のチェックは最新のコミットで通る必要がある。Pull Request で数えられるジョブのチェックは `push`・`pull_request`・`pull_request_review`・`pull_request_target`・`deployment`・`deployment_status` で起動したものだけ（`workflow_run` は入らない）。条件で飛ばしたジョブは成功と報告される | 決定 1（`workflow_run` を採らない）・非機能（`if:` を置かない）・処理の流れ（新しい head で数え直す） | https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks （2026-11-24） |

### 主要な製品

| # | 製品 | どう解いているか | 設計への反映 | 出典 |
| --- | --- | --- | --- | --- |
| PRD1 | GitHub の secret scanning と push protection | 独自のパターンはリポジトリの Secret Protection で持ち、push protection はそのリポジトリへの push で止める。当たりは警告として出る | 決定 1 で採らない（fork への push はこのリポジトリで受けず、マージの前のチェックにならない） | #1 の設計の外部の調査の PRD1（`docs/design-process/issue-1/design.md`、2026-11-21） |
| PRD2 | GitLab の Secret Detection | パイプラインで gitleaks の規則を使って探す | 決定 1（規則を gitleaks の設定に持ち、CI で探す形を保つ） | #1 の設計の外部の調査の PRD2（`docs/design-process/issue-1/design.md`、2026-11-21） |

### ライブラリとサービス

| # | 候補 | バージョン | ライセンス | 最後のリリースの日付 | 終了のアナウンス | 要件を満たすか | 出典 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| LIB1 | gitleaks（CLI） | v8.30.1 | MIT | 2026-03-21 | 無し | 満たす。`gitleaks git --log-opts` は git の履歴を読むだけで、探す範囲のコミットのファイルを動かさない。取り込んだ参照の範囲をそのまま渡せる | #1 の設計の外部の調査の LIB1（2026-11-21）・`tools/checks/leak-scan.sh` |
| LIB2 | zizmor | v1.32.0 | MIT | 2026-11-02 | 無し | 使い続ける。`dangerous-triggers` は `pull_request_target`・`workflow_run`・`issue_comment`（v1.31.0 から）を当て、Pull Request のコードを動かさないだけでは安全と言えない（引数・環境変数への注入）と書く。点検に設定の項目は無い。v1.32.0 を要約値で照合して取り、`pull_request_target` の作り物のワークフローを `--offline --no-ignores --config .github/zizmor.yml` で打つと終了コード 14。`rules.dangerous-triggers.ignore` は `--no-ignores` の下で効かず（14）、`--no-ignores` なしでは効いた（0）。`rules.dangerous-triggers.disable: true` は `--no-ignores` の下でも効いた（0） | https://github.com/zizmorcore/zizmor/blob/main/docs/audits.md ・ https://github.com/zizmorcore/zizmor/blob/main/docs/configuration.md ・ https://github.com/zizmorcore/zizmor/blob/main/docs/usage.md （2026-11-24）。配布の v1.32.0 を手元で打った（2026-11-24） |

### 確かめられなかったこと

| 対象 | 試した手段 | 結果と理由 |
| --- | --- | --- |
| Dependabot が起動した `pull_request_target` の実行が受ける秘密 | STD3 の文書と、検索の語 `GitHub Actions Dependabot pull_request_target secrets "base ref" created by Dependabot GITHUB_TOKEN` | 今の文書は、Dependabot の実行で使える秘密は Dependabot の秘密だけと書く一方、`pull_request_target` はこの制限を持たないとも書く。古いバージョンの文書は「Pull Request の基のブランチを Dependabot が作ったとき」に限っていた。どちらが今当たるかを文書から決められない |
| `pull_request_target` のチェックが付くコミット | 検索の語 `pull_request_target workflow check run attached to pull request head commit required status check branch protection` と STD4 | Pull Request で数えられることは STD4 にあるが、付くコミットを直に書いた文書は見つからなかった |

調べた量: 候補 8 件・取得の試み 10 回。
