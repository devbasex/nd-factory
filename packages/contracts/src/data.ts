import { z } from "zod";
import ndfContractsData from "../data/ndf-contracts.json" with { type: "json" };
import plansData from "../data/plans.json" with { type: "json" };
import retryPoliciesData from "../data/retry-policies.json" with { type: "json" };
import secretShapesData from "../data/secret-shapes.json" with { type: "json" };
import { type NdfContractSet, ndfContractSet } from "./ndf.ts";
import { money } from "./values.ts";

// data/*.json を形で検証して出す。モジュールの読み込みのときに検証し、形が違えば投げる（データの誤りを check で落とす）

export class DataFileError extends Error {
  override name = "DataFileError";
}

function parseWith<T extends z.ZodType>(file: string, schema: T, raw: unknown): z.infer<T> {
  const result = schema.safeParse(raw);
  if (!result.success) throw new DataFileError(`${file} の形が違う: ${z.prettifyError(result.error)}`);
  return result.data;
}

function noDuplicates(file: string, what: string, values: readonly (string | number)[]): void {
  const seen = new Set<string | number>();
  for (const v of values) {
    if (seen.has(v)) throw new DataFileError(`${file} の${what}が重なる: ${v}`);
    seen.add(v);
  }
}

// 再試行の方針。呼び出しの種類ごとのライブラリの設定の形で持ち、待ちの計算はライブラリの組み込みに任せる（決定 13）

export const RETRY_POLICY_NAMES = ["dynamodb", "aws-control", "dynamodb-transaction", "http-github", "http-notify", "runner-to-api", "http-idp-keys"] as const;

export type RetryPolicyName = (typeof RETRY_POLICY_NAMES)[number];

const positiveMs = z.int().min(1);

// 種類ごとの形。名前ごとに種類を 1 つに固定し、取り違え（dynamodb に jwks の設定など）を読み込みで拒む
// AWS SDK へ渡す
const awsPolicy = z.strictObject({ kind: z.literal("aws"), retry_mode: z.enum(["standard"]), max_attempts: z.int().min(1), request_timeout_ms: positiveMs });
// ky へ渡す。要求ごとの時間切れは全体の期限を超えない
const httpPolicy = z
  .strictObject({
    kind: z.literal("http"),
    limit: z.int().min(0),
    timeout_ms: positiveMs,
    total_timeout_ms: positiveMs,
    backoff_limit_ms: positiveMs,
    max_retry_after_ms: positiveMs,
  })
  .refine((p) => p.timeout_ms <= p.total_timeout_ms, { message: "timeout_ms は total_timeout_ms 以下", path: ["timeout_ms"] });
// aws-jwt-verify の取り手へ渡す
const jwksPolicy = z.strictObject({ kind: z.literal("jwks"), response_timeout_ms: positiveMs });
// p-retry へ渡す（トランザクションの衝突だけ）。待ちの下限は上限を超えない
const transactionPolicy = z
  .strictObject({ kind: z.literal("transaction"), retries: z.int().min(0), min_ms: z.int().min(0), max_ms: z.int().min(0) })
  .refine((p) => p.min_ms <= p.max_ms, { message: "min_ms は max_ms 以下", path: ["min_ms"] });

export type AwsRetryPolicy = z.infer<typeof awsPolicy>;
export type HttpRetryPolicy = z.infer<typeof httpPolicy>;
export type JwksRetryPolicy = z.infer<typeof jwksPolicy>;
export type TransactionRetryPolicy = z.infer<typeof transactionPolicy>;
export type RetryPolicy = AwsRetryPolicy | HttpRetryPolicy | JwksRetryPolicy | TransactionRetryPolicy;

// 名前から種類の形を引く対応表。呼び手は名前で引けば種類で絞り直さずに済む
const retryPolicies = z.strictObject({
  dynamodb: awsPolicy,
  "aws-control": awsPolicy,
  "dynamodb-transaction": transactionPolicy,
  "http-github": httpPolicy,
  "http-notify": httpPolicy,
  "runner-to-api": httpPolicy,
  "http-idp-keys": jwksPolicy,
} satisfies Record<RetryPolicyName, z.ZodType<RetryPolicy>>);

export type RetryPolicies = z.infer<typeof retryPolicies>;

export type RetryPolicyOf<N extends RetryPolicyName> = RetryPolicies[N];

export function readRetryPolicies(raw: unknown): RetryPolicies {
  return parseWith("retry-policies.json", retryPolicies, raw);
}

// 秘密の形。redact と漏れの検査と生成の照らしが同じデータを読み、2 か所に持たない

export type SecretShapes = {
  keyNames: readonly string[];
  valuePatterns: readonly { name: string; pattern: string }[];
};

const secretShapes = z.strictObject({
  key_names: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1),
  value_patterns: z.array(z.strictObject({ name: z.string().regex(/^[a-z][a-z0-9_]*$/), pattern: z.string().min(1) })).min(1),
});

export function readSecretShapes(raw: unknown): SecretShapes {
  const file = "secret-shapes.json";
  const parsed = parseWith(file, secretShapes, raw);
  noDuplicates(file, "鍵の名前", parsed.key_names);
  noDuplicates(file, "値の形の名前", parsed.value_patterns.map((p) => p.name));
  for (const p of parsed.value_patterns) {
    try {
      new RegExp(p.pattern, "u");
    } catch (error) {
      throw new DataFileError(`${file} の値の形 ${p.name} が正規表現として読めない`, { cause: error });
    }
  }
  return { keyNames: parsed.key_names, valuePatterns: parsed.value_patterns };
}

// 受ける NDF の契約の組。ランナー（#6）が読む

export function readNdfContracts(raw: unknown): NdfContractSet {
  const file = "ndf-contracts.json";
  const parsed = parseWith(file, ndfContractSet, raw);
  noDuplicates(file, "版", parsed.accepted.map((c) => c.version));
  noDuplicates(file, "sha256", parsed.accepted.map((c) => c.sha256));
  return parsed;
}

// 料金プラン。この課題は「上限なし」の 1 行だけで、値の集合と量は #29 が決める

const planRow = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  places: z.array(z.enum(["hosted", "machine"])).min(1),
  inference: z.array(z.enum(["managed", "byok"])).min(1),
  concurrency: z.int().min(1).nullable(),
  monthly_cap: money.nullable(),
});

export type PlanRow = z.infer<typeof planRow>;

export function readPlans(raw: unknown): readonly PlanRow[] {
  const file = "plans.json";
  const parsed = parseWith(file, z.array(planRow).min(1), raw);
  noDuplicates(file, "名前", parsed.map((p) => p.name));
  return parsed;
}

export const RETRY_POLICIES: Readonly<RetryPolicies> = readRetryPolicies(retryPoliciesData);
export const SECRET_SHAPES: SecretShapes = readSecretShapes(secretShapesData);
export const NDF_CONTRACTS: NdfContractSet = readNdfContracts(ndfContractsData);
export const PLANS: readonly PlanRow[] = readPlans(plansData);
