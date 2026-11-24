# 画面のモック

画面のモックのコード（Claude の Design のキャンバスの `project/` の下のファイル）の正本である。公開先のキャンバスは https://claude.ai/artifact/Vo1wCNvE9cYfPTtVWSoAdR である。設計の正本は [../screens.md](../screens.md) と [../organizer.md](../organizer.md) で、モックはそれを描いた見本にすぎない。

| ファイル | 中身 |
| --- | --- |
| `project/canvas.json` | キャンバスのインデックス（枚の位置・ページ・付箋） |
| `project/*.dc.html` | 1 枚ずつの画面 |
| `project/nd.css` | 旧い側の画面が読む共通の見た目 |
| `viewer.html` | 手元の閲覧のページ。`project/canvas.json` を読み、枚の並び・ページ・付箋をキャンバスと同じ位置に出す |

- ページ「オーガナイザー（#140）」: オーガナイザーの一覧と会話・付属の画面（旧い側の #278・#279 のモック）
- ページ「旧い側の画面（作り直す前）」: 作り直す前の画面一式。ナビゲーションは旧い形のまま
- `support.js` はキャンバスの型が配るファイルで、ここに置かない

## 手元で見る

```bash
python3 -m http.server -d docs/design/mock 8000
```

ブラウザで http://localhost:8000/viewer.html を開く。ドラッグで動かし、ホイールで拡大・縮小する。ページは上のボタンで切り替え、枚の上の名前を押すとその画面だけを開く。「画面の中を操作する」に印を付けると、並んだ画面の中でクリックやスクロールができる。

- ファイルを直に開く（`file://`）と、ブラウザが `canvas.json` の読み込みを止めるので、HTTP のサーバーを通す
- `project/*.dc.html` は 1 枚ずつ直に開いても見られる
- 枚が読む `support.js`（キャンバスの型が配る）はここに無いので、テーマの切り替えはキャンバスでだけ効く

## 直し方

1. このディレクトリのファイルを直して Pull Request にする
2. マージの後、`project/` の下の直したファイルをキャンバスへ公開する（公開の手順は Claude の Artifact の Design の型に従う）

例・見本には作り物の値だけを使う（AGENTS.md）。
