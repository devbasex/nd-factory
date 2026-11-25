/**
 * NDF の契約の使い方（#136 の決定 3・4・5・7）。
 *
 * 呼び出しの判定と区間の報告の読み取りを、固定の点の契約から生成したデータだけを使う純粋な関数として持つ。
 * 照合（`npm run ndf-contract`）とランナー（#6）が同じ関数を使う。`node:` の組み込みは読まない。
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

import {
  REPORT_ITEMS,
  type NdfCall,
  type NdfContractUseGenerated,
  type NdfEntrypointRow,
  type ReportError,
  type ReportItemName,
  type ReportMaterial,
  type ReportReading,
} from "./ndf-contract-use-schema.ts";

/** 正規表現の特殊文字を、その文字にだけ一致するようにエスケープする */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * 読むファイルの `path`（`<名前>` を含む）を、呼び出しの相対パスに全体で一致させる正規表現にする。
 * `<名前>` は `/` を含まない 1 文字以上の並びに、ほかの文字はそのままの文字に一致させる
 */
export function filePathPattern(path: string): RegExp {
  const body = path
    .split(/(<[^<>]+>)/)
    .map((part) => (/^<[^<>]+>$/.test(part) ? "[^/]+" : escapeRegExp(part)))
    .join("");
  return new RegExp(`^${body}$`);
}

/** `text` の全体が `patterns` のどれか 1 つに一致するか。読めない正規表現には一致しないとみなす */
function matchesWhole(patterns: readonly string[] | undefined, text: string): boolean {
  return (patterns ?? []).some((pattern) => {
    try {
      return new RegExp(`^(?:${pattern})$`).test(text);
    } catch {
      return false;
    }
  });
}

/** `block` の呼び出し（`ndf-next` ブロックの中身）を、任意の `lead`・`/` + 前置き + `target` + 空白・引数の順に照らす */
function judgeBlock(row: NdfEntrypointRow, skillPrefix: string, call: string): boolean {
  let rest = row.lead !== undefined && call.startsWith(row.lead) ? call.slice(row.lead.length) : call;
  const head = `/${skillPrefix}${row.target} `;
  if (!rest.startsWith(head)) return false;
  rest = rest.slice(head.length);
  return matchesWhole(row.args, rest);
}

/**
 * 使うインタフェースへの呼び出しが契約に合うかを判定する。判定できない入力はすべて偽を返し、例外を投げない。
 * 規則は設計書の決定 5 の表（種類ごとの呼び出し文字列の照合）による
 */
export function judgeCallWith(
  rows: readonly NdfEntrypointRow[],
  files: readonly { id: string; path: string }[],
  skillPrefix: string,
  call: NdfCall,
): boolean {
  const row = rows.find((r) => r.id === call.entrypoint);
  if (row === undefined) return false;
  if (!call.env.every((name) => row.env.includes(name))) return false;
  switch (row.kind) {
    case "skill":
    case "report":
    case "command":
      return matchesWhole(row.args, call.call);
    case "block":
      return judgeBlock(row, skillPrefix, call.call);
    case "hook":
      return call.call === row.target;
    case "file": {
      const ids = row.files ?? [];
      return files.some((file) => ids.includes(file.id) && filePathPattern(file.path).test(call.call));
    }
    case "spec":
      return call.call.startsWith(`${row.target}/`) && call.call.length > row.target.length + 1;
    default:
      return false;
  }
}

const RESULT_PREFIX = "- 結果:";
const ITEM_LINE = /^- ([^:]+):(.*)$/;
const NONE = "無し";
const READ_ITEMS: ReadonlySet<string> = new Set(REPORT_ITEMS.filter((name) => name !== "結果"));

type ReportShape = NdfContractUseGenerated["report"];

/** 値が無い・空・`無し` か */
function absent(value: string | undefined): boolean {
  return value === undefined || value === "" || value === NONE;
}

