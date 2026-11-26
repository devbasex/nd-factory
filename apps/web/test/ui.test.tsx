import { readdirSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionResult } from "../src/ui/action-result.tsx";
import { AppFrame } from "../src/ui/app-frame.tsx";
import { Button } from "../src/ui/button.tsx";
import { CATALOG } from "../src/ui/catalog.ts";
import { Collapsible } from "../src/ui/collapsible.tsx";
import { ConfirmDialog } from "../src/ui/confirm-dialog.tsx";
import { DataList } from "../src/ui/data-list.tsx";
import { DetailList } from "../src/ui/detail-list.tsx";
import { DocumentBody } from "../src/ui/document-body.tsx";
import { EmptyState } from "../src/ui/empty-state.tsx";
import { ErrorNotice } from "../src/ui/error-notice.tsx";
import { Loading } from "../src/ui/loading.tsx";
import { MoneyText } from "../src/ui/money-text.tsx";
import { OfflineBanner } from "../src/ui/offline-banner.tsx";
import { PendingBadge } from "../src/ui/pending-badge.tsx";
import { SelectField } from "../src/ui/select-field.tsx";
import { StatusBadge, TONES } from "../src/ui/status-badge.tsx";
import { TextField } from "../src/ui/text-field.tsx";
import { TimeText } from "../src/ui/time-text.tsx";
import { TopBar } from "../src/ui/top-bar.tsx";
import { buttonNamed, click, NOW, render, unmountAll } from "./support/render.tsx";

afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

describe("部品のカタログ", () => {
  // jsdom の環境では import.meta.url が file: でないので、テストのファイルの置き場から辿る
  const dir = join(import.meta.dirname, "../src/ui");

  it("ディレクトリの部品のファイルと両方向で一致する", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".tsx"));
    expect(CATALOG.map((c) => c.file).sort()).toEqual(files.sort());
    expect(CATALOG).toHaveLength(19);
    expect(new Set(CATALOG.map((c) => c.name)).size).toBe(19);
  });
});

describe("枠", () => {
  const frame = (over: Partial<Parameters<typeof AppFrame>[0]> = {}) => (
    <AppFrame current="approvals" places={[]} waiting={0} stopped={0} sprintsPath={null} {...over}>
      <p>本文</p>
    </AppFrame>
  );
  const items = (host: HTMLElement) => [...host.querySelectorAll("nav [data-nav]")];

  it("4 つの行き先を同じ順で出し、今の行き先に aria-current を付け、本文へ飛ぶリンクを先頭に置く", () => {
    const { host } = render(frame());
    expect(items(host).map((e) => e.getAttribute("data-nav"))).toEqual(["organizers", "approvals", "sprints", "settings"]);
    expect(host.querySelector('[aria-current="page"]')?.getAttribute("data-nav")).toBe("approvals");
    expect(host.querySelector("a")?.getAttribute("href")).toBe("#main");
    expect(host.querySelector("main#main")?.textContent).toContain("本文");
  });

  it("待ちの数は 0 なら出さず、99 を超えると 99+ にする", () => {
    expect(render(frame()).host.querySelector("[data-count]")).toBeNull();
    const { host } = render(frame({ waiting: 100 }));
    expect(host.querySelector('[data-nav="approvals"] [data-count]')?.textContent).toBe("99+");
  });

  it("プロジェクトを選んでいなければ、スプリントは場所の一覧を開く", () => {
    const { host } = render(frame({ places: [{ to: "/t/team_1", name: "acme" }] }));
    const sprints = host.querySelector('[data-nav="sprints"]');
    expect(sprints?.tagName).toBe("BUTTON");
    expect(host.querySelector('a[href="/t/team_1"]')).toBeNull();
    click(sprints);
    expect(host.querySelector('a[href="/t/team_1"]')?.textContent).toBe("acme");
  });

  it("プロジェクトを選んでいれば、スプリントはその一覧へのリンク", () => {
    const { host } = render(frame({ sprintsPath: "/p/prj_1" }));
    expect(host.querySelector('a[data-nav="sprints"]')?.getAttribute("href")).toBe("/p/prj_1");
  });
});

