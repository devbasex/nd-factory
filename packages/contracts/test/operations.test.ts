import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isPending, type OperationDef } from "../src/operation.ts";
import { indexOperations, OPERATIONS, operationByName, operationByRoute } from "../src/operations/index.ts";

// 操作の表を docs/design/api.md の操作の一覧と照らす。一覧の写しをテストに持たず、文書の表を読む

const API_MD = readFileSync(new URL("../../../docs/design/api.md", import.meta.url), "utf8");

function section(start: string, end: string): string[] {
  const from = API_MD.indexOf(start);
  const to = API_MD.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`api.md の区切りが見つからない: ${start}`);
  return API_MD.slice(from, to).split("\n");
}

function cells(line: string): string[] {
  return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function backticks(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
}

type UserRow = {
  name: string;
  route: string;
  features: string[];
  humanOnly: OperationDef["humanOnly"];
  mcpRead: string | null;
  access: OperationDef["access"];
  delegationKind: OperationDef["delegationKind"];
  allOrNothing: boolean;
};

const USER_ROWS: UserRow[] = section("### 利用者向けの操作", "### 人だけにした理由")
  .filter((l) => l.startsWith("| `"))
  .map((l) => {
    const [name, route, features, mcp, human, rw] = cells(l);
    const mcpRead = /^依頼と材料の読み出しだけ（`([^`]+)`）/.exec(mcp ?? "")?.[1] ?? null;
    const kind = /^(?:読む|書く)（(read|run|manage)/.exec(rw ?? "")?.[1] ?? null;
    return {
      name: backticks(name ?? "")[0] ?? "",
      route: backticks(route ?? "")[0] ?? "",
      features: (features ?? "").split("・"),
      humanOnly: human === "人だけ" ? "always" : human === "—" ? "never" : "per_item",
      mcpRead,
      access: (rw ?? "").startsWith("読む") ? "read" : "write",
      delegationKind: kind as OperationDef["delegationKind"],
      allOrNothing: (rw ?? "").includes("全部か無か"),
    };
  });

const SELF_ROUTES: string[] = section("### ランナー・手元のマシン・DB の用意のタスクの HTTP の経路", "### 入出力の変わり目")
  .filter((l) => l.startsWith("| `/v1/"))
  .map((l) => backticks(cells(l)[0] ?? "")[0] ?? "");

// 受け持つ子の表: エンティティ（`x.*`）・名前（`x.y`）・自分向けの受け口の語から子の番号を引く
const OWNER_ROWS = section("形の正本へ書くのは次の子の課題である。", "表の列の読み方")
  .filter((l) => l.startsWith("| ") && !l.startsWith("| 操作と") && !l.startsWith("| ---"))
  .map((l) => {
    const [ops, owner] = cells(l);
    const endpoints = [
      ...(ops?.includes("ランナー向け") ? ["runner"] : []),
      ...(ops?.includes("手元のマシン向け") ? ["machine"] : []),
      ...(ops?.includes("DB の用意のタスク向け") ? ["db_prep"] : []),
    ];
    return { refs: backticks(ops ?? ""), endpoints, owner: owner ?? "" };
  });

function expectedOwner(op: OperationDef): string | undefined {
  const row = OWNER_ROWS.find((r) =>
    op.endpoint === "user" ? r.refs.some((ref) => ref === op.name || ref === `${op.entity}.*`) : r.endpoints.includes(op.endpoint),
  );
  return row?.owner;
}

const IDEMPOTENT_NAMED = backticks(section("### 冪等の鍵", "### ページ送り").find((l) => l.startsWith("| どこに置くか")) ?? "").filter(
  (n) => n !== "idempotency_key",
);

const userOps = OPERATIONS.filter((op) => op.endpoint === "user");
const selfOps = OPERATIONS.filter((op) => op.endpoint !== "user");

describe("OPERATIONS", () => {
  it("利用者向けの 67 と自分向けの 9 を登録する", () => {
    expect(USER_ROWS).toHaveLength(67);
    expect(SELF_ROUTES).toHaveLength(9);
    expect(userOps).toHaveLength(67);
    expect(selfOps).toHaveLength(9);
    expect(OPERATIONS).toHaveLength(76);
  });

  it("全体の設計の一覧の順に、利用者向け・自分向けの順で並ぶ", () => {
    expect(OPERATIONS.map((op) => op.route)).toEqual([...USER_ROWS.map((r) => r.route), ...SELF_ROUTES]);
  });

  it("利用者向けの操作の印が一覧の表と一致する", () => {
    const actual = userOps.map((op) => ({
      name: op.name,
      route: op.route,
      features: [...op.features],
      humanOnly: op.humanOnly,
      mcpRead: op.mcpRead,
      access: op.access,
      delegationKind: op.delegationKind,
      allOrNothing: op.allOrNothing !== null,
    }));
    expect(actual).toEqual(USER_ROWS);
  });

  it("自分向けの経路は受け口が頭の名前を持ち、機能と委任の種類を持たない", () => {
    for (const op of selfOps) {
      expect(op.route).toBe(`/v1/${op.name.replaceAll(".", "/")}`);
      expect(op.name.startsWith(`${op.endpoint}.`)).toBe(true);
      expect(op.features).toEqual([]);
      expect(op.delegationKind).toBeNull();
      expect(op.humanOnly).toBe("never");
      expect(op.ownerOnly).toBe(false);
    }
    // 自分向けの経路の読み書きは動詞で決めない。答えの受け取りは送達の状態を記す書き込み
    expect(selfOps.filter((op) => op.access !== "write").map((op) => op.name)).toEqual([]);
    expect(operationByName("runner.answers.list")?.access).toBe("write");
    expect(new Set(selfOps.map((op) => op.endpoint))).toEqual(new Set(["runner", "machine", "db_prep"]));
  });

  it("名前と経路が重ならない", () => {
    expect(new Set(OPERATIONS.map((op) => op.name)).size).toBe(OPERATIONS.length);
    expect(new Set(OPERATIONS.map((op) => op.route)).size).toBe(OPERATIONS.length);
  });

  it("F1〜F20 のどれもが操作の表の機能にある", () => {
    const features = new Set(OPERATIONS.flatMap((op) => op.features));
    for (let n = 1; n <= 20; n++) expect(features.has(`F${n}`)).toBe(true);
    expect([...features].every((f) => /^F([1-9]|1\d|20)$/.test(f))).toBe(true);
  });

  it("読み出しの道具は表にある、人だけでない読む操作を指す", () => {
    for (const op of OPERATIONS.filter((o) => o.mcpRead !== null)) {
      const read = operationByName(op.mcpRead ?? "");
      expect(read?.access).toBe("read");
      expect(read?.humanOnly).toBe("never");
    }
  });

  it("受け持つ子が操作の一覧の受け持つ子の表と一致する", () => {
    for (const op of OPERATIONS) expect([op.name, op.owner]).toEqual([op.name, expectedOwner(op)]);
  });

  it("要素と結果の形は受け持つ子の形の未定", () => {
    for (const op of OPERATIONS) {
      expect(isPending(op.item) && op.item.owner).toBe(op.owner);
      expect(isPending(op.result) && op.result.owner).toBe(op.owner);
    }
  });

  it("全部か無かは projects.create（19）と repositories.add（24）だけ", () => {
    const marked = OPERATIONS.filter((op) => op.allOrNothing !== null).map((op) => [op.name, op.allOrNothing?.maxItems]);
    expect(marked).toEqual([
      ["projects.create", 19],
      ["repositories.add", 24],
    ]);
  });

  it("冪等の鍵の決まりが名を挙げる操作は冪等の鍵を持ち、新しいものを作る操作も持つ", () => {
    expect(IDEMPOTENT_NAMED.length).toBeGreaterThan(0);
    for (const name of IDEMPOTENT_NAMED) expect([name, operationByName(name)?.idempotencyKey]).toEqual([name, true]);
    for (const op of userOps.filter((o) => o.verb === "create" || o.verb === "add")) expect([op.name, op.idempotencyKey]).toEqual([op.name, true]);
    // 招待を受けると新しい席を作るため、create・add でなくても鍵を持つ
    expect(operationByName("invitations.accept")?.idempotencyKey).toBe(true);
    for (const op of OPERATIONS.filter((o) => o.access === "read")) expect(op.idempotencyKey).toBe(false);
  });

  it("持ち主だけの操作は席の役割ごとの操作の持ち主だけの組の書き込み", () => {
    const ownerOnly = OPERATIONS.filter((op) => op.ownerOnly).map((op) => op.name);
    expect(ownerOnly).toEqual([
      "teams.update",
      "seats.update",
      "seats.delete",
      "invitations.create",
      "invitations.delete",
      "projects.create",
      "projects.update",
      "repositories.add",
      "repositories.remove",
      "project_transfers.create",
      "project_transfers.accept",
      "project_transfers.delete",
      "projects.close",
      "execution_settings.update",
      "model_keys.create",
      "model_keys.delete",
      "machines.create",
      "machines.delete",
      "spend_caps.update",
    ]);
    expect(OPERATIONS.filter((op) => op.ownerOnly).every((op) => op.access === "write")).toBe(true);
  });
});

describe("operationByName・operationByRoute", () => {
  it("名前と経路で同じ定義を引く", () => {
    for (const op of OPERATIONS) {
      expect(operationByName(op.name)).toBe(op);
      expect(operationByRoute(op.route)).toBe(op);
    }
    expect(operationByRoute("/v1/runner/events/create")?.name).toBe("runner.events.create");
  });

  it("表に無い名前と経路は undefined", () => {
    expect(operationByName("sprints.delete")).toBeUndefined();
    expect(operationByRoute("/v1/users")).toBeUndefined();
    expect(operationByRoute("/v1/sprints/get/")).toBeUndefined();
  });
});

describe("indexOperations", () => {
  const [first, second] = OPERATIONS;

  it("名前の重なりで投げる", () => {
    expect(() => indexOperations([first, { ...second, name: first.name }])).toThrow(/名前/);
  });

  it("経路の重なりで投げる", () => {
    expect(() => indexOperations([first, { ...second, route: first.route }])).toThrow(/経路/);
  });
});
