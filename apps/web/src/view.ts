import type { UserRow } from "@nd-factory/contracts/users-api";

// 画面の 5 つの状態の表示。中身は textContent で入れ、受けた値を HTML として読まない

export type ViewState =
  | { kind: "redirecting" }
  | { kind: "waiting" }
  | { kind: "loading" }
  | { kind: "shown"; user: UserRow }
  | { kind: "error"; reason: string };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

// 時刻帯を指定しないことで、ブラウザーの時刻帯（利用者の時刻帯）で表示する
function formatLocal(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

function body(state: ViewState, onRetry: () => void): HTMLElement {
  const section = el("section");
  section.setAttribute("data-state", state.kind);
  switch (state.kind) {
    case "redirecting":
      section.append(el("p", "ログインの頁へ移ります"));
      break;
    case "waiting":
      section.append(el("p", "ログインの設定を待っています"));
      break;
    case "loading":
      section.setAttribute("aria-busy", "true");
      section.append(el("p", "読み込んでいます"));
      break;
    case "shown": {
      const list = el("dl");
      const time = el("time", formatLocal(state.user.created_at));
      time.dateTime = state.user.created_at;
      const since = el("dd");
      since.append(time);
      list.append(el("dt", "利用者の ID"), el("dd", state.user.id), el("dt", "利用を始めた日時"), since);
      section.append(list);
      break;
    }
    case "error": {
      section.setAttribute("role", "alert");
      const reason = el("code", state.reason);
      const line = el("p", "読み込めませんでした: ");
      line.append(reason);
      const retry = el("button", "もう一度読む");
      retry.type = "button";
      retry.addEventListener("click", () => onRetry());
      section.append(line, retry);
      break;
    }
  }
  return section;
}

export function render(root: HTMLElement, state: ViewState, onRetry: () => void): void {
  root.replaceChildren(body(state, onRetry));
}
