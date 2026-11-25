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
// VPC の CIDR。IPv4 の 4 つの数（先頭の 0 を許さない）と接頭辞の長さ 16〜20。
// 20 より長いと 2 つの AZ の公開と隔離のサブネットが VPC に収まらず、16 より短い VPC は AWS が作らない。
// ホストの部分が 0 でない CIDR（10.80.1.0/16 など）は、書いた人の意図した範囲と作られる範囲がずれるため止める。
// この制約も正規表現に入れ、生成する JSON Schema の pattern（エディタの補完や外の検証）と parseSettings の
// 判定をそろえる。接頭辞の長さ L ごとに、3 つ目の数は 2^(24-L) の倍数、4 つ目の数は 0 に限る
const OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const VPC_PREFIX_LENGTHS = [16, 17, 18, 19, 20] as const;
function networkTail(length: number): string {
  const step = 2 ** (24 - length);
  const thirds = Array.from({ length: 256 / step }, (_, i) => String(i * step));
  return `(?:${thirds.join("|")})\\.0/${length}`;
}
const VPC_CIDR_SHAPE = new RegExp(`^${OCTET}\\.${OCTET}\\.(?:${VPC_PREFIX_LENGTHS.map(networkTail).join("|")})$`);
const MAX_OPS_EMAILS = 10;

const email = z.email("メールの形でない");

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
      notify_emails: z.array(email).optional(),
    })
    .optional(),
  // ここから下はインフラの資源が読むキー。どれも任意で、無ければ INFRA_DEFAULTS を使う（infraValues）
  network: z
    .strictObject({
      vpc_cidr: z
        .string()
        .regex(VPC_CIDR_SHAPE, "IPv4 の CIDR で、接頭辞の長さを 16〜20 にし、ホストの部分を 0 にする（例 10.80.0.0/16）")
        .optional(),
    })
    .optional(),
  progress_db: z
    .strictObject({
      max_acu: z
        .number()
        .min(1, "1 以上にする")
        .max(16, "16 以下にする")
        .multipleOf(0.5, "0.5 刻みにする")
        .optional(),
    })
    .optional(),
  budget: z
    .strictObject({
      monthly_usd: z.number().int("整数にする").min(1, "1 以上にする").max(100_000, "100000 以下にする").optional(),
      scope: z.enum(["tags", "account"], "tags か account にする").optional(),
    })
    .optional(),
  ops: z
    .strictObject({
      notify_emails: z.array(email).max(MAX_OPS_EMAILS, `${MAX_OPS_EMAILS} 件までにする`).optional(),
    })
    .optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

export type BudgetScope = NonNullable<NonNullable<Settings["budget"]>["scope"]>;

// 設定のファイルにキーが無いときにインフラの資源が使う値
export type InfraValues = {
  vpcCidr: string;
  maxAcu: number;
  budgetUsd: number;
  budgetScope: BudgetScope;
  opsEmails: readonly string[];
};

export const INFRA_DEFAULTS: Readonly<InfraValues> = Object.freeze({
  vpcCidr: "10.80.0.0/16",
  maxAcu: 2,
  budgetUsd: 30,
  budgetScope: "tags",
  opsEmails: Object.freeze([]),
});

// 既定を入れた値を返す。宛先の配列は写しにし、呼び手が変えても既定を変えない
export function infraValues(s: Settings): InfraValues {
  return {
    vpcCidr: s.network?.vpc_cidr ?? INFRA_DEFAULTS.vpcCidr,
    maxAcu: s.progress_db?.max_acu ?? INFRA_DEFAULTS.maxAcu,
    budgetUsd: s.budget?.monthly_usd ?? INFRA_DEFAULTS.budgetUsd,
    budgetScope: s.budget?.scope ?? INFRA_DEFAULTS.budgetScope,
    opsEmails: [...(s.ops?.notify_emails ?? INFRA_DEFAULTS.opsEmails)],
  };
}

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
