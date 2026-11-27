import { type KeyboardEvent, useEffect, useId, useRef } from "react";
import { useI18n } from "../i18n/context.ts";
import { Button } from "./button.tsx";

export type ConfirmProps = {
  open: boolean;
  title: string;
  body: string;
  // 確定のボタンには操作の名前を書く（「OK」にしない）
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
};

export function ConfirmDialog(props: ConfirmProps) {
  return props.open ? <OpenDialog {...props} /> : null;
}

function OpenDialog({ title, body, confirmLabel, onConfirm, onClose }: ConfirmProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement;
    // showModal の無い環境では open の属性で出す
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    dialog.querySelector("button")?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = [...(ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])];
    const first = buttons[0];
    const last = buttons.at(-1);
    const [edge, next] = event.shiftKey ? [first, last] : [last, first];
    if (document.activeElement === edge) {
      event.preventDefault();
      next?.focus();
    }
  };

  return (
    <dialog ref={ref} className="nd-dialog" role="dialog" aria-modal="true" aria-labelledby={heading} onKeyDown={onKeyDown}>
      <h2 id={heading}>{title}</h2>
      <p>{body}</p>
      <div className="nd-dialog-actions">
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
