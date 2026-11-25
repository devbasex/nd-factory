/**
 * NDF の契約の使い方の型とデータの形（#136 の決定 3・5・7）。
 *
 * このモジュールはデータの JSON を読まず、読み込みのときに何も組み立てない。手で書くデータと生成のデータが
 * 食い違った作業の木でも、照合と生成のコマンドがここから形を読んで起動し、生成し直して直せるようにするためである。
 * データを読み込んで使い方を組み立てるのは `./ndf-contract-use.ts`。
 */

import { z } from "zod";

/**
 * ランナーが区間の報告から読む項目の名前（契約の `shape.items` のうち使うもの）。
 * 読み取りの戻り値の `items` の型をこの定数から作るため、JSON ではなくコードに置く
 */
export const REPORT_ITEMS = ["結果", "課題", "区分", "承認ゲート", "質問", "Pull Request", "材料", "人に頼むこと", "理由"] as const;

/** 読み取りの戻り値の `items` のキー（結果の行は `result` で返すので除く） */
export type ReportItemName = Exclude<(typeof REPORT_ITEMS)[number], "結果">;

const strings = z.array(z.string());

/** 手で書くデータ（`data/ndf-contract-use.json`）の形 */
export const ndfContractUseData = z.strictObject({
  /** 使うインタフェースの id（execution.md の「使うインタフェース」の表） */
  entrypoints: strings,
  /** Skill の名前の前置き（契約の表に無く、identity が決める） */
  skillPrefix: z.string(),
  /** インタフェースと実行の場（ホステッド・手元のマシン）の組ごとの渡す環境変数の名前 */
  env: z.array(z.strictObject({ entrypoint: z.string(), site: z.enum(["hosted", "local"]), names: strings })),
  /** 渡す名前のうち、`env.json` の `set_by` が `service` でない名前とその値 */
  envSetBy: z.record(z.string(), z.string()),
  /** 読むファイルの id と、翻訳が読む項目 */
  files: z.array(z.strictObject({ id: z.string(), fields: strings })),
});

export type NdfContractUseData = z.infer<typeof ndfContractUseData>;

/**
 * 区間の報告の結果の値ごとの要る項目。`always` は無条件に要る項目、`when` は条件つきで要る項目。
 * `when` の行は `need` のほかのキー（`item`・`prefix`・`equals` など）が条件
 */
export const reportRequiredRuleFields = {
  always: strings,
  when: z.array(z.object({ item: z.string(), need: strings }).catchall(z.unknown())),
};

const reportRequiredRule = z.strictObject(reportRequiredRuleFields);

export type ReportRequiredRule = z.infer<typeof reportRequiredRule>;

/**
 * 使うインタフェースの行の列（契約の `entrypoints.json` の行の 6 つの列と id）。
 * 生成のデータは `z.strictObject` で、照合が上流の契約を読むときは説明の列を捨てる `z.object` で、この列から形を作る
 */
export const ndfEntrypointRowFields = {
  id: z.string(),
  kind: z.string(),
  target: z.string(),
  lead: z.string().optional(),
  args: strings.optional(),
  env: strings,
  files: strings.optional(),
};

/** 生成した使うインタフェースの行 1 つ */
export const ndfEntrypointRow = z.strictObject(ndfEntrypointRowFields);

export type NdfEntrypointRow = z.infer<typeof ndfEntrypointRow>;

/** 生成のデータ（`data/ndf-contract-use.generated.json`）の形。生成のコマンドも書く前にこの形で確かめる */
export const ndfContractUseGenerated = z.strictObject({
  /** 生成の元にした固定の点のコミット */
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  entrypoints: z.array(ndfEntrypointRow),
  /** 使うインタフェースの `files` が指す読むファイルの `path`（`ndf-files.json` の行） */
  files: z.array(z.strictObject({ id: z.string(), path: z.string() })),
  /** 区間の報告の形。`values` は契約の `shape.values` のキーを契約の順に並べたもの */
  report: z.strictObject({
    values: strings,
    required: z.record(z.string(), reportRequiredRule),
    material: z.record(z.string(), z.string()),
  }),
});

export type NdfContractUseGenerated = z.infer<typeof ndfContractUseGenerated>;

/** 判定へ渡す呼び出し。`call` は契約のサンプルの `call` の列にあたり、種類ごとに中身が違う */
export type NdfCall = { entrypoint: string; call: string; env: readonly string[] };

/** 区間の報告の読み取りの誤りのコード（設計書の決定 7 の表） */
export type ReportErrorCode =
  | "result_line_missing"
  | "result_value_unknown"
  | "item_missing"
  | "material_form_invalid"
  | "material_heading_missing";

/** 誤りの一覧の 1 件。読み取った値を持たない（署名付き URL などを進捗の事象へ持ち込まないため） */
export type ReportError = { code: ReportErrorCode; item: string };

/** 読み取りが取り出した材料 */
export type ReportMaterial =
  | { kind: "none" }
  | { kind: "body"; section: string }
  | { kind: "urls"; urls: readonly string[] };

/** 区間の報告の読み取りの戻り値 */
export type ReportReading = {
  /** 結果の値。結果の行が無ければ空文字列 */
  result: string;
  errors: readonly ReportError[];
  /** 採った項目の値（同じ名前は後勝ち）。報告に無い項目はキーを持たない */
  items: Readonly<Partial<Record<ReportItemName, string>>>;
  /** 誤りがあるときは `none` */
  material: ReportMaterial;
};

/** 照合とランナーが使う NDF の契約の使い方 */
export type NdfContractUse = {
  /** 受ける契約のバージョンと sha256 の組（`NDF_CONTRACTS.accepted` そのもの。照合の 2 項目目） */
  acceptedVersions: readonly { version: number; sha256: string }[];
  /** 生成の元にした固定の点のコミット（照合の 6 項目目で `ndf-pin.json` と比べる） */
  pinnedCommit: string;
  /** Skill の名前の前置き */
  skillPrefix: string;
  /** 使うインタフェースの行（照合の 1・6 項目目） */
  entrypoints: readonly NdfEntrypointRow[];
  /** インタフェースと実行の場の組ごとの渡す環境変数の名前（照合の 3 項目目） */
  env: NdfContractUseData["env"];
  /** 渡す名前のうち `set_by` が `service` でない名前とその値（照合の 3 項目目） */
  envSetBy: Readonly<Record<string, string>>;
  /** 読むファイルの `path` と翻訳が読む項目（照合の 4 項目目） */
  files: readonly { id: string; path: string; fields: readonly string[] }[];
  /** ランナーが区間の報告から読む項目の名前（`REPORT_ITEMS`。照合の 5 項目目） */
  reportItems: readonly string[];
  /** 生成した区間の報告の形（照合の 5 項目目） */
  report: NdfContractUseGenerated["report"];
  /** ランナーが NDF を起こす前に通す呼び出しの判定（照合の 1 項目目） */
  judgeCall: (call: NdfCall) => boolean;
  /** 区間の報告の読み取り（照合の 5 項目目） */
  readReport: (text: string) => ReportReading;
};
