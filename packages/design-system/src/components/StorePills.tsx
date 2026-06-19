import * as React from "react";
import { cx } from "../cx";

export interface StorePillsProps {
  /** Store names (or any labels) to render as selectable pills. */
  stores: string[];
  /** The currently selected store. */
  active: string;
  /** Called with the store the user selects. */
  onChange?: (store: string) => void;
  className?: string;
}

/**
 * Blue segmented control for filtering by store location (Eugene, Salem
 * Northeast, Clackamas). The active pill fills with the brand blue.
 */
export function StorePills({ stores, active, onChange, className }: StorePillsProps) {
  return (
    <div className={cx("mrt-pills", className)} role="tablist">
      {stores.map((s) => (
        <button
          key={s}
          type="button"
          role="tab"
          aria-selected={s === active}
          className={cx("mrt-pill", s === active && "is-active")}
          onClick={() => onChange?.(s)}
        >
          {s}
        </button>
      ))}
    </div>
  );
}
