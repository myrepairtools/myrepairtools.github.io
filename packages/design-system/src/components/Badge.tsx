import * as React from "react";
import { cx } from "../cx";

export type BadgeTone =
  | "neutral"
  | "expense"
  | "open"
  | "close"
  | "transfer"
  | "success"
  | "info";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Semantic color of the pill. Defaults to `neutral` (grey). */
  tone?: BadgeTone;
  children?: React.ReactNode;
}

const TONE: Record<BadgeTone, string> = {
  neutral: "",
  expense: "mrt-badge--expense",
  open: "mrt-badge--open",
  close: "mrt-badge--close",
  transfer: "mrt-badge--transfer",
  success: "mrt-badge--success",
  info: "mrt-badge--info",
};

/**
 * Small uppercase rounded pill for tagging row state (operation type, expense,
 * status). Use the semantic `tone` that matches the meaning, not the color.
 */
export function Badge({ tone = "neutral", className, ...rest }: BadgeProps) {
  return <span className={cx("mrt-badge", TONE[tone], className)} {...rest} />;
}
