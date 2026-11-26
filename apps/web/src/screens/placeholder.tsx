import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { DeviceView } from "../app/device-view.ts";
import { useI18n } from "../i18n/context.ts";
import { reasonKey } from "../i18n/translate.ts";
import { operationClassOf } from "../offline/operation-classes.ts";
import type { Draft } from "../offline/outbox.ts";
import type { RouteDef } from "../routes/route-table.ts";
import { ActionResult } from "../ui/action-result.tsx";
import { Button } from "../ui/button.tsx";
import { DataList } from "../ui/data-list.tsx";
import { EmptyState } from "../ui/empty-state.tsx";
import { ErrorNotice } from "../ui/error-notice.tsx";
import { Loading } from "../ui/loading.tsx";
import { PendingBadge } from "../ui/pending-badge.tsx";
import { TopBar } from "../ui/top-bar.tsx";

// 画面マップの各ルートの仮の画面。5 つの状態（読み込み中・空・エラー・見つからない・オフライン）を共通の部品で出す。
// 機能の画面（#28）を作るときに、表示データと一緒に消す

export type PlaceholderData =
  | { kind: "rows"; rows: readonly { id: string; title: string }[] }
  | { kind: "empty" }
  | { kind: "error"; reason: string }
  | { kind: "notFound" };

// 仮の画面の操作。label は作り物の対象の名前
export type PlaceholderAction = Draft & { label: string };

export type PlaceholderDevice = { view: DeviceView; actions: readonly PlaceholderAction[] };

export type PlaceholderProps = {
  route: RouteDef;
  load: () => Promise<PlaceholderData>;
  online: boolean;
  // 端末のデータにつないだ操作。ログインの切り替えまで、本番の組み立ては渡さない
  device?: PlaceholderDevice;
};

const RESULT_KEYS = {
  confirmed: "result.confirmed",
  rejected: "result.rejected",
  unknown: "result.unknown",
  expired: "result.expired",
  "save-failed": "result.saveFailed",
} as const;

// 操作は、区分の表で押せるかと送る列に入れるかを決める
function Actions({ device, online }: { device: PlaceholderDevice; online: boolean }) {
  const { t } = useI18n();
  const { view, actions } = device;
  const state = useSyncExternalStore(view.subscribe, view.snapshot);
  const same = (a: { operation: string; targetId: string }) => (b: { operation: string; targetId: string }) =>
    a.operation === b.operation && a.targetId === b.targetId;
  return (
    <>
      <ul className="nd-actions">
        {actions.map((action) => {
          const { label, ...draft } = action;
          const { class: cls } = operationClassOf(draft.operation);
          const pending = state.pending.find(same(draft));
          return (
            <li key={`${draft.operation}:${draft.targetId}`}>
              {pending === undefined ? (
                <Button
                  needsConnection={cls === "online" && !online}
                  // つながってから押す操作の送信は、機能の画面（#28）が持つ
                  onClick={cls === "online" ? undefined : () => void view.press(draft)}
                >
                  {label}
                </Button>
              ) : (
                <>
                  <span>{label}</span>
                  <PendingBadge deadline={pending.deadline} onWithdraw={() => void view.withdraw(pending.answerTag)} />
                </>
              )}
            </li>
          );
        })}
      </ul>
      {state.results.map((result) => (
        <div key={result.key}>
          <span>{actions.find(same(result))?.label}</span>
          <ActionResult ok={result.kind === "confirmed"} messageKey={RESULT_KEYS[result.kind]} />
          {result.reason === undefined || result.reason === "" ? null : (
            <p className="nd-note">{t(reasonKey(result.reason))}</p>
          )}
        </div>
      ))}
    </>
  );
}

function Body({ route, load, online, device }: PlaceholderProps) {
  const { t } = useI18n();
  const [data, setData] = useState<PlaceholderData | null>(null);
  const read = useCallback(() => {
    setData(null);
    load().then(setData, () => setData({ kind: "error", reason: "unknown" }));
  }, [load]);
  useEffect(read, [read]);

  if (!online && !route.offline) return <EmptyState kind="offlineNotCached" nextTo="/" />;
  if (data === null) return <Loading />;
  if (data.kind === "rows") {
    return (
      <div data-state="rows">
        <DataList
          columns={[{ key: "title", label: t(route.titleKey) }]}
          rows={data.rows.map((row) => ({ id: row.id, to: "/approvals", cells: { title: row.title } }))}
        />
        {device === undefined ? null : <Actions device={device} online={online} />}
      </div>
    );
  }
  // つながっていないときに行が無ければ、写しが無いので、つながると読める旨を出す
  if (!online) return <EmptyState kind="offlineNotCached" nextTo="/" />;
  if (data.kind === "error") return <ErrorNotice code={data.reason} onRetry={read} />;
  return <EmptyState kind={data.kind} nextTo="/" />;
}

export function PlaceholderScreen(props: PlaceholderProps) {
  const { t } = useI18n();
  return (
    <>
      <TopBar title={t(props.route.titleKey)} />
      <Body {...props} />
    </>
  );
}
