import { useI18n } from "../i18n/context.ts";
import { formatMoney } from "../i18n/format.ts";

export type MoneyTextProps = { amount: number; currency: string | null };

export function MoneyText({ amount, currency }: MoneyTextProps) {
  const { locale, t } = useI18n();
  const text = formatMoney(amount, currency, locale);
  if (text === null) {
    return (
      <span className="nd-error" role="alert">
        {t("money.noCurrency")}
      </span>
    );
  }
  return <span>{text}</span>;
}
