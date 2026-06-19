import * as React from "react";
import { Card, Button } from "@myrepairtools/design-system";

export function WithTitle() {
  return (
    <Card title="Daily cash audit" style={{ maxWidth: 360 }}>
      <p style={{ margin: 0, fontSize: ".88rem", color: "#4E4E50" }}>
        Count each till and safe, then reconcile against the expected balance
        before close.
      </p>
      <div style={{ marginTop: 14 }}>
        <Button size="sm">Start count</Button>
      </div>
    </Card>
  );
}

export function Accents() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, maxWidth: 520 }}>
      <Card title="Operations" accent="blue">
        <span style={{ fontSize: ".85rem", color: "#4E4E50" }}>Blue accent — neutral panels.</span>
      </Card>
      <Card title="Admin" accent="dark">
        <span style={{ fontSize: ".85rem", color: "#4E4E50" }}>Dark accent — admin tools.</span>
      </Card>
      <Card title="Owner" accent="red">
        <span style={{ fontSize: ".85rem", color: "#4E4E50" }}>Red accent — owner tools.</span>
      </Card>
      <Card title="Reconciled" accent="green">
        <span style={{ fontSize: ".85rem", color: "#4E4E50" }}>Green accent — confirmed.</span>
      </Card>
    </div>
  );
}
