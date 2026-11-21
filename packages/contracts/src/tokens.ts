import { z } from "zod";
import { type IdKind, idOf, UUID_V7_PATTERN } from "./ids.ts";

// 委任と登録の token の形と、署名した JWT の主張の形。委任と登録の token は頭の後に行を区切りの鍵で強い整合で読むための 2 つの ID を置き、
// 最後に秘密の部分（32 バイトの base64url、43 字）を置く（docs/design/detail.md の「内部のデータと定数」）

const SECRET_PART = "[A-Za-z0-9_-]{43}";

function tokenPattern(head: string, first: IdKind, second: IdKind): RegExp {
  return new RegExp(`^${head}_${first}_${UUID_V7_PATTERN}\\.${second}_${UUID_V7_PATTERN}\\.${SECRET_PART}$`);
}

// ndfd_<利用者の ID>.<委任の ID>.<秘密の部分>
export const delegationToken = z.string().regex(tokenPattern("ndfd", "usr", "dlg"));

// ndfm_<チームの ID>.<マシンの ID>.<秘密の部分>
export const machineToken = z.string().regex(tokenPattern("ndfm", "team", "mch"));

// nd-factory 自身が Ed25519 で署名する JWT（ランナーと DB の用意のタスク）の主張の形。発行するのはランナーの起こし（#6）と
// DB の用意（#13）で、照らすのは core の authenticate（照らしの関数は core に置く）。両方が同じ形を読むよう、形はここだけに置く。
// どちらも aud（宛先）・exp（期限、UNIX の秒）・token_use（経路ごとの用途）・sub・project_id を持ち、ランナーだけ generation を持つ。
// 主張の追加（iat など）は拒まない。JSON Schema で表せる形だけで書く

export const RUNNER_AUDIENCE = "lane";
export const DB_PREP_AUDIENCE = "db_prep";

// ランナーの token の用途。引き換えの経路だけ exchange、ほかはレーンの token の lane
export const RUNNER_TOKEN_USES = ["exchange", "lane"] as const;

// DB の用意の token の用途。引き換えの経路は exchange、終わりの報告の経路は completion（どちらも 1 回だけ）
export const DB_PREP_TOKEN_USES = ["exchange", "completion"] as const;

const expiresAtSeconds = z.number();

// sub はレーンの ID、generation は割り当ての世代の番号
export const runnerTokenClaims = z.object({
  aud: z.literal(RUNNER_AUDIENCE),
  exp: expiresAtSeconds,
  token_use: z.enum(RUNNER_TOKEN_USES),
  sub: idOf("lane"),
  project_id: idOf("prj"),
  generation: z.number().int(),
});

// sub は用意の ID（プロジェクトの進行表の DB の用意ごとの値）
export const dbPrepTokenClaims = z.object({
  aud: z.literal(DB_PREP_AUDIENCE),
  exp: expiresAtSeconds,
  token_use: z.enum(DB_PREP_TOKEN_USES),
  sub: z.string().min(1),
  project_id: idOf("prj"),
});

export type RunnerTokenClaims = z.infer<typeof runnerTokenClaims>;
export type DbPrepTokenClaims = z.infer<typeof dbPrepTokenClaims>;
