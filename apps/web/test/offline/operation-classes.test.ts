// @vitest-environment node
import { OPERATIONS } from "@nd-factory/contracts/operations";
import { describe, expect, it } from "vitest";
import { OPERATION_CLASSES, operationClassOf } from "../../src/offline/operation-classes.ts";

const writes = OPERATIONS.filter((o) => o.access === "write" && o.endpoint === "user");

describe("操作の区分の表", () => {
  it("利用者の書き込みの全操作が表にあり、表の名前はすべて操作の表にある", () => {
    expect(Object.keys(OPERATION_CLASSES).sort()).toEqual(writes.map((o) => o.name).sort());
  });

  it("確定待ちは照合の値を持ち、冪等キーを受けないのは 3 つ", () => {
    expect(operationClassOf("approvals.answer")).toEqual({ class: "confirm", check: ["version", "material_digest"] });
    const keyless = writes.filter((o) => operationClassOf(o.name).class === "confirm" && !o.idempotencyKey);
    expect(keyless.map((o) => o.name).sort()).toEqual(["project_transfers.accept", "project_transfers.delete", "projects.close"]);
  });

  it("冪等キーを受けないキャッシュして送るは、送り直してよい種類", () => {
    for (const op of writes) {
      const found = operationClassOf(op.name);
      if (found.class === "queued") expect(found.resendableWithoutKey, op.name).toBe(!op.idempotencyKey);
    }
  });

  it("表に無い操作は、つながってから押す", () => {
    expect(operationClassOf("example.unknown")).toEqual({ class: "online" });
    expect(operationClassOf("toString")).toEqual({ class: "online" });
  });
});
