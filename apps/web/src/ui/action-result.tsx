import { useI18n } from "../i18n/context.ts";
import type { MessageKey } from "../i18n/translate.ts";

export type ActionResultProps = { ok: boolean; messageKey: MessageKey };

export function ActionResult({ ok, messageKey }: ActionResultProps) {
  const { t } = useI18n();
  return (
    <p className={ok ? "nd-result" : "nd-error"} role={ok ? "status" : "alert"}>
      {t(messageKey)}
    </p>
  );
}
