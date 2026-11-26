import { useI18n } from "../i18n/context.ts";
import { formatDateTime } from "../i18n/format.ts";

export type OfflineBannerProps = {
  online: boolean;
  pending: number;
  held: number;
  lastReceivedAt?: string;
  reloadFailedAt?: string;
};

// 枠の上端の 1 本の帯。出すものが無ければ描かない
export function OfflineBanner({ online, pending, held, lastReceivedAt, reloadFailedAt }: OfflineBannerProps) {
  const { t, locale, timeZone } = useI18n();
  const time = (iso: string) => formatDateTime(iso, { locale, timeZone });
  const lines: string[] = [];
  if (!online) {
    lines.push(t("offline.banner"));
    if (lastReceivedAt !== undefined) lines.push(t("offline.lastReceived", { time: time(lastReceivedAt) }));
  } else if (reloadFailedAt !== undefined) {
    lines.push(t("offline.reloadFailed", { time: time(reloadFailedAt) }));
  }
  if (pending > 0) lines.push(t("offline.pending", { count: pending }));
  if (held > 0) lines.push(t("offline.held", { count: held }));
  if (lines.length === 0) return null;
  return (
    <div className="nd-banner" role="status" data-online={online}>
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </div>
  );
}
