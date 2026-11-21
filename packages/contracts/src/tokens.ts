import { z } from "zod";
import { type IdKind, UUID_V7_PATTERN } from "./ids.ts";

// 委任と登録の token の形。頭の後に行を区切りの鍵で強い整合で読むための 2 つの ID を置き、
// 最後に秘密の部分（32 バイトの base64url、43 字）を置く（docs/design/detail.md の「内部のデータと定数」）

const SECRET_PART = "[A-Za-z0-9_-]{43}";

function tokenPattern(head: string, first: IdKind, second: IdKind): RegExp {
  return new RegExp(`^${head}_${first}_${UUID_V7_PATTERN}\\.${second}_${UUID_V7_PATTERN}\\.${SECRET_PART}$`);
}

// ndfd_<利用者の ID>.<委任の ID>.<秘密の部分>
export const delegationToken = z.string().regex(tokenPattern("ndfd", "usr", "dlg"));

// ndfm_<チームの ID>.<マシンの ID>.<秘密の部分>
export const machineToken = z.string().regex(tokenPattern("ndfm", "team", "mch"));
