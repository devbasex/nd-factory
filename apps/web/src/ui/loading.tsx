import { useI18n } from "../i18n/context.ts";

export function Loading() {
  const { t } = useI18n();
  return (
    <section className="nd-loading" data-state="loading" role="status" aria-busy="true">
      <span className="nd-spinner" aria-hidden="true" />
      <p>{t("common.loading")}</p>
    </section>
  );
}
