import * as React from "react";
import { cx } from "../cx";

export type StatCardVariant = "default" | "safe" | "large" | "total";

export interface StatCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Uppercase metric label (e.g. "Till Balance"). */
  label: React.ReactNode;
  /** The large headline value (e.g. "$1,240.00"). */
  value: React.ReactNode;
  /** Optional small caption under the value. */
  sub?: React.ReactNode;
  /**
   * Color of the left accent bar: `default` blue, `safe` purple, `large`
   * amber, `total` green (with a tinted background) for grand totals.
   */
  variant?: StatCardVariant;
}

const VARIANT: Record<StatCardVariant, string> = {
  default: "",
  safe: "mrt-stat--safe",
  large: "mrt-stat--large",
  total: "mrt-stat--total",
};

/**
 * Compact metric tile with a colored left accent bar — the "balance" box used
 * across the cash tools. Pair several in a grid for a balances summary.
 */
export function StatCard({ label, value, sub, variant = "default", className, ...rest }: StatCardProps) {
  return (
    <div className={cx("mrt-stat", VARIANT[variant], className)} {...rest}>
      <div className="mrt-stat__label">{label}</div>
      <div className="mrt-stat__value">{value}</div>
      {sub != null && <div className="mrt-stat__sub">{sub}</div>}
    </div>
  );
}
