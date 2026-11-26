import { Link } from "react-router";
import { useI18n } from "../i18n/context.ts";

export type EmptyStateProps = { kind: "empty" | "notFound" | "offlineNotCached"; nextTo: string };

// 何が無いかと、次にすることの 2 段
export function EmptyState({ kind, nextTo }: EmptyStateProps) {
  const { t } = useI18n();
  return (
    <section className="nd-empty" data-state={kind}>
      <p>{t(`state.${kind}`)}</p>
      <Link className="nd-link-block" to={nextTo}>
        {t(`state.${kind}Next`)}
      </Link>
    </section>
  );
}
