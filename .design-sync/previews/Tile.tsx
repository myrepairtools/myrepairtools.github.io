import * as React from "react";
import { Tile } from "@myrepairtools/design-system";

export function Tiles() {
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      <Tile icon="💵" name="Cash Tracker" description="Tills, safes & daily audit." accent="blue" />
      <Tile icon="💰" name="Cash Admin" description="Reconcile & oversight." accent="admin" />
      <Tile icon="📊" name="Claim Ledger" description="Warranty claim accounting." accent="owner" />
    </div>
  );
}
