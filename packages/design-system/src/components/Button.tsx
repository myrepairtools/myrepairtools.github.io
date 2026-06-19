import * as React from "react";
import { cx } from "../cx";

export type ButtonVariant = "primary" | "alt" | "blue" | "dark";
export type ButtonSize = "md" | "sm";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style. `primary` is the brand red; `alt` is the white outlined secondary. */
  variant?: ButtonVariant;
  /** `md` (default) or the compact `sm` used inside dense tables and toolbars. */
  size?: ButtonSize;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: "",
  alt: "mrt-btn--alt",
  blue: "mrt-btn--blue",
  dark: "mrt-btn--dark",
};

/**
 * Primary action button in the CPR brand. Red by default; use `variant="alt"`
 * for secondary actions and `size="sm"` for compact contexts like table rows.
 */
export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx("mrt-btn", VARIANT[variant], size === "sm" && "mrt-btn--sm", className)}
      {...rest}
    />
  );
}
