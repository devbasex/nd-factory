import { type Settings, infraValues } from "@nd-factory/contracts/settings";
import { TAG_KEYS } from "../lib/naming.ts";
import type { CostAllocationTagStatus, OrganizationManager, Target } from "./aws-reader.ts";

// diff の出力の最後に出す、足りない設定の一覧。足りない設定があっても反映はでき、終了コードは変えない。
// 照らしは関数の配列で持ち、ほかの課題は MISSING_CHECKS へ照らしを足すだけにする。AWS は読むだけで書かない

export type MissingContext = {
  settings: Settings;
  target: Target;
  readCostAllocationTags: (target: Target, keys: string[]) => Promise<Record<string, CostAllocationTagStatus>>;
  readOrganizationManager: (target: Target) => Promise<OrganizationManager>;
  readGetAzsCount: (target: Target) => Promise<number>;
};

// key は照らしの種類（テストと後の課題が行を見分ける）。text は利用者へ出す 1 行
export type MissingItem = { key: string; text: string };

// label は利用者へ出す照らしの名前（照らしが投げたときの「<label> を確かめられない」の行に使う）
export type MissingCheck = { label: string; run: (ctx: MissingContext) => Promise<MissingItem[]> };

const IDP_DOC = "docs/operations/idp-and-apps.md";

export async function checkGoogleClientId(ctx: MissingContext): Promise<MissingItem[]> {
  if (ctx.settings.login.google.client_id) return [];
  return [
    {
      key: "google_client_id",
      text: `Google のクライアントの ID が無い。画面はログインの設定を待つ。${IDP_DOC} の順でクライアントを作り、設定のファイルの login.google.client_id に書いて diff と deploy を打ち直す`,
    },
  ];
}

// タグを有効にする先。組織のメンバーのアカウントでは有効にできないため、組織の管理のアカウントを示す
function activationTarget(org: OrganizationManager): string {
  if (org === "unknown") return "組織に入っていなければこのアカウント、組織のメンバーなら組織の管理のアカウント";
  if (!org.member) return "このアカウント（請求の画面のコスト配分タグ）";
  return `${managerName(org.managementAccount)}（メンバーのアカウントでは有効にできない）`;
}

function managerName(id: string | null): string {
  return id ? `組織の管理のアカウント ${id}` : "組織の管理のアカウント";
}

const RETRY_WITH_PERMISSION = "ce:ListCostAllocationTags を許した profile で diff を打ち直す";

function askManager(id: string | null): string {
  const who = id ? `組織の管理のアカウント ${id} に` : "組織の管理のアカウントに";
  return `${who}タグの有効化を確かめて頼む（メンバーのアカウントでは権限を足しても有効にできない）。頼めなければ設定のファイルの budget.scope を account にする`;
}

// タグを読めないときの次の操作。権限の不足と組織の制限は SDK の例外では分けられないため、組織の読みで分ける
function unreadableAction(org: OrganizationManager): string {
  if (org === "unknown") {
    return `組織に入っていなければ ${RETRY_WITH_PERMISSION}。組織のメンバーなら${askManager(null)}`;
  }
  if (!org.member) return RETRY_WITH_PERMISSION;
  return askManager(org.managementAccount);
}

