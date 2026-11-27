import type { ReactNode } from "react";

export type DetailListProps = { items: readonly { name: string; value: ReactNode }[] };

export function DetailList({ items }: DetailListProps) {
  return (
    <dl className="nd-detail">
      {items.map((item) => (
        <div key={item.name}>
          <dt>{item.name}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
