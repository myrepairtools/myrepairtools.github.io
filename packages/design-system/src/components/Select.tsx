import * as React from "react";
import { cx } from "../cx";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** Uppercase label rendered above the select. */
  label?: React.ReactNode;
  /** Options to render. Alternatively pass `<option>` children directly. */
  options?: SelectOption[];
}

/**
 * Labeled dropdown matching the brand field styling and blue focus ring.
 * Pass `options` for the common case, or `children` for custom `<option>`s.
 */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  function Select({ label, options, className, id, children, ...rest }, ref) {
    const selectId = id ?? (label ? `mrt-s-${String(label).replace(/\s+/g, "-").toLowerCase()}` : undefined);
    return (
      <label className="mrt-field" htmlFor={selectId}>
        {label != null && <span className="mrt-field__label">{label}</span>}
        <select id={selectId} ref={ref} className={cx("mrt-select", className)} {...rest}>
          {options
            ? options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))
            : children}
        </select>
      </label>
    );
  }
);
