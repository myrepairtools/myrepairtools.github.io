import * as React from "react";
import { StorePills } from "@myrepairtools/design-system";

const STORES = ["Eugene", "Salem Northeast", "Clackamas"];

export function Interactive() {
  const [active, setActive] = React.useState("Eugene");
  return <StorePills stores={STORES} active={active} onChange={setActive} />;
}

export function ClackamasSelected() {
  return <StorePills stores={STORES} active="Clackamas" />;
}