describe("状態を出す部品", () => {
  it("上の帯は h1 と説明と主操作を出す", () => {
    const { host } = render(<TopBar title="題" description="説明" action={<button type="button">主</button>} />);
    expect(host.querySelector("h1")?.textContent).toBe("題");
    expect(host.textContent).toContain("説明");
    expect(buttonNamed(host, "主")).toBeDefined();
  });

  it("ボタンは、つながりが要るのにオフラインだと押せず、理由を出す", () => {
    const onClick = vi.fn();
    const { host } = render(<Button needsConnection onClick={onClick}>送る</Button>);
    expect(buttonNamed(host, "送る")?.disabled).toBe(true);
    expect(host.textContent).toContain("つながると使えます");
    click(buttonNamed(host, "送る"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it.each(["empty", "notFound", "offlineNotCached"] as const)("空の状態 %s は、何が無いかと次の行き先を出す", (kind) => {
    const { host } = render(<EmptyState kind={kind} nextTo="/" />);
    expect(host.querySelector(`[data-state="${kind}"] a`)?.getAttribute("href")).toBe("/");
  });

  it("読み込み中は status で出る", () => {
    const { host } = render(<Loading />);
    expect(host.querySelector('[data-state="loading"][role="status"]')?.textContent).toContain("読み込んでいます");
  });

  it("エラーは理由の文と「もう一度」を出し、コードの文字列を出さない", () => {
    const onRetry = vi.fn();
    const { host } = render(<ErrorNotice code="http_599" onRetry={onRetry} />);
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.getAttribute("data-reason")).toBe("http_599");
    expect(alert?.textContent).toContain("処理できませんでした");
    expect(alert?.textContent).not.toContain("http_599");
    click(buttonNamed(host, "もう一度"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(render(<ErrorNotice code="unknown" />).host.querySelector("button")).toBeNull();
  });

  it("状態のバッジは 7 つの調子を、色のほかに形の印と文言で出す", () => {
    expect(TONES).toHaveLength(7);
    const marks = TONES.map((tone) => {
      const { host } = render(<StatusBadge tone={tone} labelKey="pending.waiting" />);
      expect(host.textContent).toContain("つながってから確定");
      return host.querySelector("[aria-hidden]")?.textContent;
    });
    expect(new Set(marks).size).toBe(7);
  });

  it("オフラインの帯は、つながっていて何も無ければ出ない", () => {
    expect(render(<OfflineBanner online pending={0} held={0} />).host.textContent).toBe("");
    const { host } = render(
      <OfflineBanner online={false} pending={2} held={1} lastReceivedAt="2026-01-02T03:04:00.000Z" />,
    );
    const banner = host.querySelector('[role="status"]');
    expect(banner?.textContent).toContain("つながっていません");
    expect(banner?.textContent).toContain("2026/01/02");
    expect(banner?.textContent).toContain("確定待ち 2 件");
    expect(banner?.textContent).toContain("保留 1 件");
    const failed = render(<OfflineBanner online pending={0} held={0} reloadFailedAt="2026-01-02T03:04:00.000Z" />);
    expect(failed.host.textContent).toContain("読み直せませんでした");
  });

  it("確定待ちのバッジは期限を出し、押すと取り下げる", () => {
    const onWithdraw = vi.fn();
    const { host } = render(<PendingBadge deadline="2026-01-04T00:00:00.000Z" onWithdraw={onWithdraw} />);
    expect(host.textContent).toContain("つながってから確定");
    expect(host.querySelector("time")?.getAttribute("datetime")).toBe("2026-01-04T00:00:00.000Z");
    click(buttonNamed(host, "取り下げる"));
    expect(onWithdraw).toHaveBeenCalledTimes(1);
    const unknown = render(<PendingBadge deadline="2026-01-04T00:00:00.000Z" unknown onWithdraw={onWithdraw} />);
    expect(unknown.host.textContent).toContain("結果未確認");
  });

  it("操作の結果は、成功を status、失敗を alert で出す", () => {
    expect(render(<ActionResult ok messageKey="pending.waiting" />).host.querySelector('[role="status"]')).not.toBeNull();
    expect(render(<ActionResult ok={false} messageKey="errors.reason.unknown" />).host.querySelector('[role="alert"]')).not.toBeNull();
  });
});

describe("中身を出す部品", () => {
  it("一覧は行を行き先へのリンクにし、0 件は空の状態にする", () => {
    const columns = [{ key: "name", label: "名前" }];
    const { host } = render(<DataList columns={columns} rows={[{ id: "1", to: "/me", cells: { name: "行1" } }]} />);
    expect(host.querySelector('li a[href="/me"]')?.textContent).toContain("行1");
    expect(render(<DataList columns={columns} rows={[]} />).host.querySelector('[data-state="empty"]')).not.toBeNull();
  });

  it("詳細は名前と値の組", () => {
    const { host } = render(<DetailList items={[{ name: "ID", value: "sub-1" }]} />);
    expect(host.querySelector("dt")?.textContent).toBe("ID");
    expect(host.querySelector("dd")?.textContent).toBe("sub-1");
  });

  it("畳む節は見出しで開閉する", () => {
    const { host } = render(<Collapsible heading="終わったもの"><p>中身</p></Collapsible>);
    const toggle = buttonNamed(host, "終わったもの")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(host.textContent).not.toContain("中身");
    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("中身");
  });

  it("時刻は time の datetime に UTC の値を置き、相対は 1 分ごとに描き直す", () => {
    vi.useFakeTimers();
    let now = NOW;
    const iso = "2026-01-02T23:57:00.000Z";
    const { host } = render(<TimeText iso={iso} mode="relative" />, { now: () => now });
    expect(host.querySelector("time")?.getAttribute("datetime")).toBe(iso);
    expect(host.textContent).toBe("3 分前");
    now += 60_000;
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(host.textContent).toBe("4 分前");
    expect(render(<TimeText iso={iso} mode="absolute" />).host.textContent).toContain("2026/01/02");
  });

  it("金額は通貨つきで出し、通貨の無い金額はエラーにする", () => {
    expect(render(<MoneyText amount={1200} currency="JPY" />).host.textContent).toContain("1,200");
    const { host } = render(<MoneyText amount={1200} currency={null} />);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain("1,200");
  });

  it("入力欄は欄の上のラベルと誤りの文を結び付ける", () => {
    const { host } = render(<TextField label="名前" value="a" onChange={() => {}} errorKey="errors.reason.unknown" />);
    const input = host.querySelector("input")!;
    expect(host.querySelector("label")?.htmlFor).toBe(input.id);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toBe("処理できませんでした");
  });

  it("選択の欄はラベルと選択肢を持ち、押せなくできる", () => {
    const { host } = render(
      <SelectField label="言語" value="ja" options={[{ value: "ja", label: "日本語" }]} onChange={() => {}} disabled />,
    );
    const select = host.querySelector("select")!;
    expect(select.disabled).toBe(true);
    expect(host.querySelector("label")?.htmlFor).toBe(select.id);
    expect(select.options).toHaveLength(1);
  });
});

describe("確認のダイアログ", () => {
  const props = { title: "取り消す", body: "2 本のレーンが止まります", confirmLabel: "スプリントを取り消す" };
  const key = (target: Element, name: string, shiftKey = false) =>
    act(() => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true }));
    });

  it("確定のボタンに操作の名前を出し、Esc では確定せずに閉じる", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const { host } = render(<ConfirmDialog {...props} open onConfirm={onConfirm} onClose={onClose} />);
    expect(host.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
    expect(buttonNamed(host, props.confirmLabel)).toBeDefined();
    key(buttonNamed(host, props.confirmLabel)!, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    click(buttonNamed(host, props.confirmLabel));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("Tab の末尾から先頭へ、先頭の Shift+Tab から末尾へ戻る", () => {
    const { host } = render(<ConfirmDialog {...props} open onConfirm={() => {}} onClose={() => {}} />);
    const first = buttonNamed(host, "やめる")!;
    const last = buttonNamed(host, props.confirmLabel)!;
    last.focus();
    key(last, "Tab");
    expect(document.activeElement).toBe(first);
    key(first, "Tab", true);
    expect(document.activeElement).toBe(last);
  });

  it("閉じていれば何も出さない", () => {
    const { host } = render(<ConfirmDialog {...props} open={false} onConfirm={() => {}} onClose={() => {}} />);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("資料の本文", () => {
  const body = (markdown: string) => render(<DocumentBody markdown={markdown} />).host;

  it("段落・見出し・箇条・引用・強調を出し、表とコードは横に送れる箱に入れる", () => {
    const host = body("# 見出し\n\n本文の **強い** *弱い* `x`\n\n- 箇条\n\n1. 番号\n\n> 引用\n\n| a |\n| - |\n| 1 |\n\n```\ncode\n```\n");
    for (const tag of ["h2", "p", "strong", "em", "code", "ul li", "ol li", "blockquote", "th", "td"]) {
      expect(host.querySelector(tag), tag).not.toBeNull();
    }
    expect(host.querySelector(".nd-scroll table")).not.toBeNull();
    expect(host.querySelector(".nd-scroll pre")).not.toBeNull();
  });

  it("空の文字列は空", () => {
    expect(body("").textContent).toBe("");
  });

  it("HTML と画像と許さない行き先を要素にしない", () => {
    const host = body(
      '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[js](javascript:alert(1)) [http](http://example.com) [rel](//example.com/x) [out](/nowhere) ![代わりの文](https://example.com/a.png)',
    );
    expect(host.querySelector("script, img, a")).toBeNull();
    expect(host.textContent).toContain("js");
    expect(host.textContent).toContain("代わりの文");
  });

  it("https: と画面マップの path は押せる", () => {
    const host = body("[外](https://github.com/acme/repo) [内](/approvals)");
    const hrefs = [...host.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://github.com/acme/repo", "/approvals"]);
    expect(host.querySelector("a")?.getAttribute("rel")).toContain("noreferrer");
  });
});
