import { useI18n } from "../i18n/context.ts";
import type { SelfResult } from "../users-client.ts";
import { DetailList } from "../ui/detail-list.tsx";
import { ErrorNotice } from "../ui/error-notice.tsx";
import { TimeText } from "../ui/time-text.tsx";
import { TopBar } from "../ui/top-bar.tsx";

// 自分の設定（R14）の仮の画面。骨組みの利用者の表示をここへ置く

export type MeProps = { user: SelfResult; onRetry?: () => void };

export function MeScreen({ user, onRetry }: MeProps) {
  const { t } = useI18n();
  return (
    <>
      <TopBar title={t("routes.me.title")} />
      {user.kind === "ok" ? (
        <DetailList
          items={[
            { name: t("me.userId"), value: <code>{user.user.id}</code> },
            { name: t("me.since"), value: <TimeText iso={user.user.created_at} mode="absolute" /> },
          ]}
        />
      ) : (
        <ErrorNotice code={user.kind === "error" ? user.reason : "unauthorized"} onRetry={onRetry} />
      )}
    </>
  );
}
