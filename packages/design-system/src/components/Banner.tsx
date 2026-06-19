import * as React from "react";
import { cx } from "../cx";

export type BannerTone = "warning" | "info" | "error" | "success";

export interface BannerProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Severity / color of the banner. Defaults to `warning` (amber). */
  tone?: BannerTone;
  children?: React.ReactNode;
}

const TONE: Record<BannerTone, string> = {
  warning: "",
  info: "mrt-banner--info",
  error: "mrt-banner--error",
  success: "mrt-banner--success",
};

/**
 * Full-width inline notice for page-level messages (unsaved changes, warnings,
 * confirmations). Defaults to the amber warning style.
 */
export function Banner({ tone = "warning", className, ...rest }: BannerProps) {
  return <div role="status" className={cx("mrt-banner", TONE[tone], className)} {...rest} />;
}
