import type { ReactNode } from "react";
import { Link } from "react-router";
import { EmptyState } from "./empty-state.tsx";

export type DataListProps = {
  columns: readonly { key: string; label: string }[];
  rows: readonly { id: string; to: string; cells: Record<string, ReactNode> }[];
};

// 狭い幅では 1 行を 1 枚のカードに積み、広い幅では列の表にする（形は CSS が変える）
export function DataList({ columns, rows }: DataListProps) {
  if (rows.length === 0) return <EmptyState kind="empty" nextTo="/" />;
  return (
    <div className="nd-list">
      <div className="nd-list-head" aria-hidden="true">
        {columns.map((column) => (
          <span key={column.key}>{column.label}</span>
        ))}
      </div>
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            <Link to={row.to}>
              {columns.map((column) => (
                <span key={column.key}>{row.cells[column.key]}</span>
              ))}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
