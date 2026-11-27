import { useI18n } from "../i18n/context.ts";
import { reasonKey } from "../i18n/translate.ts";
import { Button } from "./button.tsx";

export type ErrorNoticeProps = { code: string; onRetry?: () => void };

// 理由のコードは翻訳した文で出し、コードの文字列は data-reason にだけ置く
export function ErrorNotice({ code, onRetry }: ErrorNoticeProps) {
  const { t } = useI18n();
  return (
    <section className="nd-error" data-state="error" data-reason={code} role="alert">
      <p>{t(reasonKey(code))}</p>
      {onRetry === undefined ? null : <Button onClick={onRetry}>{t("common.retry")}</Button>}
    </section>
  );
}
