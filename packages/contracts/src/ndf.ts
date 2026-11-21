import { z } from "zod";

// 受ける NDF の契約の値（決定 10）

// 受ける契約の組（版と配布物の sha256 の対）の集合。ランナーは対が集合にあるかだけを照らし、版の大小で選ばない。
// 組の重なり（同じ版か同じ sha256 が 2 つ）は data.ts の読みで照らす
export const ndfContractSet = z.strictObject({
  accepted: z
    .array(
      z.strictObject({
        version: z.int().min(1),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .min(1),
});

export type NdfContractSet = z.infer<typeof ndfContractSet>;

// 答えの語。出所は NDF の固定の点の C/facts/answers.json の写し
export const ndfAnswerWord = z.enum(["approved", "rejected", "request_changes", "retry", "finish", "cancel"]);

export type NdfAnswerWord = z.infer<typeof ndfAnswerWord>;
