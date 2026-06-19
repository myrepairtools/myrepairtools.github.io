import * as React from "react";
import { Banner } from "@myrepairtools/design-system";

export function Tones() {
  return (
    <div style={{ display: "grid", gap: 10, maxWidth: 460 }}>
      <Banner>You have unsaved changes to the Eugene audit.</Banner>
      <Banner tone="info">Reconciliation runs nightly at 11:00 PM.</Banner>
      <Banner tone="success">Drawer #1 reconciled — balanced to the penny.</Banner>
      <Banner tone="error">Safe count is short by $40.00. Recount before close.</Banner>
    </div>
  );
}
