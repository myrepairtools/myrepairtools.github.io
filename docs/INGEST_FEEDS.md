# Ingest feeds — webhook reference

All RepairQ Looker deliveries POST to one Supabase edge function. Only the `feed=`
query param changes per report; the base URL and token are the same everywhere.

- **Base URL:** `https://xuvsehrevxackuhmbmry.supabase.co/functions/v1/ingest`
- **Token:** `cpr-ingest-2026-x7k9`
- **Method:** `POST`, body = the report rows (JSON array, or Looker's standard webhook payload)

## Feeds

| Report | `feed` value | Full webhook URL |
|---|---|---|
| Device sales (merge w/ accessory attach) | `commission_device` | `https://xuvsehrevxackuhmbmry.supabase.co/functions/v1/ingest?feed=commission_device&token=cpr-ingest-2026-x7k9` |
| Device returns (exchanges auto-excluded) | `commission_device_return` | `https://xuvsehrevxackuhmbmry.supabase.co/functions/v1/ingest?feed=commission_device_return&token=cpr-ingest-2026-x7k9` |
| Accessory sales (tickets, units, $, GP) | `commission_accessory` | `https://xuvsehrevxackuhmbmry.supabase.co/functions/v1/ingest?feed=commission_accessory&token=cpr-ingest-2026-x7k9` |
| Services (per-SKU counts + service $) | `commission_service` | `https://xuvsehrevxackuhmbmry.supabase.co/functions/v1/ingest?feed=commission_service&token=cpr-ingest-2026-x7k9` |
| Accessory categories (per-category units) | `commission_category` | `https://xuvsehrevxackuhmbmry.supabase.co/functions/v1/ingest?feed=commission_category&token=cpr-ingest-2026-x7k9` |
| Device Inventory List (Sold) — per-unit, feeds Device Ordering | `device_sales` | `https://xuvsehrevxackuhmbmry.supabase.co/functions/v1/ingest?feed=device_sales&token=cpr-ingest-2026-x7k9` |
| Device Inventory List — per-unit snapshot, feeds Device Ordering | `device_inventory` | `https://xuvsehrevxackuhmbmry.supabase.co/functions/v1/ingest?feed=device_inventory&token=cpr-ingest-2026-x7k9` |

## How it behaves

- **One URL per report covers all three stores** — the ingest reads
  Location / Employee / Accounted on Date off each row, so Eugene, Salem, and
  Clackamas can all post to the same URL.
- **Keyed on (date, store, employee)** with partial-column upserts, so re-sending
  the same day overwrites with the same numbers (idempotent — safe to resend or
  backfill).
- **Device returns:** Looker sends returns with Return Count positive and
  $/GP negative; the feed nets them out (count off net devices, GP off device GP,
  returned accessories off the attach numerator). Rows where a device was returned
  **and re-sold on the same ticket** (an exchange, `Device Sale Count > 0`) are
  skipped so they don't cancel a real sale.

## Not built yet

- **Accessory returns** — no `commission_accessory_return` feed exists. If you want
  accessory refunds netted the same way devices are, it's a quick add (its own feed
  + columns, mirroring the device-returns design).

## Device Ordering feeds (device-orders.html)

Unlike `commission_device` (per-employee/day aggregates), these two carry
**one row per physical device** and fill the Device Ordering page's tables —
the same data as dropping the exports on the page by hand, so the drag-drop
stays as a manual fallback/backfill.

- `device_sales` ← the **"Device Inventory List (Sold)"** report. Upserts on the
  RepairQ device ID — history accumulates, resend anytime. Requires a
  `Sold Date` column (guard refuses otherwise).
- `device_inventory` ← the **"Device Inventory List"** report. Snapshot semantics:
  rows are replaced **per store present in the payload** (a one-store delivery
  can't wipe the others). Requires `Status` + `Added Date` columns.
- Store names are kept as the **raw RepairQ location name** (`CPR Clackamas OR`),
  NOT normalized through the `stores` table like the commission feeds — the
  device tables key on the locations.js canonical names.
- Schedule both nightly (any time after close); the page's freshness line shows
  when each last arrived.

## Column expectations (per feed)

- **commission_device / _return:** Location, Employee, Accounted on Date,
  Ticket Number, Device Sale Count, Device Return Count, Device Net Sale Price,
  Device Gross Profit, Accessory Count (sales) / Accessories Returned (returns).
- **commission_accessory:** Location, Employee, Accounted on Date, plus
  Tickets (`Accy Tkt #`), Accy Count, Accy Total, Accy GP.
- **commission_service:** Location, Employee, Accounted on Date, one column per
  service SKU (counts), plus an optional service revenue column.
- **commission_category:** Location, Employee, Accounted on Date, one column per
  accessory category (unit counts).