/** `when` の行の条件（`prefix` で始まる・`equals` と同じ）に、項目の値が当たるか。条件の項目が無ければ当たらない */
function conditionHolds(rule: ReportShape["required"][string]["when"][number], items: ReadonlyMap<string, string>): boolean {
  const value = items.get(rule.item);
  if (value === undefined) return false;
  const { prefix, equals } = rule;
  if (typeof prefix !== "string" && typeof equals !== "string") return false;
  if (typeof prefix === "string" && !value.startsWith(prefix)) return false;
  if (typeof equals === "string" && value !== equals) return false;
  return true;
}

/**
 * 結果の行より前の文を GFM で解析し、文書の直下の ATX 見出しのうち `heading` と同じ最後の見出しの節を返す。
 * 節は見出しの終わりから、次の文書の直下のレベル 1 か 2 の見出し（ATX と Setext）の前まで。見出しが無ければ null
 */
function materialSection(before: string, heading: string): string | null {
  const root = fromMarkdown(before, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const headings = root.children.flatMap((node) =>
    node.type === "heading" && node.position?.start.offset !== undefined && node.position.end.offset !== undefined
      ? [{ depth: node.depth, start: node.position.start.offset, end: node.position.end.offset }]
      : [],
  );
  const chosen = headings.filter((h) => before.slice(h.start, h.end).trim() === heading).at(-1);
  if (chosen === undefined) return null;
  const next = headings.find((h) => h.start >= chosen.end && h.depth <= 2);
  const section = before.slice(chosen.end, next?.start ?? before.length);
  return section.startsWith("\n") ? section.slice(1) : section;
}

/**
 * 区間の報告を、契約の `rule` と `shape`（生成のデータの `report`）に沿って読む（設計書の決定 7 の規則 1〜6）。
 * 例外を投げない。誤りの一覧はコードと項目の名前だけを持ち、報告の中の値を持たない
 */
export function readReportWith(report: ReportShape, text: string): ReportReading {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const resultIndex = lines.findLastIndex((line) => line.startsWith(RESULT_PREFIX));
  const none: ReportMaterial = { kind: "none" };
  if (resultIndex < 0) {
    return { result: "", errors: [{ code: "result_line_missing", item: "結果" }], items: {}, material: none };
  }
  const result = (lines[resultIndex] ?? "").slice(RESULT_PREFIX.length).trim();
  if (!report.values.includes(result)) {
    return { result, errors: [{ code: "result_value_unknown", item: "結果" }], items: {}, material: none };
  }

  // 規則 3・4: 結果の行より後ろの項目の行を読み、同じ名前は後の行で上書きする
  const all = new Map<string, string>();
  for (const line of lines.slice(resultIndex + 1)) {
    const match = ITEM_LINE.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) all.set(match[1].trim(), match[2].trim());
  }
  const items: Partial<Record<ReportItemName, string>> = {};
  for (const [name, value] of all) {
    if (READ_ITEMS.has(name)) items[name as ReportItemName] = value;
  }

  // 規則 5: 結果の値ごとの要る項目（always の後に当たった when の need）を、無い・空・無しなら欠落にする
  const errors: ReportError[] = [];
  const rule = Object.hasOwn(report.required, result) ? report.required[result] : undefined;
  const needed = [...(rule?.always ?? []), ...(rule?.when ?? []).filter((w) => conditionHolds(w, all)).flatMap((w) => w.need)];
  for (const name of new Set(needed)) {
    if (absent(all.get(name))) errors.push({ code: "item_missing", item: name });
  }

  // 規則 6: 材料に値があるときだけ形を確かめる
  const { item: materialItem = "材料", body = "本文", heading = "## 判断の材料", url_prefix: urlPrefix = "https://" } = report.material;
  const value = all.get(materialItem);
  let material: ReportMaterial = none;
  if (value !== undefined && !absent(value)) {
    if (value === body) {
      const section = materialSection(lines.slice(0, resultIndex).join("\n"), heading);
      if (section === null) errors.push({ code: "material_heading_missing", item: materialItem });
      else material = { kind: "body", section };
    } else {
      const urls = value.split(/\s+/).filter((part) => part !== "");
      if (urls.every((url) => url.startsWith(urlPrefix) && url.length > urlPrefix.length)) material = { kind: "urls", urls };
      else errors.push({ code: "material_form_invalid", item: materialItem });
    }
  }
  return { result, errors, items, material: errors.length > 0 ? none : material };
}
