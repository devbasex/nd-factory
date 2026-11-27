import { type ComponentProps, useId } from "react";
import { useI18n } from "../i18n/context.ts";

export type ButtonProps = ComponentProps<"button"> & {
  variant?: "primary" | "approve" | "normal";
  // つながってから押す操作で、今つながっていないときに真。押せなくして理由を出す
  needsConnection?: boolean;
};

export function Button({ variant = "normal", needsConnection = false, disabled, children, ...rest }: ButtonProps) {
  const { t } = useI18n();
  const note = useId();
  return (
    <span className="nd-button-box">
      <button
        type="button"
        {...rest}
        className="nd-button"
        data-variant={variant}
        disabled={disabled === true || needsConnection}
        aria-describedby={needsConnection ? note : undefined}
      >
        {children}
      </button>
      {needsConnection ? (
        <span className="nd-note" id={note}>
          {t("common.needsConnection")}
        </span>
      ) : null}
    </span>
  );
}
