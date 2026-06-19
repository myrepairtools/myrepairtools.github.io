import * as React from "react";
import { StatCard } from "@myrepairtools/design-system";

export function BalancesGrid() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, maxWidth: 640 }}>
      <StatCard label="Till Balance" value="$1,240.00" sub="Drawer #1" />
      <StatCard label="Safe" value="$3,500.00" sub="Back office" variant="safe" />
      <StatCard label="Large Deposit" value="$5,000.00" sub="Pending pickup" variant="large" />
      <StatCard label="Total On Hand" value="$9,740.00" sub="All locations" variant="total" />
    </div>
  );
}

export function Single() {
  return (
    <div style={{ maxWidth: 220 }}>
      <StatCard label="Counted Today" value="$842.50" sub="Eugene · 3:00 PM" />
    </div>
  );
}
