import * as React from "react";
import { cx } from "../cx";

export type TileAccent = "blue" | "admin" | "owner";

export interface TileProps
  extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  /** Emoji or short glyph shown at the top of the tile. */
  icon?: React.ReactNode;
  /** Tool name (the bold title). */
  name: React.ReactNode;
  /** One-line description under the name. */
  description?: React.ReactNode;
  /**
   * Top accent color: `blue` for operations tools, `admin` (dark) and `owner`
   * (red) for privileged tools.
   */
  accent?: TileAccent;
}

const ACCENT: Record<TileAccent, string> = {
  blue: "",
  admin: "mrt-tile--admin",
  owner: "mrt-tile--owner",
};

/**
 * Launcher tile linking to a tool, with an icon, name, description, and a top
 * accent that signals the tool's access level. Renders as an anchor.
 */
export function Tile({ icon, name, description, accent = "blue", className, ...rest }: TileProps) {
  return (
    <a className={cx("mrt-tile", ACCENT[accent], className)} {...rest}>
      {icon != null && <div className="mrt-tile__icon">{icon}</div>}
      <div className="mrt-tile__name">{name}</div>
      {description != null && <div className="mrt-tile__desc">{description}</div>}
    </a>
  );
}
