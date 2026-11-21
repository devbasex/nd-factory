import { z } from "zod";

// 設定のファイルの形の正本。JSON Schema と見本はここから作る（scripts/generate.ts）。
// 読む構成要素の無いキーは置かない。キーを足すのは、それを読む部品を足すときだけにする。

// 資源の名前と利用者プールのドメインの頭に付くため、小文字の英数字とハイフンに限る。
// 端のハイフンは名前の区切りと紛れるので許さない
export const PREFIX_SHAPE = /^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/;
// 利用者プールのドメインは aws で始められないため、設定の段階で止める
const PREFIX_NOT_AWS = /^(?!aws)/;
const ENVIRONMENT_SHAPE = /^[a-z0-9]{2,10}$/;
const REPOSITORY_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const settingsSchema = z.strictObject({
  prefix: z
    .string()
    .regex(PREFIX_SHAPE, "小文字の英数字とハイフンで 3〜20 文字にし、ハイフンで始めも終えもしない")
    .regex(PREFIX_NOT_AWS, "aws で始められない"),
  environment: z.string().regex(ENVIRONMENT_SHAPE, "小文字の英数字で 2〜10 文字にする"),
  login: z.strictObject({
    // client_id は、人が秘密の器へ本物の値を入れた後にだけ書く。無い間は画面が設定の待ちを示す
    google: z.strictObject({
      client_id: z.string().min(1, "空にできない").optional(),
    }),
  }),
  pipeline: z
    .strictObject({
      repository: z.string().regex(REPOSITORY_SHAPE, "<組織>/<名前> の形にする"),
      branch: z.string().min(1, "空にできない"),
      notify_emails: z.array(z.email("メールの形でない")).optional(),
    })
    .optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

export type ParseSettingsResult = { ok: true; value: Settings } | { ok: false; issues: string[] };

function formatPath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "(最上位)" : path.map(String).join(".");
}

function hasKeyAt(raw: unknown, path: readonly PropertyKey[]): boolean {
  let cur: unknown = raw;
  for (const key of path) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, key)) return false;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return true;
}

// zod の誤りを、人が読んで直せる 1 件 1 文字列（キーのパスを先頭に置く）へ写す
function describeIssue(raw: unknown, issue: z.core.$ZodIssue): string[] {
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => `${formatPath([...issue.path, key])}: 知らないキー`);
  }
  if (issue.code === "invalid_type") {
    const where = formatPath(issue.path);
    if (issue.path.length > 0 && !hasKeyAt(raw, issue.path)) return [`${where}: 必須のキーが無い`];
    return [`${where}: 型が違う（${issue.expected} を求める）`];
  }
  return [`${formatPath(issue.path)}: ${issue.message}`];
}

export function parseSettings(raw: unknown): ParseSettingsResult {
  const result = settingsSchema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, issues: result.error.issues.flatMap((issue) => describeIssue(raw, issue)) };
}
