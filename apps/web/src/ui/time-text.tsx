import { useEffect, useState } from "react";
import { useI18n } from "../i18n/context.ts";
import { formatDateTime, formatRelative } from "../i18n/format.ts";

export type TimeTextProps = { iso: string; mode: "relative" | "absolute" };

const REDRAW_MS = 60_000;

export function TimeText({ iso, mode }: TimeTextProps) {
  const { locale, timeZone, now } = useI18n();
  const [, setTick] = useState(0);
  // 相対の時刻は、画面が見えている間 1 分ごとに描き直す
  useEffect(() => {
    if (mode !== "relative") return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") setTick((n) => n + 1);
    }, REDRAW_MS);
    return () => clearInterval(timer);
  }, [mode]);
  const options = { locale, timeZone };
  return <time dateTime={iso}>{mode === "relative" ? formatRelative(iso, now(), options) : formatDateTime(iso, options)}</time>;
}
