# Daily Digest — Design Handoff (build the UI)

**For the page-improvements / Design session.** The data pipeline is **done and
live**; this is purely a UI build. You're rendering the owner's morning
scorecard (RepairQ's Looker dashboard 2273) from a Supabase table into MRT.
Nothing here requires touching the backend — read the table, paint the page.

**Read `CLAUDE.md` first** for brand + page conventions; this doc covers only
what's specific to the digest.

---

## 1. What exists (don't rebuild)

- **Table `digest_raw`** — a lossless daily snapshot. One row per
  `(capture_date, tile_key)`; `rows` is a jsonb array of that tile's records.
  RLS: **manager/owner only** (`is_admin()`), read-only from the browser.
  Columns: `capture_date date`, `tile_key text`, `element_id text`,
  `rows jsonb`, `row_count int`, `captured_at timestamptz`.
- **`repairq-query` action `sync_digest`** + **`daily-digest-sync` pg_cron**
  (every 4h) keep it fresh. **History accumulates from 2026-07-21 forward** —
  there is no backfill before that date, so any trend view should handle "no
  prior data yet" gracefully for the first few weeks.

Your job: **`daily-digest.html`** (new page, My Hub nav) + a home-dashboard
**"Today's Numbers"** widget. Both read `digest_raw`.

## 2. How to read it (client pattern)

Same as every Supabase page here: import the vendored client, ride the pin-gate
session, query the table. Manager/owner gate is automatic via RLS (a
non-manager just gets zero rows — design an empty/"managers only" state).

```js
import { createClient } from '/assets/supabase-js.js';
const sb = createClient(SB_URL, SB_ANON);            // same consts as other pages
// today's scorecard:
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const { data } = await sb.from('digest_raw').select('tile_key, rows, row_count, captured_at')
  .eq('capture_date', today);
const byTile = Object.fromEntries(data.map(r => [r.tile_key, r.rows]));
// byTile.monthly_digest is an array of store rows, etc.
```

Store names come back **raw** from Looker (`"CPR Eugene"`, `"CPR Salem
Northeast"`, `"CPR Clackamas OR"`). Normalize/display through
**`CPRLocations`** like everywhere else. For the store switcher use the
**`.storesel` dropdown** pattern (StorePills is deprecated — see CLAUDE.md).

## 3. The 11 tiles + field reference

`tile_key` → what it is → the fields on each row. **Important:** the "computed"
columns the owner sees in the CSV (GP %, Accy %, attach rate…) come back **null**
from Looker (they're client-side table calcs). **Compute them yourself** from
the raw fields — formulas below, all verified against the owner's export.

### `monthly_digest` (per store, month-to-date) and `daily_digest` (per store, today)
Same field set. One row per store. **This is the headline scorecard.**

| Owner's column | raw field | notes |
|---|---|---|
| Rank (franchise-wide) | `ranked_net_sales_mtd.rank` | lower = better; a real competitive hook |
| Total Sales | `ticket_item.all_net_sale_total` | |
| Repair Sales | `ticket_item.all_net_repair_sale_total` | |
| Retail Sales | `ticket_item.all_net_retail_sale_total` | |
| Retail GP | `ticket_item.all_net_retail_sale_after_cogs_total` | |
| Accy Sales | `ticket_item.all_net_accessory_sales_total` | |
| Accy GP | `ticket_item.all_net_accessory_sales_after_cogs_total` | |
| Ticket # | `ticket.count_all` | |
| Accy # | `ticket_item.all_sale_accessory_count` | |
| Gross Profit | `ticket_item.all_net_sale_after_cogs_total` | |
| Promos | `ticket_item.all_sale_promotion_total` | negative |
| Returns | `ticket_item.all_return_gross_total` | |
| Discounts | `tradein.all_net_discount_total` | |
| Waives | `ticket_item.pending_sale_waived_total` | |

**Derived (compute these — verified against the CSV):**
- **GP %** = Gross Profit ÷ Total Sales  *(Salem 2173.28/3442.68 = 63.1% ✓)*
- **Accy %** = Accy Sales ÷ Total Sales
- **Retail %** = Retail Sales ÷ Total Sales
- **Accy / Ticket** = Accy Sales ÷ Ticket #  *($ per ticket)*
- **Accy Attach Rate** = Accy # ÷ Ticket #  *(Salem 10/27 = 37% ✓)*
- **Accy GP %** = Accy GP ÷ Accy Sales  *(Salem 215.18/239.92 = 90% ✓)*

### `employee_breakdown` (per employee, today)
One row per rep. Same idea, keyed by `sold_by.full_name`. Extra: COGS =
`ticket_item.all_sale_cogs_total`; Discounts = `ticket_item.all_net_discount_total`.
Same derived metrics (attach rate, accy/tkt, GP %). **This is the leaderboard.**

### `claim_payout_weekly` (per store, last 7 days)
`location.short_name`, `transaction.payment_amount_total`. Simple money-per-store.

### `device_cleanings`, `express_repairs`, `akko_plan_sales` (per employee, MTD)
`user.full_name`, `catalog_item.sku`, `ticket_item.all_sale_count`. Simple
count leaderboards.

### `device_sales_today` (per device sold, today)
Ticket-level rows: Ticket #, Location, device Name, Instock, Units Sold, Sale
Price, COGS, Gross Profit, GP %. *(0 rows at capture time earlier — exact raw
keys populate once devices sell today; mirror the CSV columns.)*

### `claims_completed_{eugene,salem,clackamas}` (per claim, today)
Per-claim detail: Location, RQ Ticket #, Claim Status, Device, Description,
Returned-to-Cust color, Days Since Status Updated, Total, COGS, GP, GP %.
*(0 rows early-day; populates through the day.)*

## 4. Design conventions (must follow)

- **Brand:** fonts Nunito / Nunito Sans; `--red #DC282E --dark #2D2D3B
  --blue #4FB0E3 --grey #B9BDCB --light-grey #F3F2F2`. Match the other pages.
- **Store switching:** `.storesel` `<select>` dropdown, values =
  `CPRLocations.names()`, labels = `'CPR ' + display(name)`. Never pills.
- **Tabs + deep links:** if you use tabs (e.g. Today / Month / Team), persist
  in `localStorage` AND mirror in the URL hash (`#today`/#month/#team) —
  settings.html is the reference pattern. New tabbed tools must ship both.
- **Mobile app shell:** the page must feel native below 860px (this is the
  owner's phone-first morning read). Respect `--cpr-bb-h` for the bottom bar,
  safe areas are handled by nav.js. **Design mobile-first — the owner checks
  this on their phone each morning.**
- **Icons:** Lucide (nav uses `NAV_SVG`); no emoji in the chrome. Page-content
  glyphs are a separate call.
- **Title Case** for titles/tabs/section headers (owner preference).
- **Charts/trends:** history is thin at first (starts 7/21). A 30-day sparkline
  of GP or rank per store is a great someday-add but must no-op gracefully with
  1–2 days of data.

## 5. Layout is YOURS — but here's what the owner glances at first

The owner is **very** particular about UI (their words), so this is direction,
not prescription. From how they read the scorecard, lead with:
1. **Per-store cards, top of page:** store name, **franchise Rank** (big — it's
   the competitive hook), Total Sales, GP $ + **GP %**, ticket count. Today vs.
   MTD toggle. Rank in an accent chip.
2. **Employee leaderboard:** sorted by sales or GP, showing attach rate + accy/tkt
   (the coaching numbers). This is what drives 1:1s.
3. **Operational counts row:** device cleanings, express repairs, AKKO plans,
   claim payouts — compact tiles.
4. **Claims completed today** (per store) as an expandable detail table.

The **home-dashboard widget** should be a tight 1–2 line-per-store summary
(Rank · Total · GP%) linking into the full page — the "first thing I see"
version.

Confirm the lead-with priority with the owner before finalizing — they'll have
opinions on order and what's hero vs. secondary.

## 6. Caveats

- **Numbers are clean in our table** (proper floats). The owner's CSV export has
  a cosmetic double-decimal bug in Promos ("-$252.410.00") — that's their
  spreadsheet export, NOT our data. Ignore it.
- **Early-day zeros are normal** — `daily_digest`, claims, device sales fill in
  as the day progresses (the 4h cron refreshes). Empty states should read
  "nothing yet today," not "error."
- **Manager/owner only** by RLS. A regular employee gets no rows — show a clean
  "managers only" state, don't error.
- **Timezone:** `capture_date` is America/Los_Angeles (store time). Query
  today's date in that zone (snippet above), or the newest row won't match at
  night.

## 7. Wire-up checklist (definition of done)

- [ ] `daily-digest.html` reads `digest_raw`, renders store cards + employee
      leaderboard + ops counts, Today/Month toggle, `.storesel` switcher,
      hash-deep-linked tabs, mobile-first.
- [ ] Nav entry (My Hub, manager-gated) in `assets/nav.js` + tile in `index.html`.
- [ ] Home-dashboard "Today's Numbers" widget in the `REG` registry.
- [ ] Verified in headless Chromium at 390px + desktop.
- [ ] Update CLAUDE.md with a short Daily Digest paragraph.
