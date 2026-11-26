import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthzRecord } from "../src/offline/authz.ts";
import type { HeldItem, HeldStore } from "../src/offline/held-store.ts";
import { HeldListDialog, type HeldListProps } from "../src/screens/held-list.tsx";
import { buttonNamed, click, render, unmountAll } from "./support/render.tsx";

// 保留の一覧。件の中身は見られる対象にだけ出し、破棄は確認のダイアログで確定したときだけ行う

afterEach(unmountAll);

const settle = () => act(async () => {});

const item = (over: Partial<HeldItem> = {}): HeldItem => ({
  answerTag: "tag-1",
  holdReason: "rejected",
  kind: "confirm",
  body: {
    operation: "approvals.answer",
    targetId: "apr_example",
    projectId: "prj_example",
    input: { comment: "作り物のコメント" },
    idempotencyKey: "key",
    pressedAt: Date.parse("2026-01-02T03:04:00.000Z"),
    pressedFloor: null,
    seq: 1,
    sendStarted: true,
    sentAt: null,
  },
  ...over,
});

const ALLOWED: AuthzRecord = {
  generation: 1,
  allowedProjectIds: ["prj_example"],
  listedSeq: 1,
  mismatchProjectIds: [],
  mismatchSeq: null,
  denied: [],
};

function setup(items: HeldItem[], over: Partial<HeldListProps> = {}) {
  let rows = items;
  const store: HeldStore = {
    count: async () => rows.length,
    list: async () => rows,
    discard: vi.fn(async (tag: string) => void (rows = rows.filter((r) => r.answerTag !== tag))),
  };
  const props = {
    store,
    quarantined: null,
    open: true,
    record: async () => ALLOWED,
    onClose: vi.fn(),
    onChanged: vi.fn(),
    onStale: vi.fn(),
    ...over,
  };
  const view = render(<HeldListDialog {...props} />);
  return { ...view, props, store };
}

const dialog = (host: HTMLElement) => host.querySelector('[role="dialog"][aria-modal="true"]') as HTMLElement | null;

describe("HeldListDialog", () => {
  it("理由・操作の種類・押した時刻と、見られる対象の入力した文を出す", async () => {
    const { host } = setup([item()]);
    await settle();
    expect(host.textContent).toContain("サーバーが受け付けませんでした");
    expect(host.textContent).toContain("承認の依頼に答える");
    expect(host.querySelector("time")).not.toBeNull();
    expect(host.textContent).toContain("作り物のコメント");
  });

  it("見る権限を確かめられない件は、入力した文を出さずに理由を出す", async () => {
    const { host } = setup([item()], { record: async () => null });
    await settle();
    expect(host.textContent).not.toContain("作り物のコメント");
    expect(host.textContent).not.toContain("apr_example");
    expect(host.textContent).toContain("内容は表示しません");
  });

  it("復号できない件は「内容を読めません」と区分を出す", async () => {
    const { host } = setup([item({ body: null, holdReason: "unreadable" })]);
    await settle();
    expect(host.textContent).toContain("内容を読めません");
    expect(host.textContent).toContain("確定待ち");
  });

  it("確認のダイアログを閉じただけでは残り、確定すると消える", async () => {
    const { host, props, store } = setup([item()]);
    await settle();
    click(buttonNamed(host, "破棄する"));
    expect(dialog(host)?.textContent).toContain("破棄すると元に戻せません");
    click(buttonNamed(dialog(host)!, "やめる"));
    expect(store.discard).not.toHaveBeenCalled();

    click(buttonNamed(host, "破棄する"));
    click(buttonNamed(dialog(host)!, "破棄する"));
    await settle();
    expect(store.discard).toHaveBeenCalledWith("tag-1");
    expect(props.onChanged).toHaveBeenCalled();
    expect(host.textContent).not.toContain("作り物のコメント");
  });

  it("破棄に失敗したらエラーを出し、件は残る", async () => {
    const { host, store } = setup([item()]);
    await settle();
    vi.mocked(store.discard).mockRejectedValueOnce(new Error("abort"));
    click(buttonNamed(host, "破棄する"));
    click(buttonNamed(dialog(host)!, "破棄する"));
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("破棄できませんでした");
    expect(host.textContent).toContain("作り物のコメント");
  });

  it("隔離の読めない件は、隔離の破棄へ渡す。stale なら閉じて起動の照合からやり直す", async () => {
    const discard = vi.fn(async () => "stale" as const);
    const { host, props } = setup([], { quarantined: { items: [{ answerTag: "q-1", kind: "queued" }], discard } });
    await settle();
    expect(host.textContent).toContain("内容を読めません");
    expect(host.textContent).toContain("キャッシュして送る");
    click(buttonNamed(host, "破棄する"));
    click(buttonNamed(dialog(host)!, "破棄する"));
    await settle();
    expect(discard).toHaveBeenCalledWith("q-1");
    expect(props.onClose).toHaveBeenCalled();
    expect(props.onStale).toHaveBeenCalled();
  });

  it("閉じていれば何も出さず、閉じるボタンで onClose を呼ぶ", async () => {
    expect(setup([item()], { open: false }).host.textContent).toBe("");
    const { host, props } = setup([item()]);
    await settle();
    click(buttonNamed(host, "閉じる"));
    expect(props.onClose).toHaveBeenCalled();
  });
});
