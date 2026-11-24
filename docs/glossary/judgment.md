# 用語集: 人の判断（`judgment`）

この文書は `docs/glossary/glossary.json` から作る。手で直さない。索引は `docs/glossary.md` にある。

承認の依頼・問い・答え・承認資料

| 語 | 識別子 | 意味 | 廃止した語 | 廃止した識別子 | SSOT |
| --- | --- | --- | --- | --- | --- |
| 承認の依頼 | — | NDF の承認ゲート（設計・リリース）か、レッドラインに当たる操作で、人の承認を求めるもの | — | — | `docs/design/overview.md` |
| 問い | — | NDF が区分を付けて人へ出す、承認の依頼でない問い | — | — | `docs/design/overview.md` |
| 承認資料 | — | 承認の依頼が添える、承認の判断に要る材料（題・目的・差分の要約・リンク）。要約値でバージョンを見分ける | — | — | `docs/design/overview.md` |
| 答えの送達 | — | 確定した答えを、ランナーが NDF へ ndf answer で渡し終えるまでの流れ。状態は未渡し・渡し中・届いた・失敗。対象は NDF の区間の報告から作った承認の依頼（ndf-gate:* と ndf-ask:redline:<番号>）の答えと、ndf-ask:human-action を除く問いの答え（委任が確定したものも含む）。ndf-ask:human-action の答えと起票の依頼の答えは対象外 | — | — | `docs/design/execution.md` |
