# Eugene (799) Report Catalog — canonical reporting source

**Decision (Britt, Jul 2026):** Eugene is the main store. All live reporting pulls
authenticate as the **Eugene embed user (RepairQ location `799`)** and pull **all
stores** by overriding the `location.short_name` filter. This replaces the older
mix where some reports lived only in Clackamas's (917) Looker folder and some only
in Eugene's — going forward every canonical report is an **Eugene-folder** report so
one identity sees them all.

## How the pull works

The `repairq-query` edge function authenticates RepairQ under a chosen location
(isolated from the live global session), mints a Looker embed session, and runs a
captured querymanager body. Action: **`looker_body_as`**

```jsonc
{ "action": "looker_body_as",
  "login_location": "799",
  "location_override": "CPR Eugene,CPR Salem Northeast,CPR Clackamas OR",
  "body": { /* the literal querymanager --data-raw from the dashboard's cURL */ } }
```

`location_override` rewrites every `location.short_name` filter in the body.

### ⚠️ Store-name gotchas (Looker `location.short_name`)

| Store | Looker name | Notes |
|-------|-------------|-------|
| Eugene | `CPR Eugene` | |
| Salem | `CPR Salem Northeast` | |
| Clackamas | `CPR Clackamas OR` | **has the " OR" state suffix** — `CPR Clackamas` matches nothing |

- **Canonical filter:** `CPR Eugene,CPR Salem Northeast,CPR Clackamas OR`
- **NEVER** send an empty `location.short_name` — an empty filter pulls the **entire
  CPR franchise network** (West Chester PA, Beaverton, … other owners' stores).
- When writing to our tables, `appStoreName()` strips the trailing ` OR`/` WA`/` PA`
  so `CPR Clackamas OR` → `CPR Clackamas` to match `CPRLocations`.

## Look-ID mapping — 917 (old) → 799 (canonical)

Britt supplied the full Eugene Look set (Jul 2026). All 8 confirmed accessible to
799. **This is the cutover map** for the Look-based crons/consumers.

| Report | Old Look (917/Clackamas) | **New Look (799/Eugene)** | Consumer |
|--------|--------------------------|---------------------------|----------|
| All Part Inventory (stock) | 5784 | **5775** | `sync_stock` → `stock` |
| Part Consumption | 5785 | **5774** | `sync_consumption` → `consumption_log` |
| Claim Payouts | 5790 | **5759** | claims → `claim_repairs` |
| Claim Payout: Parts | 5789 | **5760** | claims → `claim_parts` |
| Accessory Sales by Employee | 5792 | **4591** | commission accessory |
| Item Sales / Services | 5798 | **5399** | commission service |
| Repairs w/o Parts | 5804 | **5803** | commission (no-part repairs) |
| Category Sales | 5817 | 5817 | commission category |

Pull any of these as 799 for all stores:
```jsonc
{ "action": "looker_pull_as", "login_location": "799", "look_id": "5775",
  "location": "CPR Eugene,CPR Salem Northeast,CPR Clackamas OR",
  "force_location": true }
```
- **Verified:** 5775 pulled as 799 → 5000 rows (limit cap), Eugene 2142 / Salem 1652
  / Clackamas 1206, columns match `sync_stock`. Bump the Look's `limit` past 5000
  when wiring so no SKUs are dropped.

## Reports (all in the Eugene / 799 folder)

Captured from browser cURLs (element_id + result_maker_id + default filters). 799
is confirmed to have content access to each.

| Report | Kind | Dashboard | Tiles (element_id · result_maker_id) | Date field |
|--------|------|-----------|--------------------------------------|-----------|
| Category Sales | Look | — | Look `5817` | `ticket_item.accounted_on_date` |
| Device Sales | dashboard (merge) | `2827` | `12289` · `31223` | `ticket_item.accounted_on_date` |
| Device Inventory List | dashboard | `1317` | `6744` · `30287` (Instock/Ordered/Pending/Pulled), `9596` · `26084` (sold-in yesterday) | `inventory_item.status_updated_date` |
| Device Inventory (Sold) | dashboard | `2330` | `10113` · `27819` (Sold, status-updated window), `10114` · `26084` (Instock, sold-in yesterday) | `inventory_item.status_updated_date` |

Device Returns (Eugene) dashboard `2830` (element `12289` · `31236`) is Eugene-only
by design; the all-store returns come from the device-sales/returns tiles above.

### Verified
- `2330` tile `10113` pulled as 799 with the canonical 3-store filter → rows for
  Eugene + Salem + Clackamas (16 rows, last month). Empty filter → 5 franchise
  locations (proof 799 is not row-locked; proof empty = leak).

## Cutover status (Jul 2026)

| Feed | Source (799 Look/dash) | Path | Status |
|------|------------------------|------|--------|
| stock | 5775 | live pull → `stock` | ✅ live, cron `repairq-stock-sync` |
| consumption | 5774 | live pull → `consumption_log` | ✅ live, cron `repairq-consumption-sync` |
| claim_repairs | 5759 | pull→relabel→`ingest` | ✅ live + validated, cron `repairq-claims-sync` (8:25 UTC) |
| claim_parts | 5760 | pull→relabel→`ingest` | ✅ live + validated (same cron) |
| commission_accessory | 4591 | pull→relabel→`ingest` | ✅ live + validated (cron `repairq-commission-sync`, :20 hourly) |
| commission_service | 5399 (**pivot**) | pull→flatten pivot→`ingest` | ✅ live + validated (same cron) |
| commission_category | 5817 (**pivot, date injected**) | pull→flatten pivot→`ingest` | ✅ live + validated — restored dead feed (same cron) |
| commission_device | 2827 (**merge**) | merge-pull→relabel→`ingest` | ✅ live + validated exact match (same cron) |
| commission_device_return | 2830 (**merge**) | merge-pull→relabel→`ingest` | ✅ live + validated exact match (same cron) |

**All feeds cut over to Eugene 799.** Orchestrators: `sync_claims` (both claim
Looks), `sync_commission` (all five commission feeds; accessory/service/category
refresh the whole current month, device the month, device-returns the year).
Crons: stock (7,37), consumption (12,42), claims (8:25 daily), commission
(:20 hourly). Field maps live in `INGEST_FIELD_MAP` + the pivot/merge helpers in
`repairq-query`.

### The bridge (proven)
`sync_ingest` / `sync_claims`: pulls a Look as the global 799 session, renames
API fields → the human LABEL headers `ingest` expects (`INGEST_FIELD_MAP`), and
POSTs to `ingest` so its exact money-table logic runs (no aggregation
reimplemented). `dry_run:true` returns the transform for inspection.

### Commission — remaining work per feed
1. Sample the Look/merge, note its API field/pivot shape.
2. Extend `INGEST_FIELD_MAP` (flat feeds) OR add a pivot-flatten step
   (category/service — nested `{cat:{value}}` → flat `"Accessory - Case": count`).
3. Device feeds run via the `looker_body_as`/merge path, not a plain Look.
4. **Validate**: `dry_run`, then real run into a scratch compare — the live-pull
   output must match current `commission_sales` for a known finished month
   before scheduling the cron.

## Still to wire (supervised — these feed money/commission tables)

- device_inventory ← `1317`, device_sales ← `2330` (device-orders page)
- category sales ← `5817` (commission category)
- commission device-attach ← `2827` (device sales) + returns
- Keep stock (`5784`) / consumption (`5785`) crons as-is until they're confirmed
  visible to 799 (currently 917-folder) or moved to the Eugene/group folder.
