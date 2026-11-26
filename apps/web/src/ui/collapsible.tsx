import { type ReactNode, useId, useState } from "react";

export type CollapsibleProps = { heading: string; defaultOpen?: boolean; children: ReactNode };

export function Collapsible({ heading, defaultOpen = false, children }: CollapsibleProps) {
  const [open, setOpen] = useState(defaultOpen);
  const body = useId();
  return (
    <section className="nd-collapsible">
      <h2>
        <button type="button" aria-expanded={open} aria-controls={body} onClick={() => setOpen(!open)}>
          <span aria-hidden="true">{open ? "▾" : "▸"}</span> {heading}
        </button>
      </h2>
      <div id={body}>{open ? children : null}</div>
    </section>
  );
}
