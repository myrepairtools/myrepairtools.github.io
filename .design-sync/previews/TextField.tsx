import * as React from "react";
import { TextField } from "@myrepairtools/design-system";

export function Basic() {
  return (
    <div style={{ maxWidth: 280 }}>
      <TextField label="Employee name" placeholder="e.g. Jordan R." />
    </div>
  );
}

export function Filled() {
  return (
    <div style={{ display: "grid", gap: 14, maxWidth: 280 }}>
      <TextField label="Counted amount" defaultValue="1,240.00" inputMode="decimal" />
      <TextField label="Note" defaultValue="Drawer #2 short by $5" />
    </div>
  );
}
