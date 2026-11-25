/**
 * NDF の契約の使い方（#136 の決定 3・4・5・7）。
 *
 * 呼び出しの判定と区間の報告の読み取りを、固定の点の契約から生成したデータだけを使う純粋な関数として持つ。
 * 照合（`npm run ndf-contract`）とランナー（#6）が同じ関数を使う。`node:` の組み込みは読まない。
 */

import type { NdfCall, NdfEntrypointRow } from "./ndf-contract-use-schema.ts";

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
