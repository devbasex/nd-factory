import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n/context.ts";
import type { RouteDef } from "../routes/route-table.ts";
import { DataList } from "../ui/data-list.tsx";
import { EmptyState } from "../ui/empty-state.tsx";
import { ErrorNotice } from "../ui/error-notice.tsx";
import { Loading } from "../ui/loading.tsx";
import { TopBar } from "../ui/top-bar.tsx";

// 画面マップの各ルートの仮の画面。5 つの状態（読み込み中・空・エラー・見つからない・オフライン）を共通の部品で出す。
// 機能の画面（#28）を作るときに、表示データと一緒に消す

export type PlaceholderData =
  | { kind: "rows"; rows: readonly { id: string; title: string }[] }
  | { kind: "empty" }
  | { kind: "error"; reason: string }
  | { kind: "notFound" };

export type PlaceholderProps = { route: RouteDef; load: () => Promise<PlaceholderData>; online: boolean };

function Body({ route, load, online }: PlaceholderProps) {
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
