import { z } from "zod";

// ID は <種類の頭>_<UUIDv7>（RFC 9562 の文字の形、小文字）。頭の集まりは docs/design/api.md の「値の形」

export const ID_KINDS = ["usr", "team", "inv", "prj", "repo", "trf", "spr", "lane", "apr", "qst", "ntc", "dst", "dlg", "mch", "key", "aud"] as const;

export type IdKind = (typeof ID_KINDS)[number];

// UUIDv7 の文字の形（版の数字が 7、変種が 8〜b）。token の形も同じ部分を組む
export const UUID_V7_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

// 種類ごとの ID の形。core の parseId はこれを呼ぶ
export function idOf(kind: IdKind): z.ZodString {
  return z.string().regex(new RegExp(`^${kind}_${UUID_V7_PATTERN}$`));
}
