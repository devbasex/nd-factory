# 画面のモック

画面のモックのコード（Claude の Design のキャンバスの `project/` の下のファイル）の正本である。公開先のキャンバスは https://claude.ai/artifact/Vo1wCNvE9cYfPTtVWSoAdR である。設計の正本は [../screens.md](../screens.md) と [../organizer.md](../organizer.md) で、モックはそれを描いたサンプルにすぎない。

| ファイル | 中身 |
| --- | --- |
| `project/canvas.json` | キャンバスのインデックス（枚の位置・ページ・付箋） |
| `project/*.dc.html` | 1 枚ずつの画面 |
| `project/R<番号><幅>.dc.html` | ページ「画面の基盤（#12）」の枚。ルート R1〜R16 を幅ごと（`Phone`・`Tablet`・`Pc`）に 1 枚ずつ描く（例: `R06Pc.dc.html`） |
| `project/State<状態><幅>.dc.html` | 同じページの共通の状態の見本（`Loading`・`Empty`・`Error`・`NotFound`・`Offline`）。R16 で描く |
| `project/foundation.css` | ページ「画面の基盤（#12）」の枚が読む共通の見た目（ナビゲーション・状態のバッジ・一覧など） |
| `viewer.html` | 手元の閲覧のページ。`project/canvas.json` を読み、枚の並び・ページ・付箋をキャンバスと同じ位置に出す |

- ページ「画面の基盤（#12）」（最初に開くページ）: [画面マップ](../screens.md#画面マップ) の 16 本のルートを、行＝ルート（R1〜R16）、列＝幅（スマートフォン 390 px・タブレット 834 px・PC 1440 px）の格子に並べる。最後の 5 行は R16 で描いた共通の状態（読み込み中・空・エラー・見つからない・オフライン＋確定待ち）。幅ごとに別の枚にし、1 枚の中でメディアクエリで出し分けない
- ページ「オーガナイザー（#140）」: オーガナイザーの一覧と会話・付属の画面（旧い側の #278・#279 のモック）。ナビゲーションは旧い形のままで、R2・R15・R16 と重なる画面はページ「画面の基盤（#12）」を正とする
- `support.js` はキャンバスの型が配るファイルで、ここに置かない

## 手元で見る

利用者の Chrome で見せるときは、プロジェクト Skill `mock-viewer`（`npm run mock:up`）でコンテナから http://ndf-mock.localhost/ に出す。Chrome を使えないときは、次のとおり HTTP のサーバーで開く。

```bash
python3 -m http.server -d docs/design/mock 8000
```

ブラウザで http://localhost:8000/viewer.html を開く。ドラッグで動かし、ホイールで拡大・縮小する。ページは上のボタンで切り替え、枚の上の名前を押すとその画面だけを開く。「画面の中を操作する」にフラグを付けると、並んだ画面の中でクリックやスクロールができる。

- ファイルを直に開く（`file://`）と、ブラウザが `canvas.json` の読み込みを止めるので、HTTP のサーバーを通す
- `project/*.dc.html` は 1 枚ずつ直に開いても見られる
- 枚が読む `support.js`（キャンバスの型が配る）はここに無いので、テーマの切り替えはキャンバスでだけ効く

## 直し方

1. このディレクトリのファイルを直して Pull Request にする
2. マージの後、`project/` の下の直したファイルをキャンバスへ公開する（公開の手順は Claude の Artifact の Design の型に従う）

例・サンプルには作り物の値だけを使う（AGENTS.md）。
