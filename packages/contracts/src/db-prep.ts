import { z } from "zod";

// DB の用意の関数（Lambda）の呼び出しの値と終わりの結果の形の正本。関数は HTTP の経路を持たず、
// API と見回りが非同期の Invoke でこの値を渡す。呼び出しにも結果にも、パスワード・URL・管理の値・
// データベースと役割の名前を載せない（名前と秘密の器は関数が終わりの記録の口から読む）

// プロジェクトの ID は API の値の形の `<種類の頭>_<UUIDv7>`（小文字）で、頭は prj
const PROJECT_ID_SHAPE = /^prj_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// 用意の ID は API が呼ぶ前にプロジェクトの行へ置く値で、ID の頭の集まりに無い。受け取りの表の主キーと
// ログに載るため、区切りや空白の無い文字と、利用者の ID と同じ長さの上限に限る
const PREP_ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

// 進行表の DB のデータベースと役割の名前の形。関数は口から読んだ名前をこの形で照らしてから SQL に載せる。
// 頭を英字にして予約の名前と数の名前を避け、PostgreSQL の名前の上限 63 バイトに収める
export const PROGRESS_DB_IDENT_SHAPE = /^[a-z][a-z0-9_]{7,62}$/;

const prepId = z.string().regex(PREP_ID_SHAPE, "英数字と _ と - で 1〜128 文字にする");
const projectId = z.string().regex(PROJECT_ID_SHAPE, "prj_ と UUIDv7 の形にする");
const seq = z.number().int().min(1);

// 作るは番号を持たず、差し替えだけが番号 n を持つ。ほかの項目は strict で誤りにする
export const dbPrepInvocation = z.discriminatedUnion("kind", [
  z.strictObject({ prep_id: prepId, project_id: projectId, kind: z.literal("create") }),
  z.strictObject({ prep_id: prepId, project_id: projectId, kind: z.literal("rotate"), rotation_seq: seq }),
]);

// 古い接続が残った差し替えは終わりを記さずに落ちる（I17）ため、記す理由に無い
export const DB_PREP_FAILURE_REASONS = Object.freeze(["data_api_unavailable", "guard_conflict", "sql_failed"] as const);

// recorded_seq は DB の側に記してあった差し替えの番号
export const dbPrepOutcome = z.discriminatedUnion("result", [
  z.strictObject({ result: z.literal("applied") }),
  z.strictObject({ result: z.literal("rotation_superseded"), recorded_seq: seq }),
  z.strictObject({ result: z.literal("failed"), reason: z.enum(DB_PREP_FAILURE_REASONS) }),
]);

// 時間の関係（決定 9・全体の設計の決定 96）。待ち行列の年齢＋関数の時間切れ＋Data API の長い方が、
// 前の呼び出しが DB へ働きうる最も遅い時刻で、それが用意の期限より短く、差が見回りの間隔以上であることを
// test/db-prep.test.ts で照らす。dataApiCallSeconds と dataApiTxIdleSeconds は Data API が決める値で、関数からは変えない。
// この定数が時間の値の正本で、実際の資源はここを読む。照らしをインフラの値の変化でも落とすため、読み手は
// 値を写さずこの定数を参照し、合成のテストで合成の出力と定数の一致を照らす:
// - functionTimeoutSeconds と maxEventAgeSeconds: DB の用意の関数の資源（infra/lib/db-prep-function.ts、#13 の U7）
//   が Timeout と MaximumEventAgeInSeconds に使い、infra/test/db-prep-function.test.ts で照らす
// - prepDeadlineSeconds と patrolIntervalSeconds: 見回りの資源とスケジュール、API の期限（#6）が使う
export type DbPrepTiming = Readonly<{
  maxEventAgeSeconds: number;
  functionTimeoutSeconds: number;
  dataApiCallSeconds: number;
  dataApiTxIdleSeconds: number;
  prepDeadlineSeconds: number;
  patrolIntervalSeconds: number;
}>;

export const DB_PREP_TIMING: DbPrepTiming = Object.freeze({
  maxEventAgeSeconds: 60,
  functionTimeoutSeconds: 300,
  dataApiCallSeconds: 45,
  dataApiTxIdleSeconds: 180,
  prepDeadlineSeconds: 900,
  patrolIntervalSeconds: 300,
});

// DB の用意の関数へ渡す環境変数の名前。資源（infra/lib/db-prep-function.ts、#13 の U7）が値を入れ、
// 起点（apps/api/src/entries/db-prep.ts）が読む。両方がこの定数を参照し、名前を写さない
export const DB_PREP_ENV = Object.freeze({
  // 進行表の DB のクラスタの ARN（Data API の resourceArn）
  clusterArn: "DB_PREP_CLUSTER_ARN",
  // 管理の役割の秘密の器の ARN（Data API の secretArn）
  adminSecretArn: "DB_PREP_ADMIN_SECRET_ARN",
  // プロジェクトの秘密の器の名前の頭（<prefix>/<environment>/progress-db/）
  secretPrefix: "DB_PREP_SECRET_PREFIX",
} as const);

export type DbPrepInvocation = z.infer<typeof dbPrepInvocation>;
export type DbPrepOutcome = z.infer<typeof dbPrepOutcome>;
export type DbPrepFailureReason = (typeof DB_PREP_FAILURE_REASONS)[number];
