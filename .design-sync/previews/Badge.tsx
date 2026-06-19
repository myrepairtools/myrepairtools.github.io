import * as React from "react";
import { Badge } from "@myrepairtools/design-system";

export function Tones() {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <Badge>Neutral</Badge>
      <Badge tone="open">Open</Badge>
      <Badge tone="close">Close</Badge>
      <Badge tone="transfer">Transfer</Badge>
      <Badge tone="expense">Expense</Badge>
      <Badge tone="success">Deposit</Badge>
      <Badge tone="info">Large</Badge>
    </div>
  );
}
