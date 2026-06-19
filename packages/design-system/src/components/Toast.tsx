import * as React from "react";
import { cx } from "../cx";

export type ToastTone = "default" | "error" | "success";

export interface ToastProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The message to display. */
  message: React.ReactNode;
  /** Color of the toast. `default` is dark, plus `error` and `success`. */
  tone?: ToastTone;
}

const TONE: Record<ToastTone, string> = {
  default: "",
  error: "mrt-toast--error",
  success: "mrt-toast--success",
};

/**
 * Transient confirmation pill, normally anchored to the bottom-center of the
 * screen. This renders the toast body itself; the consumer controls visibility
 * and positioning.
 */
export function Toast({ message, tone = "default", className, ...rest }: ToastProps) {
  return (
    <div className={cx("mrt-toast", TONE[tone], className)} {...rest}>
      {message}
    </div>
  );
}
