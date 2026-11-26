# #12 の詳細設計: 画面の基盤

設計文書 [issue-12-design.md](./issue-12-design.md) の構成要素を、ファイルと関数の粒度へ下ろした文書である。振る舞いの決まり（保存先の列・そろえ方の段・保留の理由・照合の条件など）は設計文書が持ち、ここには写さず節の名前で指す。要求の受け入れ条件は [issue-12-requirements.md](./issue-12-requirements.md) にある。

この文書で使う語と番号の意味は、設計文書の次の場所にある。

| 語・番号 | 意味 | 設計文書の場所 |
| --- | --- | --- |
| そろえ方・段 1〜5 | 端末とサーバーの状態を合わせる処理と、その 5 つの段階 | 「解き方の全体像」「処理の流れ」 |
| 錠 | Web Locks API で取るロック | 「用語」 |
| `IW<番号>` | 設計文書が定める不変条件の番号 | 「ドメインモデル」の「不変条件」 |
| `LIB<番号>` | 調べたライブラリの番号 | 「外部の調査」の「ライブラリとサービス」 |
| サインアウトの証 | サインアウトで `sessions.delete` に送る access token と、そのセッションの指紋 | 「文脈と制約」 |
| 外しのキャッシュ | 今のセッションを発行した連携ログインを解除するときに送る `logins.delete` のアイテム | 「文脈と制約」 |
| セッションの指紋・`fingerprintTag` | `sub` と `origin_jti` をつないだ SHA-256 と、それをさらに HMAC にした値 | 「端末のデータベースの保存先と列」 |
| `switching` | 持ち主の交代のために件を隔離している間だけ真になる、キーの行の値 | 「保留の件と隔離」 |
| 受け入れ | 割り当ての受け入れ（`project_transfers.accept`） | 「段 1 の受け入れの扱い」 |
| 先映し | キャッシュして送る操作を、サーバーの結果を待たずに写しへ反映すること | 「用語」 |
| 途中のフラグ | サインアウトの途中のフラグと、連携ログインの解除の途中のフラグ | 「文脈と制約」 |
| サインアウトの 2.・5. | 2. は送る列と保留の件を片付ける段、5. はデータベースと鍵を消す段 | 「入出力のコントラクト」の「端末のデータを消す段」 |
| `answerTag` | 答えの ID（冪等キー）を HMAC にした値 | 「端末のデータベースの保存先と列」 |
| `api-time` | 最後に受けた API の応答の `Date` の値を置く、「送信の待機」の行 | 「端末のデータベースの保存先と列」 |
| `pressedFloor` | API の時刻で数えて、実際に押した時刻より後にならない値 | 「送る列の 1 件の中身」「段 2 の送る前の期限」 |

## 地図

パッケージ・モジュール構成（触るファイルだけ。`*` は新設）:

```text
apps/web/
├── index.html・package.json・tsconfig.json・vite.config.ts・playwright.config.ts
├── public/manifest.webmanifest *
├── scripts/ build-route-operations.ts * build-tokens.ts * build-sw.ts * module-list-plugin.ts * check-dummy-free.ts *
└── src/
    ├── main.tsx *   auth.ts   （main.ts・view.ts は消す）
    ├── app/      compose.ts * boot.ts * App.tsx *
    ├── routes/   route-table.ts * router.tsx * route-operations.generated.ts *
    ├── screens/  placeholder.tsx * signin.tsx * me.tsx * held-list.tsx *
    ├── ui/       catalog.ts * tokens.json * tokens.dark.json * tokens.generated.css * 部品 19 ファイル *
    ├── i18n/     ja.json * en.json * locales.ts * translate.ts * format.ts *
    ├── offline/  crypto.ts * db.ts * migrate.ts * snapshot-kinds.ts * authz.ts * guarded-commit.ts * cache-store.ts *
    │             operation-classes.ts * outbox.ts * held-store.ts * quarantine.ts * login-store.ts * pending-store.ts *
    │             erase.ts * connectivity.ts * send-wait.ts * api-transport.ts * revocation.ts * send.ts * sync.ts *
    ├── sw/       cache-rules.ts * service-worker.ts * register.ts *
    └── dummy/    dummy-client.ts *
packages/core/src/ids.ts
infra/lib/app-stack.ts
```

依存の向き: `main.tsx` → `app/` → `screens/` → `ui/`・`i18n/` の順で、`app/` はさらに `routes/`・`offline/`・`sw/register.ts` を組み立てる。`offline/` の中は、下の層から順に `crypto.ts`、`db.ts`、各保存、`revocation`・`send`、`sync` と並び、上の層が下の層を読む。各保存は `cache-store`・`outbox`・`held-store`・`quarantine`・`login-store`・`pending-store`・`send-wait` である。`authz.ts`・`snapshot-kinds.ts`・`operation-classes.ts` は、端末の保存を読まない葉である。`guarded-commit.ts` は `db`・`crypto`・`authz` だけを読む。`offline/`・`ui/`・`routes/` は `app/` と `screens/` を読まないので循環しない。画面の部品は写しと送る列を、`app/compose.ts` が渡すインターフェースの型を通して読む。`dummy/` は `app/compose.ts` の動的な import だけが読む。構成要素どうしの関係は設計文書の「構成要素」の図を指す。

| パス（`apps/web/` から） | 種類 | 役割 1 文 | 依存する先 | モジュール | 最上位の関数 |
| --- | --- | --- | --- | --- | --- |
| `src/main.tsx` | 新設 | ページの起動 | `app/` | main | — |
| `src/main.ts`・`src/view.ts` | 削除 | 骨組みの起動と表示（`app/` と `screens/` へ移す） | — | — | — |
| `src/auth.ts` | 変更 | `oidc-client-ts` の組み立て | oidc-client-ts | auth | `createAuth`（変更） |
| `src/app/compose.ts` | 新設 | 本物かダミーを選び、各要素を組む | `offline/`・`routes/`・`dummy/`（動的） | compose | `composeApp` |
| `src/app/boot.ts` | 新設 | 起動の順序 | `offline/`・auth・runtime-config | boot | `boot` |
| `src/app/App.tsx` | 新設 | 枠・ルーター・翻訳を描く | `ui/`・`routes/`・`i18n/` | App | `App` |
| `src/routes/route-table.ts` | 新設 | 画面マップの表と戻り先の振り分け | 生成物 | route-table | `matchReturn` |
| `src/routes/router.tsx` | 新設 | 表から React Router を作る | route-table・react-router | router | `createAppRouter` |
| `scripts/build-route-operations.ts` | 新設 | ルートと操作の対応の生成 | node | build-route-operations | `parseScreensTable`・`renderRouteOperations` |
| `src/screens/*.tsx` | 新設 | 仮の画面・サインイン・自分の設定・保留の一覧 | `ui/`・`i18n/` | screens | `PlaceholderScreen`・`SigninScreen`・`MeScreen`・`HeldListDialog` |
| `src/ui/*` | 新設 | 共通の部品とカタログ | react・`i18n/` | ui | 下の「枠と共通の部品」 |
| `scripts/build-tokens.ts` | 新設 | 見た目の値から CSS の変数を作る | style-dictionary | build-tokens | `buildTokens` |
| `src/i18n/*.ts` | 新設 | 言語の決定・引き当て・書式 | Intl | i18n | `pickLocale`・`createTranslator`・`formatDateTime`・`formatRelative`・`formatNumber`・`formatMoney` |
| `src/offline/crypto.ts` | 新設 | AES-GCM と HMAC | Web Crypto | crypto | `createKeySet`・`seal`・`unseal`・`tagOf` |
| `src/offline/db.ts` | 新設 | データベースの形・開く・番号・消す | idb・crypto | db | `openDeviceDb`・`readOwner`・`createOwner`・`nextSeq`・`deleteDeviceDb` |
| `src/offline/migrate.ts` | 新設 | 版の上げの中身の移行 | db・crypto | migrate | `runMigrations` |
| `src/offline/snapshot-kinds.ts` | 新設 | 写しにする種類の表 | — | snapshot-kinds | `snapshotKindOf`・`projectIdsOf` |
| `src/offline/authz.ts` | 新設 | 見られるプロジェクトの記録の判定と錠 | Web Locks | authz | `judgeVisibility`・`nextAuthz`・`addDenied`・`withAuthzLock` |
| `src/offline/guarded-commit.ts` | 新設 | 「利用者の境界」の照合と書き込み | db・crypto・authz | guarded-commit | `prepareGuard`・`commitGuarded` |
| `src/offline/cache-store.ts` | 新設 | 写しの読み書き | guarded-commit・snapshot-kinds | cache-store | `createCacheStore` |
| `src/offline/operation-classes.ts` | 新設 | 操作の 3 つの区分の表 | contracts の操作の表（型） | operation-classes | `operationClassOf` |
| `src/offline/outbox.ts` | 新設 | 送る列 | db・crypto・operation-classes | outbox | `createOutbox` |
| `src/offline/held-store.ts` | 新設 | 保留の件 | db・crypto・authz | held-store | `createHeldStore`・`visibleFieldsOf` |
| `src/offline/quarantine.ts` | 新設 | 隔離 | db・crypto | quarantine | `quarantinePending`・`restoreQuarantined`・`rollbackQuarantine`・`unreadableQuarantine` |
| `src/offline/login-store.ts` | 新設 | `userStore` と #4 が呼ぶ書き込み | db・crypto・quarantine | login-store | `createLoginStore` |
| `src/offline/pending-store.ts` | 新設 | 途中の記録 | db・crypto | pending-store | `createPendingStore` |
| `src/offline/erase.ts` | 新設 | サインアウトの 2. と 5. | db・quarantine | erase | `recordDiscardConfirmation`・`settleForSignout`・`deleteDeviceData`・`forgetDeviceMemory` |
| `src/offline/connectivity.ts` | 新設 | つながりの判定 | window | connectivity | `createConnectivity` |
| `src/offline/send-wait.ts` | 新設 | 待機の期限と API の時刻 | db・crypto | send-wait | `retryUntilFrom`・`createSendWait` |
| `src/offline/api-transport.ts` | 新設 | API への 1 つの送り方 | contracts の client | api-transport | `createApiSender` |
| `src/offline/revocation.ts` | 新設 | 段 1・段 5・403・404 の失効の反映 | guarded-commit・authz・cache-store | revocation | `planRevocation`・`applyRevocation`・`holdDenied` |
| `src/offline/send.ts` | 新設 | 段 2 | outbox・api-transport・send-wait・revocation | send | `classifyResult`・`checkDeadline`・`sendQueue`・`withdraw` |
| `src/offline/sync.ts` | 新設 | そろえ方の起動と段の順 | send・revocation・cache-store | sync | `createSync` |
| `src/sw/cache-rules.ts` | 新設 | 保存の規則と設定の値の保存 | Cache・Web Locks・idb | cache-rules | `classifyRequest`・`nextConfigSeq`・`saveConfig`・`pickNewestConfig` |
| `src/sw/service-worker.ts` | 新設 | `install`・`activate`・`fetch`・`message` | cache-rules | service-worker | — |
| `src/sw/register.ts` | 新設 | 登録と設定の値の受け渡し | navigator | register | `registerServiceWorker` |
| `public/manifest.webmanifest` | 新設 | Web App Manifest | — | — | — |
| `src/dummy/dummy-client.ts` | 新設 | ダミーの表示データとつながり | — | dummy-client | `createDummyApp` |
| `scripts/build-sw.ts` | 新設 | 事前に保存する一覧と Service Worker のビルド | vite | build-sw | `precacheList`・`shellVersion` |
| `scripts/module-list-plugin.ts` | 新設 | 成果物のモジュールの一覧を書く | vite | module-list-plugin | `moduleListPlugin` |
| `scripts/check-dummy-free.ts` | 新設 | ダミーの混入の検査 | node | check-dummy-free | `findDummyLeaks` |
| `e2e/support/` | 新設 | 手数・ページ数・回線の絞り・大きさの計測 | Playwright | measure | `throttle`・`countActions`・`recordTiming`・`smallTargets` |
| `packages/core/src/ids.ts` | 変更 | 冪等キーの UUID を足す | uuid | ids | `newIdempotencyKey`（新設） |
| `infra/lib/app-stack.ts` | 変更 | `prune: false` と `exposeHeaders` | aws-cdk-lib | AppStack | （関数の追加なし） |
| `package.json`・`apps/web/package.json`・`package-lock.json`・`vite.config.ts`・`tsconfig.json`・`index.html`・`playwright.config.ts`・`vitest.config.ts`・`knip.jsonc` | 変更 | 依存・生成・ビルド・テストの設定 | — | — | — |

