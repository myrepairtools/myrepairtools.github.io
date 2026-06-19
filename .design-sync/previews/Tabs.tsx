import * as React from "react";
import { Tabs } from "@myrepairtools/design-system";

const TABS = [
  { id: "audit", label: "Audit" },
  { id: "entries", label: "Entries" },
  { id: "recon", label: "Reconcile" },
];

export function Interactive() {
  const [active, setActive] = React.useState("entries");
  return <Tabs tabs={TABS} active={active} onChange={setActive} />;
}

export function FirstSelected() {
  return <Tabs tabs={TABS} active="audit" />;
}
