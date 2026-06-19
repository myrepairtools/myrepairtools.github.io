import * as React from "react";
import { Select } from "@myrepairtools/design-system";

const STORES = [
  { value: "eugene", label: "Eugene" },
  { value: "salem-ne", label: "Salem Northeast" },
  { value: "clackamas", label: "Clackamas" },
];

export function StoreSelect() {
  return (
    <div style={{ maxWidth: 260 }}>
      <Select label="Store" options={STORES} defaultValue="salem-ne" />
    </div>
  );
}

export function OperationType() {
  return (
    <div style={{ maxWidth: 260 }}>
      <Select label="Operation" defaultValue="close">
        <option value="open">Open drawer</option>
        <option value="close">Close drawer</option>
        <option value="transfer">Transfer</option>
        <option value="deposit">Bank deposit</option>
      </Select>
    </div>
  );
}
