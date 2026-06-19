import * as React from "react";
import { Toast } from "@myrepairtools/design-system";

export function Tones() {
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
      <Toast message="Audit saved" />
      <Toast message="Reconciled successfully" tone="success" />
      <Toast message="Save failed — try again" tone="error" />
    </div>
  );
}
