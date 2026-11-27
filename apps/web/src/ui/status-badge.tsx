import { useI18n } from "../i18n/context.ts";
import type { MessageKey } from "../i18n/translate.ts";

// 色だけに頼らないよう、調子ごとに形の違う印を頭に置く
const MARKS = {
  waiting: "◆",
  running: "▶",
  done: "✓",
  stopped: "■",
  failed: "✕",
  neutral: "○",
  pending: "◌",
} as const;

type Tone = keyof typeof MARKS;

/** カタログのテストが調子の数を照合する @internal */
export const TONES = Object.keys(MARKS) as Tone[];

export type StatusBadgeProps = { tone: Tone; labelKey: MessageKey };

export function StatusBadge({ tone, labelKey }: StatusBadgeProps) {
  const { t } = useI18n();
  return (
    <span className="nd-badge" data-tone={tone}>
      <span aria-hidden="true">{MARKS[tone]}</span>
      {t(labelKey)}
    </span>
  );
}
