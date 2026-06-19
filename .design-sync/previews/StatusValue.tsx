import * as React from "react";
import { StatusValue } from "@myrepairtools/design-system";

export function Statuses() {
  return (
    <div style={{ display: "flex", gap: 20, alignItems: "center", fontSize: "1.1rem" }}>
      <StatusValue status="ok">$0.00 · Balanced</StatusValue>
      <StatusValue status="bad">−$5.00 · Short</StatusValue>
      <StatusValue status="over">+$12.00 · Over</StatusValue>
    </div>
  );
}
