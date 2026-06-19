# Using @myrepairtools/design-system

The CPR Oregon (myrepairtools) brand library — internal phone-repair business
tools. Import components from `@myrepairtools/design-system`; the bundle exposes
them on `window.MyRepairTools`.

## Setup — no provider, but you MUST load the stylesheet

There is **no theme provider or context wrapper**. Components render correctly
as soon as the brand stylesheet is loaded once at the app root:

```jsx
import "@myrepairtools/design-system/styles.css";
import { Card, Button, StatCard } from "@myrepairtools/design-system";

function CashSummary() {
  return (
    <Card title="Daily cash audit" accent="blue">
      <StatCard label="Till Balance" value="$1,240.00" sub="Drawer #1" />
      <Button>Save audit</Button>
    </Card>
  );
}
```

Without `styles.css`, every component renders unstyled (browser-default text,
no brand color, no fonts). The stylesheet also pulls in the brand fonts
**Nunito** (headings, button/label text) and **Nunito Sans** (body) via a remote
`@import` — no font files ship with the bundle.

## Styling idiom — semantic props, NOT class names

Style components through their **semantic props**, never by passing CSS classes.
Each prop maps to the brand meaning, not a raw color — pick by intent:

| Component | Prop | Values |
|---|---|---|
| `Button` | `variant` / `size` | `primary` (red, default) · `alt` (white outline) · `blue` · `dark` / `md` · `sm` |
| `Card`, `Tile` | `accent` | `red` · `blue` · `dark` · `green` (Tile: `blue` · `admin` · `owner`) |
| `StatCard` | `variant` | `default` (blue) · `safe` (purple) · `large` (amber) · `total` (green) |
| `Badge` | `tone` | `neutral` · `open` · `close` · `transfer` · `expense` · `success` · `info` |
| `Banner`, `Toast` | `tone` | `warning`/`default` · `info`/`success` · `error` |
| `StatusValue` | `status` | `ok` (green) · `bad` (red) · `over` (amber) — for over/short cash |
| `Tabs` | — | dark segmented control; `StorePills` is the blue segmented variant |

Form controls (`TextField`, `Select`) take a `label` plus all native input/select
props (`value`, `onChange`, `placeholder`, `options`). `Table` takes `columns`
(with `numeric` for right-aligned currency) and `rows`.

## For your own layout glue — use the brand tokens

When you write surrounding markup (grids, spacing, one-off text), reach for the
brand CSS custom properties defined in `styles.css`, so it matches:

`--mrt-red #DC282E` · `--mrt-dark #2D2D3B` · `--mrt-blue #4FB0E3` ·
`--mrt-grey #B9BDCB` · `--mrt-light-grey #F3F2F2` · `--mrt-green #2E9E5B` ·
`--mrt-border #E0E2EA` · fonts `--mrt-font-head` (Nunito) / `--mrt-font-body`
(Nunito Sans).

```jsx
<div style={{ display: "grid", gap: 12, fontFamily: "var(--mrt-font-body)" }}>
  <StatCard label="Total On Hand" value="$9,740.00" variant="total" />
</div>
```

## Where the truth lives

- **Tokens, fonts, and every component class**: `_ds/<folder>/styles.css` (read it
  before styling — it is the single source of the look).
- **Per-component API + usage**: each component's `.prompt.md` and `.d.ts`.
