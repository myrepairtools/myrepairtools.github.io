import * as React from "react";
import { cx } from "../cx";

export interface TableColumn {
  /** Key into each row object. */
  key: string;
  /** Column header text. */
  label: React.ReactNode;
  /** Right-align and use the tabular number style (for currency/counts). */
  numeric?: boolean;
}

export interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  columns: TableColumn[];
  /** Row data; each row is keyed by column `key`. */
  rows: Array<Record<string, React.ReactNode>>;
}

/**
 * Brand data table wrapped in a rounded card surface, with uppercase column
 * headers, hover rows, and right-aligned numeric columns.
 */
export function Table({ columns, rows, className, ...rest }: TableProps) {
  return (
    <div className="mrt-table-card">
      <table className={cx("mrt-table", className)} {...rest}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={cx(c.numeric && "is-num")}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c.key} className={cx(c.numeric && "is-num")}>
                  {row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
