import type { Settings } from "@nd-factory/contracts/settings";
import { describe, expect, it } from "vitest";
import type { OrganizationManager, Target } from "../setup/aws-reader.ts";
import {
  MISSING_CHECKS,
  type MissingCheck,
  type MissingContext,
  type MissingItem,
  collectMissingSettings,
  printMissingSettings,
} from "../setup/missing-settings.ts";

const TARGET: Target = { profile: "acme-test", account: "123456789012", region: "us-west-2" };
const MANAGER = "123456789012";

// どの照らしにも当たらない設定
const COMPLETE: Settings = {
  prefix: "acme",
  environment: "test",
  login: { google: { client_id: "example-client-id" } },
  ops: { notify_emails: ["ops@example.com"] },
};

type CtxOptions = {
  settings?: Settings;
  tags?: Record<string, "Active" | "Inactive" | "Missing"> | "throw";
  org?: OrganizationManager;
  azs?: number | "throw";
};

function ctx(o: CtxOptions = {}): MissingContext & { orgReads: number } {
  const c = {
    settings: o.settings ?? COMPLETE,
    target: TARGET,
    orgReads: 0,
    async readCostAllocationTags(_target: Target, keys: string[]) {
      if (o.tags === "throw") throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
      return o.tags ?? Object.fromEntries(keys.map((k) => [k, "Active" as const]));
    },
    async readOrganizationManager() {
      c.orgReads += 1;
      return o.org ?? { member: false, managementAccount: null };
    },
    async readGetAzsCount() {
      if (o.azs === "throw") throw Object.assign(new Error("denied"), { name: "UnauthorizedOperation" });
      return o.azs ?? 3;
    },
  };
  return c;
}

async function collect(o: CtxOptions = {}): Promise<MissingItem[]> {
  return collectMissingSettings(ctx(o), MISSING_CHECKS);
}

function only(items: MissingItem[], key: string): string {
  const rows = items.filter((i) => i.key === key);
  expect(rows).toHaveLength(1);
  return rows[0]!.text;
}

const INACTIVE = { "app-prefix": "Inactive", "app-env": "Active" } as const;
const MEMBER: OrganizationManager = { member: true, managementAccount: MANAGER };