ファイル全体にかかる決まりは次の 3 つである（`eslint.config.js` の横断の部品の規則による）。

| 項目 | 決まり |
| --- | --- |
| 端末の時刻 | `Date.now` は使えない。`createClock()` は戻った時刻を前の値へ丸めるため、時計の戻りを見分ける所（「時刻を読み直す手順」）では、読むたびに `createClock().epochMs()` で新しい時計を作る。この関数を `wallNow: () => number` として引数で渡し、テストで差し替える |
| 乱数 | 冪等キーは `newIdempotencyKey` で作る。暗号の IV は ID でないため、`crypto.ts` の 1 か所だけ `no-restricted-properties` を理由つきの注釈で外して `getRandomValues` を呼ぶ |
| `fetch` | 大域の `fetch` を直に呼ぶのは `app/compose.ts` と `sw/service-worker.ts` だけにし、ほかは引数で受ける |

## 起動の組み立て
満たす決定: 決定 4・決定 10、受け入れ条件 7・17
### 関数の仕様
| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `composeApp` | `src/app/compose.ts` | 新設 | `(env: BrowserEnv) => Promise<AppDeps>` | mode を見て本物かダミーを選び、保存・そろえ方・翻訳を 1 度だけ組む |
| `boot` | `src/app/boot.ts` | 新設 | `(deps: AppDeps) => Promise<BootState>` | 設定を読み、起動の順序を通して最初の画面の状態を返す |
| `createAuth` | `src/auth.ts` | 変更 | `(config: WebConfig, stores: { userStore: StateStore; stateStore: StateStore }) => UserManager` | 保存を引数で受けて `UserManager` を組む |
| `App` | `src/app/App.tsx` | 新設 | `(props: { deps: AppDeps; state: BootState }) => ReactElement` | `BootState` に応じて枠とルーターか、起動の途中の表示を描く |

- `composeApp`
  - 事後条件: `import.meta.env.MODE === "dummy"` の分岐の中だけで `dummy/dummy-client.ts` を `await import` する
- `boot`
  - 事後条件: 戻り値が写しを描く状態なら、ログインのキャッシュと持ち主の照合が済んでいる。途中のフラグがあれば利用者のデータを読んでいない
  - 副作用: IndexedDB の削除（期限切れの行）・`sessionStorage` の `oidc.user:` のキーの削除・Service Worker の登録
- `BootState` は `config_unavailable`・`login_waiting`・`signin`・`returning`（戻り先の処理）・`ready` の 5 つの和にする

#4 の「サインインを確定する」呼び出しを有効にするまで、`createAuth` の `stores` の 2 つには、今と同じ `WebStorageStateStore`（`sessionStorage`）を渡す。有効にする Pull Request（#4 の呼び出しと同じ Pull Request か、同じリリース）で `userStore` を `createLoginStore` に替える。`sessionStorage` の骨組みのキャッシュの削除も同時に入れる（設計文書の「#12 と #4 の反映の順」）。切り替える前は持ち主の利用者の ID が分からないため、端末のデータベースを作らず、写し・送る列・そろえ方を動かさない。骨組みの 401 の扱い（`nd.reauth` のフラグ）と `users-client.ts` の呼び出しは、`boot` と `MeScreen` へ移して振る舞いを変えない。

### 異常系の処理
| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `composeApp` | ダミーのモジュールの読み込みの失敗 | 配信の欠け | `await import` | 呼び出し元へ返す | `main.tsx` がエラーの表示 | 再読み込み |
| `boot` | 設定を読めない | `/config.json` の失敗か形の違い | `loadRuntimeConfig` | 止める | `config_unavailable` の表示と「もう一度」 | 再読み込みで再実行 |
| `boot` | データベースを開けない | 非公開ブラウズ・容量 | `openDeviceDb` | 既定値で続ける（写しと送る列を使わず、つながっていれば読む） | エラーの表示「この端末に保存できません」 | 次の起動で開き直す |
| `boot` | 持ち主の違い | 別の利用者の行 | `userTag` と `ownerTag` の比較 | 隔離してから消してサインインへ | サインインの画面 | 隔離が失敗したらデータベースを消さず止める |
| `boot` | Service Worker の登録の失敗 | 非対応・配信の欠け | `register` の reject | 既定値で続ける | 出さない（ログに残す） | 次の起動で再登録 |

### 処理の手順

`boot` は次の順に当たった所で返る。

| 順 | 条件 | 結果 |
| --- | --- | --- |
| 1 | 設定を読めない | `config_unavailable` |
| 2 | `login_ready` が偽 | `login_waiting` |
| 3 | `matchReturn` が戻り先を返す | `returning`（#4 の処理か、既存の `signinRedirectCallback`） |
| 4 | サインアウトか連携ログインの解除の途中のフラグがある | `runMigrations` の先行の移行だけを通し、#4 の再開へ渡す。写しを読まない |
| 5 | `runMigrations` → `rollbackQuarantine` → 確認の記録の片付け → `purgeExpiredLogin` → `purgeExpired` | 次の行へ |
| 6 | ログインのキャッシュが無い・読めない・持ち主と違う | `signin` |
| 7 | 上のどれでもない | `ready`（写しを描いた後、つながっていれば token の取り直し → `createSync().start()`） |

### 既存の部品の再利用
| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `composeApp`・`boot` | `main.ts` の `startApp` | `apps/web/src/main.ts` を読んだ | 順序と 401 の扱いを移す。表示は `view.ts` ごと置き換える |
| `boot` の設定の読み込み | `loadRuntimeConfig` | `apps/web/src/runtime-config.ts` | そのまま使う |
| `App` | 無し | `git ls-files apps/web/src` に TSX が無い | 新しく書く |
### 単体テストの観点
| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `composeApp` | mode で本物とダミーが替わる | — | 本番の mode でダミーを読まない |
| `boot` | 期限内の行と写しで `ready`（access token 無し・オフライン） | `refreshExpiresAt` が今と同じ | 異常系の各行・途中のフラグ |
| `createAuth` | 渡した保存に書く | — | — |
| `App` | `BootState` の 5 つを描き分ける | — | — |

## 画面マップの表
満たす決定: 決定 6、受け入れ条件 5・10
### 関数の仕様
| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `matchReturn` | `src/routes/route-table.ts` | 新設 | `(url: URL) => "return:signin" \| "return:link" \| "return:signout" \| null` | 設計文書の「画面マップの表」の振り分けの順で戻り先を判定する |
| `parseScreensTable` | `scripts/build-route-operations.ts` | 新設 | `(markdown: string) => Map<RouteId, string[]>` | 画面の文書の「画面一覧」の表からルートごとの操作の名前を読む |
| `renderRouteOperations` | 同上 | 新設 | `(map: Map<RouteId, string[]>) => string` | 生成物の TypeScript の文字列を作る |

- `parseScreensTable`
  - 事前条件: 見出し「## 画面一覧」の直後の最初の表を渡せる文書である
  - 事後条件: 返る `Map` の鍵は `R1`〜`R16` の 16 個
- `ROUTES` は `{ id, path, group, titleKey, operations, offline, nav }` の読み取り専用の配列である。`operations` は `route-operations.generated.ts` から引く

### 異常系の処理
| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `parseScreensTable` | 列の見出しが無い・ルートが 16 本そろわない | 画面の文書の書式の変更 | 表の読み取り | 止める | 標準エラーに欠けた見出しか番号。終了コード 1 | 何も書かない。直して再実行 |
| `renderRouteOperations` | `check` で生成物が古い | 生成し忘れ | 文字列の比較（呼び出し側） | 止める | 違うファイルの名前。終了コード 1 | `npm run generate` で直す |
### 単体テストの観点
| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `matchReturn` | 3 つの戻り先 | `code` か `state` の片方だけの `/` は `null` | `code` 付きの `/signed-out` は `return:signout` |
| `parseScreensTable` | 実の画面の文書から 16 本 | 操作の無いセル（R1 の括弧書き） | 見出しの違い・15 本 |
| `renderRouteOperations` | 同じ入力で同じ出力 | — | — |

### 既存の部品の再利用
| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `matchReturn` | `main.ts` の `isLoginReturn` | `apps/web/src/main.ts` | `code` と `state` の判定を移して広げる |
| `parseScreensTable`・`renderRouteOperations` | `packages/contracts/scripts/generate.ts`（`write`・`check` の形）、`mdast-util-from-markdown`（contracts の依存） | 同ファイルと `packages/contracts/package.json` | `write`・`check` の形に倣う。表の読み取りは同じ版の mdast を `apps/web` の開発の依存に足して使う |

## ルーター
満たす決定: 決定 1、受け入れ条件 10
### 関数の仕様
| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `createAppRouter` | `src/routes/router.tsx` | 新設 | `(screens: ScreenFactory) => ReturnType<typeof createBrowserRouter>` | `ROUTES` の 16 行からルートを作り、`*` を `replace` で `/` へ移す |
| `PlaceholderScreen` | `src/screens/placeholder.tsx` | 新設 | `(props: { route: RouteDef }) => ReactElement` | 題と 5 つの状態の仮の画面 |
| `SigninScreen` | `src/screens/signin.tsx` | 新設 | `(props: { onSignin: () => void; offline: boolean }) => ReactElement` | R1 |
| `MeScreen` | `src/screens/me.tsx` | 新設 | `(props: { user: SelfResult }) => ReactElement` | R14 の仮の画面に骨組みの利用者の表示を置く |

