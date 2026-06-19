import * as React from "react";
import { Table, Badge, StatusValue } from "@myrepairtools/design-system";

const columns = [
  { key: "date", label: "Date" },
  { key: "emp", label: "Employee" },
  { key: "op", label: "Operation" },
  { key: "amount", label: "Amount", numeric: true },
  { key: "status", label: "Over / Short", numeric: true },
];

const rows = [
  {
    date: "Jun 16",
    emp: "Jordan R.",
    op: <Badge tone="open">Open</Badge>,
    amount: "$300.00",
    status: <StatusValue status="ok">$0.00</StatusValue>,
  },
  {
    date: "Jun 16",
    emp: "Casey M.",
    op: <Badge tone="close">Close</Badge>,
    amount: "$1,240.00",
    status: <StatusValue status="bad">−$5.00</StatusValue>,
  },
  {
    date: "Jun 17",
    emp: "Sam T.",
    op: <Badge tone="transfer">Transfer</Badge>,
    amount: "$500.00",
    status: <StatusValue status="over">+$2.00</StatusValue>,
  },
];

export function CashEntries() {
  return (
    <div style={{ maxWidth: 620 }}>
      <Table columns={columns} rows={rows} />
    </div>
  );
}
