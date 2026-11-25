# 104: インフラの課題（#13）の設計の記録を docs/design-process/issue-13/ へ写す

## 関連リンク

- 要求仕様: [issue-104-requirements.md](./issue-104-requirements.md)（正は [#104](https://github.com/devbasex/nd-factory/issues/104) の本文）。受け入れ条件は番号で指す
- 設計書: [issue-104-design.md](./issue-104-design.md)（詳細設計は「どこを変えるか」に畳んである）
- モード: `standard`（#104 の本文の「進行」の欄の「モード」による）

## 修正対象

設計書の「どこを変えるか」の表から写す。5 本の記録は、どれも `git show 98fafb0:<元>` の出力に、設計書の決定 1 の表の置き換えを `](` の直後だけに当てて作る。

| ファイル | 変える中身 |
| --- | --- |
| `docs/design-process/issue-13/README.md`（新設） | [docs/design-process/issue-1/README.md](../docs/design-process/issue-1/README.md) と同じ並び（H1・何の記録かと今の正の段落・文書の一覧の表・移した後に直したことの段落・関わる Pull Request の表）で書く。中身は設計書の表のとおり |
| `docs/design-process/issue-13/requirements.md`（新設） | 元は `issues/issue-13-requirements.md`。相対リンクが無いため、元と同じ中身になる |
| `docs/design-process/issue-13/design.md`（新設） | 元は `issues/issue-13-design.md`。リンクの飛び先だけを決定 1 の表で置き換える |
| `docs/design-process/issue-13/design-detail.md`（新設） | 元は `issues/issue-13-design-detail.md`。同上 |
| `docs/design-process/issue-13/survey.md`（新設） | 元は `issues/issue-13-design-survey.md`。同上 |
| `docs/design-process/issue-13/plan.md`（新設） | 元は `issues/issue-13-plan.md`。同上 |

## タスク分解

変更の種類は機能追加なので、最初に今の振る舞いを縛る確かめを置く。ここでは、写した結果と比べる期待のファイルを先に作り、写す先が無いために比較が落ちることを見てから写す。

### Task 1: 期待のファイルを作り、比較が落ちることを確かめる

- **対象ファイル:** 無し（期待のファイルはリポジトリの外の一時ディレクトリに置く）
- **変更内容:** 5 本ごとに、`git show 98fafb0:<元>` へ決定 1 の表の置き換えだけを `](` の直後に当てて期待のファイルを作る。置き換えはその場のコマンドで行い、スクリプトをリポジトリに置かない。期待のファイルと `docs/design-process/issue-13/` の写す先を比べ、写す先が無いため落ちることを見る
- **満たす受け入れ条件:** 2 の確かめの用意
- **進め方:** 失敗する確かめ → Task 2 で通す。コードのテストは足さない（文書の写しで、設計書の「テスト設計」が確かめをコマンドで決めているため）

### Task 2: 5 本の記録を写す

- **対象ファイル:** `docs/design-process/issue-13/requirements.md`・`design.md`・`design-detail.md`・`survey.md`・`plan.md`
- **変更内容:** Task 1 の期待のファイルを写す先へ置く。記録の中身は直さない
- **満たす受け入れ条件:** 1（5 本の分）・2・3（5 本の分）
- **進め方:** Task 1 の比較が違い 0 で通ることを見る。5 本から `](` で始まる `https://` でないリンクを抜き、`#` より前のパスを各ファイルのディレクトリから `test -e` で引いて、在らないものが 0 件であることを確かめる

### Task 3: README を書く

- **対象ファイル:** `docs/design-process/issue-13/README.md`
- **変更内容:** 設計書の「どこを変えるか」の README の行と決定 2 のとおりに書く。記録の時点 `98fafb0`・設計の Pull Request #45・後から追わないこと・今の正の保存先へのリンク・食い違えば正の側が勝つこと・5 本の一覧の表・関わる Pull Request の表（#45・#70・#72・#74・#77・#81・#83・#90・#97・#103 の 10 行）を置く
- **満たす受け入れ条件:** 1（README の分）・3（README の分）・4・5・6
- **進め方:** 設計書の「テスト設計」の 4〜6 の行を 1 つずつ照らす。README のリンクも Task 2 と同じ `test -e` で確かめる

### Task 4: 範囲を確かめて 1 つのコミットにまとめ、CI を通す

- **対象ファイル:** 無し
- **変更内容:** Task 2・3 の変更を 1 つのコミット `<C>` にまとめる。`git diff --name-only <C>^ <C>` が 6 本だけを返すことを確かめる。スプリントの Pull Request の CI の `check`・`ref-check`・`leak-check` が通ることを確かめる
- **満たす受け入れ条件:** 7・8
- **進め方:** `ref-check` が写した記録に当たったときは、記録の中身を直さず、Pull Request にはジョブの出力の検査の種類・パス・行の番号だけを書き、作業を止めてリポジトリの管理者に判断を求める（設計書の「影響と危険」の「写した後の検査」）

## レビューの単位

| 単位 | 含むタスク | 満たす受け入れ条件 | 見込みの差分の行数 | 実際の行数 |
| --- | --- | --- | --- | --- |
| #104 | Task 1・2・3・4 | 104:1・104:2・104:3・104:4・104:5・104:6・104:7・104:8 | 約 60（README の約 40 行と、写しで元と違うリンクの行）。写しの 5 本（約 1,240 行）は `git show 98fafb0` から置き換えのコマンドで作るため、再生成で作るファイルと同じく数えない。数えるコマンドは `git diff --shortstat <ベース>...HEAD -- . ':(exclude)issues/issue-*' ':(exclude)docs/design-process/issue-13/requirements.md' ':(exclude)docs/design-process/issue-13/design.md' ':(exclude)docs/design-process/issue-13/design-detail.md' ':(exclude)docs/design-process/issue-13/survey.md' ':(exclude)docs/design-process/issue-13/plan.md'` に、写しと元の違う行の数を足す | （実装の後に書き足す） |

単位を分けないのは、設計書が #104 の変更を 1 つのコミットにまとめ、受け入れ条件 8 をそのコミットと親のコミットの比較で確かめると決めているためである。写しの中身は、レビューの担当が読む代わりに Task 1 の比較（違い 0）で確かめる。

## リファクタリングの時機

| 時機 | 対象 | 理由 |
| --- | --- | --- |
| 実装の前（準備のリファクタリング） | しない | 触るのは新設の 6 本だけで、既にあるファイルを触らない。同じファイルを触るタスクは無い。覆うテストは無く、設計書の「テスト設計」のコマンドで確かめる |
| 実装の中 | 各タスクで行う | `tdd-cycle` のリファクタリングのステップ |
| スプリントの終わり（cross-refactoring） | しない | 新設の記録は後から追わず中身を直さないため、ほかの単位とまとめて整える対象にならない |

## リスクと対処

| リスク | 対処 |
| --- | --- |
| 置き換えがリンクの外の本文（コードブロックの中のパスなど）に当たり、リンクを含まない行が変わる | 置き換えは `](` の直後だけに当て、Task 1 の比較で違い 0 を確かめる |
| 照合の語が増えていて、写した記録が `ref-check` に当たる | Task 4 の進め方のとおり、記録を直さずに止めて判断を求める |

## 完了の定義

- [ ] 受け入れ条件 1〜8 をすべて満たし、条件ごとに設計書の「テスト設計」の確かめと結果が対応している
- [ ] `standard` の検証の段階（`npm run check` と CI）を通す
