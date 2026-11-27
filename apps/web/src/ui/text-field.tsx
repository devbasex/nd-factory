import { useId } from "react";
import { useI18n } from "../i18n/context.ts";
import type { MessageKey } from "../i18n/translate.ts";

export type TextFieldProps = { label: string; value: string; onChange: (value: string) => void; errorKey?: MessageKey };

export function TextField({ label, value, onChange, errorKey }: TextFieldProps) {
  const { t } = useI18n();
  const id = useId();
  const error = `${id}-error`;
  return (
    <div className="nd-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={errorKey !== undefined}
        aria-describedby={errorKey === undefined ? undefined : error}
      />
      {errorKey === undefined ? null : (
        <span className="nd-error" id={error}>
          {t(errorKey)}
        </span>
      )}
    </div>
  );
}