`PlaceholderScreen` が受ける表示データは `AppDeps` が渡す。本番の組み立てが渡すのは行の無いデータ（空の状態）で、画面は `dummy/` を読まない。戻り先の行はルートにしない。仮の画面は `React.lazy` で群ごとに分けて読み込み、遅延読み込みのチャンクが事前に保存する一覧に載ることを e2e で確かめる。

### 単体テストの観点
| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `createAppRouter` | 16 本の path がそれぞれの題を出す | `/` | 表に無い path は履歴が増えずに `/` |
| `PlaceholderScreen`・`SigninScreen`・`MeScreen` | 状態の描き分け | オフラインで写し無し | エラーと「もう一度」 |

### 既存の部品の再利用
| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `createAppRouter` | `react-router`（LIB1） | 設計文書の決定 1 | 使う |
| `PlaceholderScreen`・`SigninScreen`・`MeScreen` | `view.ts`・`users-client.ts` | 両ファイル | `fetchSelf` は使い、表示は部品で作り直す |

## 枠と共通の部品
満たす決定: 決定 7、受け入れ条件 4・11・12
### 部品の一覧と状態

`ui/catalog.ts` は `{ name, file }` の配列で、次の 19 件を持つ。画面の文書の [共通の部品](../docs/design/screens.md#共通の部品) の 17 行のうち「ボタン・入力欄・選択の欄」を 3 ファイルに分ける。見た目と振る舞いの決まりは同じ表を指す。

| ファイル（`src/ui/`） | 部品 | 受ける値 | 状態 |
| --- | --- | --- | --- |
| `app-frame.tsx` | 枠 | 今の行き先・場所の一覧・待ちの数 | 場所のメニューの開・閉 |
| `top-bar.tsx` | 上の帯 | 題・説明・主操作（0 か 1） | — |
| `data-list.tsx` | 一覧 | 行・列・行き先 | 行あり（0 件は `empty-state`） |
| `detail-list.tsx` | 詳細 | 名前と値の組 | — |
| `collapsible.tsx` | 畳む節 | 節の名前・見出し | 開・閉 |
| `status-badge.tsx` | 状態のバッジ | 調子の名前（画面の文書の 7 つ）・文言のキー | 調子 7 つ |
| `empty-state.tsx` | 空の状態 | 種類・次の行き先 | `empty`・`notFound`・`offlineNotCached`（「つながると読めます」） |
| `loading.tsx` | 読み込み中 | — | 動く・動きを減らす |
| `error-notice.tsx` | エラーの表示 | 理由のコード・やり直しの関数 | やり直せる・やり直せない |
| `confirm-dialog.tsx` | 確認のダイアログ | 題・本文・確定のボタンの名前 | 開・閉 |
| `offline-banner.tsx` | オフラインの帯 | つながり・最後に受け取った時刻・確定待ちの数・保留の数・読み直しの失敗の時刻 | 出ない・オフライン・読み直せない・保留あり |
| `pending-badge.tsx` | 確定待ちのバッジ | 期限の時刻・取り下げの関数 | 確定待ち・結果未確認 |
| `action-result.tsx` | 操作の結果 | 文言のキー | 成功（`status`）・失敗（`alert`） |
| `time-text.tsx` | 時刻 | UTC の値・相対か絶対 | 相対・絶対 |
| `money-text.tsx` | 金額 | 金額・通貨 | 通常・通貨が無い（エラーの表示） |
| `document-body.tsx` | 資料の本文 | Markdown の文字列 | 通常 |
| `button.tsx` | ボタン | 調子（主・承認・通常）・使えるか | 通常・押せない（「つながると使えます」） |
| `text-field.tsx` | 入力欄 | ラベル・値・誤りのキー | 通常・誤り |
| `select-field.tsx` | 選択の欄 | ラベル・選択肢 | 通常・押せない |

画面の 5 つの状態は、`loading`・`empty-state`（`empty`・`notFound`・`offlineNotCached`）・`error-notice` と `offline-banner` で出す。幅の区切りは CSS の `@media (min-width: 640px)` と `(min-width: 1024px)` だけに置き、TSX は幅を読まない。押せる要素の最小の大きさは見た目の値 `size.target.min`（44 px）を共通の CSS の 1 か所で当てる。

### 関数の仕様

部品の関数は上の表の「受ける値」を props に取り `ReactElement` を返す（種類はすべて新設、名前はファイル名の PascalCase）。ふるまいに分岐を持つ次の 2 つを挙げる。

| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `DocumentBody` | `src/ui/document-body.tsx` | 新設 | `(props: { markdown: string }) => ReactElement` | Markdown の構文木から安全な節だけを React の要素にする |
| `ConfirmDialog` | `src/ui/confirm-dialog.tsx` | 新設 | `(props: ConfirmProps) => ReactElement` | フォーカスを中に留め、Esc で閉じる |

`DocumentBody` は `mdast-util-from-markdown`（GFM）の構文木を読み、段落・見出し・箇条・表・コード・引用・強調・リンクだけを要素にする。`html` の節は捨て、画像は代わりの文だけを出し、リンクの行き先は `https:` と画面マップの path だけを `href` にする。`dangerouslySetInnerHTML` は使わない。

### 異常系の処理
| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `DocumentBody` | 許さない節・行き先 | 資料の中の HTML や `javascript:` | 節の種類と URL の scheme の判定 | 既定値で続ける（捨てるか文字だけ） | 文字として出る | — |
### 単体テストの観点
| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `DocumentBody` | 表とコードが横に送れる箱に入る | 空の文字列 | `<script>`・`javascript:` のリンクが要素にならない |
| `ConfirmDialog` | 確定のボタンに操作の名前 | Tab の末尾から先頭へ戻る | Esc で確定しない |
| そのほかの部品 | 上の表の状態ごとに役割と文言が出る | 通貨の無い金額 | — |
| カタログ | ディレクトリの `*.tsx` と両方向で一致 | — | 1 件足す・消すと落ちる |

### 既存の部品の再利用
| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `DocumentBody` | `mdast-util-from-markdown`・`mdast-util-gfm`・`micromark-extension-gfm` | `packages/contracts/package.json` | 同じ版を `apps/web` の依存に足して使う（HTML の文字列を作らない） |
| `ConfirmDialog` | ブラウザーの `<dialog>` の `showModal` | HTML の標準の要素 | 使う（フォーカスの保持と Esc を持つ） |
| `view.ts` の表示 | `apps/web/src/view.ts` | 同ファイル | 部品へ置き換えて消す |

## 見た目の値
満たす決定: 決定 8、受け入れ条件 12
### 関数の仕様
| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `buildTokens` | `scripts/build-tokens.ts` | 新設 | `(mode: "write" \| "check") => Promise<void>` | `tokens.json` と `tokens.dark.json` から `tokens.generated.css` を作るか比べる |

- `buildTokens`
  - 事後条件: ダークの値は `@media (prefers-color-scheme: dark)` の中に出る
  - 副作用: `src/ui/tokens.generated.css` の書き込み（`write` のときだけ）

### 異常系の処理
| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `buildTokens` | 参照の解けない値・生成物が古い | JSON の誤り・生成し忘れ | Style Dictionary・文字列の比較 | 止める | 理由。終了コード 1 | 何も書かない。直して再実行 |

### 既存の部品の再利用
| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `buildTokens` | `style-dictionary`（LIB5） | 設計文書の決定 8 | 使う |
### 単体テストの観点
| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `buildTokens` | `check` がコミットした生成物と一致 | — | JSON の値を変えると `check` が落ちる |

## 翻訳
満たす決定: 画面の文書の決定 34・36、受け入れ条件 16
### 関数の仕様
| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `pickLocale` | `src/i18n/locales.ts` | 新設 | `(setting: string \| null, preferred: readonly string[]) => Locale` | 自分の設定 → ブラウザの言語 → `ja` の順で決める |
| `createTranslator` | `src/i18n/translate.ts` | 新設 | `(locale: Locale) => (key: MessageKey, params?: Record<string, string \| number>) => string` | キーを引き、差し込みと複数の形を解く |
| `formatDateTime` | `src/i18n/format.ts` | 新設 | `(iso: string, o: { locale: Locale; timeZone: string }) => string` | 絶対の日時を出す |
| `formatRelative` | 同上 | 新設 | `(iso: string, nowMs: number, o: FormatOpts) => string` | 24 時間以内は相対、それより前は日時 |
| `formatNumber` | 同上 | 新設 | `(n: number, locale: Locale) => string` | 数を出す |
| `formatMoney` | 同上 | 新設 | `(amount: number, currency: string \| null, locale: Locale) => string \| null` | 通貨の無い金額は `null` |

`MessageKey` は `ja.json` の型から入れ子のキーを `.` でつないだ型にする。`errors.reason.<コード>` が無いコードは `errors.reason.unknown` を引く。言語を決めた所（`App`）で `<html lang>` を書き換える。

### 単体テストの観点
| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `pickLocale` | 設定が最優先 | `ja-JP` は `ja` | どれも対応外なら `ja` |
| `createTranslator` | `{{name}}`・`_one`・`_other` | 0 件・1 件 | 無い理由のコードは汎用の文。`ja` と `en` のキーの集合が一致 |
| `formatDateTime`・`formatRelative` | 時刻帯で日付が替わる | ちょうど 24 時間 | — |
| `formatNumber`・`formatMoney` | 言語ごとの区切り | 小数の無い通貨 | 通貨が `null` |

### 既存の部品の再利用
| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `pickLocale`・`createTranslator` | i18next | 画面の文書の決定 34 | 使わず自前（決定 34） |
| `formatDateTime`・`formatRelative`・`formatNumber`・`formatMoney` | `view.ts` の `formatLocal`、`Intl` | `apps/web/src/view.ts` | `Intl` を使う。`formatLocal` の項目の指定を移す |

## 端末のデータベース
満たす決定: 決定 3、受け入れ条件 13・14
### 関数の仕様
| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `createKeySet` | `crypto.ts` | 新設 | `() => Promise<{ key: CryptoKey; tagKey: CryptoKey }>` | 取り出せない AES-GCM 256 と HMAC-SHA-256 のキーを作る |
| `seal` | 同上 | 新設 | `(key: CryptoKey, value: unknown) => Promise<Sealed>` | 新しい 12 バイトの IV で JSON を暗号化する |
| `unseal` | 同上 | 新設 | `<T>(key: CryptoKey, sealed: Sealed) => Promise<T>` | 復号する。失敗は `UnreadableError` |
| `tagOf` | 同上 | 新設 | `(tagKey: CryptoKey, ...parts: string[]) => Promise<string>` | 部分を区切り文字でつないで HMAC の 16 進を返す |
| `openDeviceDb` | `db.ts` | 新設 | `(o: { onClosed: () => void }) => Promise<DeviceDb>` | 版 1 の 9 つの保存先を作って開き、`versionchange` で閉じる |
| `readOwner` | 同上 | 新設 | `(db: DeviceDb) => Promise<KeyRow \| null>` | キーの行を読む |
| `createOwner` | 同上 | 新設 | `(db: DeviceDb, userId: string) => Promise<KeyRow>` | キーと `ownerTag` を作り、全保存先を移行済みと記す |
| `nextSeq` | 同上 | 新設 | `(db: DeviceDb) => Promise<number>` | 読み出しの通し番号を 1 つ取る |
| `deleteDeviceDb` | 同上 | 新設 | `(o: { onBlocked: () => void }) => Promise<"deleted" \| "failed">` | データベースを丸ごと消し、`success` を待つ |
| `runMigrations` | `migrate.ts` | 新設 | `(db: DeviceDb, o: { only?: StoreName[] }) => Promise<void>` | 版の上げの表の順で中身を移す |

- `createOwner`
  - 事前条件: キーの行が無い
- `nextSeq`
  - 事後条件: 返る値は、どのタブで前に返した値より大きい。保存先に行は残らない
- `deleteDeviceDb`
  - 事前条件: このタブの接続を閉じている
  - 副作用: IndexedDB の削除
- `openDeviceDb`・`createOwner`・`runMigrations`
  - 副作用: IndexedDB の書き込み

### 異常系の処理
| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `unseal` | 復号できない | 壊れた暗号文・違うキー | AES-GCM の reject | 呼び出し元へ返す（`UnreadableError`） | 設計文書の「復号できないとき」の表 | 保存先ごと |
| `openDeviceDb` | 開けない | 容量・新しい版の DB | `openDB` の reject | 呼び出し元へ返す | `boot` の異常系 | 再読み込み |
| `createOwner` | 書き込みの失敗 | 容量 | トランザクションの abort | 呼び出し元へ返す | サインインを確定しない | 何も残らない。再実行できる |
| `deleteDeviceDb` | `blocked`・`error` | ほかの接続・ブラウザー | 要求のイベント | `blocked` は知らせて待つ。`error` は `failed` | 3 秒後の案内は #4 | 再実行できる |
| `runMigrations` | 移せない行 | 形の変換の失敗 | 変換の例外 | 版の上げの表の保存先ごとの扱い | 保留の件の件数 | 移行の記録で続きから |

### 内部のデータと定数
| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `Sealed` | 型 | `crypto.ts` | `{ iv: Uint8Array; data: ArrayBuffer }` |
| `DB_NAME`・`QUARANTINE_DB_NAME`・`CONFIG_SEQ_DB_NAME` | 定数 | `db.ts`（3 つ目は `sw/cache-rules.ts`） | `nd-device`・`nd-quarantine`・`nd-config-seq` |
| `DB_VERSION` | 定数 | `db.ts` | 1 |
| 保存先の名前 | 定数 | `db.ts` | `keys`・`snapshots`・`outbox`・`held`・`login`・`pending`・`wait`・`authz`・`seq` |
| `HoldReason` | 型 | `db.ts` | 設計文書の「保留の件と隔離」の表の 8 つ |
| `KeyRow`・各行の型 | 型 | `db.ts` | 設計文書の「端末のデータベースの保存先と列」 |

### 並行と排他
| 同時に走りうる処理 | 共有する資源 | 排他の取り方 | 冪等性と中断からの再開 |
| --- | --- | --- | --- |
| 2 つのタブの `runMigrations` | 各保存先 | 書くトランザクションで移行の記録・主キー・`iv` を確かめる | 移し終えた保存先は飛ばす |
| 別タブの `deleteDeviceDb` | 接続 | `versionchange` で閉じて `onClosed` を呼ぶ | 接続を閉じたタブは次の回まで開き直さない |

### 既存の部品の再利用
| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `createKeySet`・`seal`・`unseal`・`tagOf` | Web Crypto、`packages/contracts/src/sha256.ts`、`@noble/hashes` | `grep -n export packages/contracts/src/sha256.ts` | 取り出せないキーが要るため Web Crypto を直に呼ぶ（決定 3） |
| `openDeviceDb`・`readOwner`・`createOwner`・`nextSeq`・`deleteDeviceDb`・`runMigrations` | `idb`（LIB4） | 設計文書の決定 3 | `idb` を使う |
### 単体テストの観点
| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `createKeySet`・`seal`・`unseal`・`tagOf` | 往復する・同じ入力のタグは同じ | 同じ値を 2 回暗号化して IV が違う | `exportKey` が失敗・壊した暗号文 |
| `openDeviceDb`・`readOwner`・`createOwner` | 平文の列に利用者の ID が無い | 行が無ければ `null` | — |
| `nextSeq` | 単調に増える | 2 接続で重ならない | — |
| `deleteDeviceDb` | `deleted` | ほかの接続が閉じるのを待つ | `failed` |
| `runMigrations` | 設計文書のテスト設計「版の上げ」 | 2 重の起動 | 中断して再実行 |

## 端末のキャッシュの保存
満たす決定: 決定 3、受け入れ条件 6・13・14（IW1・IW2・IW11）
### 関数の仕様
| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `snapshotKindOf` | `snapshot-kinds.ts` | 新設 | `(operation: string) => SnapshotKind \| null` | 操作のレスポンスが写しにする種類かを返す |
| `projectIdsOf` | 同上 | 新設 | `(kind: SnapshotKind, value: unknown) => string[]` | 中身が含むプロジェクトの ID を集める |
| `judgeVisibility` | `authz.ts` | 新設 | `(record: AuthzRecord \| null, target: Target, fetchSeq: number) => "show" \| "drop" \| "hold"` | 設計文書の「記録との照合の表」 |
| `nextAuthz` | 同上 | 新設 | `(prev: AuthzRecord \| null, read: ListsRead) => AuthzRecord` | 段 1 の表のとおり記録を作り直す |
| `addDenied` | 同上 | 新設 | `(prev: AuthzRecord, id: string, deniedSeq: number) => AuthzRecord` | `denied` に足し世代を増やす |
| `withAuthzLock` | 同上 | 新設 | `<T>(mode: "shared" \| "exclusive", fn: () => Promise<T>) => Promise<T>` | `nd-authz` の錠の中で打つ |
| `prepareGuard` | `guarded-commit.ts` | 新設 | `(db: DeviceDb, owner: Owner) => Promise<Guard \| null>` | 設計文書の「利用者の境界」の照合と書き込みの手順 1・2（読み取りと持ち主の照合） |
| `commitGuarded` | 同上 | 新設 | `(guard: Guard, write: (tx: GuardedTx) => void) => Promise<"committed" \| "stale">` | 同じ照合と書き込みの手順 3（確認と書き込み） |
| `createCacheStore` | `cache-store.ts` | 新設 | `(d: { db: DeviceDb; wallNow: () => number }) => CacheStore` | 写しの保存を組む |

`CacheStore` のメソッドは次のとおりで、書くメソッドはすべて `Guard` を引数に取る。

| メソッド | 返り | 中身 |
| --- | --- | --- |
| `read(kind, targetId)` | `{ value, receivedAt, fetchSeq } \| null` | 14 日を過ぎた行・削除の印は `null`。復号できなければ全写しを消して `null` |
| `prepareReplace(guard, kind, targetId, value, fetchSeq)` | 書き込みの 1 件か `null` | 表に無い種類・番号の古いレスポンス・印と一覧の記録に合わないものは `null` |
| `applyOptimistic(guard, kind, targetId, change)` | `void` | 先映し（`fetchSeq` を変えない） |
| `markGone(guard, kind, targetId, goneSeq)` | `void` | 削除の印 |
| `recordList(guard, scope, ids, fetchSeq)` | `void` | 一覧の読み出しの記録と、返らなかった行の印 |
| `dropProjects(tx, projectTags)` | `void` | `projectTags` の索引で消す |
| `purgeExpired()` | `number` | 14 日を過ぎた行を消す。`boot` が開くたびに呼ぶ |
| `lastReceivedAt()` | `number \| null` | オフラインの帯に出す時刻 |

- `commitGuarded`
  - 事後条件: `stale` のときは何も書いていない
  - 副作用: IndexedDB の書き込み

### 異常系の処理
| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `prepareGuard` | 持ち主の違い・途中のフラグ | 別の利用者・サインアウト | 手順 1・2 | `null`（呼び出し元は捨てる） | 出さない | 起動の照合からやり直す |
| `commitGuarded` | `iv` の違い | 別タブの書き換え | 手順 3 の確認 | `stale` を返す | 出さない | 次の回で読み直す |
| `commitGuarded` | `QuotaExceededError` | 容量の不足 | トランザクションの abort | 写しは捨てて表示を続ける。送る列の移動は呼び出し元へ返す | 写しは出さない | 次の読み出しで書き直す |
| `createCacheStore` の `read` | 復号できない | 壊れ・キーの欠け | `unseal` | 全写しを消す | 読み直して描く。オフラインは空の状態 | 読み直し |

### 内部のデータと定数
| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `SNAPSHOT_KINDS` | 定数 | `snapshot-kinds.ts` | 設計文書の「写しにする種類の表」の種類。各行に、操作の名前・一覧の範囲・件数の上限・プロジェクトの ID の取り出し方を持つ |
| `SNAPSHOT_TTL_MS` | 定数 | `cache-store.ts` | 14 日 |
| `AuthzRecord`・`Guard`・`Owner` | 型 | `authz.ts`・`guarded-commit.ts` | 設計文書の「見られるプロジェクトの記録の中身」「利用者の境界」 |

端末のキャッシュの量の上限は、**件数と期間で決め、バイトの総量の上限は持たない**。件数は画面の文書の [端末に保存するもの](../docs/design/screens.md#端末に保存するもの) の値を `SNAPSHOT_KINDS` に持つ。値は、会話が最新 200 項目、スプリントの一覧がプロジェクトごとに 50 件、通知が 100 件である。超える分は置き換えのときに古い方から落とす。ブラウザーが許す量を超えたら、上の `QuotaExceededError` の扱いにする。`boot` は `navigator.storage.persist()` を求め、拒まれても続ける。実際の使用量は「実機の確認の記録」に残す。

### 並行と排他
| 同時に走りうる処理 | 共有する資源 | 排他の取り方 | 冪等性と中断からの再開 |
| --- | --- | --- | --- |
| そろえ方と画面の読み込み | 写しの行 | `fetchSeq` の比較と `iv` の確認 | 古い結果は書かない |
| 失効の反映と描画 | 画面の状態 | `withAuthzLock`（書く側 `exclusive`・反映する側 `shared`） | 世代の番号で取りこぼしを照合する |

コミットの後の知らせは `BroadcastChannel`（名前 `nd-authz`）の 1 本に `{ type: "authz" | "gone" }` を流し、中身は載せない。

### ログと記録の出力
| 関数 | 出すもの | レベルまたは書き先 | 出さないもの |
| --- | --- | --- | --- |
| `commitGuarded`・`read` | 中止と復号の失敗の種類、写しの `kind` | `createLogger` の `warn` | レスポンスの中身・対象とプロジェクトと利用者の ID・タグ |

### 既存の部品の再利用
| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `snapshotKindOf`・`projectIdsOf` | 操作の表（`packages/contracts/src/operations/`） | 形がすべて未定（`generated/pending.json`） | 表を画面の側に持つ。項目の取り出しは #28 が形を決めたら足す |
| `judgeVisibility`・`nextAuthz`・`addDenied`・`withAuthzLock`・`prepareGuard`・`commitGuarded`・`createCacheStore` | `packages/core/src/conditional-write.ts`・`authorize.ts` | `ls packages/core/src` | サーバー（DynamoDB と認可）の部品で、画面の依存の規則（`web-uses-browser-core-only`）でも読めないため使わない |
### 単体テストの観点
| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `snapshotKindOf`・`projectIdsOf` | 表の種類と ID の集合 | 0 件の一覧は空の配列 | 表に無い操作は `null` |
| `judgeVisibility` | 照合の表の各行 | `fetchSeq` が `listedSeq` の直前・直後 | 記録が無い・`allowedTeamIds` が無い |
| `nextAuthz`・`addDenied` | 食い違いの記録と解除 | `deniedSeq` より小さい番号の読み出しは除かない | `teams.list` の一時の失敗 |
| `withAuthzLock` | `exclusive` と `shared` が重ならない | — | `fn` の例外でも錠を放す |
| `prepareGuard`・`commitGuarded` | 合えば書く | 手順の間の token の取り直し | フラグ・持ち主の違いで書かない |
| `createCacheStore` | 往復・平文で読めない | ちょうど 14 日・件数の上限 | 表に無い種類・古いレスポンス・削除の印 |

## 操作の区分の表
満たす決定: 決定 5、受け入れ条件 2・15
### 関数の仕様
| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `operationClassOf` | `operation-classes.ts` | 新設 | `(operation: string) => OperationClass` | 区分・照合の値・送り直してよいかを返す |

```ts
type OperationClass =
  | { class: "queued"; resendableWithoutKey: boolean; keepsInput: boolean }
  | { class: "confirm"; check: readonly ("version" | "material_digest")[] }
  | { class: "online" };
```

表の中身は画面の文書の [操作の 3 つの区分](../docs/design/screens.md#操作の-3-つの区分) の「当たる操作」を操作の名前にしたもので、`check` は設計文書の「操作の区分の表」に従う。

### 異常系の処理
| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `operationClassOf` | 表に無い操作 | 足し忘れ | 表の引き当て | `online`（つながっていないと押せない）を返す | 「つながると使えます」 | テストが落とすので表に足す |
### 単体テストの観点
| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `operationClassOf` | `access` が `write` で `endpoint` が `user` の全操作が表にある | 冪等キーを受けない確定待ち 3 つ | 表の名前が操作の表に無ければ落ちる |

### 既存の部品の再利用
| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `operationClassOf` | `OperationDef` の `idempotencyKey`・`access` | `packages/contracts/src/operation.ts` | 冪等キーの有無は操作の表を読み、写さない |

## 送る列の保存
満たす決定: 決定 3・決定 12、受け入れ条件 2・14・15（IW3・IW8・IW12・IW13）
### 関数の仕様
| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `newIdempotencyKey` | `packages/core/src/ids.ts` | 新設 | `(clock: Clock) => string` | UUIDv7 の文字列を返す |
| `createOutbox` | `outbox.ts` | 新設 | `(d: { db: DeviceDb; clock: Clock }) => Outbox` | 送る列の保存を組む |

| `Outbox` のメソッド | 返り | 中身 |
| --- | --- | --- |
| `enqueue(owner, draft)` | `OutboxItem` | `nd-outbox` の錠の中で番号を取り、同じ対象の未送信の確定待ちは置き換える。`online` の操作は受けない（IW4） |
| `readBatch()` | `{ items: OutboxItem[]; unreadable: string[] }` | 錠の中で全件読み、`seq` の順に返す |
| `markSendStarted(item, sentAt)` | `OutboxItem \| null` | `iv` を確かめて印を真にする |
| `unmarkSendStarted(item)` | `void` | 設計文書の「会話の項目の取り下げ」の手順 4（送り始めた印を戻す）。同じ対象の確定待ちが後ろに足されていれば、印を戻さずに元の件を消す |
| `settle(item, outcome)` | `"removed" \| "held" \| "kept" \| "missing"` | 送る列と保留の件を `answerTag` で引き、1 トランザクションで消すか移す |
| `moveToHeld(tags, reason)` | `number` | 暗号文のまま保留へ移す |
| `countPending(owner)` | `{ confirm: number; queued: number; held: number }` | 帯と、#4 のサインアウトの確認の数 |

- `newIdempotencyKey`
  - 事後条件: UUID の形（API の文書の冪等キーの条件）
- `createOutbox` の `enqueue`
  - 副作用: IndexedDB の書き込み

### 異常系の処理
| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `createOutbox` の `enqueue` | 保存の失敗 | 容量・`switching` | トランザクションの abort | 呼び出し元へ返す | 操作の結果「保存できませんでした」。先映ししない | 錠を放す。利用者が押し直す |
| `createOutbox` の `readBatch` | 復号できない件 | 壊れ | `unseal` | その件を `unreadable` で保留へ | 保留の件数 | — |
| `createOutbox` の `markSendStarted` | `iv` の違い | 取り下げ・置き換え | トランザクション内の比較 | `null`（送らない） | 出さない | 次の件へ |

### 内部のデータと定数
| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `OutboxItem` | 型 | `outbox.ts` | 設計文書の「送る列の 1 件の中身」と平文の列 |
| `OUTBOX_LOCK` | 定数 | `outbox.ts` | `nd-outbox` |

### 並行と排他
| 同時に走りうる処理 | 共有する資源 | 排他の取り方 | 冪等性と中断からの再開 |
| --- | --- | --- | --- |
| 2 タブの `enqueue` と `readBatch` | 送る順 | Web Locks `nd-outbox`（`exclusive`。中でネットワークを待たない） | 番号は `nextSeq` |
| 取り下げと送信の開始 | 送る列の 1 件 | サインインの錠（#4 と共有する 1 つの錠） | 設計文書の「取り下げと送信の開始の排他」 |
| `settle` と取り下げ | 同じ答えの件 | `answerTag` と `iv` | 無ければ何もしない |

### ログと記録の出力
| 関数 | 出すもの | レベルまたは書き先 | 出さないもの |
| --- | --- | --- | --- |
| `createOutbox` | 保存と移動の失敗の種類、区分、`holdReason` | `warn` | 操作の入力・対象の ID・冪等キー |

### 既存の部品の再利用
| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `newIdempotencyKey` | `newId`（`packages/core/src/ids.ts`） | 同ファイル | `newId` は種類の接頭辞を付けるため UUID の形にならない。同じファイルの `uuid` の `v7` を使う関数を足す |
| `createOutbox` | `packages/core/src/idempotency.ts`・`retry.ts` | `ls packages/core/src` | サーバーの冪等の行と呼び出しの再試行で、端末の保存を持たないため使わない |
### 単体テストの観点
| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `newIdempotencyKey` | UUID の形 | 同じミリ秒で重ならない | — |
| `createOutbox` | 押した順・置き換え・`settle` | 時計を戻しても順が保たれる・送り始めた件は置き換えない | 保存の失敗・`online` の操作を受けない |

## 隔離の保存
満たす決定: 決定 12、受け入れ条件 14（IW6・IW7・IW13）
### 関数の仕様
| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `quarantinePending` | `quarantine.ts` | 新設 | `(db: DeviceDb, o: { drop: ReadonlySet<string> }) => Promise<void>` | `switching` を書き、`drop` に無い件とキーを隔離へ移す |
| `restoreQuarantined` | 同上 | 新設 | `(db: DeviceDb, userId: string) => Promise<void>` | 持ち主の件を今のキーで戻す（戻し先は設計文書の「戻した件の戻し先」） |
| `rollbackQuarantine` | 同上 | 新設 | `(db: DeviceDb) => Promise<void>` | 中断した隔離の複製を消して `switching` を外す |
| `unreadableQuarantine` | 同上 | 新設 | `(userId: string) => Promise<{ count: number; discard: (answerTag: string) => Promise<void> }>` | 持ち主の復号できない件の数と破棄 |

- `quarantinePending`
  - 事前条件: サインインの錠を持つ
  - 事後条件: 戻ったときは、`drop` に無い件がすべて隔離の側にある。元のデータベースは消していない（呼び出し元が消す）
  - 副作用: 2 つの IndexedDB の書き込み
- `restoreQuarantined`
  - 事後条件: 今のデータベースへ書き終えた件だけを隔離から消す
  - 副作用: 同上

### 異常系の処理
| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `quarantinePending` | 隔離の書き込みの失敗 | 容量 | トランザクションの abort | 呼び出し元へ返す | 持ち主の交代は「この端末の保存の領域が足りないため、サインインを終えられませんでした」 | 元を消さない。再実行は同じ主キーの上書き |
| `restoreQuarantined` | 復号できない件 | 壊れ | `unseal` | 隔離に残す | 件数と「内容を読めません」 | 次のサインインの確定で再試行 |
| `rollbackQuarantine` | 削除の失敗 | 容量・ブラウザー | トランザクションの abort | `switching` を残す | 保留の件数は出す | 完了まで送らず破棄も受けない |

### 既存の部品の再利用
| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `quarantinePending`・`restoreQuarantined`・`rollbackQuarantine`・`unreadableQuarantine` | `db.ts`・`crypto.ts` | この文書 | 開き方と暗号化は同じ関数を使う |
### 単体テストの観点
| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `quarantinePending` | 暗号文のまま移る | 件が 0 | 書き込みの失敗で元が残る |
| `restoreQuarantined` | キャッシュして送るは送る列へ、確定待ちは保留へ | 版の古い隔離 | 壊れた 1 件が残る・2 回打って増えない |
| `rollbackQuarantine` | 複製が消える | 元に無い件は残る | 削除の失敗 |
| `unreadableQuarantine` | 持ち主だけに数が出る | 0 件で持ち主の行が消える | 別の利用者は 0 件 |

## 保留の一覧
満たす決定: 決定 12、受け入れ条件 14
### 関数の仕様
| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `createHeldStore` | `held-store.ts` | 新設 | `(d: { db: DeviceDb }) => HeldStore`（`count()`・`list()`・`discard(answerTag)`） | 保留の件の読み出しと、確認の後の破棄 |
| `visibleFieldsOf` | 同上 | 新設 | `(item: HeldItem, record: AuthzRecord \| null) => HeldView` | 設計文書の「件の表示で出すもの」の条件で項目を落とす |
| `HeldListDialog` | `screens/held-list.tsx` | 新設 | `(props: { store: HeldStore; open: boolean }) => ReactElement` | 一覧と「破棄すると元に戻せません」の確認 |

- `createHeldStore` の `discard`
  - 事前条件: 利用者が確認のダイアログで確定した
  - 副作用: IndexedDB の削除

「結果未確認」と食い違いの表示も `visibleFieldsOf` を通す（出し分けを 1 か所にする）。

### 異常系の処理
| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `createHeldStore` の `discard` | 削除の失敗 | ブラウザー | トランザクションの abort | 呼び出し元へ返す | エラーの表示と「もう一度」 | 件は残る |
### 単体テストの観点
| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `createHeldStore`・`HeldListDialog` | 件数と一覧・確定で消える | ダイアログを閉じただけでは残る | 復号できない件の「内容を読めません」 |
| `visibleFieldsOf` | 見られる対象は入力を出す | 自分の設定は常に出る | 記録が無い・`denied`・権限の外は理由と操作の種類と時刻だけ |

### 既存の部品の再利用
| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `createHeldStore`・`visibleFieldsOf` | `judgeVisibility` | この文書 | `denied` の判定は `authz.ts` を使う |
| `HeldListDialog` | `ConfirmDialog`・`DataList` | この文書の部品 | 使う |

## ログインのキャッシュの保存
満たす決定: 決定 4、受け入れ条件 7・13・14（IW7・IW10）
### 関数の仕様
| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `createLoginStore` | `login-store.ts` | 新設 | `(d: LoginDeps) => LoginStore` | `StateStore` と、#4 が呼ぶ関数を組む |

| `LoginStore` のメソッド | シグネチャ | 呼ぶ側 |
| --- | --- | --- |
| `set`・`get`・`remove`・`getAllKeys` | `oidc-client-ts` の `StateStore` | `UserManager`。`set` はメモリに留めるだけ。`get` は設計文書の「`get` が返す値」 |
| `confirmSignin` | `(userId: string) => Promise<void>` | #4（`sessions.create` の成功の後） |
| `discardPendingExchange` | `() => void` | #4（失敗・照合の外れ） |
| `readFingerprintTag` | `() => Promise<string \| null>` | #4（取り直しの前） |
| `writeRefreshed` | `(fingerprintTag: string) => Promise<"written" \| "discarded">` | #4 |
| `deleteLoginRow` | `(fingerprintTag: string) => Promise<"deleted" \| "kept">` | #4（`invalid_grant`） |
| `purgeExpiredLogin` | `(nowMs: number) => Promise<boolean>` | `boot` |
| `readSession` | `() => Promise<{ userId: string; refreshExpiresAt: number } \| null>` | `boot` |
| `forget` | `() => void` | `forgetDeviceMemory` |

- `createLoginStore` の `confirmSignin`
  - 事前条件: #4 がサインインの錠を持ち、3 つの条件を照合した
  - 事後条件: 行があるとき、持ち主はその利用者で、隔離の戻しが終わっている
  - 副作用: IndexedDB の書き込みと削除

### 異常系の処理
| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `createLoginStore` の `confirmSignin` | 隔離・削除・書き込みの失敗 | 容量・ブラウザー | 各関数の戻り | 呼び出し元（#4）へ返す | サインインを終えない（隔離の文は「隔離の保存」） | 行を書かない。次のサインインの確定でやり直す |
| `createLoginStore` の `writeRefreshed` | タグの違い・途中のフラグ | 別タブの入り直し | 照合 | `discarded` | 出さない | 留めた結果を捨てる |
| `createLoginStore` の `readSession` | 復号できない・`userId` のタグの違い | 壊れ | `unseal`・`tagOf` | 行を消して `null` | 「もう一度サインインしてください」 | 再サインイン |

### 内部のデータと定数
| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `LoginRow` の中身 | 型 | `login-store.ts` | 設計文書の「ログインキャッシュ行に置く項目」の項目だけ |
| `REFRESH_TTL_MS` | 定数 | `login-store.ts` | 30 日（`auth_time` に足す） |

### ログと記録の出力
| 関数 | 出すもの | レベルまたは書き先 | 出さないもの |
| --- | --- | --- | --- |
| `createLoginStore` | 確定・破棄・削除の結果の種類 | `info`・`warn` | token・指紋・タグ・利用者の ID |

### 既存の部品の再利用
| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `createLoginStore` | `WebStorageStateStore`（`oidc-client-ts`） | 設計文書の決定 4 と LIB6 | `StateStore` の形だけ合わせ、保存は自前 |
### 単体テストの観点
| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `createLoginStore` | 設計文書のテスト設計「E1」「`get` が返す値」「取り直しの前に覚えるタグ」「IW10」 | `refreshExpiresAt` が今と同じ・期限は取り直しで延びない | 行に access token と ID token が無い |

## 途中の記録の保存
満たす決定: 決定 3、受け入れ条件 13・14
### 関数の仕様
| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `createPendingStore` | `pending-store.ts` | 新設 | `(d: { db: DeviceDb }) => PendingStore` | 証と外しのキャッシュを置く・読む・消す |

`PendingStore` が持つのは次の 3 つである。`put(id, value, fingerprint)`・`read(id): { value, fingerprintTag } | "unreadable" | null`・`remove(id)`。`id` は `signout-proof` か `unlink-item` の型にする。呼ぶのは #4 だけで、錠は #4 が持つ。

### 異常系の処理
| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `createPendingStore` の `read` | 復号できない | 壊れ | `unseal` | `unreadable` を返し、消さない | #4 が告知を出す | #4 が次の候補へ進む |
### 単体テストの観点
| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `createPendingStore` | 往復・平文に token が無い | 同じ `id` は 1 件 | 壊すと `unreadable` で行が残る |

### 既存の部品の再利用
| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `createPendingStore` | `crypto.ts` | この文書 | 使う |

## 端末から消す処理
満たす決定: 決定 12、受け入れ条件 14（IW6）
### 関数の仕様
| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `recordDiscardConfirmation` | `erase.ts` | 新設 | `(db: DeviceDb, signoutId: string, answerTags: string[]) => Promise<void>` | 確認した件をサインアウトの ID に結び付けて記す |
| `settleForSignout` | 同上 | 新設 | `(db: DeviceDb, signoutId: string) => Promise<void>` | サインアウトの 2.: 確認した件を捨て、ほかを隔離する |
| `deleteDeviceData` | 同上 | 新設 | `(db: DeviceDb, signoutId: string, o: { onBlocked: () => void }) => Promise<"deleted" \| "failed">` | サインアウトの 5.: 隔離し残しが無いことを確かめてデータベースを消す |
| `forgetDeviceMemory` | 同上 | 新設 | `() => void` | 復号した写しとキーの参照を捨てる（`versionchange` と #4 の通知で呼ぶ） |

確認の件を #4 の画面に出すための一覧は `createOutbox` と `createHeldStore` を使う。`erase.ts` は `localStorage` の途中のフラグを書かない。

- `recordDiscardConfirmation`・`settleForSignout`・`deleteDeviceData`
  - 事前条件: #4 がサインインの錠を持つ
  - 副作用: IndexedDB の書き込みと削除

### 異常系の処理
| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `recordDiscardConfirmation` | 書き込みの失敗 | 容量 | abort | 呼び出し元へ返す | #4 がフラグを置かない | 件は残る |
| `settleForSignout` | 隔離の失敗 | 容量 | `quarantinePending` | 呼び出し元へ返す | #4 の案内 | 元を消さない。再実行できる |
| `deleteDeviceData` | 隔離し残し・削除の失敗 | 別タブが件を足した・`blocked`・`error` | 消す前の確認・`deleteDeviceDb` | `failed` | #4 の案内 | 2. からやり直せる |
### 単体テストの観点
| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `recordDiscardConfirmation`・`settleForSignout` | 確認した件だけ消える | ID の合わない記録はすべて隔離 | ダイアログの後に足した件は隔離 |
| `deleteDeviceData` | データベースが無くなる | ほかの接続を待つ | 隔離し残しで消さない |
| `forgetDeviceMemory` | 以後の `read` が `null` | 2 回呼べる | — |

### 既存の部品の再利用
| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `recordDiscardConfirmation`・`settleForSignout`・`deleteDeviceData`・`forgetDeviceMemory` | `quarantinePending`・`deleteDeviceDb` | この文書 | 使う |

## つながりの判定
満たす決定: 決定 10、受け入れ条件 15・17
### 関数の仕様
| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `createConnectivity` | `connectivity.ts` | 新設 | `(win: Window) => Connectivity`（`online(): boolean`・`subscribe(fn): () => void`） | `navigator.onLine` と `online`・`offline` のイベントを 1 つの値にする |

`navigator.onLine` が真でも通信が失敗することは、そろえ方の一時の失敗として扱う。ここでは覆さない。

### 単体テストの観点
| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `createConnectivity` | イベントで値と購読者が変わる | 解除の後は呼ばれない | — |

### 既存の部品の再利用
| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `createConnectivity` | `navigator.onLine` | ブラウザーの標準 | 使う |

## そろえ方
満たす決定: 決定 3・決定 12、受け入れ条件 2・15（IW5・IW9・IW12）
### 関数の仕様
| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `createApiSender` | `api-transport.ts` | 新設 | `(d: SenderDeps) => (call: ApiCall) => Promise<ApiReply>` | 「送信の直前の照合と token の固定」の手順で 1 リクエストを送り、結果と HTTP の状態・ヘッダー・持ち主を返す |
| `retryUntilFrom` | `send-wait.ts` | 新設 | `(retryAfter: string \| null, date: string \| null, nowMs: number, backoffMs: number) => { retryUntil: number; backoffMs: number }` | 429 の待機の期限を作る |
| `createSendWait` | 同上 | 新設 | `(d: { db: DeviceDb }) => SendWait` | 待機の期限と `api-time` を暗号化して持つ |
| `planRevocation` | `revocation.ts` | 新設 | `(read: ListsRead, local: LocalIndex) => RevocationPlan` | 消す写し・保留に移す件・新しい記録を決める（副作用なし） |
| `applyRevocation` | 同上 | 新設 | `(guard: Guard, plan: RevocationPlan) => Promise<"committed" \| "stale">` | 1 トランザクションで反映し、全タブへ知らせる |
| `holdDenied` | 同上 | 新設 | `(guard: Guard, o: { id: string; item?: OutboxItem }) => Promise<void>` | 403・404 の件の扱いと `denied` の記録を 1 トランザクションで行う |
| `classifyResult` | `send.ts` | 新設 | `(input: { cls: OperationClass; resent: boolean; hasInput: boolean; reply: ApiReply }) => SendDecision` | 設計文書の「段 2 の結果ごとの扱い」を判定する（副作用なし） |
| `checkDeadline` | 同上 | 新設 | `(item: OutboxItem, apiNowMs: number \| null, wallNowMs: number) => "send" \| "expired" \| "unknown"` | 24 時間の期限と冪等キーの保持期間を判定する |
| `sendQueue` | 同上 | 新設 | `(round: Round, batch: OutboxItem[]) => Promise<"done" \| "stopped">` | 押した順に 1 件ずつ送る |
| `withdraw` | 同上 | 新設 | `(answerTag: string) => Promise<"removed" \| "held" \| "enqueued" \| "unconfirmed">` | 確定待ちと会話の項目の取り下げ |
| `createSync` | `sync.ts` | 新設 | `(d: SyncDeps) => { start(): () => void; runOnce(): Promise<RoundReport> }` | 起動の元と錠を持ち、段 1〜5 を順に打つ |

- `createApiSender`
  - 事後条件: 照合が外れたときは本物の `fetch` を呼んでいない
  - 副作用: ネットワーク
- `sendQueue`・`withdraw`・`createSync`
  - 副作用: ネットワーク・IndexedDB の書き込み
- `applyRevocation`・`holdDenied`・`createSendWait`
  - 副作用: IndexedDB の書き込み

そろえ方は読み出しを関数で受け取る（`SyncDeps.readers`: `projects`・`teams`・`transfers`・`screen`・`lists`）。操作の形が未定の間、本番の組み立てが渡す `readers` は一時の失敗になり、何も消さない。テストは `createOperationClient` に作り物の操作の表を渡して組む。

### 異常系の処理
| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `createApiSender` | 照合の外れ・件が無い | サインアウト・別タブ・取り下げ | 錠の中の確認 | `aborted`（理由 `session` か `gone`） | 出さない | `session` は回を止め、`gone` は次の件へ。印を戻す |
| `createApiSender` | 通信の失敗・形の違う応答 | ネットワーク・中継 | `fetch` の例外・保持した HTTP の状態 | 一時の失敗か認証の失敗にする（「`Retry-After` と `Date` の受け取り」） | 呼び出し元が出す | 件は消さない |
| `createSendWait` | 復号できない | 壊れ | `unseal` | 行を消し 60 秒から | 出さない | — |
| `applyRevocation`・`holdDenied` | `stale` | 別タブの書き換え | `commitGuarded` | 回を止める | 出さない | 次の回で段 1 から |
| `sendQueue` | 一時の失敗 | 503・429・通信 | `classifyResult` | その回の段 2 を止める（IW12） | 「読み直せませんでした（時刻）」 | 30 秒後 |
| `sendQueue` | 401 | token・セッション | 同上 | 止めて #4 の 401 の扱いへ持ち主つきで渡す | #4 の表示 | 件は残る |
| `withdraw` | 取り下げの成否が分からない | 送った後・成功の反映が先 | 件の `sendStarted`・会話の写し | `held` か `unconfirmed` | 設計文書の「確定待ちの取り下げ」「送信の成功が先に反映されていたとき」の文 | 利用者が確かめる |
| `createSync` | 段 1 の一覧の失敗 | 一時の失敗 | `readers` の結果 | 「段 1 の失敗」の扱い | 「読み直せませんでした（時刻）」 | 30 秒後に段 1 から |

### 処理の手順

`classifyResult` の判定表は設計文書の「段 2 の結果ごとの扱い」が持つ。返り値の形だけを決める。

| `SendDecision.kind` | 意味 | 次の件 |
| --- | --- | --- |
| `done` | 送る列から消す（確定待ちは確定と出す） | 進む |
| `reject` | `rejected` の保留か削除。`deny` があれば `holdDenied` | 進む |
| `unknown` | `unknown-result` の保留 | `stop` の真偽で決まる（冪等キーを受けない操作の 503 は止める） |
| `retry` | 元の区分で残す（429 は `retryUntil` を持つ） | 止める |
| `auth` | 残して #4 へ渡す | 止める |

`runOnce` は次の順に打つ。錠 → 途中のフラグ → 回の持ち主 → `nd-outbox` で対象を読む → 段 1 → 待機の期限の確認 → 段 2（`sendQueue`）→ 段 3 → 段 4 → 段 5。段 1 は `planRevocation`・`applyRevocation`・割り当ての受け入れの扱いである。各段の中身と、錠・途中のフラグ・回の持ち主の決まりは、設計文書の「処理の流れ」と「利用者の境界」にある。段 2 が `stopped` でも段 3〜4 は打つ。段 1 が失敗した回は段 2 以降を打たない。

- 繰り返しの終わる条件: 一覧は `next_cursor` が `null` になるまで。時刻の読み直しは 1 件につき 1 回の段 2 で 1 回まで
- 計算量の注意: 段 1 の写しの照合は `projectTags` の索引のキーを集めて比べ、全写しを復号しない

### 内部のデータと定数
| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `RELOAD_INTERVAL_MS` | 定数 | `sync.ts` | 30 秒 |
| `SYNC_LOCK` | 定数 | `sync.ts` | `nd-sync`（`ifAvailable`） |
| `DEADLINE_MS`・`API_DEADLINE_MS`・`KEY_RESEND_MS`・`TIME_READ_MAX_MS` | 定数 | `send.ts` | 24 時間・23 時間 58 分・23 時間・60 秒 |
| `BACKOFF_FIRST_MS`・`BACKOFF_MAX_MS` | 定数 | `send-wait.ts` | 60 秒・15 分 |
| `ApiReply`・`Round`・`ListsRead`・`RevocationPlan` | 型 | 各モジュール | — |

そろえ方の食い違いの解き方は、設計文書の「段ごとの決まり」と「段 2 の結果ごとの扱い」で決まっており、ここで規則を足さない。

### 並行と排他
| 同時に走りうる処理 | 共有する資源 | 排他の取り方 | 冪等性と中断からの再開 |
| --- | --- | --- | --- |
| 複数のタブの `runOnce` | 送る列・写し | `nd-sync` を取れた 1 つだけ | 取れなければ何もしない |
| 送信の開始とサインアウト・取り下げ | token と件 | サインインの錠の中で照合して `fetch` を呼び、応答を待たずに放す | 送り始めた印 |
| 待機の期限の書き込み | `wait` の行 | `iv` の確認。後の期限のときだけ書く | タブをまたいで残る |
| 送った直後にタブが閉じる | 送る列 | — | 次の回が `sendStarted` で送り直しか結果未確認を決める |

### ログと記録の出力
| 関数 | 出すもの | レベルまたは書き先 | 出さないもの |
| --- | --- | --- | --- |
| `createSync`・`sendQueue` | 回の終わりの理由、段、件数、HTTP の状態、理由のコード、操作の名前 | `info`・`warn` | 入力・対象とプロジェクトと利用者の ID・token・冪等キー |

### 既存の部品の再利用
| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `createApiSender` | `httpTransport`・`createOperationClient` | `packages/contracts/src/client.ts` | 使う。`fetch` と `token` をリクエストごとに渡し、形は変えない |
| `retryUntilFrom`・`createSendWait`・`sendQueue`・`checkDeadline` | `packages/core/src/retry.ts`・`outbound.ts` | `packages/core/package.json` | サーバーの呼び出しの再試行（プロセス内）で、タブをまたぐ期限と順序を持たないため使わない |
| `planRevocation`・`applyRevocation`・`holdDenied`・`classifyResult`・`withdraw`・`createSync` | `REASONS`（`packages/contracts/src/reasons.ts`） | `grep -n idempotency_key_reused packages/contracts/src/reasons.ts` | 理由のコードは正本の値を使う。判定と段の順は新しく書く |
### 単体テストの観点
| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `createApiSender` | 照合した token がそのまま送られる | 時刻の読み出しから 60 秒の直前・直後、時計の戻り | フラグ・指紋の違いで `fetch` を呼ばない。本文が違う 401・429・503 |
| `retryUntilFrom`・`createSendWait` | 秒数と日付の `Retry-After` | 2 倍の上限 15 分 | ヘッダー無し・`Date` 無し |
| `planRevocation`・`applyRevocation`・`holdDenied` | 失効の写しと件 | 食い違いのプロジェクトは件を残す | 一覧の途中の失敗で何も消さない・`stale` |
| `classifyResult` | 判定表の各行 | 再送の 403・404 は `unknown` | `in_progress`・422 |
| `checkDeadline` | 期限内は `send` | 23 時間 58 分・24 時間・23 時間 | `Date` が無い・`pressedFloor` が空 |
| `sendQueue` | 押した順・冪等キーは受ける操作だけ | 一時の失敗で後続を止める | 401 |
| `withdraw` | 未送信は消える | 送り始めた件は保留 | 成功の反映が先 |
| `createSync` | 段の順・30 秒 | 錠を取れない回 | 段 1 の失敗・受け入れの一覧の 403・404 |

## Service Worker
満たす決定: 決定 2、受け入れ条件 13
### 関数の仕様
| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `classifyRequest` | `sw/cache-rules.ts` | 新設 | `(req: { url: URL; mode: RequestMode; method: string }, precache: ReadonlySet<string>, origin: string) => "shell" \| "asset" \| "config" \| "network"` | 保存から返すかを決める。`/signed-out` と一覧に無い URL は `network` |
| `nextConfigSeq` | 同上 | 新設 | `() => Promise<number>` | `nd-config-seq` の生成器から番号を取る |
| `saveConfig` | 同上 | 新設 | `(cacheName: string, value: unknown, seq: number \| null) => Promise<boolean>` | 錠の中で形を検査し、番号が新しいときだけ書く |
| `pickNewestConfig` | 同上 | 新設 | `(cacheNames: string[]) => Promise<{ response: Response; seq: number } \| null>` | 形の合う値のうち番号の最も大きいものを選ぶ |
| `registerServiceWorker` | `sw/register.ts` | 新設 | `(config: WebConfig) => Promise<void>` | 登録し、`ready` の後に `MessageChannel` で設定の値を渡して応答を待つ |
| `precacheList` | `scripts/build-sw.ts` | 新設 | `(distDir: string) => Promise<string[]>` | マニフェストと名前の決まったファイルから一覧を作る |
| `shellVersion` | 同上 | 新設 | `(files: readonly { path: string; bytes: Uint8Array }[], swCode: string) => string` | SHA-256 のバージョン |

- `saveConfig`
  - 副作用: Cache Storage の書き込み
- `registerServiceWorker`
  - 副作用: Service Worker の登録
- `precacheList`
  - 事前条件: `vite build` が `.vite/manifest.json` を出した
  - 副作用: ファイルの読み取り

`service-worker.ts` は、`install`・`activate`・`fetch`・`message` の 4 つのハンドラーを上の関数で組む。`skipWaiting` と `clients.claim` を呼ばない。`public/manifest.webmanifest` は画面の文書の [端末に保存するもの](../docs/design/screens.md#端末に保存するもの) の項目を持つ。

### 異常系の処理
| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `saveConfig` | 形が合わない・番号が古い | 古い値・壊れた応答 | `webConfigSchema`・番号の比較 | 書かずに `false` | 出さない | 次の読み出しで書く |
| `registerServiceWorker` | 登録・応答の失敗 | 非対応・`ready` が来ない | reject | 呼び出し元へ返す | 出さない（`boot` がログに残す） | 次の起動 |
| `precacheList` | 参照するファイルが無い | ビルドの欠け | 存在の確認 | 止める | 欠けたパス。終了コード 1 | 直してビルドし直す |

`install` が失敗するのは、次の 2 つの場合だけである。1 つは、設計文書の決定 2 の「更新の訪問」の場合である（`/config.json` を読めず、旧いバージョンの保存先の設定の値が、どれも新しい `webConfigSchema` に合わない）。もう 1 つは、一覧のファイルを取れない場合である。

### 内部のデータと定数
| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `CACHE_PREFIX` | 定数 | `cache-rules.ts` | `nd-shell-`（後ろにバージョン） |
| `CONFIG_SEQ_HEADER` | 定数 | `cache-rules.ts` | `x-nd-config-seq` |
| 一覧とバージョン | 定数 | ビルド時の `define`（`__PRECACHE__`・`__VERSION__`） | — |

### 並行と排他
| 同時に走りうる処理 | 共有する資源 | 排他の取り方 | 冪等性と中断からの再開 |
| --- | --- | --- | --- |
| `install`・`fetch`・`activate`・`message` の設定の書き込み | 保存した `/config.json` | 保存先の名前の Web Locks | 番号の比較で古い値を書かない |

### 既存の部品の再利用
| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `classifyRequest`・`nextConfigSeq`・`saveConfig`・`pickNewestConfig`・`registerServiceWorker`・`precacheList`・`shellVersion` | `vite-plugin-pwa`（LIB3）、`webConfigSchema` | 設計文書の決定 2 | ラッパーは使わない。形の検査は `webConfigSchema` を使う |
### 単体テストの観点
| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `classifyRequest` | ナビゲーション・資産・設定 | 一覧に無い同一オリジンの URL | `/signed-out`・API・`PUT` |
| `nextConfigSeq`・`saveConfig`・`pickNewestConfig` | 新しい番号が残る | 時計を戻す・同じ時刻の 2 件 | 形の違う値 |
| `registerServiceWorker` | 応答を待つ | — | 非対応のブラウザー |
| `precacheList`・`shellVersion` | `index.html` とアイコンが載る | `index.html` だけの違い・Service Worker のコードだけの違いで値が変わる | 参照の欠け |

## ダミーのクライアント
満たす決定: 決定 10、受け入れ条件 17
### 関数の仕様
| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `createDummyApp` | `src/dummy/dummy-client.ts` | 新設 | `(url: URL) => { placeholder: () => Promise<PlaceholderData>; connectivity: Connectivity; seedPending: boolean }` | `scenario` と `connection` を読み、表示データとつながりを返す |
| `moduleListPlugin` | `scripts/module-list-plugin.ts` | 新設 | `(outFile: string) => Plugin` | `generateBundle` でモジュールの ID と `renderedExports` を書き足す |
| `findDummyLeaks` | `scripts/check-dummy-free.ts` | 新設 | `(modules: ModuleEntry[], files: { path: string; text: string }[]) => string[]` | 決定 10 の 3 つの検査の違反を返す |

- `createDummyApp`
  - 事後条件: `connection=pending` は確定待ちが 1 件ある状態を作る。組むときに `document.documentElement.dataset` へ目印 `nd-factory:dummy-client` を書く
- `moduleListPlugin`
  - 副作用: 一覧のファイルの書き込み（成果物の外の `node_modules/.cache`）

遅延は `scenario=slow` のとき **2,000 ミリ秒** にする（読み込み中の表示を e2e が確実に観察でき、テストの既定の時間切れに掛からない長さ）。知らない値は `normal`・`online` にする。

### 異常系の処理
| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `moduleListPlugin` | 書けない | 権限・容量 | 書き込みの例外 | 止める | ビルドの失敗。終了コード 1 | 再実行 |
| `findDummyLeaks` | 違反あり・一覧のファイルが無い | ダミーの混入・プラグインの欠け | 検査の入口 | 止める | 違反したモジュールか目印。終了コード 1 | 直してビルドし直す |
### 単体テストの観点
| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `createDummyApp` | 5 つの `scenario` と 3 つの `connection` | `slow` の待ち（偽の時計） | 知らない値 |
| `moduleListPlugin`・`findDummyLeaks` | 違反 0 件 | Service Worker のバンドルも対象 | 設計文書の決定 10 の 2 つの壊したビルド |

### 既存の部品の再利用
| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `createDummyApp` | `createDummyTransport` | `packages/contracts/src/client.ts` | 使わない（設計文書の「ダミーの mode のクエリパラメータ」） |
| `moduleListPlugin`・`findDummyLeaks` | Rolldown の `renderedExports` | 設計文書の決定 10 | 使う |

## e2e の計測
満たす決定: 決定 9、受け入れ条件 3・6・11・12
### 関数の仕様
| 関数 | 保存先 | 種類 | シグネチャ | 責務 |
| --- | --- | --- | --- | --- |
| `throttle` | `apps/web/e2e/support/measure.ts` | 新設 | `(page: Page) => Promise<NetworkSetting>` | DevTools Protocol で回線を絞り、掛けた値を返す |
| `countActions` | 同上 | 新設 | `(page: Page) => ActionCounter`（`tap(locator)`・`result(): { actions: number; pages: number }`） | 手数と移った path の数を数える |
| `recordTiming` | 同上 | 新設 | `(scene: string, ms: number, setting: NetworkSetting) => Promise<void>` | 待ち時間と絞りの設定を記録に書く |
| `smallTargets` | 同上 | 新設 | `(page: Page) => Promise<string[]>` | 44 px 未満の押せる要素（文中のリンクを除く）を返す |

- `recordTiming`
  - 副作用: `apps/web/test-results/timings.json` への追記

### 異常系の処理
| 関数 | 失敗 | 原因 | 検出する場所 | 扱い | 利用者に見える出力と終了コード | 後始末と再実行の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| `recordTiming` | 絞りの設定が無いか決めた値と違う | 絞りの外し | 記録の検査のテスト | テストを落とす | 違う値 | 再実行 |

### 内部のデータと定数
| 名前 | 種類 | 保存先 | 既定値 |
| --- | --- | --- | --- |
| `NETWORK_4G` | 定数 | `measure.ts` | 遅延 150 ms・下り 200,000 バイト/秒（1.6 Mbps）・上り 93,750 バイト/秒（750 kbps） |
| 画面の幅の projects | 設定値 | `playwright.config.ts` | 360×780・768×1024・1280×800 |
| 区切りの確認の幅 | 定数 | ナビゲーションの e2e | 639・640・1023・1024 px |

e2e は 2 組のサーバーで打つ。ダミーの mode のビルド（`vite build --mode dummy`。出力は `dist-dummy`）は状態と手数の場面に、本番の mode のビルドは Service Worker・暗号化・サインインの場面に使う。

### 単体テストの観点
| 関数 | 正常 | 境界値 | 異常 |
| --- | --- | --- | --- |
| `throttle`・`recordTiming` | 記録に設定が残る | — | 絞りを外すと落ちる |
| `countActions` | 上限以内で通る | ちょうど上限 | 1 手・1 ページ足すと落ちる |
| `smallTargets` | 0 件 | ちょうど 44 px | 40 px のボタンを返す |

### 既存の部品の再利用
| 新設する関数 | 確かめた既存の部品 | 確かめた手段 | 結果 |
| --- | --- | --- | --- |
| `throttle`・`countActions`・`recordTiming`・`smallTargets` | `apps/web/e2e/user-page.spec.ts` のネットワークの差し替え | 同ファイル | 差し替えは共通の準備へ移して使う。計測は新しく書く |

## 反映の定義（インフラ）
満たす決定: 決定 2、受け入れ条件 13（テスト設計の「`Retry-After` と `Date` の公開」「決定 2 配信の切り替え」）

関数は足さず、`infra/lib/app-stack.ts` の 2 つの値を変える。

| 変える所 | 値 | 条件 |
| --- | --- | --- |
| `BucketDeployment`（`WebDeployment`） | `prune: false` | Service Worker を入れる変更と同じ反映 |
| HTTP API の `corsPreflight` | `exposeHeaders: ["date", "retry-after"]` | プラットフォームの文書を直す設計の Pull Request のマージの後 |

`infra/test/app-stack.test.ts` に 2 つの値の確認を足す。

## 実機の確認の記録

受け入れ条件 8 と、設計文書が詳細設計に残すとした値の記録先である。実装の後に測り、値と確認した日と端末の機種とブラウザーのバージョンをこの表に書く。環境の URL などの実際の値は書かない。

| 項目 | 確かめ方 | 結果 |
| --- | --- | --- |
| iOS の Safari での Web Push | ホーム画面に加えた Web アプリで購読できるか（送り手は #8） | 未確認（実装の後） |
| 端末のデータの暗号化の鍵の置き場と強さ | 主なブラウザーで `extractable` が偽の `CryptoKey` を IndexedDB から読み直せるか | 未確認（実装の後） |
| Badging と Background Sync | 主なブラウザーでの有無 | 未確認（実装の後） |
| 手数の目標の待ち時間 | ダミーで回線を絞って測り、実 API を接続した検証用の配信環境で同じ操作を測り直す | 未確認（実装の後） |
| 30 日に近いログインのキャッシュから通知を開く | 実機 | 未確認（#8 の通知がそろった後） |
| ホーム画面に加えた場合と加えない場合の Safari のキャッシュ | 7 日の経過の前後 | 未確認（実装の後） |
| access token を 15 分にしたときの取り直し | 検証用の配信環境 | 未確認（実装の後） |
| Web Push の本文の暗号化（RFC 8291）の細部 | 実機 | 未確認（#8 の送り手がそろった後） |
| 端末のキャッシュの使用量 | `navigator.storage.estimate()` | 未確認（実装の後） |
| 画面の殻の初回の大きさ | ビルドの成果物の合計（圧縮後） | 未確認（実装の後） |
