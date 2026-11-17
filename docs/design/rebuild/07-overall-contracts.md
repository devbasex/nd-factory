# 作り直しの全体設計: NDF との契約と入出力の規約

頭の文書は [05-overall.md](05-overall.md) にある。この文書は、NDF との契約と、入出力の規約と形の正本を扱う。NDF との契約は、作り直しの調査（NDF の目指す姿と契約。旧い側。移していない）の 2 節の表の 28 行である。

## NDF との契約

### 固定の点

NDF の契約は、devbasex/ai-plugins の develop のコミット `70f5fe685` の `plugins/ndf-next/contracts/` で固定する。契約の版は `contracts/version.json` の版 4（`/history/3`、8 行目）である。表の中では `C/` を `plugins/ndf-next/contracts/` の略として使う。行番号は `git show 70f5fe685:<パス> | grep -n` で読んだ値である。

NDF 11.0.0 が出たら、固定の点をそのタグへ付け替え、契約の照合のジョブ（[下](#契約の照合のジョブ)）で食い違いを確かめてから、[契約の表](#契約の表)の位置を書き直す。

### 版の数字と内部のスクリプトに依らない

nd-factory は次の 2 つの経路を持たない。検査（#1）がコードの中のこの 2 つを落とす。

| 持たない経路 | 代わりに使うもの |
| --- | --- |
| NDF の版の数字（`NDF_VERSION` の値や `plugin.json` の版）を比べて、NDF の機能を判断する | 契約の版（`C/version.json` の版と sha256）を、nd-factory の 1 か所に置いた対応する版の集合と照らす。`ndf capabilities` が NDF に入ったら、機能の名前で判断する |
| NDF の内部のスクリプト（`plugins/ndf/scripts/*.py`・`src/ndf/` のモジュール）を直に呼ぶ、NDF の状態のファイルを直に書く | 契約の表のエントリポイント（Skill の起動・`ndf-next` ブロック・区間の報告・hook・置き場のファイル・`gate`）と、`ndf answer`・`ndf lanes` の副命令だけ |

使う NDF の固定の値（11.0.0 が出る前は開発版の SHA、出た後はタグ）は、新しいリポジトリの 1 か所に置く（[判定の規則](01-rules.md)の R10）。

### 契約の表

「契約」の列の値は次の 3 つで、行の数は合わせて 28 行である。

| 契約 | 意味 | 行数 | 行 |
| --- | --- | ---: | --- |
| 有る | 契約ファイルが項目を持つ | 9 | 1・2・4・5・8・9・10・11・25 |
| 一部 | 契約ファイルが項目の一部を持ち、残りは仮置き | 8 | 3・6・13・15・18・20・23・26 |
| 仮置き | 契約ファイルに項目が無く、nd-factory が暫定の決定を置く（NDF の側で決まったら差し替える） | 11 | 7・12・14・16・17・19・21・22・24・27・28 |

| # | 項目 | 契約ファイルのパス | 項目の位置 | 契約 | nd-factory の扱い | 決まる先の NDF の課題 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 関係の型 | `C/domains/entrypoints.json` | `/summary`（2 行目） | 有る | NDF が上流、nd-factory が下流で、公開された言語でやり取りする。NDF の集約を直に書かず、完了の規則を組み直さない（決定 2） | — |
| 2 | 呼べる口 | `C/domains/entrypoints.json`・`C/domains/skill-io.json` | entrypoints `/rows/0`〜`/rows/14`（16〜30 行目）、列 `/columns/kind`（5 行目）・`/columns/env`（9 行目）。skill-io `/summary`（2 行目） | 有る | 呼ぶのは表の 15 の口だけ。公開か内部かの列は無く、表に載る口を公開の口として扱う。環境変数は各行の `env` 列の名前だけを入れる | — |
| 3 | 人のいない実行 | `C/domains/env.json`・`C/domains/entrypoints.json`・`C/domains/entrypoint-cases.json` | env `/rows/45`（58 行目）。entrypoints `/rows/2/args`（18 行目）。cases `/rows/10`〜`/rows/12`（22〜24 行目） | 一部 | `NDF_FACTORY_RUN` を空でない値で入れる。結果の値は `判断が要る`・`完了`・`できなかった` の 3 つ。最後の `- 結果:` の行で決める読み方は契約ファイルに無く（`skills/development-workflow/references/asking.md` の 97 行目だけ）、仮置きにする（決定 18） | devbasex/ai-plugins#3242・devbasex/ai-plugins#3329 |
| 4 | サービスが入れる環境変数 | `C/domains/env.json`・`C/domains/entrypoints.json` | env の `set_by: service` の行 `/rows/45`〜`/rows/49`（58〜62 行目）・`/rows/53`（66 行目）。`NDF_STATE_HOME` は `/rows/2`（15 行目、`set_by: user`）、`NDF_ORGANIZER_DIR`・`NDF_ORGANIZER_LANE` は `/rows/43`〜`/rows/44`（56〜57 行目、`set_by: ndf`）。entrypoints の各行の `env` 列（16・17・22・27 行目）がこの 3 つを入れてよい名前に挙げる | 有る | 入れるのは `NDF_FACTORY_RUN`・`NDF_VERSION`・`NDF_LOOP_EXCLUDE`・`NDF_ISSUE_REQUEST_FILE`・`NDF_MVV_STATE_DIR`・`NDF_PROGRESS_DB`（秘密）と、口の `env` 列が許す `NDF_STATE_HOME`・`NDF_ORGANIZER_DIR`・`NDF_ORGANIZER_LANE`（組で）。名前の一覧は契約のコピーから生成する | — |
| 5 | 端末向けの前提を渡さない | `C/domains/entrypoint-cases.json`・`C/domains/env.json` | cases `/rows/9`（21 行目、`valid: false`）。env `/rows/11`（24 行目、`NDF_RELAY_NAME`） | 有る | 中継・リレーハブ・アカウント・tmux・statusline の系の変数を、ランナーが子のプロセスへ渡す前に消す | — |
| 6 | DB と DBOS の system database | `C/domains/env.json` | `/rows/53`（66 行目、`NDF_PROGRESS_DB`・`secret: true`） | 一部 | URL の受け渡しだけが契約にある。DBOS が使う機能（advisory lock・LISTEN の常時接続・keepalive。`src/ndf/core/durable.py` の 412・743・758・766・767 行目、`durable_locks.py` の 300・317 行目）と 14 日の消去（`durable_sweep.py` の 27 行目）は契約ファイルの外で、仮置きとして受ける（[状態の置き場](08-overall-state-infra.md#進行表の-db)） | devbasex/ai-plugins#2608 |
| 7 | 名前空間（多テナント） | 無し | — | 仮置き | `NDF_NAMESPACE` が無い間は、プロジェクトごとにデータベースとログインの役割を分ける（決定 7） | devbasex/ai-plugins#3694 |
| 8 | 進捗の行き先 | `C/domains/ndf-files.json`・`C/workflow/progress.json` | ndf-files `/columns/reader`（14 行目）。progress `/events`（29〜65 行目）・`/gates`（67〜70 行目） | 有る | ランナーは `reader: service` の 9 行のファイルだけを読み、進捗の事象へ翻訳する。進行表の DB への寄せは NDF の構想で、来たら翻訳の入力を差し替える | — |
| 9 | 進捗の行き先（続き） | `C/domains/ndf-files.json` | `/rows/41`〜`/rows/44`（59〜62 行目）・`/rows/48`（66 行目）・`/rows/52`〜`/rows/55`（70〜73 行目） | 有る | 読むのは `progress.jsonl`・`loop.json`・`ask.jsonl`・`gate-rejections.jsonl`・オーガナイザーの依頼・提示・進捗・結果・起票の依頼。オーガナイザーが書く側の 3 行（67〜69 行目）は読まない | — |
| 10 | 承認の答えの口 | `C/schemas/io/answer.args.schema.json` | `/oneOf/0/properties`（10〜54 行目）・`/oneOf/0/required`（55〜62 行目）。`--by` の説明（29 行目） | 有る | `ndf answer <table_id> --gate --result --reason --by service:<利用者の ID> --key <答えの ID>` で渡す。任意の `--head`・`--material-sha256` は承認資料の要約値を渡す。ファイルを直に書かない | — |
| 11 | 承認ゲートの名前 | `C/domains/entrypoints.json`・`C/domains/entrypoint-cases.json` | entrypoints `/rows/11/args`・`/rows/11/order`（27 行目）。cases `/rows/14`（26 行目）・`/rows/15`（27 行目、`gate1` は `valid: false`） | 有る | 正の名前「設計承認ゲート」「リリース承認ゲート」だけを API・画面・事象の値に使う。旧名を持たない | — |
| 12 | 承認を守る | `C/schemas/io/answer.args.schema.json` | `--by` が `service:<主体>` を受ける（29 行目）。信用の規則は無い | 仮置き | 防ぐ守りと照らす守りの 2 つを置く（決定 11、[承認ゲートを無効にさせない守り](09-overall-trust.md#承認ゲートを無効にさせない守り)） | devbasex/ai-plugins#3364 |
| 13 | レーンと計画 | `C/workflow/parallel-plan.schema.json`・`C/schemas/io/lanes.args.schema.json`・`C/schemas/io/lanes.result.schema.json` | plan `/required`（8 行目）・`/properties/lanes`（15 行目）・`additionalProperties: false`（7 行目）。args の init `/oneOf/1`（34 行目）・status `/oneOf/18`（556 行目）。result `/properties/items`（194 行目）・`/properties/metrics`（15 行目） | 一部 | 計画の設定ファイルを `ndf lanes init` へ渡し、`ndf lanes status` の `items` と `metrics` を読む。`epic`・`epic_state`・`done_checked` などのイベントは契約に無く、使わない（宣言のスキーマが `epic` を拒む） | devbasex/ai-plugins#3600 |
| 14 | 実行の単位 | 無し（`docs/ndf-parallel-model.md` の 178〜227 行目だけ） | — | 仮置き | レーンをコンテナへ割り当て、コンテナがループを回す。答えはコンテナが指示の問い合わせで取りに行く。ホステッドのレーンでは、承認の待ちが猶予（既定 5 分）を超えたら、NDF のファイルを状態の S3 へ固めてタスクを止め、答えの確定で同じレーンに新しいタスクを起こし直す。割り当ては外さない（決定 25、[承認の待ちの間の扱い](08-overall-state-infra.md#進行表の-db)） | devbasex/ai-plugins#2608 |
| 15 | 状態の寿命 | `C/domains/ndf-files.json` | `/columns/ends`（11 行目。kept・replaced・cleanup・run・archived） | 一部 | 永続（進行表の DB と状態の S3）・実行の間（タスクの手元）・使い捨ての 3 つで置き場を分ける（[状態の置き場](08-overall-state-infra.md#状態の置き場)）。SIGTERM のときに途中までのファイルを状態の S3 へ置く | devbasex/ai-plugins#2606・devbasex/ai-plugins#2608 |
| 16 | ログ | 無し | — | 仮置き | スプリントの実行・レーン・セグメントの ID をログの項目に入れ、CloudWatch Logs へ送る。NDF のログの書き口が決まったら出力先を差し替える | devbasex/ai-plugins#2608・devbasex/ai-plugins#2338 |
| 17 | 分析の記録 | 無し | — | 仮置き | 作り直しでは持たない。NDF の形が決まったら、サービスの表に同じ形で足す | devbasex/ai-plugins#2749 |
| 18 | 複数リポジトリ | `C/workflow/parallel-plan.schema.json` | `/$defs/lane/properties/after`（28 行目）・`/$defs/lane/properties/repo`（29 行目） | 一部 | 1 レーン 1 リポジトリ。またがる作業はレーンの `repo` と `after` で表す。参照は `owner/repo#N` の形。プロジェクトの宣言の形は仮置き（決定 4） | devbasex/ai-plugins#2653 |
| 19 | NDF の版の下限 | `C/domains/entrypoint-cases.json`（契約の見本だけ） | 12〜37 行目（26 件） | 仮置き | 版の数字で判断しない（[版の数字と内部のスクリプト](#版の数字と内部のスクリプトに依らない)）。`ndf capabilities` は無く、契約の版で判断する（決定 17） | devbasex/ai-plugins#3694 |
| 20 | 契約の版 | `C/version.json` | `/history/3`（8 行目、版 4 と sha256） | 一部 | 対応する契約の版の集合を nd-factory の 1 か所に置き、起動のときに照らす。面ごとの版は NDF に無い | devbasex/ai-plugins#3694 |
| 21 | 事象の流れ・取り消し・締め切り | 無し | — | 仮置き | `ndf events --follow` が無い間は、ランナーが NDF のファイルを読んで進捗の事象を送る（決定 20）。取り消しは SIGTERM で止める | devbasex/ai-plugins#3694 |
| 22 | モデルの選択 | 無し | — | 仮置き | nd-factory はモデルを渡さない。画面にモデルの設定を置かない | devbasex/ai-plugins#3612 |
| 23 | 上限と再試行 | `C/limits.json` | `/policies/supervise.limit-retry/seconds`（155 行目、900 秒）・`/policies/supervise.limit-wait-max`（156 行目） | 一部 | 上限の既定値は NDF の宣言に任せ、nd-factory は区間の上限を独自に持たない。上書きの順は仮置き | devbasex/ai-plugins#2343 |
| 24 | MCP | 無し | — | 仮置き | MCP は nd-factory だけの面（`/mcp`）で、NDF の契約に含めない。外の呼び手の面が NDF に入ったら見直す | devbasex/ai-plugins#3694 |
| 25 | 起票 | `C/domains/env.json`・`C/domains/ndf-files.json`・`C/domains/entrypoints.json`・`C/domains/places.json` | env `/rows/48`（61 行目）。ndf-files `/rows/55`（73 行目、`repo`・`title`・`body`・`labels`）。entrypoints `/rows/10`（26 行目）。places の issue-request（27 行目） | 有る | 依頼の 1 行を受け、起票するかをサービスが決める。起票しないときは理由を残す（E11） | — |
| 26 | 設定ページ | `C/domains/entrypoints.json`・`C/schemas/declarations/` | `/rows/13`（29 行目）・`/rows/14`（30 行目） | 一部 | 作り直しでは作らない。宣言の JSON Schema からページを作る形が決まったら足す | devbasex/ai-plugins#3518・devbasex/ai-plugins#3519 |
| 27 | 承認資料の見せ方 | 無し | — | 仮置き | 承認資料は 1 件 1 行のリンクと要旨で見せる | devbasex/ai-plugins#2721 |
| 28 | 資源の監視 | 無し | — | 仮置き | 作り直しでは持たない。ECS のタスクの CPU とメモリは CloudWatch の既定の指標だけを使う | devbasex/ai-plugins#2710 |

### 区間の結果の行

区間が終わったら、ランナーは区間の出力の最後の `- 結果:` の行を読む（決定 18）。

| 出力 | 扱い |
| --- | --- |
| 最後の `- 結果:` の行の値が `完了` | 区間を成功で閉じ、次の区間か終わりへ進む |
| 同じく `判断が要る` | 区間を成功で閉じ、セグメントを承認の依頼か判断の待ちで止める。人の答えを待ち、答えから次のセグメントを始める（E8） |
| 同じく `できなかった` | 区間を失敗にし、その区間を含むセグメントを失敗で閉じる。理由の行を進捗の事象に残す |
| `- 結果:` の行が無い | 区間を失敗にし、セグメントを失敗で閉じる。理由は「結果の行が無い」 |
| 値が 3 つのどれでもない（例: `保留`。`C/domains/entrypoint-cases.json` の 22〜24 行目の見本） | 区間を失敗にし、セグメントを失敗で閉じる。理由は「契約に無い値」と、読んだ値 |

区間とセグメントの関係は、[用語](05-overall.md#用語)の表のとおり、1 つのセグメントが 1 つ以上の区間からなる（I6）。失敗で閉じたセグメントは自動で繰り返さない。人がレーンの画面から再開を指示する。

### 契約の照合のジョブ

| 項目 | 中身 |
| --- | --- |
| いつ | 毎日 1 回と、NDF の固定の点を変える PR |
| 何に照らすか | 固定の点の契約ファイルと、devbasex/ai-plugins の develop の先端の契約ファイル（読むだけ） |
| 何を照らすか | `C/domains/entrypoint-cases.json` の 26 件を、ランナーの呼び出しの組み立てと翻訳へ通し、`valid` の値と同じ判定になるか。`C/version.json` の版と sha256 が、nd-factory の対応する契約の版の集合にあるか。`C/domains/env.json` の `set_by: service` の名前の集合が、生成した環境変数の一覧と同じか |
| 失敗したとき | 運用する人へ知らせ（E14）、食い違った見本の行（`entrypoint` と `call`）と契約ファイルの位置を本文に並べる。develop の先端だけが食い違うときは、固定の点を変えずに知らせだけを出す |
| 受け持つ子 | 検査（#1） |

### 仮置きの一覧

契約が「一部」か「仮置き」の行を、決まる先の課題ごとに並べる。NDF の側で決まったら、その行の扱いを差し替える。devbasex/ai-plugins は改修を止めているため、作り直しの作業から NDF の課題を起こさない。

| 決まる先 | 行 |
| --- | --- |
| devbasex/ai-plugins#3242・devbasex/ai-plugins#3329 | 3 |
| devbasex/ai-plugins#2608 | 6・14・15・16 |
| devbasex/ai-plugins#2606 | 15 |
| devbasex/ai-plugins#3694 | 7・19・20・21・24 |
| devbasex/ai-plugins#3364 | 12 |
| devbasex/ai-plugins#3600 | 13 |
| devbasex/ai-plugins#2338 | 16 |
| devbasex/ai-plugins#2749 | 17 |
| devbasex/ai-plugins#2653 | 18 |
| devbasex/ai-plugins#3612 | 22 |
| devbasex/ai-plugins#2343 | 23 |
| devbasex/ai-plugins#3518・devbasex/ai-plugins#3519 | 26 |
| devbasex/ai-plugins#2721 | 27 |
| devbasex/ai-plugins#2710 | 28 |

## 入出力の規約と形の正本

### 正本と生成元

形の正本は `packages/contracts/`（TypeScript）の 1 か所に置き、ほかの表現はすべてそこから生成する（決定 12・13）。CI の往復の検査（#1）が、生成し直した結果と、リポジトリに置いた生成物が同じかを照らす。

| 入出力 | 正本 | 生成元と生成するもの |
| --- | --- | --- |
| API の経路と形 | `packages/contracts/` の操作の表（経路・メソッド・入力と出力の zod の形・人だけが確定できるかの印・使える量の判定の要否） | zod-openapi で OpenAPI の文書、`z.toJSONSchema` で JSON Schema、`z.infer` で TypeScript の型。API の経路の登録と MCP のツールの一覧も、同じ操作の表から作る |
| 型 | 同上の zod の形 | `z.infer`。手で型を書かない |
| JSON Schema | 同上の zod の形 | `z.toJSONSchema`（draft 2020-12）。表せない型（日時など）は文字列の形式で持つ |
| 環境変数 | `packages/contracts/` の環境変数の表（名前・意味・必須か・秘密か・読む構成要素） | 各構成要素の起動のときの検証、CDK が Lambda とタスクへ渡す値の組み立て、`.env.example`、文書の環境変数の表。NDF へ渡す変数は契約のコピー（`C/domains/env.json`）から生成する |
| CDK のパラメーター | `packages/contracts/` の設定のファイルの形（zod） | 設置のコマンドの入力の検証、設定のファイルの JSON Schema、作り物の値の見本 |
| 終了コード | `packages/contracts/data/exit-codes.json` | 設置のコマンドと検査のスクリプトの終了コードの定数、文書の表。NDF の終了コード（`C/facts/exit-codes.json`）は NDF の側の正本で、nd-factory は読むだけ |

設定のキーごとに、読む構成要素が 1 つ以上あることを検査で確かめる（読み手の無いキーを置かない）。

### API の規約

| 規約 | 中身 |
| --- | --- |
| 機能から起こした契約 | 経路と入出力を、画面の 1 枚でなくエンティティと操作から決める |
| 配列で受け渡す | 取得・作成・更新・削除とも本文は配列で受け渡す。1 件のときも要素 1 個の配列にする（I12）。応答は要素ごとの結果を持つ |
| 同じ API | 画面・API の呼び手・MCP のツールは、同じ操作の表の同じ操作を同じ API で呼ぶ。画面にしか無い操作も、API と MCP にしか無い操作も作らない（プロジェクト MVV の Value 4） |
| 人だけが確定できる操作 | 操作の表の印で決める。委任の資格情報とレーンの token からの要求は 403 で断る。API と MCP からは依頼と材料を読める |
| 失敗の形 | 500 を返さない。失敗の種類は形の正本の enum。見えないプロジェクトは 404 |
| 冪等 | 作成は冪等の鍵を要求ごとに 1 つ受け、24 時間は同じ鍵の 2 回目に同じ応答（要素ごとの結果を含む）を返す。結果は配列の要素ごとに持つ |
| 日時と言語 | 日時は UTC で受け渡し、画面が利用者の時刻帯で表示する。文言は画面の翻訳のファイルが持ち、API は文言でなく理由のコードを返す |
| 後方互換 | 公開の前は持たない（[判定の規則](01-rules.md)の要求の Q3）。公開の後の方針は #14 で決める |
