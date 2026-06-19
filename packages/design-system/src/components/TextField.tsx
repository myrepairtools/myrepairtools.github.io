import * as React from "react";
import { cx } from "../cx";

export interface TextFieldProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Uppercase label rendered above the input. Omit for a bare input. */
  label?: React.ReactNode;
}

/**
 * Labeled text input with the brand's uppercase field label and blue focus
 * ring. Forwards all native input props (`value`, `onChange`, `type`, etc.).
 */
export const TextField = React.forwardRef<HTMLInputElement, TextFieldProps>(
  function TextField({ label, className, id, ...rest }, ref) {
    const inputId = id ?? (label ? `mrt-f-${String(label).replace(/\s+/g, "-").toLowerCase()}` : undefined);
    return (
      <label className="mrt-field" htmlFor={inputId}>
        {label != null && <span className="mrt-field__label">{label}</span>}
        <input id={inputId} ref={ref} className={cx("mrt-input", className)} {...rest} />
      </label>
    );
  }
);
