import type { ReactNode } from "react";

export type TopBarProps = { title: string; description?: string; action?: ReactNode };

export function TopBar({ title, description, action }: TopBarProps) {
  return (
    <header className="nd-top">
      <div>
        <h1>{title}</h1>
        {description === undefined ? null : <p className="nd-note">{description}</p>}
      </div>
      {action === undefined ? null : <div className="nd-top-action">{action}</div>}
    </header>
  );
}
