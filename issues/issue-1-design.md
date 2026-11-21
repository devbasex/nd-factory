# 検査: 値の漏れと設計の決まりの破れと NDF の契約の食い違いを、Pull Request ごとと定期の CI で落とす（#1）

全体の設計が「検査が落とす」と決めた決まり（実際の値と秘密を置かない・横断の部品を 1 か所に置く・依存の向き・使える量の判定は 1 か所・画面の操作はすべて API と MCP にもある・NDF の契約に載るものだけでやり取りする）のうち、今の CI が落とせるのは参照の検査と CI の定義のテストだけである。構文で見つかる破れは ESLint の組み込みの規則を置き場ごとに設定して今の `check` で落とし、形の往復と I14 の対応はリポジトリを読む単体テストで、漏れと NDF の契約の照合は資格情報を持たない新しい 2 つのジョブで落とす。形の正本の側（操作の表・生成物・受ける契約の組）は #2 が作り、この設計は検査がそこから何を読むかと、#2 へ渡す欠けを決める。比べた案は「決定の記録」に、候補の調べは「外部の調査」にある。

## 今の姿

何が起きたか・目的・受け入れ条件は要求仕様（[issue-1-requirements.md](./issue-1-requirements.md)、正は #1 の本文）にある。この文書は「どう解くか」と「なぜその解き方か」だけを書く。

```mermaid
flowchart LR
    pr["Pull Request"] --> ci["ci.yml"]
    ci --> check["check<br/>lint・型・生成物の差・単体テスト"]
    ci --> synth["synth"]
    ci --> e2e["e2e"]
    ci --> ref["ref-check<br/>照合の語・固定の値・版の比べ"]
    check --> cidef["CI の定義のテスト<br/>ci.yml だけを読む"]
    decl[".ndf/project.json<br/>必須のチェック 4 つ"] -.照らす.- cidef
    missing["無い: 漏れ・形の往復・境界・依存の向き<br/>I8・I14・NDF の契約の照合（F23）"]
```

