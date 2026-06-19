import * as React from "react";
import { cx } from "../cx";

export type CardAccent = "red" | "blue" | "dark" | "green";

export interface CardProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  /** Optional heading rendered at the top of the card in the Nunito display face. */
  title?: React.ReactNode;
  /** Color of the 3px top accent border. Defaults to brand red. */
  accent?: CardAccent;
  children?: React.ReactNode;
}

const ACCENT: Record<CardAccent, string> = {
  red: "",
  blue: "mrt-card--blue",
  dark: "mrt-card--dark",
  green: "mrt-card--green",
};

/**
 * Surface container with the signature 3px colored top border. The default
 * red accent matches operations tools; use `accent="blue"` for neutral panels.
 */
export function Card({ title, accent = "red", className, children, ...rest }: CardProps) {
  return (
    <div className={cx("mrt-card", ACCENT[accent], className)} {...rest}>
      {title != null && <h2 className="mrt-card__title">{title}</h2>}
      {children}
    </div>
  );
}
