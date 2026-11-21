import { expect, it } from "vitest";
import { ADMIN_DATABASE } from "../../src/db-prep/sql-executor.ts";
import type { FakeSqlExecutor, SqlCall } from "./fake-sql-executor.ts";

// トランザクションの開始・確定・巻き戻しの決まりを、トランザクションを使う手続きごとに同じ形で確かめる。
// - 開始は管理のデータベースで打ち、中の文はどれもその transactionId と管理のデータベースで打つ。外の文は transactionId を持たない
// - 開始と確定は入れ子にならず、1 つ確定してから次を開始する。うまくいけば巻き戻しを打たない
// - 開始が投げたら、その失敗をそのまま投げ、その先を何も打たない
// - 中の文が投げたら、そのトランザクションを巻き戻して元の失敗を投げ、確定もその先の文も打たない。巻き戻しが投げても元の失敗を投げる
// - 確定が投げたら、その失敗をそのまま投げ、巻き戻しもその先の文も打たない
export function itKeepsTransactionBoundary(
  run: (fake: FakeSqlExecutor) => Promise<unknown>,
  make: () => FakeSqlExecutor,
  transactions: number,
): void {
  const txs = Array.from({ length: transactions }, (_, i) => `tx-${i + 1}`);

  it(`トランザクション: 管理のデータベースで ${transactions} 回を順に開始・確定し、中の文はその ID で打つ`, async () => {
    const fake = make();
    await run(fake);
    const begins = fake.calls.filter((c) => c.kind === "begin");
    expect(begins).toEqual(txs.map(() => ({ kind: "begin", database: ADMIN_DATABASE })));
    expect(fake.calls.filter((c) => c.kind === "commit")).toEqual(txs.map((t) => ({ kind: "commit", transactionId: t })));
    expect(fake.calls.some((c) => c.kind === "rollback")).toBe(false);
    let open: string | undefined;
    let n = 0;
    for (const c of fake.calls) {
      if (c.kind === "begin") {
        expect(open).toBeUndefined();
        n += 1;
        open = `tx-${n}`;
      } else if (c.kind === "commit") {
        expect(c.transactionId).toBe(open);
        open = undefined;
      } else if (c.kind === "execute") {
        expect(c.transactionId).toBe(open);
        if (open !== undefined) expect(c.database).toBe(ADMIN_DATABASE);
      }
    }
    expect(open).toBeUndefined();
  });

  for (const [i, tx] of txs.entries()) {
    const label = transactions > 1 ? `${i + 1} 回目の` : "";

    it(`トランザクション: ${label}開始が投げたら、その失敗を投げてその先を打たない`, async () => {
      const fake = make();
      const failure = new Error("begin failed");
      let seen = 0;
      fake.failOn = (c) => (c.kind === "begin" && ++seen === i + 1 ? failure : undefined);
      await expect(run(fake)).rejects.toBe(failure);
      expect(fake.calls.at(-1)).toEqual({ kind: "begin", database: ADMIN_DATABASE });
      expect(fake.calls.filter((c) => c.kind === "commit")).toHaveLength(i);
      expect(fake.calls.some((c) => c.kind === "rollback")).toBe(false);
    });

    for (const rollbackFails of [false, true]) {
      it(`トランザクション: ${label}中の文が投げたら巻き戻して元の失敗を投げ、確定しない${rollbackFails ? "（巻き戻しも投げる）" : ""}`, async () => {
        const fake = make();
        const failure = new Error("boom");
        fake.failOn = (c) => {
          if (c.kind === "execute" && c.transactionId === tx) return failure;
          if (rollbackFails && c.kind === "rollback") return new Error("rollback failed");
          return undefined;
        };
        await expect(run(fake)).rejects.toBe(failure);
        const failed = fake.calls.findIndex((c) => c.kind === "execute" && c.transactionId === tx);
        expect(failed).toBeGreaterThan(0);
        // 失敗の後は、そのトランザクションの巻き戻しだけ
        expect(fake.calls.slice(failed + 1)).toEqual<SqlCall[]>([{ kind: "rollback", transactionId: tx }]);
        expect(fake.calls.filter((c) => c.kind === "commit")).toHaveLength(i);
      });
    }

    it(`トランザクション: ${label}確定が投げたら、その失敗を投げて巻き戻さず、その先を打たない`, async () => {
      const fake = make();
      const failure = new Error("commit lost");
      fake.failOn = (c) => (c.kind === "commit" && c.transactionId === tx ? failure : undefined);
      await expect(run(fake)).rejects.toBe(failure);
      expect(fake.calls.at(-1)).toEqual({ kind: "commit", transactionId: tx });
      expect(fake.calls.some((c) => c.kind === "rollback")).toBe(false);
      expect(fake.calls.filter((c) => c.kind === "begin")).toHaveLength(i + 1);
    });
  }
}