検査の置き場と落とすものは全体の設計が決めてある（[土台の検査](../docs/design/platform.md#検査)・[API と MCP の照らす検査（I14）](../docs/design/api.md#照らす検査i14)・[実行の契約の照合の定期の検査](../docs/design/execution.md#契約の照合の定期の検査)・[詳細設計のファイル配置](../docs/design/detail.md#クラスと関数の構造)）。設計に要る今の構造は次のとおり。

| 今あるもの | 中身 |
| --- | --- |
| 参照の検査（`tools/ref-check/src/ref-check.ts`） | `git grep` で追跡しているファイルをすべて読む。照合の語（作り直す前の旧いリポジトリの名前や組織の名前など、参照の検査が残っていないかを探す語）は CI の秘密 `REF_CHECK_TERMS` から受け、当たりは「種類・ファイル・行」だけを出し、語を出さない。語を必須にするのは変数で有効にした正本のリポジトリの中の実行だけ |
| CI の定義のテスト（`tools/test/ci-definition.test.ts`） | `ci.yml` のジョブの名前の集合と `.ndf/project.json` の `ci.required_checks` を照らし、`ci.yml` の中の AWS の資格情報の語を落とす |
| ESLint（`eslint.config.js`、`check` の中の `npm run lint`） | 推奨の規則と型の import の規則だけ。置き場ごとの規則は無い |
| 骨組みのコード | `apps/api/src/users-handler.ts` が AWS SDK のクライアントを直に作り、引数なしの `new Date()` と `console.log` を使う。`apps/web/src/main.ts` が `window.fetch` を、`apps/web/src/users-client.ts` が `/v1/users` を直に書く。#2 が横断の部品へ移す（#2 の本文の「骨組みのコードから引き継ぐ形」）、#4 が `PUT /v1/users` を置き換える |
| 照らす相手 | 操作の表・生成した MCP の道具の一覧と HTTP の経路の登録・横断の部品（`packages/core`）・料金プランの値・受ける契約の組は、まだ無い（#2・#29）。形の正本は、型・JSON Schema・OpenAPI・MCP の道具の一覧などを生成する元になる zod の定義と操作の表を置く `packages/contracts` である。横断の部品は、時計・ID・ログと伏せ字・外部の呼び出し・再試行・認可の判定などを 1 か所にまとめ、`apps/` が直に使わずに通す `packages/core` の部品である |
| NDF の契約 | #41 の設計（PR #42、承認待ち）で、固定の点は ndf v11.0.12、置き場は `plugins/ndf/contracts/`、受ける組（nd-factory が受け入れる契約の版と、その版の契約の中身の sha256 の対の集まり）は `{版 8, ed8b0365…}`、F23 が予告として読む先は ai-plugins の既定の枝の先端になる（#41 の決定 104・107・108） |

## 文脈と制約

- CI は AWS の資格情報を持たない（Value 8、`AGENTS.md`）。足すワークフローも `permissions: contents: read` だけで動く
- 照合の語と実際の値はリポジトリに置かない。当たりの出力にも値を出さない。CI の記録は公開される（Value 7）
- 依存の向きの決まりで、`tools` が import してよいのは `packages/contracts` だけで、ほかの置き場は文字として読む（[詳細設計の依存の表](../docs/design/detail.md#クラスと関数の構造)）。検査はランナーや横断の部品のコードを import できない
- 境界の検査の対象は `apps/` の 5 つの置き場の実行時のコードで、`packages/core`・`infra/`・`tools/` は外す（土台の決定 91）
- 照らす相手がまだ無い検査は、相手が無いことで落とさずに通り、わざと違反を入れた入力で落ちることをテストで示す（要求の前提 2）
- 全体の設計で決めた「落とすもの」の集合は変えない（要求の前提 1）。#41 の決定が承認で変われば、この設計の F23 の節を直す
- #2（K2）の設計が同時に進む。形の往復と、検査が読む形の正本のデータは、両方の課題の境目に当たる（実行計画の変更重複）
- `ndf_ref` を読む行に大小の比べの記号を置くと参照の検査が落ちる。この文書も追跡するファイルとして読まれる

## 解き方の全体像

```mermaid
flowchart TB
    subgraph ci["ci.yml（pull_request・main への push）"]
        check["check"]
        ref["ref-check"]
        leak["leak-check（新設）"]
        synth["synth"]
        e2e["e2e"]
    end
    subgraph nc["ndf-contract.yml（新設。pull_request・push・毎日・手動）"]
        ndfc["ndf-contract"]
    end
    check --> lint["ESLint の置き場ごとの規則<br/>境界・依存の向き・I8・画面の HTTP の経路"]
    check --> unit["リポジトリを読む単体テスト<br/>形の往復・I14・CI の定義（すべてのワークフロー）"]
    leak --> shapes["packages/contracts/data/secret-shapes.json<br/>と CI の秘密 LEAK_CHECK_TERMS"]
    ndfc --> up["devbasex/ai-plugins の<br/>固定の点と既定の枝の先端の契約"]
    ndfc --> use["形の正本の NDF の契約の使い方（#2）"]
    decl[".ndf/project.json の必須のチェック 6 つ"] -.CI の定義のテストが照らす.- ci
    decl -.-> nc
```

- 構文で見つかる破れ（横断の部品の外での直の利用・依存の向きに反する import・料金プランの値の判定の外での import と名前の比べ・画面の HTTP の経路の直書き・API の振り分けと API Gateway の定義への HTTP の経路の手書き）は、`eslint.config.js` が `tools/checks/` の規則の組を置き場ごとに読み込み、今の `check` が落とす
- 形の往復と I14 の対応は、形の正本と生成物を読む単体テスト（`tools/test/`）が落とす。I15（日時は時刻帯つきの UTC で、金額は `amount_minor` と `currency` の組で受ける）と I12（利用者向けの操作の要求と応答は配列で、1 件も配列の 1 要素として扱う）の形もここで照らす（どちらも [API と MCP の文書](../docs/design/api.md) の不変条件）
- 漏れの検査は新しいジョブ `leak-check` が、秘密の形のデータと CI の秘密の実際の値で、`docs/` を含む追跡しているファイルを探す
- NDF の契約の照合は新しいワークフローのジョブ `ndf-contract` が、固定の点を変えた Pull Request・main への push・毎日 1 回・手動で照らし、ほかの Pull Request では照らさずに通る
- 必須のチェックは 6 つ（`check`・`synth`・`e2e`・`ref-check`・`leak-check`・`ndf-contract`）になり、CI の定義のテストがすべてのワークフローを読んで宣言との食い違いと資格情報の語を落とす

## 構成要素

| 要素 | 責務 | 走るジョブ |
| --- | --- | --- |
| 規則の組（`tools/checks/src/lint-rules.ts`、新設） | 境界・依存の向き・I8・画面の HTTP の経路の直書きを、ESLint の組み込みの規則（`no-restricted-imports`・`no-restricted-syntax`・`no-restricted-globals`・`no-restricted-properties`）の設定として置き場ごとに組む。期限つきの控え（下の決定 5）を外す置き場として持つ | `check` |
| 漏れの検査（`tools/checks/src/leak-check.ts`、新設） | 形の当たりと実際の値の当たりを探し、「種類・ファイル・行」だけを出す | `leak-check` |
| 秘密の形のデータ（`packages/contracts/data/secret-shapes.json` と形 `packages/contracts/src/secret-shapes.ts`、新設） | 値の形（私有鍵の頭・token の頭）と、漏れの検査が使うインフラの値の形（アカウント ID・ARN・資源の ID・端点）と、作り物の値の一覧を持つ。#2 の伏せ字も同じファイルを読む | — |
| 形の往復の検査（`tools/checks/src/round-trip.ts`、新設） | 操作ごとの見本とその変形を、zod の形・生成した JSON Schema・OpenAPI の要素の形・MCP の道具の入力の形の 4 つで検証し、結果が食い違う組を返す。I15 と I12 の形も照らす | `check`（単体テスト） |
| I14 の対応の検査（`tools/checks/src/operation-coverage.ts`、新設） | 操作の表・MCP の道具の一覧・HTTP の経路の登録・画面が呼ぶ操作の名前・機能 F1〜F20 を突き合わせ、欠けと余りを返す | `check`（単体テスト） |
| NDF の契約の照合（`tools/checks/src/ndf-contract-check.ts`、新設） | 固定の点と既定の枝の先端の契約を取り、形の正本の NDF の契約の使い方（#2）と照らす。固定の点の食い違いで失敗し、先端だけの食い違いは要約に並べる | `ndf-contract` |
| CI の定義のテスト（`tools/test/ci-definition.test.ts`、変更） | `.github/workflows/` のすべてのワークフローを読み、Pull Request で走るジョブの集合と必須のチェックの宣言の一致・資格情報の語の無さ・足したジョブの権限を照らす | `check` |
| 参照の検査（`tools/ref-check`、変えない） | 追跡しているファイルをすべて読むため、足すワークフローも今のまま対象に入る。テストだけを足す | `ref-check` |

## #2 との境目

形の往復は 2 つの課題が分けて持つ（#1 の本文の起票者の推定 6）。#2 が形の正本と生成を持ち、#1 は生成物を読んで照らす側だけを持つ。

| 事柄 | #2 が持つ | #1 が持つ |
| --- | --- | --- |
| 生成 | 型・JSON Schema・OpenAPI・MCP の道具の一覧・HTTP の経路の登録・ダミーデータの生成と、生成物が古いと `check` が落ちること | — |
| 往復 | — | 生成物の間で検証の結果が同じであること（決定 8）。I15・I12 の形の照らし |
| 操作の表の項目 | 項目の型と名前 | 読む項目（名前・エンティティ・読むか書くか・人だけか・HTTP の経路・機能・見本・要素と結果の形） |
| 画面の呼び出し | 生成した呼び出しの形 | 画面が呼ぶ操作の名前を静的に読み、表と照らす（I14） |
| 秘密の形のデータ | 鍵の名前の形を足し、伏せ字が読む | ファイルと形を作り、値の形とインフラの値の形を埋める（決定 9） |
| NDF の契約の使い方 | 受ける組・使う口・渡す環境変数・読むファイルと項目・区間の報告から読む項目のデータと、呼び出しの判定 | データと判定を契約と照らす（決定 7） |

#2 へ渡す欠け（#2 の詳細設計が持つ。#1 の実装の最初のタスクで #2 の本文へ追記する）:

| # | 欠け | なぜ要るか |
| --- | --- | --- |
| K2-1 | 操作の定義に機能（F1〜F20 の配列）を持たせる。全体の設計の操作の一覧の「機能」の列にあたる | I14 の「機能の対応」を照らす |
| K2-2 | 画面が操作を呼ぶ形は、静的に操作の名前を読める形にする（生成した関数の名前が操作の名前から決まるか、呼び出しの第 1 引数が操作の名前の文字列の定数） | I14 の「画面と操作の対応」を照らす |
| K2-3 | 操作の表・生成した JSON Schema と OpenAPI・MCP の道具の一覧・HTTP の経路の登録を、`packages/contracts` の書き出し（export）から読めるようにし、利用者向けの操作と機械向けの経路（ランナー・手元のマシン・DB の用意のタスク）を分けて読めるようにする。`apps/api` の振り分けと `infra/` の API Gateway の定義は、HTTP の経路をこの登録の書き出しからだけ読む | 検査は `packages/contracts` だけを import する。I14 の画面と MCP の照らしは利用者向けの操作だけを数える。手書きの経路は規則の組 `routes.generated` が落とすので、生成した登録を照らせば両方の実際の登録を照らしたことになる |
| K2-4 | 日時の項目の名前を `_at` で終え、金額は `amount_minor` と `currency` の組にする（全体の設計の値の形） | I15 の形の照らしが名前で項目を見分ける |
| K2-5 | 形の正本の要素と結果の形に、JSON Schema に表せない制約（変換・独自の検査）を使わない | 形の往復が食い違いとして落とす |
| K2-6 | NDF の契約の使い方のデータと呼び出しの判定を `packages/contracts` に置く（決定 7。受ける組を置くことは実行計画で #2 にある） | F23 が照らす相手 |

#29 へ渡す欠け: 料金プランの名前を形の正本の閉じた語の集まりとして、料金プランの値を `packages/contracts/data/` のデータとして置き、値を読む書き出しを 1 つにする（I8 の検査がその書き出しの import を判定の外で落とし、名前を画面で落とす）。#6 へ渡す欠け: ランナーは NDF を起こす前に形の正本の呼び出しの判定を通す（決定 7）。

## 決定の記録

決定の番号はこの文書の中の番号で、全体の設計の決定の番号（`docs/design/decisions.md` の置き場）とは別である。

### 決定 1: 構文で見つかる破れを依存を足さずに今の CI で落とすため、境界・依存の向き・I8・画面の HTTP の経路を ESLint の組み込みの規則で置き場ごとに縛る

- **質問**: 境界の検査・依存の向き・I8 の「判定の外の比べ」・画面の HTTP の経路の直書きを、どの道具で落とすか
- **選んだ案**: ESLint の組み込みの 4 つの規則を、`tools/checks/src/lint-rules.ts` が置き場（`files` の glob）ごとの設定として組み、`eslint.config.js` が読み込む。型だけの import は `@typescript-eslint/no-restricted-imports` の `allowTypeImports` で許す。縛る置き場の設定は行の中の無効化の注釈（`eslint-disable`）を受けない（`linterOptions.noInlineConfig`）。違反を入れた文字列を ESLint の API で検査する単体テストで、規則ごとに落ちることを確かめる
- 採らなかった案: dependency-cruiser で依存の向きを縛る（依存を 1 つ足し、境界と I8 は別の道具になる。依存の向きは `no-restricted-imports` の置き場ごとの設定で表せる）
- 採らなかった案: eslint-plugin-boundaries（依存を 1 つ足す。ESLint 10 での動作を確かめられなかった。境界の検査の「直の利用」は import でなく呼び出しの形なので、組み込みの規則が要ることは変わらない）
- 採らなかった案: TypeScript の構文木を自前で歩くスクリプト（ESLint の選び方の記法とファイルの選び方を作り直すことになる）
- **代償**: 構文の印の無い破れ（変数に入れてから呼ぶ・別名で受ける）は落とせない。行の中の無効化を受けないため、正当な例外は控えのファイル（決定 5）を直す Pull Request でしか作れない
- 作り方: ライブラリやサービスを使う
- 比べた候補: LIB5 / LIB6 / LIB7
- 根拠: Value 1・Value 7（MVV バージョン 1）

### 決定 2: 構文の印が無い「置き場の外で直に使わないもの」も落とせるよう、行ごとに印を決めて照らす

- **質問**: 土台の表の「置き場の外で直に使わないもの」のうち、関数の名前で書かれていない 3 つ（自前の再試行のループ・条件式を直に組む書き込み・入口ごとの独自の認可の判定）を、検査から外すか、印を決めて照らすか
- **選んだ案**: 行ごとに印を決める。再試行は「繰り返しの文の中で外部の呼び出しの部品（`callHttp` か AWS SDK の `send`）を呼ぶこと」、条件つきの書き込みは「AWS SDK の import」と「`ConditionExpression` の鍵を持つオブジェクト」、認可の判定は「403 の数値と、認可の判定だけが返す理由のコードの文字列」を `apps/` の中で落とす。印と土台の行の対応は詳細設計の表に置く
- 採らなかった案: 3 つの行を検査から外し、レビューに任せる（全体の設計の「落とすもの」を減らすことになり、要求の前提 1 に反する）
- **代償**: 印は近似で、印を避けた書き方（再帰で繰り返す・応答を作る部品を別に作る）は通る。`apps/` の中の正当な 403（無い）や繰り返しの中の外部の呼び出し（一覧の頁送り）が出たら、控えに理由を書いて足す
- 根拠: Value 7・Value 9（MVV バージョン 1）

### 決定 3: 伏せ字と漏れの検査が同じ形を読むよう、漏れの検査を自前で作り、形を形の正本のデータから読む

- **質問**: 漏れの検査を既存の秘密の走査の道具で行うか、自前で作るか
- **選んだ案**: `tools/checks/src/leak-check.ts` を自前で作る。参照の検査と同じく `git grep` で追跡しているファイル（`docs/` を含む）を読み、形は `packages/contracts/data/secret-shapes.json` から読む。作り物の値（`123456789012`・`us-west-2`・`acme`・`example.com`）は同じデータの一覧で当たりから外す。当たりは「種類・ファイル・行」だけを出し、当たった文字を出さない
- 採らなかった案: gitleaks（形を gitleaks の設定のファイルに持つことになり、伏せ字の部品（#2）と同じデータを読めない。組織のリポジトリで GitHub Action を使うには鍵の登録が要る）
- 採らなかった案: trufflehog（AGPL-3.0 で、形の置き場の問題は gitleaks と同じ）
- 採らなかった案: secretlint（形を規則の設定に持つ点は同じ。CI の秘密の実際の値の照合と作り物の値の外し方は、自前の照合を足すことになる）
- 採らなかった案: GitHub の secret scanning に任せる（既知の提供者の token の形を探す。アカウント ID・profile・環境の名前の照合と作り物の値の外しは持たない。公開のリポジトリでは無料で走るので、この検査と重ねて使える）
- **代償**: 形の正規表現の保守をこのリポジトリが持つ。既知の提供者の token の形の網羅は GitHub の secret scanning に劣る
- 作り方: 自前で作る
- 比べた候補: PRD1 / PRD2 / LIB1 / LIB2 / LIB3 / STD4
- 根拠: Value 7（MVV バージョン 1）。決定 92（土台）

### 決定 4: 実際の値の一覧を参照の検査の語と混ぜないため、漏れの検査の語を別の CI の秘密 `LEAK_CHECK_TERMS` で受ける

- **質問**: 実際の値（アカウント・profile・環境の名前）の一覧を、参照の検査の `REF_CHECK_TERMS` に足すか、別の秘密で受けるか
- **選んだ案**: 別の CI の秘密 `LEAK_CHECK_TERMS`（JSON。種類 `accounts`・`profiles`・`environments` ごとの語の配列）で受ける。語を必須にするかの切り替えは、参照の検査と同じ形（変数 `LEAK_CHECK_REQUIRE_TERMS` を `1` にした正本のリポジトリの中の実行だけ）にする。語の無い実行は形の当たりだけを探し、照合を飛ばしたと出力する
- 採らなかった案: `REF_CHECK_TERMS` に種類を足す（参照の検査の語は旧い側の名前で、運用する環境の値とは持ち主と変える時期が違う。片方の形を変えるともう片方の検査が語の形の誤りで止まる）
- **代償**: 秘密が 1 つ増え、正本のリポジトリの持ち主が登録する（下の「人へ残す判断」）。登録されるまで、照合は飛ばされる
- 根拠: Value 7（MVV バージョン 1）

### 決定 5: 検査を足した Pull Request から main を落とさずに入れるため、骨組みの既知の当たりを課題の番号つきの控えに置き、直した後の控えを残さない

- **質問**: 境界の検査と画面の HTTP の経路の検査が、今の骨組みのコード（「今の姿」の表）に当たる。#2 は「外で直に使うと境界の検査（#1）が落ちる」を受け入れ条件に持ち、#1 の検査を待つ。どちらを先に入れるか
- **選んだ案**: 検査を先に入れ、今の当たりを `tools/checks/data/lint-exceptions.json` に「ファイル・規則・受け持つ課題（#2 か #4）・理由」で置き、その置き場だけ規則を外す。単体テストが、控えの行ごとにそのファイルが今もその規則に当たることを確かめ、当たらなくなった行（直したのに残った控え）で落ちる。控えに行を足す変更はレビューで見る
- 採らなかった案: #2 が骨組みを移すまで検査を入れない（#2 の受け入れ条件が #1 の検査を前提にしており、互いに待つ）
- 採らなかった案: #1 の Pull Request で骨組みを直す（横断の部品が無いので移す先が無く、#2 の範囲を先取りする）
- **代償**: 控えが残る間、控えたファイルは同じ規則に当たる新しい行も通る。控えはファイルの単位で、行の単位でない
- 同じ考えを I14 の画面の対応にも使う。#2 が操作の表を置いた時点では画面の多くが無く、利用者向けの操作がすべて `screen-missing` になる。画面を作る課題が別に分かれているため、画面の無い操作を `tools/checks/data/screen-pending.json` に「操作の名前・画面を作る課題の番号・理由」で置き、その操作だけを `screen-missing` から外す。単体テストが、画面から呼ばれるようになった操作の行（直したのに残った控え）と、表に無い操作の行で落ちる。表に操作を足す Pull Request は、画面を同じ Pull Request で足すか、控えに画面を作る課題を書いて足す。画面を作る課題は、自分の番号の行を消すことで画面の対応が必須になる
- 根拠: Value 7（MVV バージョン 1）

### 決定 6: 全体の設計の「いつ」を変えずに必須のチェックへ載せるため、NDF の契約の照合を別のワークフローの常に起動するジョブにし、固定の点を変えない Pull Request では照らさずに通す

- **質問**: F23 は「毎日 1 回と `ndf-pin.json` を変える Pull Request」で走り（実行の文書）、同時に必須のチェックに載る（土台の文書）。パスの絞り込みで起動を絞ると、起動しなかった Pull Request で必須のチェックが待ちのまま残る
- **選んだ案**: 新しいワークフロー `.github/workflows/ndf-contract.yml` に 1 つのジョブ `ndf-contract` を置き、`pull_request`・main への `push`・`schedule`（毎日 1 回）・`workflow_dispatch` で起動する。Pull Request では、ジョブの中で Pull Request の分岐点（基点の枝の先端と head の共通の祖先。GitHub の Pull Request の差分と同じ点）と head のコミットの `ndf-pin.json` を比べ、同じなら照らさずに成功で終える（出力に「照らさなかった」と理由を出す）。基点の枝の先端と比べないのは、分岐の後に main だけで固定の点が変わった場合を Pull Request 自身の変更と取り違えないためである。変えた Pull Request では、マージした結果のコミット（`pull_request` の既定の取得）で照らす。マージされる姿の固定の点と形の正本で照らすためである。push・毎日・手動では、そのコミットで固定の点と既定の枝の先端の両方を照らす
- 採らなかった案: `on.pull_request.paths` で起動を絞る（起動しなかった Pull Request で必須のチェックが待ちのまま残り、マージできない。STD1）
- 採らなかった案: すべての Pull Request で照らす（全体の設計の「いつ」を広げることになり、詳細設計で決め直さない決まりに当たる。照らす相手のコード（#2・#6）の変更は毎日の実行で知る）
- 採らなかった案: `ci.yml` に `schedule` を足す（毎日、ほかのすべてのジョブも走る）
- **代償**: 照らす相手（形の正本の NDF の契約の使い方）を変えて固定の点を変えない Pull Request は、その Pull Request では照らされず、マージした後の push か次の毎日の実行で落ちる。公開のリポジトリで 60 日活動が無いと、毎日の起動が止まる（STD2）
- 根拠: Value 8・Vision（MVV バージョン 1）

### 決定 7: 契約の見本でランナーと同じ判定を照らすため、検査は形の正本の判定とデータを呼び、自前の判定を持たない

- **質問**: 実行の文書の照らすこと (1)〜(4)（(1) NDF の契約の見本のファイル `plugins/ndf/contracts/domains/entrypoint-cases.json` の 26 件を、ランナーの呼び出しと環境変数の組み立てへ通し、見本の `valid` と同じ判定になるか。(2) `version.json` の最後の行が受ける組にあるか。(3) `env.json` の `set_by: service` の名前と口の `env` 列の名前が、ランナーが組む環境変数を含むか。(4) `ndf-files.json` の `reader: service` の行の `fields` が、翻訳が読む項目を含むか。[実行の文書](../docs/design/execution.md#契約の照合の定期の検査)）は「ランナーの組み立て」と契約を照らす。`tools` はランナーのコードを import できない（依存の向き）。検査は何と照らすか
- **選んだ案**: ランナーが打つ前に使う判定（呼び出しの口・値・環境変数の名前が受ける契約に合うか）と、NDF の契約の使い方のデータ（受ける組・使う口・渡す環境変数の名前・読むファイルと項目・区間の報告から読む項目）を、形の正本（`packages/contracts`）に置き、ランナー（#6）と検査の両方がそれを使う。形の正本に置くのは #2 で、この設計は検査が要る形を #2 へ渡す欠けとして書く（下の「#2 との境目」）。検査は見本 26 件（`entrypoint-cases.json`）をその判定へ通して `valid` と比べ、データを契約のファイルと照らす
- 採らなかった案: 検査の中に契約の判定を自前で持つ（契約を契約自身と照らすことになり、ランナーの食い違いを拾えない）
- 採らなかった案: 検査がランナーのコードを読み込む（`tools` は `packages/contracts` だけに依る決まりに反する）
- **代償**: #2 が判定とデータを置くまで、照合は「相手が無い」と出して通る（要求の前提 2）。#6 が判定を使わずに組み立てを書くと、検査は食い違いを拾えない。#6 の受け入れ条件へ「判定を通す」ことを渡す
- 根拠: Vision・Value 8（MVV バージョン 1）

### 決定 8: 生成物の間の食い違いを見本の外でも拾うため、形の往復は見本とその機械的な変形を 4 つの形で検証して比べる

- **質問**: 形の往復の「見本の値の検証が往復で同じ結果」を、どの値で確かめるか
- **選んだ案**: 操作ごとの見本（#2 が作るダミーデータ）に、機械的な変形（必須の項目を 1 つ消す・項目の型を変える・知らない項目を足す・配列を 1 件の値にする）を加え、zod の形・JSON Schema・OpenAPI の要素の形・MCP の道具の入力の形の 4 つで検証し、通るか拒むかが 1 つでも違う組を落とす。加えて、変形していない見本は、該当するすべての形で通ることを確かめ、どれか 1 つでも拒めば落とす（すべての形が見本を拒むように揃って変わると、比べだけでは食い違いが出ないため）。JSON Schema の検証は ajv の draft 2020-12 のクラスと書式の拡張で行う
- 採らなかった案: 見本だけを検証する（見本はすべて通る値なので、拒むべき値を片方だけが通す食い違いを拾えない）
- 採らなかった案: 拒む見本を操作ごとに手で書く（操作が増えるたびに書き足しが要り、書き漏れた操作は照らされない）
- **代償**: 開発の依存に ajv と書式の拡張を足す。zod の形に表せても JSON Schema に表せない制約（変換・独自の検査）は、変形が当たると食い違いとして出るので、#2 が形の正本の側でそうした制約を使わないことを前提にする
- 作り方: ライブラリやサービスを使う・標準に倣う
- 比べた候補: LIB8 / LIB9 / STD3
- 根拠: Value 2・Value 4（MVV バージョン 1）

### 決定 9: 漏れの検査を伏せ字の部品より先に入れるため、秘密の形のデータは #1 が作り、#2 の伏せ字が同じファイルを読む

- **質問**: 伏せ字（#2）と漏れの検査（#1）が読む秘密の形のデータを、どちらの課題が作るか
- **選んだ案**: #1 が `packages/contracts/data/secret-shapes.json` と、その形 `packages/contracts/src/secret-shapes.ts`（zod）を作る。#1 が埋めるのは値の形（私有鍵の頭・token の頭）とインフラの値の形と作り物の値で、伏せ字が使う鍵の名前の形は #2 が同じファイルへ足す
- 採らなかった案: #2 が作り、#1 は待つ（漏れの検査が伏せ字の部品の設計と実装を待つ。漏れは一度入ると公開の履歴から消せない）
- 採らなかった案: 漏れの検査の形を `tools/checks/` に別に持つ（伏せ字と漏れの検査が違う形を読む。全体の設計の「同じデータを読む」に反する）
- **代償**: `packages/contracts/` の中で #1 と #2 が同じファイルを触る。#1 の実装の Pull Request が先にマージされ、#2 はその上で鍵の名前の形を足す
- 根拠: Value 7（MVV バージョン 1）

## 影響と危険

- **働く範囲**: このリポジトリの CI だけ。nd-factory を自分で設置する人の環境には何も足さない（設置のコマンドと反映のパイプラインは変えない）
- **プロジェクトごとに違うもの**: 実際の値の一覧は CI の秘密 `LEAK_CHECK_TERMS` で受け、リポジトリに置かない。fork したリポジトリは秘密を持たないので、照合を飛ばして形の当たりだけを探す
- **当たるモード**: `standard` の CI の必須のチェック。ほかのモードの工程は変えない
- **必須のチェックが増える**: 宣言（`.ndf/project.json`）と GitHub の main の保護の必須のチェックの両方に `leak-check`・`ndf-contract` を足す。保護の設定は GitHub の側の設定で、宣言と食い違うとマージが待ちのまま残るか、足した検査が必須にならない
- **同じファイルを触る別の変更**: #2 が `packages/contracts/` の別のファイルと `package.json` を触る（決定 9・「#2 との境目」）。#13 は `infra/` と `docs/design/platform.md` を触り、重ならない。#41 の実装（N11-実装）は `ndf-pin.json` を付け替える。その Pull Request が #1 の実装の後なら `ndf-contract` が照らす最初の Pull Request になり、前なら照らさない
- **壊れうる箇所**: 漏れの検査は今のリポジトリの 12 桁の数（コミットの SHA の一部・数の並び）に誤って当たりうる。実装の Pull Request で main の全体を走らせ、当たりを直すか、外し（`tools/checks/data/leak-allow.json`）に理由を書いて置く。テストの見本は、違反の文字列をリポジトリに置かないよう実行の時に組み立てる（置くと漏れの検査と参照の検査がそのテストのファイルに当たる）
- **漏れの検査の外しの粒度**: 外しは「パス・種類・当たりの件数・理由」で、値もその要約値（ハッシュなど）も書かない。要約値を置くと、桁の少ない値（12 桁のアカウント ID など）は総当たりで戻せるためである。外したパスと種類の当たりの件数が外しの件数と違えば落とすので、外したファイルに同じ種類の値を足すと落ちる。行の番号は外しに使わない（上の行の編集で動き、外しが無駄に壊れる）。**代償**: 外したファイルの当たりを、同じ件数のまま別の実際の値へ置き換えると、形の検査では通る。秘密の一覧（`LEAK_CHECK_TERMS`）との照合は外しに関わらず効くので、一覧にある値は落ちる。一覧に無い値や、秘密が渡らない実行（fork・秘密の未登録）では、この置き換えは検査で見つからず、外しのあるファイルの変更はレビューで見る
- **NDF の取得**: `ndf-contract` は devbasex/ai-plugins を資格情報なしで取る。GitHub が落ちていると照らす実行は失敗し、照らさない Pull Request は通る
- **#41（PR #42）の承認との順序**: この設計の F23 の節（決定 6・7、詳細設計の「NDF の契約の照合」）は、承認待ちの #41 の決定 104〜108（固定の点・契約の置き場・受ける組・区間の報告・先端を既定の枝にすること）を前提にする。PR #42 の承認で決定 104〜108 のどれかが変わったら、#1 の実装を始める前に、その結果をこの設計と詳細設計の F23 の節（NDF のリポジトリの URL と契約の置き場の定数・照らすこと 1〜6 の契約のファイル・先端の取り方）へ取り込む Pull Request を先に通す。#1 の実装は、PR #42 が承認され、F23 の節が承認された決定と合ってから始める

### 残る危険

検査を入れても、次の破れは Pull Request の時点で落とせない。どれも決まりを変えるのでなく、検査が近似であるか照らす相手が無いために残る。

| 残る危険 | 何が通るか | どこで扱うか |
| --- | --- | --- |
| 別名で受ける・変数に入れてから呼ぶ（決定 1） | 構文の印の無い呼び出し（`const f = Date.now; f()` など）は ESLint の規則に当たらない | レビュー |
| 印を避ける書き方（決定 2） | 再帰で繰り返す・応答を作る部品を別に作る・文字列を連結して経路や理由のコードを組む | レビュー。正当な例外は控えに理由を書いて足す |
| 固定の点を変えない Pull Request での NDF の契約の使い方の変更（決定 6） | 形の正本の NDF の契約の使い方だけを変えた Pull Request は、その Pull Request では照らされない | マージの後の push の実行か次の毎日の実行で落ちる |
| 漏れの検査の外しの中の置き換え（上の「漏れの検査の外しの粒度」） | 外したファイルの当たりを、同じ件数の別の実際の値へ置き換える | 秘密の一覧との照合とレビュー |
| 照らす相手（#2・#29）がそろうまで「相手が無い」で通る検査 | 形の往復・I14（#2 の操作の表と生成物）・I8 の料金プランの値と名前（#29）・F23 の 1〜6（#2 の NDF の契約の使い方）は、相手が無い間はリポジトリへの適用を飛ばして通る。作り物の入力で落ちることはテストで示すが、実物は照らされない | #2・#29 の実装の Pull Request で相手が入った時点から照らされる。相手を足す Pull Request は、検査がその相手を読むことを同じ Pull Request の CI で確かめる |
| I14 の画面の控え（決定 5） | 控えに載せた操作は、画面が無くても `screen-missing` にならない | 画面を作る課題が自分の行を消す |

### このリポジトリだけの事情

| 値 | 置く所 | 持つ Issue |
| --- | --- | --- |
| 実際の値の一覧 | CI の秘密 `LEAK_CHECK_TERMS` と変数 `LEAK_CHECK_REQUIRE_TERMS` | #1（登録は持ち主） |
| NDF のリポジトリの URL と契約の置き場 | `tools/checks/src/ndf-contract-check.ts` の出所つきの定数（外部の仕様の値） | #1 |
| 毎日の起動の時刻 | `ndf-contract.yml` の `schedule` | #1 |

## 用語

| 用語 | 意味 | 用語集への反映 |
| --- | --- | --- |
| 規則の組 | 1 つの決まり（境界の検査の 1 行・依存の向きの 1 つの置き場など）を落とす ESLint の規則の設定の集まり。ID（`boundary.clock` など）を持ち、控えはこの ID で外す | 追加（用語集の描画が #43 で止まっているため、描画が直った後の確定仕様化で足す） |
| 控え（検査の） | 検査を入れる時点で既に当たるファイルを、受け持つ課題の番号と理由つきで外す一覧。減るだけで、当たらなくなった行はテストが落とす | 同上 |
| 印（検査の） | 関数の名前で書かれていない決まりの破れを、構文で見分けるために決めた形（繰り返しの中の外部の呼び出しなど） | 同上 |
| 照合の語 | 参照の検査が探す、作り直す前の旧いリポジトリ・組織・表の名前。CI の秘密 `REF_CHECK_TERMS` で受け、リポジトリに置かない | 用語集に既にあれば足さない。無ければ同上 |
| 形の正本 | 型・JSON Schema・OpenAPI・MCP の道具の一覧・HTTP の経路の登録を生成する元になる、`packages/contracts` の zod の定義と操作の表。検査はここと生成物を読む | 用語集の既存の語 |
| 横断の部品 | 時計・ID・ログと伏せ字・外部の呼び出し・再試行・条件つきの書き込み・認可の判定など、`apps/` が直に使わずに通す `packages/core` の部品。境界の検査は、これらを置き場の外で直に使うことを落とす | 用語集の既存の語 |
| I12・I15 | API と MCP の文書の不変条件。I12 は利用者向けの操作の要求と応答を配列にすること、I15 は日時を時刻帯つきの UTC で、金額を `amount_minor` と `currency` の組で受けること | 全体の設計の語 |
| 受ける組 | nd-factory が受け入れる NDF の契約の、版と、その版の契約の中身の sha256 の対の集まり。F23 の照らすこと 2 が、上流の `version.json` の最後の行がこの集まりにあるかを見る | 全体の設計の語（#41） |
| 見本 26 件 | NDF の契約の `plugins/ndf/contracts/domains/entrypoint-cases.json` にある、呼び出しの口・値・環境変数の組と、それが通るか（`valid`）の 26 件 | 足さない（NDF の契約の中身） |
| C1・C7 | NDF の共通原則が定める、AI が自分で進めずに必ず人の承認を求める操作（レッドライン）。C1 は秘密（token・鍵・資格情報）に触れる操作、C7 は利用者の宣言と設定（`.ndf/` など）と指示書を書き換える操作 | 足さない（NDF の語） |

## テスト設計

| 受け入れ条件・決定 | どの振る舞いで縛るか | どう壊したら落ちるべきか |
| --- | --- | --- |
| 受け入れ条件 1（漏れ） | 漏れの検査に、実行の時に組み立てた作り物でない 12 桁・ARN・端点・私有鍵の頭・token の頭を含むファイルを持つ作業の木を渡すと、終了コード 1 と種類・ファイル・行が出る | 形を 1 つでもデータから読まなくすると落ちる |
| 受け入れ条件 1（形の往復） | 4 つの形のうち 1 つだけ必須の項目を外した操作の定義を渡すと、食い違った操作と変形が返る。4 つの形がそろって見本を拒む操作の定義を渡すと、見本が拒まれたことが返る | 変形を作らずに見本だけを検証する・見本が通ることを確かめずに比べだけにすると落ちる |
| 受け入れ条件 1（境界・依存の向き・I8・画面の HTTP の経路） | 規則ごとに、違反を入れた文字列を置き場のパスで ESLint にかけると、その規則の誤りが出る | 置き場の glob を外す・規則を消すと落ちる |
| 受け入れ条件 1（F23）・9 | 固定の点の見本 1 件の `valid` を判定と食い違わせた契約を渡すと終了コード 1、先端だけで食い違わせると終了コード 0 で、要約に見本の id と契約のファイルのパスが並ぶ | 先端の食い違いで失敗にする・要約に id を出さないと落ちる |
| 受け入れ条件 2 | 漏れの検査の出力と標準エラーに、渡した実際の値と当たった文字が現れない。実際の値をパスに含むファイルでも、パスの当たりと本文の当たりと読み込みの誤りのどの出力にも値が現れない。作り物の値だけのファイルでは当たりが 0 件。語を必須にした実行で語が無ければ終了コード 2 | 当たった行の中身を出力に足す・パスを伏せずに出すと落ちる |
| 受け入れ条件 3 | 作り物でない 12 桁を `docs/` の下のファイルに置いた作業の木で当たる | `docs/` を探す範囲から外すと落ちる |
| 受け入れ条件 4（I8） | 判定のモジュールの外で料金プランの値の書き出しを import する・画面で料金プランの名前の文字列を使うと誤りが出る。判定のモジュールの中では出ない | 判定のモジュールも対象にする・画面の名前の照らしを外すと落ちる |
| 受け入れ条件 5（I14） | 画面だけが呼ぶ操作・MCP の道具の無い人だけでない操作・対になる読み出しの無い人だけの操作・表に無い HTTP の経路・どの操作にも無い機能を、それぞれ足した表を渡すと欠けとして返る。`apps/api` と `infra/` に HTTP の経路を手で書くと規則の組 `routes.generated` の誤りが出る。画面の控えに載せた操作は `screen-missing` にならず、画面から呼ばれるようになった控えの行で落ちる | 片方向だけを照らす・手書きの経路を許す・控えの照らしを消すと落ちる |
| 受け入れ条件 6 | `apps/` の 5 つの置き場で「置き場の外で直に使わないもの」の印ごとに誤りが出て、`packages/core`・`infra/`・`tools/`・テストのファイルでは出ない | 対象の置き場を広げる・狭めると落ちる |
| 受け入れ条件 7 | `packages/core` から `apps/*`・`apps/*` どうし・`infra` から `apps/*` の import で誤りが出る。型だけの import も同じ | 置き場の 1 つの規則を外すと落ちる |
| 受け入れ条件 8（旧い名前） | 照合の語（旧い名前）を含む追跡しているファイルで、参照の検査が終了コード 1 で終わる。既存の `tools/test/ref-check.test.ts` の `mainRefCheck` の「当たりがあれば 1 で、種類とファイルと行を出し語そのものは出さない」と、`findOldRefs` の「文書にだけ当たりがあれば 1 件」「リポジトリの名前は大文字小文字を問わず当たる」（`.github/workflows/ci.yml` の当たり）が縛る。#1 はこのテストを変えない | 照合の語の照らしを外す・ワークフローを読む範囲から外すと落ちる |
| 受け入れ条件 8（版の比べ） | 足すワークフローの文字列に NDF の版を読む式と大小の比べを同じ行に置くと参照の検査が当たる | 参照の検査がワークフローを読まなくなると落ちる |
| 受け入れ条件 10 | ジョブを宣言とワークフローの片方にだけ足す・どれかのワークフローに資格情報の語を足す・最上位かジョブの `permissions` に `contents: read` 以外を足すと、CI の定義のテストが落ちる | `ci.yml` だけを読む・最上位の `permissions` だけを読むと落ちる |
| 受け入れ条件 11 | 詳細設計（[issue-1-design-detail.md](./issue-1-design-detail.md)）が、全体の設計の置き場・依存の向き・落とすものを引いて書かれ、決め直していない（cross-review が読む） | 全体の設計に無い置き場や、落とすものの増減を書くと cross-review が落とす |
| 決定 5 | 控えの行のファイルが規則に当たらなくなると単体テストが落ちる | 控えの照らしを消すと落ちる |
| 決定 6 | `ndf-pin.json` が分岐点と head で同じ Pull Request では照らさずに成功し、違えば照らす。分岐の後に基点の枝だけで `ndf-pin.json` を変えた作業の木では照らさない | 起動の判定を逆にする・基点の枝の先端と比べると落ちる |

## 設計の結果

詳細設計は [issue-1-design-detail.md](./issue-1-design-detail.md) にある（新設する関数が 2 つ以上あるため）。

| 課題 | 扱い | 統合先 | 触るファイル |
| --- | --- | --- | --- |
| #1 | 実装する | — | `eslint.config.js`、`tools/checks/src/lint-rules.ts`、`tools/checks/data/lint-exceptions.json`、`tools/checks/data/screen-pending.json`、`tools/checks/src/leak-check.ts`、`tools/checks/data/leak-allow.json`、`tools/checks/src/round-trip.ts`、`tools/checks/src/operation-coverage.ts`、`tools/checks/src/ndf-contract-check.ts`、`packages/contracts/data/secret-shapes.json`、`packages/contracts/src/secret-shapes.ts`、`packages/contracts/package.json`、`tools/test/lint-rules.test.ts`、`tools/test/leak-check.test.ts`、`tools/test/round-trip.test.ts`、`tools/test/operation-coverage.test.ts`、`tools/test/ndf-contract-check.test.ts`、`tools/test/ci-definition.test.ts`、`tools/test/ref-check.test.ts`、`tools/package.json`、`tools/tsconfig.json`、`package.json`、`package-lock.json`、`.github/workflows/ci.yml`、`.github/workflows/ndf-contract.yml`、`.ndf/project.json`、`AGENTS.md` |

## 人へ残す判断

C1 と C7 は、NDF の共通原則が「AI が自分で進めずに必ず人の承認を求める操作」として定めるレッドラインである。C1 は秘密（token・鍵・資格情報）に触れる操作、C7 は利用者の宣言と設定と指示書を書き換える操作を指す。

| 判断 | 当たるレッドライン | なぜ当たるか |
| --- | --- | --- |
| CI の秘密 `LEAK_CHECK_TERMS` に実際の値を登録し、変数 `LEAK_CHECK_REQUIRE_TERMS` を `1` にする（GitHub のリポジトリの設定。実装の Pull Request のマージの後に持ち主が行う） | C1 | 運用する環境の実際の値という秘密に触れる |
| `.ndf/project.json` の必須のチェックに `leak-check`・`ndf-contract` を足し、`AGENTS.md` の「秘密とインフラの値を置かない」に `LEAK_CHECK_TERMS` の行を足す | C7 | 利用者の設定と指示書を書き換える。実装の中でコミットし、承認ゲートで人が見る |

## 未確認のまま残ること

| 項目 | 内容 |
| --- | --- |
| 今のリポジトリの漏れの検査の当たり | 12 桁の数の当たりがどれだけ出るか。実装の Pull Request で main の全体を走らせて分かる |
| GitHub の main の保護の必須のチェックの今の値 | 宣言の 4 つと一致しているか。実装の Pull Request の前に持ち主の設定で分かる |
| 上流の `ask-journal` の `fields` | #41 の決定 106 の依頼の答えで分かる。足されたら、F23 の照らすこと (4) が読む項目に入る |

## 外部の調査

| 種類 | 調べるか | 理由 |
| --- | --- | --- |
| 標準・仕様 | 調べる | 必須のチェックと起動の条件の扱い（GitHub Actions）・JSON Schema の版・AWS の ARN の形が、検査の作りを縛る |
| 主要な製品 | 調べる | 秘密の走査は GitHub と GitLab が製品として持つ |
| ライブラリとサービス | 調べる | 秘密の走査・依存の向き・JSON Schema の検証に既存の道具がある |

### 標準・仕様

| # | 標準・仕様 | 何を定めているか | 設計への反映 | 出典 |
| --- | --- | --- | --- | --- |
| STD1 | GitHub Actions の必須のステータスチェック | パスや枝の絞り込みでワークフローが起動しないと、必須のチェックは待ちのまま残りマージを止める。ジョブの `if` で飛ばしたジョブは成功と報告される | 決定 6（パスで絞らず、ジョブの中で照らすかを決める） | https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks（2026-11-21） |
| STD2 | GitHub Actions の `schedule` と `workflow_dispatch` | `schedule` は既定の枝の最新のコミットで走り、公開のリポジトリで 60 日活動が無いと止まる。`workflow_dispatch` で手で起こせる | 決定 6・影響と危険 | https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows（2026-11-21） |
| STD3 | JSON Schema draft 2020-12 と zod v4 の `z.toJSONSchema` | zod v4 の書き出しの既定の版は draft 2020-12。ajv はこの版に別のクラスを使う | 決定 8 | https://zod.dev/json-schema・https://ajv.js.org/json-schema.html（2026-11-21） |
| STD4 | AWS の ARN | 形は `arn:partition:service:region:account-id:resource`。パーティションは `aws`・`aws-cn`・`aws-us-gov`。資源によりリージョンとアカウントを省く。ARN そのものは秘密でないと明記 | 決定 3（ARN の形と、秘密でなくても実際の値として探す理由） | https://docs.aws.amazon.com/IAM/latest/UserGuide/reference-arns.html（2026-11-21） |
| STD5 | GitHub Actions の `permissions` と秘密の伏せ字 | `permissions` で 1 つでも指定すると、ほかは `none` になる。`::add-mask::` で値をログで伏せる | 足すワークフローは `contents: read` だけにする。検査は値を出さないので伏せ字に頼らない | https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions・https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions（2026-11-21） |

### 主要な製品

| # | 製品 | どう解いているか | 設計への反映 | 出典 |
| --- | --- | --- | --- | --- |
| PRD1 | GitHub の secret scanning と push protection | 公開のリポジトリで無料で自動に走り、既知の提供者の token と汎用の形を探す。独自の形はリポジトリの Secret Protection を前提にする | 決定 3（重ねて使えるが、実際の値の照合と作り物の値の外しを持たない） | https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning・https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection（2026-11-21） |
| PRD2 | GitLab の Secret Detection | push の時・パイプライン・課題の本文の 3 か所で探す。パイプラインは gitleaks の規則（GitLab が保守する TOML）を使う | 決定 3（規則を道具の設定に持つ形） | https://docs.gitlab.com/user/application_security/secret_detection/pipeline/（2026-11-21） |

### ライブラリとサービス

| # | 候補 | バージョン | ライセンス | 最後のリリースの日付 | 終了のアナウンス | 要件を満たすか | 出典 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| LIB1 | gitleaks と gitleaks-action | v8.30.1・v3.0.0 | MIT・登録の判定なし | 2026-03-21・2026-05-30 | 無し | 形は gitleaks の設定のファイルに持つ。組織のリポジトリで Action を使うには鍵の登録が要る。伏せ字の部品と同じデータを読めない | `gh api repos/gitleaks/gitleaks/releases/latest`・https://github.com/gitleaks/gitleaks-action（2026-11-21） |
| LIB2 | trufflehog | v3.100.0 | AGPL-3.0 | 2026-11-19 | 無し | 形の置き場は LIB1 と同じ問題を持つ | `gh api repos/trufflesecurity/trufflehog/releases/latest`（2026-11-21） |
| LIB3 | secretlint | 14.0.1 | MIT | 2026-11-16（登録簿の更新） | 無し | Node で動く。実際の値の照合と作り物の値の外しは自前で足すことになる | `npm view secretlint version time.modified license deprecated`（2026-11-21） |
| LIB4 | dependency-cruiser | 18.8.0 | MIT | 2026-11-16（登録簿の更新） | 無し | 依存の向きは縛れるが、境界と I8 には別の道具が要る | `npm view dependency-cruiser version time.modified license deprecated`（2026-11-21） |
| LIB5 | ESLint の組み込みの規則（`no-restricted-imports`・`no-restricted-syntax`・`no-restricted-globals`・`no-restricted-properties`） | 10.15.0（このリポジトリが既に使う） | MIT | 2026-11-16（登録簿の更新） | 無し | import の先・構文の形・グローバルの名前・オブジェクトの性質を、設定の `files` ごとに落とせる。行の中の無効化の注釈を設定で受けなくできる | https://eslint.org/docs/latest/rules/no-restricted-imports・https://eslint.org/docs/latest/rules/no-restricted-syntax・https://eslint.org/docs/latest/rules/no-restricted-globals（2026-11-21）、`node_modules/eslint/lib/rules/no-restricted-properties.js` と `node_modules/eslint/lib/config/flat-config-schema.js` の `noInlineConfig`（2026-11-21） |
| LIB6 | eslint-plugin-boundaries | 7.4.4 | MIT | 2026-11-15（登録簿の更新） | 無し | 置き場ごとの import を縛れる。ESLint 10 での動作は確かめられなかった | `npm view eslint-plugin-boundaries version time.modified license deprecated peerDependencies`（2026-11-21） |
| LIB7 | typescript-eslint の `no-restricted-imports` | 8.73.0（このリポジトリが既に使う） | MIT | — | 無し | ESLint の規則に `allowTypeImports` を足す | 根の `package.json` の `typescript-eslint`（2026-11-21） |
| LIB8 | ajv | 8.20.0 | MIT | 2026-04-24（登録簿の更新） | 無し | draft 2020-12 を別のクラスで検証できる。書式（`date-time`）は書式の拡張が要る | `npm view ajv version time.modified license deprecated`・https://ajv.js.org/json-schema.html（2026-11-21） |
| LIB9 | zod | 4.6.7 | MIT | 2026-10-12（登録簿の更新） | 無し | 形の正本の正。`z.toJSONSchema` が draft 2020-12 を出す。変換などは既定で書き出せず例外にする | `npm view zod version time.modified license deprecated`・https://zod.dev/json-schema（2026-11-21） |

### 確かめられなかったこと

| 対象 | 試した手段 | 結果と理由 |
| --- | --- | --- |
| gitleaks・trufflehog・secretlint の許可の一覧と出力の伏せ字の設定 | 試していない | 上限。決定 3 は形の置き場の理由で退けたので、この結果に依らない |
| eslint-plugin-boundaries の ESLint 10 での動作 | `npm view eslint-plugin-boundaries peerDependencies`（`eslint >=6.0.0`） | 範囲の宣言だけで、実際の動作は確かめていない（上限） |
| 公開のリポジトリでの GitHub の独自の形と push protection の費用 | secret scanning・push protection・独自の形の 3 つの頁 | どの頁も公開のリポジトリの費用を書いていない。無料かは確かめていない |
| `ajv/dist/2020` の読み込みの経路 | ajv の JSON Schema の頁 | 取得した範囲にコードの例が無い。実装の最初のタスクで読み込んで確かめる |

調べた量: 候補 16 件・取得の試み 32 回。
