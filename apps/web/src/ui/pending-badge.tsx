import { useI18n } from "../i18n/context.ts";
import { Button } from "./button.tsx";
import { StatusBadge } from "./status-badge.tsx";
import { TimeText } from "./time-text.tsx";

export type PendingBadgeProps = { deadline: string; unknown?: boolean; onWithdraw: () => void };

export function PendingBadge({ deadline, unknown = false, onWithdraw }: PendingBadgeProps) {
  const { t } = useI18n();
  const [before, after] = t("pending.deadline", { time: "\n" }).split("\n");
  return (
    <span className="nd-pending">
      <StatusBadge tone="pending" labelKey={unknown ? "pending.unknown" : "pending.waiting"} />
      <span className="nd-note">
        {before}
        <TimeText iso={deadline} mode="absolute" />
        {after}
      </span>
      <Button onClick={onWithdraw}>{t("pending.withdraw")}</Button>
    </span>
  );
}
