# 画面の基盤（画面マップ・共通の部品・翻訳・Service Worker・ダミー）

## 概要

機能の画面（[#28](https://github.com/devbasex/nd-factory/issues/28)）が共通に使う、画面の土台の仕組みである。`apps/web/` に React と TypeScript で実装し、Vite でビルドする。次のものを持つ。

- 画面マップ: 16 本の HTTP のルート（R1〜R16）を 1 つの表としてコードに持ち、ルーター・ナビゲーション・e2e・操作の対応の検査がその表を読む
- 共通の部品: 画面の文書の「共通の部品」を 1 ファイル 1 部品で置き、部品の一覧（カタログ）とディレクトリの一致をテストで確かめる
- 見た目の値: 色や寸法を JSON に持ち、そこから CSS の変数を生成する
- 翻訳: 文言を翻訳のファイルのキーで引き、日時・数・金額を利用者の言語と時刻帯で出す
- Service Worker: 画面の殻と画面の設定の値だけを保存し、オフラインでも画面を起動できるようにする
- ダミーのクライアント: mode `dummy` のビルドだけに入り、クエリパラメータで画面の状態を切り替える。本番の成果物に入らないことをビルドの検査で確かめる
- e2e の計測: 3 つの幅・手数とページの数・回線の絞り・押せる要素の大きさを数える

機能の画面の中身はまだ無い。16 本のルートには、題と 5 つの状態（読み込み中・空・エラー・見つからない・オフライン）だけを出す仮の画面を置く。R1（サインイン）と R14（自分の設定の利用者の表示）だけは実際の表示を持つ。

端末に置くデータ（端末のキャッシュ・送る列・保留の件・隔離・ログインのキャッシュ）と、つながったときのそろえ方は [端末のデータとそろえ方](screen-offline-data.md) にある。

## 用語

語の意味は [用語集](../glossary.md) に従う（画面の殻・写し・送る列・確定待ち・キャッシュして送る・つながってから押すなど）。用語集に無い語のうち、この文書で使うものは次のとおりである。

| 語 | 意味 |
| --- | --- |
| 画面マップの表 | 16 本の HTTP のルートの行を持つ表（`apps/web/src/routes/route-table.ts` の `ROUTES`） |
| 戻り先 | 画面ではない 3 つの受け口（サインインの戻り・連携ログインの戻り・サインアウトの戻り）。ルートにせず、ルーターの前で見分ける |
| 起動の組み立て | 本物かダミーのクライアントを 1 か所で選び、各要素を組む処理（`apps/web/src/app/compose.ts` の `composeApp`） |
| 仮の画面 | 題と 5 つの状態だけを出す画面（`apps/web/src/screens/placeholder.tsx`） |

## 構成要素と責務

| 要素 | 置き場（`apps/web/` から） | 責務 |
| --- | --- | --- |
| ページの起動 | `src/main.tsx` | `#app` の要素に描く。組み立てと起動の順序を通し、失敗したらエラーの表示と「もう一度」を出す |
| 起動の組み立て | `src/app/compose.ts` | 言語と時刻帯を決め、mode `dummy` のときだけダミーのモジュールを動的に読み込む。それ以外は本物のブラウザーにつなぐ依存を組む |
| 起動の順序 | `src/app/boot.ts` | 画面の設定の値を読み、戻り先を判定し、サインインと利用者の取得を通して最初の画面の状態を返す |
| 画面の描き分け | `src/app/App.tsx` | 起動の状態に応じて、枠とルーターか起動の途中の表示を描く。`<html lang>` を決めた言語へ書き換える |
| 画面マップの表 | `src/routes/route-table.ts` | 16 本のルートの行と、戻り先の判定 |
| ルートと操作の対応 | `src/routes/route-operations.generated.ts` | 画面の文書の「画面一覧」の表から生成した、ルートごとの操作の名前 |
| ルーター | `src/routes/router.tsx` | 表の行から React Router のルートを作る |
| 画面 | `src/screens/` | 仮の画面・サインイン（R1）・自分の設定（R14）・保留の一覧のダイアログ |
| 共通の部品 | `src/ui/` | 19 の部品と、その一覧 `catalog.ts`。見た目の値と共通の CSS（`ui.css`） |
| 翻訳 | `src/i18n/` | 翻訳のファイル（`ja.json`・`en.json`）・言語の決め方・キーの引き当て・書式 |
| Service Worker | `src/sw/` | 保存の規則（`cache-rules.ts`）・本体（`service-worker.ts`）・登録（`register.ts`） |
| ダミーのクライアント | `src/dummy/` | ダミーの表示データ・つながり・端末のデータ |
| 生成と検査のスクリプト | `scripts/` | 見た目の値の生成・ルートと操作の対応の生成・Service Worker のビルド・成果物のモジュールの一覧・ダミーの混入の検査 |
| e2e の計測 | `e2e/support/` | 手数・ページの数・回線の絞り・押せる要素の大きさ |

依存の向きは `main.tsx` → `app/` → `screens/` → `ui/`・`i18n/` で、`app/` が `routes/`・`offline/`・`sw/register.ts` を組む。`offline/`・`ui/`・`routes/` は `app/` と `screens/` を読まない。`dummy/` は起動の組み立ての動的な import だけが読む。大域の `fetch` を直に呼ぶのは `app/compose.ts` と `sw/service-worker.ts` だけである。

## 背景

画面の振る舞い（画面マップ・ナビゲーション・端末の幅・オフライン・国際化）は、画面の文書（[screens.md](../design/screens.md)）が決めている。この仕組みは、その決まりをどのファイルとライブラリで実現するかを持つ。主な選択と理由は次のとおりである。

| 選択 | 理由 |
| --- | --- |
| ルーターに React Router を使う | 画面マップの表から HTTP のルートを作れる |
| Service Worker は登録・保存の規則・版の切り替えを自前で書く | 画面の殻だけを保存し、API のレスポンスを残さないため（画面の文書の決定 28） |
| 見た目の値は Style Dictionary で CSS の変数にし、生成物をコミットする | 色や寸法の値を 1 か所に置くため |
| ルートと操作の対応は画面の文書の「画面一覧」から生成する | 対応を 1 か所に置き、操作の表と両方向で照合するため |
| 部品の一覧を 1 つのファイルに持つ | 部品の一覧と置き場を食い違わせないため |
| 回線の絞りは Chromium の DevTools Protocol で掛ける | 待ち時間を毎回同じ条件で測るため |
| ダミーは起動の組み立てで mode を見て動的に読み込む | 本番の成果物にダミーを入れないため |
| 翻訳は i18next を使わず自前で持つ | 画面の文書の決定 34 |

## 仕様

### 起動の順序

`boot` は次の順に条件を確かめ、当たった所で最初の画面の状態を返す。状態は `config_unavailable`・`login_waiting`・`signin`・`returning`・`ready` の 5 つである。

| 順 | 条件 | 結果 |
| --- | --- | --- |
| 1 | 画面の設定の値（`/config.json`）を読めない | `config_unavailable`。エラーの表示と「もう一度」（押すと再読み込み） |
| 2 | 本番の配信のときは Service Worker を登録する。完了を待たず、失敗はログに残して続ける | 次の行へ |
| 3 | 設定の `login_ready` が偽 | `login_waiting`。設定の待ちを示し、ログインへ送らない |
| 4 | 戻り先が連携ログインの戻りかサインアウトの戻り | `returning`。URL を保ったまま、サインインの処理（[#4](https://github.com/devbasex/nd-factory/issues/4)）へ渡す |
| 5 | 戻り先がサインインの戻り | 認可コードを交換する。失敗したら `returning` のエラーと「もう一度」。成功・失敗とも、認可コードを履歴から消し、戻す先の path へ置き換える |
| 6 | 期限内の token が無い | 認可コードと PKCE（S256）で認可の頁へ送り、`signin` |
| 7 | 利用者の取得（`users.get`）が 401 で、送り直しの印がタブの `sessionStorage`（キー `nd.reauth`）に無い | 印を置いてログインへ 1 回だけ送り直す |
| 8 | 上のどれでもない | `ready`。2 回目の 401 はエラーと「もう一度」を出し、送り直しを繰り返さない |

サインインの後に戻す先は、同じ配信元の画面マップの path だけにする。それ以外は `/` に戻す。

ログインのキャッシュ（refresh token）の保存先は、今はタブの `sessionStorage` である（`oidc-client-ts` の `WebStorageStateStore`）。暗号化した端末のデータベースへの切り替えは、#4 の「サインインを確定する」呼び出しと同じリリースで行う（[画面の基盤の続き #196](https://github.com/devbasex/nd-factory/issues/196)）。切り替えるまで、本番の起動は端末のデータベースを開かず、写し・送る列・そろえ方を動かさない。端末のデータの部品は起動の組み立ての `device` に入れて渡してあり、ダミーの mode だけが使う。

### 画面マップの表

`ROUTES` の各行は `{ id, path, group, titleKey, operations, offline, nav }` を持つ。`operations` は生成物から引き、手で書かない。

| ルート | path | 群 | オフラインで読めるか | ナビゲーションの行き先 |
| --- | --- | --- | --- | --- |
| R1 | `/signin` | サインイン | 読めない | — |
| R2 | `/` | 主 | 読める | オーガナイザー |
| R3 | `/p/:projectId` | プロジェクト | 読める | スプリント |
| R4 | `/p/:projectId/start` | プロジェクト | 読めない | スプリント |
| R5 | `/p/:projectId/sprints/:sprintId` | プロジェクト | 読める | スプリント |
| R6 | `/p/:projectId/approvals/:approvalId` | プロジェクト | 読める | 承認待ち |
| R7 | `/p/:projectId/questions/:questionId` | プロジェクト | 読める | 承認待ち |
| R8 | `/p/:projectId/settings` | プロジェクト | 読めない | 設定 |
| R9 | `/t/:teamId` | チーム | 読めない | 設定 |
| R10 | `/t/:teamId/projects/new` | チーム | 読めない | 設定 |
| R11 | `/t/:teamId/execution` | チーム | 読めない | 設定 |
| R12 | `/t/:teamId/usage` | チーム | 読めない | 設定 |
| R13 | `/t/:teamId/audit` | チーム | 読めない | 設定 |
| R14 | `/me` | 自分 | 読める | 設定 |
| R15 | `/p/:projectId/organizers/:organizerId` | 主 | 読める | オーガナイザー |
| R16 | `/approvals` | 主 | 読める | 承認待ち |

- ルーターは表の 16 行からルートを作る。表に無い path は、履歴を置き換えて `/` へ移す
- 戻り先は、ルーターより先に次の順で判定する（`matchReturn`）。`/signed-out` はサインアウトの戻り、`/me/logins/return` は連携ログインの戻り、`code` と `state` の両方のクエリパラメータを持つ `/` はサインインの戻りである。`code` か `state` の片方だけの `/` は戻り先にしない
- 仮の画面は `React.lazy` で分けて読み込む。分けたチャンクも Service Worker が事前に保存する一覧に載る

#### ルートと操作の対応の生成

`scripts/build-route-operations.ts` が、画面の文書の見出し「## 画面一覧」の直後の最初の表から、ルートごとの操作の名前を読み、`src/routes/route-operations.generated.ts` を作る。`npm run generate` で書き、`npm run generate:check` で古さを比べる。表の見出しが無いか、ルートが R1〜R16 の 16 本そろわなければ、欠けた見出しか番号を標準エラーに出して終了コード 1 で止まり、何も書かない。

### 共通の部品

`src/ui/catalog.ts` は `{ name, file }` の配列で、次の 19 件を持つ。画面の文書の [共通の部品](../design/screens.md#共通の部品) の 17 行のうち「ボタン・入力欄・選択の欄」を 3 ファイルに分けている。見た目と振る舞いの決まりは同じ表にある。

| ファイル（`src/ui/`） | 部品 | 状態 |
| --- | --- | --- |
| `app-frame.tsx` | 枠（ナビゲーション・場所の切り替え・帯の置き場） | 場所のメニューの開・閉 |
| `top-bar.tsx` | 上の帯 | — |
| `data-list.tsx` | 一覧 | 行あり（0 件は空の状態） |
| `detail-list.tsx` | 詳細 | — |
| `collapsible.tsx` | 畳む節 | 開・閉 |
| `status-badge.tsx` | 状態のバッジ | 画面の文書の 7 つの調子 |
| `empty-state.tsx` | 空の状態 | 空・見つからない・「つながると読めます」 |
| `loading.tsx` | 読み込み中 | 動く・動きを減らす |
| `error-notice.tsx` | エラーの表示 | やり直せる・やり直せない |
| `confirm-dialog.tsx` | 確認のダイアログ | 開・閉 |
| `offline-banner.tsx` | オフラインの帯 | 出ない・オフライン・読み直せない・保留あり |
| `pending-badge.tsx` | 確定待ちのバッジ | 確定待ち・結果未確認 |
| `action-result.tsx` | 操作の結果 | 成功（`status`）・失敗（`alert`） |
| `time-text.tsx` | 時刻 | 相対・絶対 |
| `money-text.tsx` | 金額 | 通常・通貨が無い（エラーの表示） |
| `document-body.tsx` | 資料の本文 | 通常 |
| `button.tsx` | ボタン | 通常・押せない（「つながると使えます」） |
| `text-field.tsx` | 入力欄 | 通常・誤り |
| `select-field.tsx` | 選択の欄 | 通常・押せない |

- 幅の区切りは CSS の `@media (min-width: 640px)` と `(min-width: 1024px)` だけに置き、TSX は幅を読まない。ナビゲーションの 4 つの行き先（オーガナイザー・承認待ち・スプリント・設定）は、640 px 未満で下の帯、1024 px 未満で細い帯、1024 px 以上で横の帯に、同じ順で出る
- 押せる要素の最小の大きさは、見た目の値 `size.target.min`（44 px）を共通の CSS の 1 か所で当てる
- 資料の本文（`DocumentBody`）は Markdown を `mdast-util-from-markdown`（GFM）で構文木にし、段落・見出し・箇条・表・コード・引用・強調・リンクだけを React の要素にする。HTML の節は捨て、画像は代わりの文だけを出す。リンクの行き先は `https:` と画面マップの path だけを `href` にする。`dangerouslySetInnerHTML` は使わない
- 確認のダイアログは `<dialog>` の `showModal` を使い、フォーカスを中に留め、Esc で確定せずに閉じる

### 見た目の値

`src/ui/tokens.json`（ライト）と `src/ui/tokens.dark.json`（ダーク）を Design Tokens Format で持つ。`scripts/build-tokens.ts` が Style Dictionary で `src/ui/tokens.generated.css` を作る。ダークの値は `@media (prefers-color-scheme: dark)` の中に出る。`npm run generate` で書き、`npm run generate:check` で古さを比べる。参照の解けない値か古い生成物があれば、理由を出して終了コード 1 で止まる。

### 翻訳

| 項目 | 決まり |
| --- | --- |
| 言語 | `ja` と `en`。言語を足すときは、翻訳のファイル 1 つと `src/i18n/locales.ts` の 1 行を足す |
| 言語の決め方 | 自分の設定 → ブラウザーの言語のうち最初に当たるもの → `ja` の順。`ja-JP` は `ja` に当てる |
| キーの引き当て | キーは `ja.json` の入れ子のキーを `.` でつないだ型（`MessageKey`）である。`{{name}}` の差し込みと、`_one`・`_other` の複数の形を解く。翻訳の無い理由のコードは `errors.reason.unknown` を引く |
| 日時 | 利用者の時刻帯で出す。相対の表示は 24 時間以内だけで、それより前は日時を出す |
| 数と金額 | `Intl` で言語ごとの区切りを出す。通貨の無い金額は出さず、エラーの表示にする |

時刻帯は `Intl.DateTimeFormat().resolvedOptions().timeZone` から決める。端末の時刻は、読むたびに新しい時計（`createClock().epochMs()`）を作って読む。

### Service Worker

Service Worker が保存するのは、画面の殻と画面の設定の値だけである。API のレスポンスは保存しない。保存先は Cache Storage の `nd-shell-<版>` である。

| リクエスト | 扱い |
| --- | --- |
| GET 以外・別の配信元・`/signed-out` | ネットワークへ通す |
| `/config.json` | ネットワークから読み、形が合えば保存して返す。読めなければ保存した値を返す |
| 画面へのナビゲーション | 保存した `index.html` を返す |
| 事前に保存する一覧にある path で、クエリパラメータが無いもの | 保存した応答を返す |
| そのほか | ネットワークへ通す |

- 事前に保存する一覧と版は `scripts/build-sw.ts` が作る。一覧は Vite のビルドの一覧と、`index.html` などの名前の決まったファイルが直に参照する公開のファイルから作る。版は、一覧のファイルの中身と、一覧と版を埋め込む前の Service Worker のコードから求める。ビルドの一覧そのものは配らない
- `skipWaiting` と `clients.claim` を呼ばない。開いているタブには、読み込んだ版の 1 揃いを返し続ける。開き直すと新しい版になる
- 配信の S3 は古い版のファイルを消さない（`infra/lib/app-stack.ts` の `BucketDeployment` の `prune: false`）。開いているタブが前の版のチャンクを取れるようにするためである
- 設定の値には、読み出しを始める前に取った番号を付けて保存する。番号は、端末のデータベースとは別の IndexedDB `nd-config-seq` の番号の生成器から取る。この IndexedDB は行を残さず、サインアウトでも消さない。新しい番号の値だけが古い値を上書きする
- `activate` では、すべての版の保存から一番新しい番号の値を今の版へ写し、旧い版の保存を消す。`install` で設定を読めず、旧い版に値があるのに引き継げる値が無いときは、install を失敗させて旧い版を残す
- 初回の訪問では、ページは Service Worker の制御の前に設定を読む。そこで登録（`registerServiceWorker`）は、ページが読んだ設定の値をメッセージで渡し、保存の完了の返事を待つ。ページから受けた値は、保存した値が無いときだけ書く
- Web App Manifest は `public/manifest.webmanifest` にある（`display: standalone`・`start_url: /`）

### ダミーのクライアント

mode `dummy` のビルド（`vite build --mode dummy`）のときだけ、起動の組み立てが `src/dummy/dummy-client.ts` を動的に読み込む。外へは何も送らず、作り物の値だけを使う。クエリパラメータ `scenario` と `connection` を読むのは、このモジュールの中だけである。

| クエリパラメータ | 値 | 画面の状態 |
| --- | --- | --- |
| `scenario` | `normal`（既定）・`empty`・`error`・`notFound`・`slow` | 仮の画面が、行あり・空・エラー・見つからない・2 秒の読み込み中の後に行あり、を出す。知らない値は `normal` |
| `connection` | `offline` | つながっていないとして扱う |
| `connection` | `pending` | 確定待ちが 1 件ある状態にする |
| `connection` | 無し | ブラウザーのつながりに従う |

ダミーの mode は、端末のデータベースと送る列とそろえ方の本物の部品を使い、送り先だけを作り物にする（`src/dummy/device.ts`）。対象の ID の末尾が `-closed` なら `state_mismatch`、`-changed` なら `version_mismatch` で確定待ちを拒む。

#### 本番の成果物の検査

`npm run build`（`apps/web`）は、Vite のビルド → Service Worker のビルド → ダミーの混入の検査（`scripts/check-dummy-free.ts`）の順に通し、検査が失敗すると終了コード 1 で止まる。検査は次の 3 つを調べる。

| 調べるもの | 落とす条件 |
| --- | --- |
| 成果物に入ったモジュールの一覧（画面と Service Worker の 2 つ。`scripts/module-list-plugin.ts` が書く） | `apps/web/src/dummy/` か `packages/contracts/generated/dummy/` のモジュールがある。`packages/contracts/src/client.ts` に `createDummyTransport` の書き出しが残る。どちらかの一覧が空（プラグインが働いていない） |
| 成果物のファイルの中身 | 目印の文字列 `nd-factory:dummy-client` がある |

### e2e の計測

`apps/web/e2e/support/measure.ts` が次の計測を持つ。e2e は Chromium の 3 つの幅（360・768・1280 px）で打ち、本番の mode とダミーの mode の 2 組の配信物を `vite preview` で出す。

| 計測 | 中身 |
| --- | --- |
| 回線の絞り（`throttle`） | DevTools Protocol で、遅延 150 ms・下り 200,000 バイト/秒・上り 93,750 バイト/秒（`NETWORK_4G`）を掛ける |
| 手数とページの数（`countActions`） | 押した回数と、移った先の path の数を数え、上限を超えたら落とす |
| 待ち時間（`recordTiming`） | 絞りの設定と一緒に `test-results/timings.json` へ記録する。合否には使わない |
| 押せる要素の大きさ（`smallTargets`） | 文中のリンクを除き、幅か高さが 44 px 未満の要素を返す |

この課題は仕組みを作り、仮の画面で上限を超えると落ちることを確かめている。実際の操作の場面は、機能の画面（#28）がこの計測で書く。

## データ・設定

| 保存先 | 置くもの |
| --- | --- |
| Cache Storage `nd-shell-<版>` | 画面の殻と画面の設定の値 |
| IndexedDB `nd-config-seq` | 設定の値の番号の生成器だけ（行を残さない） |
| `sessionStorage` | OIDC の認可フローの状態・今のログインのキャッシュ・401 の送り直しの印 `nd.reauth` |

API の CORS は `Date` ヘッダーを公開する（`infra/lib/app-stack.ts` の `exposeHeaders: ["date"]`）。画面が API の時刻を読むためである。`Retry-After` は公開していないため、画面は `Retry-After` が無いものとして既定の待ちを使う。公開は #196 で行う。

端末のデータベースの保存先と列は [端末のデータとそろえ方](screen-offline-data.md#データ設定) にある。

## エラー処理

| 場面 | 扱い | 利用者に見えるもの |
| --- | --- | --- |
| 組み立てか起動が例外を投げた | 止める | エラーの表示と「もう一度」（再読み込み） |
| 画面の設定の値を読めない | 止める | エラーの表示と「もう一度」 |
| サインインの戻りの失敗 | 止める | エラーの表示と「もう一度」（ログインへ送り直す） |
| 2 回目の 401 | 止める | エラーの表示と「もう一度」（サインインのやり直し） |
| Service Worker の登録の失敗 | 続ける。ログに残す | 出さない |
| 資料の本文の許さない節・行き先 | 捨てるか文字だけにする | 文字として出る |

## セキュリティ

- Service Worker の保存先に API のレスポンスを置かない
- 本番の成果物にダミーのモジュール・ダミーの送信・目印が無いことを、ビルドごとに検査する
- 資料の本文は、許した節と行き先だけを要素にし、HTML の文字列を作らない
- 例・テスト・ダミーには作り物の値だけを使う

## 運用

- 生成物（`tokens.generated.css`・`route-operations.generated.ts`）は `npm run generate` で作り直してコミットする。CI の `check` が古さを落とす
- 手元の確かめは `npm run check`・`npm run knip`・`npm run build:web`・`npm run e2e`
- Service Worker を反映した後は、利用者のブラウザーに Service Worker が残る。戻すときは直した版を出し直す。`prune: false` は戻さない
- 実機でしか分からない値（iOS の Safari・Badging と Background Sync・鍵の置き場・端末のキャッシュの量・実 API をつないだ待ち時間）は、まだ測っていない。手元の値は次のとおりである（2026-11-26）

| 項目 | 値 |
| --- | --- |
| 画面の殻の初回の大きさ | 約 206 KB（gzip。圧縮前は約 686 KB）。事前に保存する 6 ファイルの合計 |
| S2「Web アプリを開く」の仮の画面の初回の読み込み（ダミー・`NETWORK_4G`・Service Worker の保存なし） | 2,192〜2,211 ミリ秒（ヘッドレスの Chromium、Playwright 1.65.1、3 つの幅） |

## テスト観点

| 観点 | 確かめ方 |
| --- | --- |
| 16 本の path を直に開くと、その画面が出る。表に無い path は履歴を置き換えて `/` へ移る。3 つの戻り先は URL を保ったまま渡す | e2e（`routes.spec.ts`） |
| 3 つの幅で、ナビゲーションの 4 つの行き先が同じ順で出る | e2e（`layout.spec.ts`） |
| どの幅でも、押せる要素が 44 px 未満だと落ちる | e2e（`layout.spec.ts`・`routes.spec.ts`） |
| 部品の一覧とディレクトリの `*.tsx` が両方向で一致する | 単体テスト（`ui.test.tsx`） |
| 画面の操作と、スキーマの正本の操作の一覧が対応する。生成物が古いと落ちる | `npm run generate:check` と単体テスト（`route-table.test.ts`） |
| 言語を切り替えると文言が変わり、日時は利用者の時刻帯で出る。`ja` と `en` のキーの集合が一致する | e2e（`i18n.spec.ts`）と単体テスト |
| 手数とページの数が上限を超えると落ちる。待ち時間を絞りの設定と一緒に記録する | e2e（`budget.spec.ts`） |
| 本番の成果物にダミーが無い。ダミーの mode では `scenario` と `connection` で状態が変わる | ビルドの検査と e2e（`dummy.spec.ts`） |
| Service Worker の保存先に API のレスポンスが無い。オフラインで画面の URL を直に開くと起動する | e2e（`offline.spec.ts`） |
| 旧い版のタブは自分の版のチャンクと設定の値を読み続け、開き直すと新しい版になる。更新で設定を読めなくても旧い値を引き継ぐ | e2e（`sw-update.spec.ts`） |
| 骨組みの起動の振る舞い（認可の頁への送り・`login_ready`・401 の 1 回の送り直し・設定と戻りの失敗） | e2e（`user-page.spec.ts`）と単体テスト（`boot.test.ts`） |
| 資料の本文で `<script>` と `javascript:` のリンクが要素にならない | 単体テスト（`ui.test.tsx`） |

## 関連リンク

- [画面の文書](../design/screens.md)（画面マップ・共通の部品・オフライン・国際化の決まり）
- [端末のデータとそろえ方](screen-offline-data.md)
- [スキーマの正本と横断の部品](contracts-and-core.md)
- 機能の画面 [#28](https://github.com/devbasex/nd-factory/issues/28)、利用者とチーム [#4](https://github.com/devbasex/nd-factory/issues/4)、画面の基盤の続き [#196](https://github.com/devbasex/nd-factory/issues/196)
