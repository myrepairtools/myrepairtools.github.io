import * as React from "react";
import { cx } from "../cx";

export interface TabItem {
  id: string;
  label: React.ReactNode;
}

export interface TabsProps {
  /** The tabs to render, in order. */
  tabs: TabItem[];
  /** `id` of the currently active tab. */
  active: string;
  /** Called with the `id` of the tab the user selects. */
  onChange?: (id: string) => void;
  className?: string;
}

/**
 * Dark segmented control used for top-level view switching (the active tab
 * fills with the dark brand color). For store filtering use `StorePills`.
 */
export function Tabs({ tabs, active, onChange, className }: TabsProps) {
  return (
    <div className={cx("mrt-tabs", className)} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === active}
          className={cx("mrt-tab", t.id === active && "is-active")}
          onClick={() => onChange?.(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
