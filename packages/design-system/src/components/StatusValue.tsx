import * as React from "react";
import { cx } from "../cx";

export type Status = "ok" | "bad" | "over";

export interface StatusValueProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** `ok` green, `bad` red, `over` amber — for over/short cash counts. */
  status: Status;
  children?: React.ReactNode;
}

const STATUS: Record<Status, string> = {
  ok: "mrt-status--ok",
  bad: "mrt-status--bad",
  over: "mrt-status--over",
};

/**
 * Bold colored inline value for reconciliation outcomes — e.g. a register
 * count that is balanced (`ok`), short (`bad`), or over (`over`).
 */
export function StatusValue({ status, className, ...rest }: StatusValueProps) {
  return <span className={cx("mrt-status", STATUS[status], className)} {...rest} />;
}
