import * as React from "react";
import { Button } from "@myrepairtools/design-system";

export function Variants() {
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
      <Button>Save audit</Button>
      <Button variant="alt">Cancel</Button>
      <Button variant="blue">Reconcile</Button>
      <Button variant="dark">Close till</Button>
    </div>
  );
}

export function Sizes() {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <Button>Default</Button>
      <Button size="sm">Small</Button>
      <Button variant="alt" size="sm">
        Add row
      </Button>
    </div>
  );
}

export function Disabled() {
  return <Button disabled>Saving…</Button>;
}
