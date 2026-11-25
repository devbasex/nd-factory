## 何が起きたか

2026-11-24 に、NDF 11.0.32 への移行に合わせて nd-factory の全体の設計を見直した（設計 PR `design/review-ndf11`）。そのとき、NDF との契約について 2 つの問題が見つかった。

1. nd-factory が使う NDF の版を決めるファイル（`ndf-pin.json`）が、NDF 11.0.12（契約の版 8）を指したままになっている。受ける契約を版 8 の 1 組だけに限る決まり（[execution.md](https://github.com/devbasex/nd-factory/blob/main/docs/design/execution.md) の決定 104）のままでは、開発に使っている NDF 11.0.32（契約の版 15）で実行用のイメージを作ると、ランナーが起動のときに契約の食い違い（`contract_mismatch`）としてレーンを止める
2. NDF の契約と nd-factory の使い方を突き合わせる検査（`npm run ndf-contract`）が、何も検査せずに成功で終わっている。検査が使う nd-factory 側の使い方の書き出し（`ndf-contract-use`）がまだ無いため、検査は `skip: no-contract-use` を出して、突き合わせの 6 項目を 1 つも実行しない

起票の時点で、版 9〜15 の差は主に中継・アカウント・上限・読み手役の追加で、nd-factory が使う呼び出しの口・区間の報告の形・`ndf answer` の引数は変わっていないと、2 つの点を浅く比べて見ている。`parallel-plan` から `max_lanes`・`max_plans`・`plans` が外れたが、nd-factory はこの 3 つを使っていない（2026-11-25 に `grep` で確認）。

## 種類

不具合（設計がすでに約束している「上流の最新の配布と同じ契約で作る」（決定 104）と「契約の食い違いを定期の検査で見つける」（F23）が守られていない状態を、約束どおりに戻すため）

## 今の姿

nd-factory は、NDF（devbasex/ai-plugins の `ndf` プラグイン）の契約のファイル（`plugins/ndf/contracts/`）に載る口と形だけを使う。約束の正は [execution.md の「NDF との契約」](https://github.com/devbasex/nd-factory/blob/main/docs/design/execution.md#ndf-との契約) にある。

| 約束 | 正の場所 | 今の状態 |
| --- | --- | --- |
| 使う NDF のコミットは `ndf-pin.json` の 1 か所に置き、上流の最新の配布のタグに合わせる。配布が進んだら、固定の点と受ける組を同じ Pull Request で直す | 決定 104 | 固定の点は `ndf--v11.0.12` のコミット `752a9cf`（契約の版 8）のまま |
| ランナーは起動のとき、契約の版と sha256 の組が「受ける組」にあるかを見て、無ければレーンを失敗（`contract_mismatch`）にする | 「NDF との契約」の表の「契約のバージョンの照合し」の行 | 受ける組（`packages/contracts/data/ndf-contracts.json`）は版 8 の 1 組だけ |
| 固定の点の契約と nd-factory の使い方の食い違いを、検査で見つけて落とす | 「契約の照合の定期の検査」（F23） | 使い方の書き出しが無いので、検査は突き合わせずに成功で終わる |

起票の時点の 2026-11-25 には、NDF の配布のタグは `ndf--v11.0.36`（契約の版 16）まで進んでいる。

## 事象

```text
$ npm run ndf-contract
> node tools/checks/src/ndf-contract-check.ts

read: fixed 752a9cf48a6d36c00ffb3197c8668d1c898c32e2
read: tip e57e151c10e5ab15b7716cac2aabf22c13903fad
skip: no-contract-use 752a9cf48a6d36c00ffb3197c8668d1c898c32e2
```

終了コードは 0 で、突き合わせの 6 項目の結果は 1 行も出ない。`ndf-pin.json` の `ndf_ref` は `752a9cf48a6d36c00ffb3197c8668d1c898c32e2`（`ndf--v11.0.12`、契約の版 8）である。

## 期待する結果

- 固定の点が NDF 11.0.32 以降の配布のタグを指し、受ける組がその点の契約の版と sha256 の 1 組になる
- `npm run ndf-contract` が、固定の点の契約と nd-factory の使い方を突き合わせ、6 項目の結果を出して成功で終わる

## 再現手順

1. main（`b75045d`）を取り出す
2. `npm run ndf-contract` を打つ
3. 出力の最後の行が `skip: no-contract-use …` になり、終了コードが 0 になる

## 環境

| 項目 | 値 |
| --- | --- |
| nd-factory | main の `b75045d`（2026-11-25） |
| 固定の点の NDF | `ndf--v11.0.12`（`752a9cf`、契約の版 8） |
| 開発に使う NDF | 11.0.32（契約の版 15）。2026-11-25 の最新の配布は 11.0.36（契約の版 16） |
| ランタイム・OS | Node.js v26.13.1、Linux |

## なぜ困るか

- 開発に使う NDF と、設計が固定する契約が離れたままになる。今の固定の点で実行用のイメージを作ると、開発で使った NDF とは別の版で動く。開発と同じ NDF でイメージを作ると、ランナーが `contract_mismatch` でレーンを止める
- 契約の検査が成功で終わるので、NDF の契約が変わって nd-factory の使い方と食い違っても、誰も気づかない

## 目的

- nd-factory が、上流の最新に近い配布の NDF の契約で作られ、その契約と使い方の食い違いが検査で必ず見つかる状態にする

## 対象範囲

含む:
- `ndf-pin.json` の固定の点を、NDF 11.0.32 以降の配布のタグのコミットへ上げる
- 受ける組と、決定 104・「NDF との契約」の表の値を、新しい固定の点に合わせて直す
- 契約の検査が、使い方の書き出しを読んで 6 項目を実際に突き合わせる状態にする

含まない:
- 実行の契約（子へ渡す環境変数・引継ぎ文書・承認資料の材料）を NDF 11.0.32 に追い付かせること。NDF 11.0.32 との食い違いを直す課題（[#135](https://github.com/devbasex/nd-factory/issues/135)）の範囲（[overview.md の見直しの表](https://github.com/devbasex/nd-factory/blob/main/docs/design/overview.md)）
- 新しい固定の点でも残る、上流の契約の不足 3 件（[devbasex/ai-plugins#3947](https://github.com/devbasex/ai-plugins/issues/3947)。OPEN）
- `block-next` の口の保存先が固定の点に無い置き場を指す件（[#47](https://github.com/devbasex/nd-factory/issues/47)）
- レーンを動かすランナーを作る課題（[#6](https://github.com/devbasex/nd-factory/issues/6)）が持つ、起動のときの照合の実装

## 前提

- 前提 1: 使い方の書き出し（`ndf-contract-use`）を置くのは、型・API・ダミーデータの元になる定義と横断の部品を作る課題（[#2](https://github.com/devbasex/nd-factory/issues/2)）である。この課題は #2 と同じ変更か、#2 が main に入った後の変更で完了する
- 前提 2: 固定の点のタグは、設計の時点で最新の配布のタグを選ぶ（決定 104 の「上流の最新の配布と同じ契約で作る」に合わせる）。選んだタグは設計書に書く

## 受け入れ条件

- [ ] 1. `ndf-pin.json` の `ndf_ref` が、devbasex/ai-plugins の `ndf--v11.0.<N>`（N は 32 以上）のタグが指すコミットと一致する
- [ ] 2. 受ける組（`packages/contracts/data/ndf-contracts.json` の `accepted`）が、新しい固定の点の `plugins/ndf/contracts/version.json` の `history` の最後の行と同じ版と sha256 の 1 組だけである
- [ ] 3. execution.md の決定 104 と「NDF との契約」の表の「契約のバージョンの照合し」の行が、新しい固定の点のタグ・コミット・契約の版・sha256 を書いており、版 8 と sha256 `ed8b0365…` を今の値として書いていない
- [ ] 4. `npm run ndf-contract` の出力に `skip:` の行が無く、固定の点の契約と使い方を突き合わせた 6 項目の結果が出て、終了コードが 0 になる
- [ ] 5. 使い方の書き出しが無い状態で `npm run ndf-contract` を打つと、`skip` でなく `fail: no-contract-use` を出して終了コード 1 で終わる（退行しない）
- [ ] 6. `npm run check` が通る（生成物の差・単体テストを含む）

## 影響

| 対象 | 影響 |
| --- | --- |
| 公開インタフェース | 変わらない。nd-factory の API・画面・設置のコマンドの入出力は変えない。NDF との間で受ける契約の組だけが変わる |
| 重さ | 中。ランナーを動かす前の今は利用者の作業は止まらないが、このままランナー（[#6](https://github.com/devbasex/nd-factory/issues/6)）を作ると、開発と同じ NDF のイメージがレーンを `contract_mismatch` で止める。契約の食い違いを検査で拾えない |
| データ | スキーマは変わらない。受ける組のデータ（`packages/contracts/data/ndf-contracts.json`）の値が変わる |
| 既存の振る舞い | `npm run ndf-contract` が、成功で素通りする代わりに突き合わせをして、食い違えば落ちるようになる |

## ドメインイベント

| # | イベント | 引き金 | 失敗したとき | 順序の前提 |
| --- | --- | --- | --- | --- |
| E1 | NDF が新しい配布のタグを打った | 上流の配布 | — | — |
| E2 | nd-factory が固定の点を新しいタグのコミットへ付け替えた | 開発者が配布の更新を取り込む | 受ける組と食い違ったまま main に入る。受け入れ条件 2・3 で防ぐ | E1 |
| E3 | nd-factory が受ける組と設計書の値を、新しい固定の点の契約に合わせた | E2 と同じ Pull Request | 受け入れ条件 2・3 | E2 |
| E4 | 契約の検査が、固定の点と先端の契約のファイルを読んだ | `npm run ndf-contract`（CI と手元） | 固定の点の契約を読めなければ終了コード 2 で落ちる | E2 |
| E5 | 契約の検査が、使い方の書き出しと固定の点の契約を突き合わせた | E4 の続き | 食い違えば終了コード 1。書き出しが無ければ `fail: no-contract-use`（受け入れ条件 5） | E4。書き出しは #2 が置く（前提 1） |

## 検証手段

| 項目 | 手段 |
| --- | --- |
| テスト | `npm run ndf-contract`（受け入れ条件 4・5）、`npm run check`（受け入れ条件 6） |
| 静的解析・型検査 | `npm run check` |
| 手動確認（マージ前） | `ndf-pin.json` の値を `gh api repos/devbasex/ai-plugins/git/ref/tags/ndf--v11.0.<N>` の `object.sha` と比べ、受ける組を同じコミットの `plugins/ndf/contracts/version.json` の `history` の最後の行と比べる（受け入れ条件 1・2）。設計書の値を目で見る（受け入れ条件 3） |

## 前提とする取り決め

| 項目 | 参照先 / 決めたこと |
| --- | --- |
| プロジェクト構造 | 固定の点は `ndf-pin.json` の 1 か所だけに置く（[AGENTS.md](https://github.com/devbasex/nd-factory/blob/main/AGENTS.md)）。受ける組は形の定義のデータ（`packages/contracts/data/`）の 1 か所だけに置く |
| コーディング規約 | 形を変えたら `npm run generate` で生成物を作り直してコミットする（AGENTS.md）。NDF の版の数字を読んで大小を比べる処理を書かない（「NDF との契約」の表） |

## 未決

| 項目 | 誰が決めるか | 期限 |
| --- | --- | --- |
| 使い方の書き出し（`ndf-contract-use`）を、この課題で足すか、#2 が足すのを待つか。全体の設計の見直しの表（[overview.md](https://github.com/devbasex/nd-factory/blob/main/docs/design/overview.md) の「2026-11-24 の見直しで見つけた欠け」）は「書き出しを足して検査が skip せずに通るまでを直す」と書き、本文は「#2 と同じ変更か、その直後」と書いている | 設計者が設計書で案を出し、設計承認ゲートで利用者が決める | 設計承認ゲート |
| 新しい固定の点で、#47（`block-next` の保存先の件）と上流の不足 3 件が突き合わせの食い違いとして出るか。出るなら、受け入れ条件 4 を満たすための扱い（使い方の書き出しから外すか、範囲を戻すか） | 設計者が設計書で調べて示し、設計承認ゲートで利用者が決める | 設計承認ゲート |

## 起票者の推定

| # | 条件 | 推した出所 | この要求での扱い |
| --- | --- | --- | --- |
| S1 | 固定の点は 11.0.32 以降を指す | 課題の本文の「受け入れ条件 1」（2026-11-24 の見直しで開発に使っていた版） | 受け入れ条件 1・前提 2 |
| S2 | 検査を動かすのは、#2 の書き出しと同じ変更か、その直後 | 課題の本文の「対象範囲」 | 前提 1・未決 1 |
| S3 | 版 9〜15 の差で、nd-factory が使う口・報告の形・`ndf answer` の引数は変わっていない | 課題の本文の「何が起きたか」（2 つの点を浅く比べた結果） | 受け入れ条件 4 の検査の結果で判定する |
| S4 | 実行の契約の追い付き・上流の不足 3 件・#47 は含まない | 課題の本文の「対象範囲」 | 含まない |
| S5 | 重さは中 | 課題の本文の「種類」 | 影響の「重さ」の行 |

## リクエスト（原文）

<details>
<summary>課題の題と、要求を書く前の本文</summary>

書き手: 起票者（全体の設計の見直しで課題を起こした AI）、日付: 2026-11-24。書き手が利用者でないので、利用者の指示の原文として扱わない。

```text
題: NDF との契約: 固定の点を 11.0.32 へ上げ、受ける組（決定 104）と照合を新しい契約で効かせる

## 何が起きたか

`npm run ndf-contract` は固定の点（11.0.12、契約の版 8）と先端（11.0.32、契約の版 15）を読むが、#2 の書き出し（`ndf-contract-use`）がまだ無いため `skip: no-contract-use` で通り、照らすこと 1〜6 を 1 つも実行していない。受ける組を版 8 に限る決まり（決定 104）のままでは、11.0.32 で作ったイメージは `contract_mismatch` になる。版 9〜15 の差は、ほぼ中継・アカウント・上限・読み手役の追加で、nd-factory が使う口・報告の形・`ndf answer` の引数は変わっていない（2 つの点を浅く取って比べた）。`parallel-plan` から `max_lanes`・`max_plans`・`plans` が外れた。devbasex/ai-plugins#3947 は OPEN のまま

## 種類

設計の欠け（重さ: 中）

## なぜ困るか

開発に使う NDF（11.0.32）と、設計が固定する契約（11.0.12）が離れ、照合が空振りのまま

## 対象範囲

含む: `ndf-pin.json` を上げる・決定 104 の受ける組を直す・照合が実際に照らす状態にする（#2 の `ndf-contract-use` と同じ変更か、その直後）
含まない: 実行の契約の追い付き（別の課題）。先端でも残る契約の不足 3 件と #47

## 受け入れ条件

- [ ] 1. `ndf-pin.json` が 11.0.32 以降を指し、決定 104 の受ける組が合う
- [ ] 2. `npm run ndf-contract` が skip でなく照らして通る

## 見つけた場所

全体の設計の見直し（NDF 11.0.32 への移行に合わせた、2026-11-24 の見直し。設計 PR `design/review-ndf11`）
```

</details>