describe("collectMissingSettings", () => {
  it("どれにも当たらなければ 0 件", async () => {
    expect(await collect()).toEqual([]);
  });

  it("Google のクライアントの ID が無ければ 1 行", async () => {
    const items = await collect({ settings: { ...COMPLETE, login: { google: {} } } });
    expect(items).toHaveLength(1);
    expect(only(items, "google_client_id")).toContain("Google のクライアントの ID が無い");
  });

  it("運用の知らせの宛先が無い・空なら 1 行", async () => {
    for (const ops of [undefined, { notify_emails: [] }]) {
      const items = await collect({ settings: { ...COMPLETE, ops } });
      expect(items).toHaveLength(1);
      expect(only(items, "ops_notify_emails")).toContain("ops.notify_emails");
    }
  });

  describe("コスト配分タグが有効でない", () => {
    it("有効でないタグだけを挙げ、0 を数え続けることと budget.scope の代わりを含む", async () => {
      const items = await collect({ tags: INACTIVE });
      expect(items).toHaveLength(1);
      const text = only(items, "cost_allocation_tags");
      expect(text).toMatch(/^コスト配分タグ app-prefix が有効でない。/);
      expect(text).toContain("有効になるまで予算は 0 を数え続け、予算の知らせは鳴らない");
      expect(text).toContain("有効にできなければ設定のファイルの budget.scope を account にする（アカウントの全体を数える）");
    });

    it("一覧に無いタグ（Missing）も有効でないと数える", async () => {
      const text = only(await collect({ tags: { "app-prefix": "Missing", "app-env": "Missing" } }), "cost_allocation_tags");
      expect(text).toMatch(/^コスト配分タグ app-prefix・app-env が有効でない。/);
    });

    it.each([
      ["組織に入っていない", { member: false, managementAccount: null }, "有効にする先: このアカウント（請求の画面のコスト配分タグ）。"],
      [
        "組織のメンバー",
        MEMBER,
        `有効にする先: 組織の管理のアカウント ${MANAGER}（メンバーのアカウントでは有効にできない）。`,
      ],
      [
        "組織を読めない",
        "unknown",
        "有効にする先: 組織に入っていなければこのアカウント、組織のメンバーなら組織の管理のアカウント。",
      ],
    ] as const)("%s なら有効にする先が変わる", async (_name, org, expected) => {
      expect(only(await collect({ tags: INACTIVE, org }), "cost_allocation_tags")).toContain(expected);
    });

    it("タグがすべて有効なら組織を読まない", async () => {
      const c = ctx();
      expect(await collectMissingSettings(c, MISSING_CHECKS)).toEqual([]);
      expect(c.orgReads).toBe(0);
    });
  });

  describe("コスト配分タグを読めない", () => {
    const head = "コスト配分タグ app-prefix・app-env が有効かを確かめられない。有効でなければ予算は 0 を数え続け、予算の知らせは鳴らない。次の操作: ";

    it("組織に入っていなければ、権限を足した profile での打ち直し", async () => {
      const text = only(await collect({ tags: "throw", org: { member: false, managementAccount: null } }), "cost_allocation_tags");
      expect(text).toBe(`${head}ce:ListCostAllocationTags を許した profile で diff を打ち直す`);
      expect(text).not.toContain("budget.scope");
    });

    it("組織のメンバーなら、管理のアカウントへの依頼と budget.scope の account", async () => {
      const text = only(await collect({ tags: "throw", org: MEMBER }), "cost_allocation_tags");
      expect(text).toBe(
        `${head}組織の管理のアカウント ${MANAGER} にタグの有効化を確かめて頼む（メンバーのアカウントでは権限を足しても有効にできない）。頼めなければ設定のファイルの budget.scope を account にする`,
      );
    });

    it("組織を読めなければ両方を示し、管理のアカウントの ID を出さない", async () => {
      const text = only(await collect({ tags: "throw", org: "unknown" }), "cost_allocation_tags");
      expect(text).toBe(
        `${head}組織に入っていなければ ce:ListCostAllocationTags を許した profile で diff を打ち直す。組織のメンバーなら組織の管理のアカウントにタグの有効化を確かめて頼む（メンバーのアカウントでは権限を足しても有効にできない）。頼めなければ設定のファイルの budget.scope を account にする`,
      );
    });
  });

  it("budget.scope が account ならタグを読まず、タグの行を出さない", async () => {
    let reads = 0;
    const c = ctx({ settings: { ...COMPLETE, budget: { scope: "account" } }, tags: "throw" });
    c.readCostAllocationTags = async () => {
      reads += 1;
      throw new Error("読まない");
    };
    expect(await collectMissingSettings(c, MISSING_CHECKS)).toEqual([]);
    expect(reads).toBe(0);
  });

  it("AZ の数 2 では行が出ず、1 では出る", async () => {
    expect(await collect({ azs: 2 })).toEqual([]);
    const text = only(await collect({ azs: 1 }), "get_azs");
    expect(text).toBe(
      "Fn::GetAZs が返す AZ が 1 つで、反映がネットワークを作れずに止まる。既定の VPC の別の AZ に既定のサブネットを作る（aws ec2 create-default-subnet --availability-zone <AZ>）か、既定のサブネットをすべて消す",
    );
  });

  it("AZ の数を読めなければ、要る許しを示す", async () => {
    expect(only(await collect({ azs: "throw" }), "get_azs")).toBe(
      "Fn::GetAZs が返す AZ の数を確かめられない（ec2:DescribeSubnets・ec2:DescribeAvailabilityZones を許した profile で読む）",
    );
  });

  it("4 種類が当たれば、照らしの順に 1 種類 1 行", async () => {
    const items = await collect({
      settings: { prefix: "acme", environment: "test", login: { google: {} } },
      tags: INACTIVE,
      azs: 1,
    });
    expect(items.map((i) => i.key)).toEqual(["google_client_id", "cost_allocation_tags", "ops_notify_emails", "get_azs"]);
  });

  it("照らしが投げると、その照らしを確かめられないの 1 行にして続ける", async () => {
    const broken: MissingCheck = async function brokenCheck() {
      throw new TypeError("壊れた");
    };
    const after: MissingCheck = async () => [{ key: "after", text: "後の照らし" }];
    const items = await collectMissingSettings(ctx(), [broken, after]);
    expect(items).toEqual([
      { key: "check_failed", text: "brokenCheck を確かめられない（TypeError: 壊れた）" },
      { key: "after", text: "後の照らし" },
    ]);
  });

  it("組織の読みが投げても、タグの照らしは確かめられないの 1 行になる", async () => {
    const c = ctx({ tags: INACTIVE });
    c.readOrganizationManager = async () => {
      throw new Error("壊れた");
    };
    const items = await collectMissingSettings(c, MISSING_CHECKS);
    expect(items).toEqual([{ key: "check_failed", text: "checkCostAllocationTags を確かめられない（Error: 壊れた）" }]);
  });
});

describe("printMissingSettings", () => {
  it("0 件なら「足りない設定: 無し」の 1 行", () => {
    const out: string[] = [];
    printMissingSettings([], (l) => out.push(l));
    expect(out).toEqual(["足りない設定: 無し"]);
  });

  it("見出しと 1 件 1 行", () => {
    const out: string[] = [];
    printMissingSettings(
      [
        { key: "a", text: "一つ目" },
        { key: "b", text: "二つ目" },
      ],
      (l) => out.push(l),
    );
    expect(out).toEqual(["足りない設定:", "  - 一つ目", "  - 二つ目"]);
  });
});