export async function checkCostAllocationTags(ctx: MissingContext): Promise<MissingItem[]> {
  if (infraValues(ctx.settings).budgetScope !== "tags") return [];
  const keys = [...TAG_KEYS];
  let statuses: Record<string, CostAllocationTagStatus>;
  try {
    statuses = await ctx.readCostAllocationTags(ctx.target, keys);
  } catch {
    const org = await ctx.readOrganizationManager(ctx.target);
    return [
      {
        key: "cost_allocation_tags",
        text: `コスト配分タグ ${keys.join("・")} が有効かを確かめられない。有効でなければ予算は 0 を数え続け、予算の知らせは鳴らない。次の操作: ${unreadableAction(org)}`,
      },
    ];
  }
  const notActive = keys.filter((k) => statuses[k] !== "Active");
  if (notActive.length === 0) return [];
  // Missing は請求の画面のコスト配分タグの一覧にキーが無いことだけを示す。タグの付いた資源がまだ無いときのほか、
  // 資源はあるが一覧への反映を待っているとき（資源ができてから最大 24 時間）も Missing になるため、両方の次の操作を示す
  const missing = notActive.filter((k) => statuses[k] === "Missing");
  const wait =
    missing.length > 0
      ? `${missing.join("・")} は請求の画面のコスト配分タグの一覧にまだ出ていないため、まだ有効にできない。タグの付いた資源がまだ無ければ deploy で作り、すでにあれば一覧への反映を待つ（資源ができてから最大 24 時間）。一覧にキーが出てから有効にする。`
      : "";
  const org = await ctx.readOrganizationManager(ctx.target);
  return [
    {
      key: "cost_allocation_tags",
      text: `コスト配分タグ ${notActive.join("・")} が有効でない。有効になるまで予算は 0 を数え続け、予算の知らせは鳴らない。${wait}有効にする先: ${activationTarget(org)}。有効にできなければ設定のファイルの budget.scope を account にする（アカウントの全体を数える）`,
    },
  ];
}

export async function checkOpsNotifyEmails(ctx: MissingContext): Promise<MissingItem[]> {
  if (infraValues(ctx.settings).opsEmails.length > 0) return [];
  return [
    {
      key: "ops_notify_emails",
      text: "運用の知らせの宛先が空。予算と運用の知らせがどこにも届かない。設定のファイルの ops.notify_emails に宛先のメールを書く",
    },
  ];
}

// AZ は Fn::GetAZs から 2 つ選ぶため、返す AZ が 2 つ未満だと反映がネットワークを作れずに止まる
export const MIN_GET_AZS = 2;

// 値をシェルの 1 つの引数にする。安全な文字だけならそのまま、ほかは単一引用符で囲み、中の ' は '\'' にする
export function shellArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function checkGetAzs(ctx: MissingContext): Promise<MissingItem[]> {
  let count: number;
  try {
    count = await ctx.readGetAzsCount(ctx.target);
  } catch {
    return [
      {
        key: "get_azs",
        text: "Fn::GetAZs が返す AZ の数を確かめられない（ec2:DescribeSubnets・ec2:DescribeAvailabilityZones を許した profile で読む）",
      },
    ];
  }
  if (count >= MIN_GET_AZS) return [];
  return [
    {
      key: "get_azs",
      text: `Fn::GetAZs が返す AZ が ${count} つで、反映がネットワークを作れずに止まる。既定の VPC の別の AZ に既定のサブネットを作る（aws ec2 create-default-subnet --profile=${shellArg(ctx.target.profile)} --region=${shellArg(ctx.target.region)} --availability-zone <AZ>）か、既定のサブネットをすべて消す`,
    },
  ];
}

export const MISSING_CHECKS: readonly MissingCheck[] = [
  { label: "Google のクライアントの ID", run: checkGoogleClientId },
  { label: "コスト配分タグ", run: checkCostAllocationTags },
  { label: "運用の知らせの宛先", run: checkOpsNotifyEmails },
  { label: "Fn::GetAZs が返す AZ の数", run: checkGetAzs },
];

function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

// 照らしを順に打つ。1 つの照らしが投げても、ほかの照らしは続け、その照らしを「確かめられない」の 1 行にする
export async function collectMissingSettings(ctx: MissingContext, checks: readonly MissingCheck[]): Promise<MissingItem[]> {
  const items: MissingItem[] = [];
  for (const check of checks) {
    try {
      items.push(...(await check.run(ctx)));
    } catch (e) {
      items.push({
        key: "check_failed",
        text: `${check.label} を確かめられない（${errorText(e)}）。括弧の中の例外で原因を確かめる。AWS の読みの失敗なら profile の認証と通信を直し、権限が足りなければ docs/operations/setup.md の「足りない設定」の許しを足して diff を打ち直す`,
      });
    }
  }
  return items;
}

export function printMissingSettings(items: MissingItem[], out: (line: string) => void): void {
  if (items.length === 0) {
    out("足りない設定: 無し");
    return;
  }
  out("足りない設定:");
  for (const item of items) out(`  - ${item.text}`);
}
