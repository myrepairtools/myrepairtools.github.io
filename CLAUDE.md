# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Internal web tools for CPR Oregon (a phone-repair business), served as a **static
site on GitHub Pages** at `myrepairtools.github.io`. There is **no build system, no
package manager, and no test suite** — every page is a hand-authored `.html` file with
inline `<style>` and `<script>`. Deployment is just `git push` to `main`; GitHub Pages
serves the repo root.

To preview locally, open a file directly or run any static server, e.g.
`python3 -m http.server` then visit `http://localhost:8000`.

## Standing directive: design for AI

**The owner wants every tool we build or touch to be AI-compatible, and wants AI
progressively woven into the site.** Apply this by default — it does not need to be
re-requested:

- **Keep data in clean Supabase tables (not buried in page-only state).** The AI
  assistant reads/writes the database server-side via an edge function — never through
  the HTML pages — so any data a tool produces should live in well-named Postgres tables
  the assistant can query. Prefer Supabase over Apps Script for new data (continues the
  existing migration).
- **The AI proxy is the `cpr-assistant` Supabase edge function** (holds
  `ANTHROPIC_API_KEY` as a secret; the key must never ship to the browser). The chat
  widget is `assets/cpr-assistant.js`, injected site-wide by `nav.js` and openable via
  `window.CPRAssistant.open()`. Default model `claude-opus-4-8`; the Anthropic Messages
  API is streamed back as SSE.
- **Reads before writes.** Data-access "tools" the assistant can call are scoped query
  functions defined in the edge function, gated by the existing `permissions` /
  `role_permissions` system. Write actions must be **named, permission-checked,
  confirm-gated** (read → propose → human confirms → write → audit-log) — never raw SQL.
- When adding a feature, ask "how would the assistant see or do this?" and leave the
  data model and permissions in a state that answers it.

## Standing directive: build like a future product

**The long-term aim is to turn these tools into a real product other CPR franchisees (and
eventually any repair shop) could use — a company, not just CPR Oregon's internal site.**
That's a *someday*, not a mandate to over-engineer today; the job right now is still a
fast, working internal tool. But when a choice is a coin-flip, pick the one that doesn't
paint a future product into a corner:

- **Don't hard-code CPR-Oregon specifics** where a table, config, or `CPRLocations`/`stores`
  lookup would let another shop use the same code. Stores, roles, rates, goals, hours,
  templates — data, not literals. (We already fought the two-store-name problem; keep new
  code multi-tenant-friendly by default.)
- **Secrets stay server-side, always.** The browser never holds an API key/JWT — every
  integration goes through an edge function (messaging, twilio-call, square-pay,
  repairq-query, cpr-assistant all follow this). Never add a new browser-held secret. The
  committed anon key + deterrent-level gates are a deliberate *interim* posture for an
  internal tool; don't extend that pattern to anything a paying customer would touch.
- **Isolate the RepairQ dependency.** Scraping + the undocumented internal API are great
  hacks but a shaky product foundation — keep that coupling behind a clear seam (the
  extension, `repairq-query`) so it's swappable, not woven through every tool.
- **Clean, well-named, RLS'd data** (see the AI directive above) is also the product
  foundation — the same tables that make the assistant work make multi-tenant later possible.
- This is a lens, not a checklist. Note in passing when a shortcut would be hard to undo
  at product scale; don't block internal velocity over it.

## Page model

Each tool is **one self-contained HTML file** at the repo root (e.g. `cash-tracker.html`,
`claim-ledger.html`). All CSS and JS for a tool live inline in that file. The only shared
code is in `assets/`. There is no component system or templating — when a pattern needs to
change across tools, it changes in each file or in a shared `assets/*.js`.

`index.html` is the **employee dashboard** — the landing page for everyone after sign-in
(also listed under **My Hub** in `nav.js`). It greets the user (`window.CPRNavName`) and
renders a **widget registry** (the `REG` array in its inline script): each widget is a
module `{ id, title, icon, accent, defaultSize, tag, link, can(), render(), mount() }`.
In "Customize" mode each widget is **drag-reorderable**, has a **100/60/40 width preset**,
can be **removed**, and an **"＋ Add a widget"** gallery offers any registry widget not on
the board (gated by `can()` against role/`window.CPRPerms`). To add a widget, push a module
to `REG`; that's the whole "widget library." Layout persists **per-user in Supabase**
(`dashboard_layouts`, keyed by `staff_id`) with a `localStorage` (`cprDashLayout`) cache /
offline fallback. Several widgets still carry sample/Preview data; the **My Commission**
widget is wired to real numbers via `assets/commission-summary.js`. `operations.html` /
`admin.html` are thin redirect/landing stubs. `login-test.html` / `settings.html` are
utility pages.

The brand system (reused everywhere): fonts `Nunito` / `Nunito Sans`; CSS custom props
`--red:#DC282E --dark:#2D2D3B --blue:#4FB0E3 --grey:#B9BDCB --light-grey:#F3F2F2`. Match
these when adding UI so a new tool looks native.

## Shared assets (`assets/`)

- **`nav.js`** — the navigation shell. Injects the fixed icon-rail + slide-out menu pane
  into every page, defines the canonical tool lists (`OPERATIONS` + `PRIVILEGED` +
  `SETTINGS` et al.), and owns role-based visibility. **When you add or rename a tool,
  update the right area array here** (and the tile in `index.html`) or it won't appear in
  the nav. **The rail-bottom gear is a real area** (not a link): clicking it swaps the pane
  to the `SETTINGS` list (Team Members, Locations, Notifications, Page Settings, Commission,
  Integrations, Roles & Permissions) and highlights the gear like any area icon. Every row
  deep-links to `settings.html#<tab>` (staff/loc/notif/pages/commission/integ/roles — the
  page opens that tab from the hash, listens to hashchange, keeps the hash synced via
  replaceState, and owner-gates integ/roles). settings.html's own tab strip is hidden
  (kept in the DOM so bindings stay harmless); a dynamic per-section header renders in its
  place. The nav Settings pane is the only section switcher — don't add page-level ones.
  The Locations tab manages the `stores` table (RQ name, color, active); the canonical
  cross-tool store list still lives in `assets/locations.js`.
  **Admin-page access pattern:** an admin page that manages a front-end tool (Cash Admin,
  Schedule Admin, Task Admin) is reached from an **`.adminbtn` button in the header of the
  tool it manages** (Cash Tracker / My Time / Checklist) — not from the nav menus. Keep its
  nav entry with `hidden:true` (stays registered for rail highlighting; never renders in a
  menu). The button is always visible: enabled for admin/owner, greyed (`.off`) with a toast
  for everyone else; the page itself stays gated. The link is **two-way**: the admin page
  carries a back-to-tool button in the same header spot (Cash Admin → 💵 Cash Tracker,
  Schedule Admin → 🗓️ My Time, Task Admin → ✅ Checklist), so the button in that spot just
  toggles between admin and tool. Follow this pattern for new admin pages.
- **`site-gate.js`** — site-wide front-door password. One shared password, cached forever
  in `localStorage` (`cpr_site_unlocked`). A casual-access deterrent, not real security.
- **`admin-gate.js`** — per-person passcode overlay for protected pages. Verifies
  server-side, caches in `sessionStorage` with a 30-min idle relock, and exposes
  `window.CPRGate` (`user()`, `ownerCode()`, `lock()`, plus admin/employee CRUD helpers).
  Fires a `cpr-unlocked` event on success.
- **`locations.js`** — **single source of truth for the store list** (Eugene, Salem
  Northeast, Clackamas). Exposes `window.CPRLocations` (`names`, `normalize`, `display`,
  `sort`, `options`, `find`). Store `name` must match RepairQ/sheet exports exactly;
  `aliases` resolve older spellings. Add/rename/remove stores **only here**.
- **`hyla/rq-device-catalog.json`** — RepairQ device catalog consumed by `hyla-orders.html`.
- **`qrcode.js`** — vendored qrcode-generator (MIT); global `qrcode(type, ecc)`. Used by
  `lcd-buyback.html` for send-display labels; the extension carries its own copy.
- **`commission-engine.js`** — shared commission math (`window.CommissionEngine`); single
  source of truth for the Commission Calculator (nav label "Payroll · Commission & Tips" —
  same tool, payroll-focused name; file stays commission-calculator.html) + Dashboard.
  Never re-implement the math.
- **`commission-summary.js`** — one call (`window.CPRCommissionSummary.forMe()`) returning the
  signed-in user's current-month `{ commission, tips, total, goal }` using the engine. Used by
  the dashboard's My Commission widget; load `commission-engine.js` before it.
- **`schedule-summary.js`** — one call (`window.CPRScheduleSummary.forMe()`) returning the
  signed-in user's `{ today, weekHours }`, mirroring `my-schedule.html`'s shift-resolution
  logic (shifts → shift_hours, named-shift + label fallbacks). Used by the My Schedule widget.
- **`leaderboard-summary.js`** — one call (`window.CPRLeaderboard.forStore()`) returning the
  current-month per-tech `{ accy, devUnits, devAccy }` for the viewer's store (RLS
  `can_see_store` scopes it). Powers the Store Leaderboard widget's accessory-$ / device-units
  toggle.
- **`checklist-summary.js`** — one call (`window.CPRChecklist.forMe()`) returning today's
  checklist for the signed-in user (`{ tasks, open, done, overdue }`) plus
  `markDone(id, done)`; mirrors `checklist.html`'s row semantics (assigned-or-eligible,
  'each' = own completion row). Used by the dashboard's My Tasks widget.

## Auth & roles

Three independent, layered gates (a page opts in by including the script tags):

1. **Site gate** (`site-gate.js`) — shared password, gates the whole site per device.
2. **Nav role auth** (`nav.js`) — verifies a passcode → role, stored in `localStorage`
   (`cprNavAuth`, 15-min idle). Roles rank `none < employee < admin < owner`. The nav
   broadcasts the role via `window.CPRNavRole` and a `cprnav:auth` event; pages listen to
   show/hide privileged content (see the role logic at the bottom of `index.html`).
3. **Admin gate** (`admin-gate.js`) — separate per-person passcode for sensitive pages,
   uses `sessionStorage` and `window.CPRGate`.

A page is "privileged" if it appears in `nav.js`'s `PRIVILEGED` list with a `minRole`.
Public/operations tools simply omit `admin-gate.js`. All three gates skip themselves inside
an iframe (`window.self !== window.top`) so tools can be embedded in RepairQ.

## Backends — two generations (migration in progress)

There is **no single backend**. Tools talk to one of two systems:

1. **Google Apps Script web apps** (older). Each tool has its **own `/exec` deployment URL**
   hardcoded near the top of its file, backed by a Google Sheet. Calls are
   `fetch(URL, {method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'},
   body: JSON.stringify({action, token, ...})})` returning JSON `{ok, ...}`. The
   `text/plain` content-type is deliberate — it avoids a CORS preflight against Apps Script.
   Auth services (`site-gate`/`admin-gate`/`nav`) are themselves Apps Script deployments.

2. **Supabase** (newer; the active migration target — see recent "Cash Tracker Migration"
   commits). Project `xuvsehrevxackuhmbmry.supabase.co`, client imported from the
   **vendored bundle `/assets/supabase-js.js`** (self-contained minified ESM build of
   `@supabase/supabase-js` v2.110.5 — one same-origin request instead of esm.sh's
   third-party module graph; rebuild instructions in the file header; edge functions
   still import from esm.sh — that's Deno, leave them). Tools on Supabase: cash-tracker, cash-admin,
   consumption-report, settings, login-test, damage-tracker, employee-records, hyla-orders,
   claim-payouts, commission-calculator, commission-dashboard, schedule pages,
   time-entries, monthly-goals, checklist, task-admin, device-orders, cash-journal.

**Device ordering (`device-orders.html`, Ordering & Inventory nav):** used-device
consumption + suggested buys, the device-side sibling of the parts consumption report.
Data arrives **automatically**: the `repairq-devices-sync` pg_cron (:50 hourly) calls
`repairq-query`'s `sync_devices`, which pulls the two Eugene Looker dashboards live
(1317 "Device Inventory List" tile 6744 → `device_inventory` full per-store snapshot;
2330 "Device Inventory List (Sold)" tile 10113, 1-month window → `device_sales`
upserted on RepairQ ID — history accumulates) and hands the rows to `ingest`'s device
handlers. Manual zip/csv upload on the page still works as a fallback. Device tables
key on the RAW RepairQ store name ("CPR Clackamas OR" — no suffix strip). Rows group by `model_key` (device name minus
storage/color, e.g. "iPhone 15 Pro Max"); per model: sold-30d, sellable stock
(Instock + Pending Refurb), Ordered, days of cover, oldest-unit age (stale > 60d),
and a suggested buy from a per-30d demand rate over up to 60 days of history
(normalized by how much history the uploads actually cover), computed **per store**
(All view sums the per-store numbers) and **hard-capped per model per store**
(default 4 — phones depreciate; never concentrate risk in one SKU). Cover dial is
capped at 30 days for the same reason; both dials persist in localStorage. 🔥 marks
hot movers (3+/month and avg shelf-turn ≤ 14d); ▪ on a suggestion means demand
wanted more but the cap held it. 📋 Copy order list emits a per-store buy list
(devices are ordered through Hyla/vendor portals — no quick-order export). Store
chips normalize through CPRLocations; page adopts the shared PIN session
(authenticated RLS on both tables).

**Cash journal (QBO month-end):** `cash_journal` (store, month 'YYYY-MM',
starting_cash, ending_cash, cash_deposited, generated `store_revenue` =
ending − starting and `ending_on_hand` = ending − deposited, note, updated_by/at;
unique store+month; RLS owner-only via the new `is_owner()` helper). Surface:
`cash-journal.html` (owner-only; PRIVILEGED nav 'Cash Journal', permission key
`cash.journal`) — a 12-month year grid per store; `ending_on_hand` carries forward
into the next month's `starting_cash` (an "adjusted" flag marks months where the
start was overridden), revenue/on-hand compute live, and each month has a
"📋 JE" copy block for the QBO journal entry (cash revenue, deposits to match in
banking, Cash on Hand adjustment). Closed `cash_audits` feed BOTH suggestions:
Cash Deposited (bank_deposit + small_to_bank) and Ending Cash (the audit's
`cash_audit_locations.counted` summed — drawers + safes, verified to the dollar
against the owner's workbook); store names matched via CPRLocations aliases.
The 2025+2026 history was imported from the owner's workbook.
**QBO push:** each complete month also has an "⬆ QBO" button → review modal →
the **`qbo` edge function** posts the journal entry straight to QuickBooks Online
(debit "Cash on Hand — <store>", credit the store-revenue income account; TxnDate
= month end; negative months swap postings). Intuit OAuth mirrors qbtime-oauth
(secrets `QBO_CLIENT_ID`/`QBO_CLIENT_SECRET`, tokens + realm in
`integration_tokens` provider 'qbo'; **Intuit rotates refresh tokens — every
refresh persists the new one or the connection dies in 100 days**). The JE amount
is **server-computed from the row** (never client-supplied); an atomic claim on
the row prevents double-posts; receipts stamp back onto `cash_journal`
(qbo_je_id/doc_number/posted_at/by/amount — the page flags ⚠ drift when a posted
month is later edited) and every post logs to `qbo_post_log`. Account mapping per
store lives in `qbo_store_map` (owner RLS), edited in **Settings → Integrations →
QuickBooks Online** (Connect + per-store Cash-on-Hand/Revenue account dropdowns
from the live QBO chart of accounts, plus a per-store **Class** — the owner's P&L
is class-segmented, so post_je stamps ClassRef on both JE lines; `?action=classes`
feeds the dropdown). Deposits deliberately stay in QBO's bank
feed (recorded there as Transfers to Cash on Hand — the modal shows the total to
match). Schema: docs/sql/cash-journal-schema.sql + cash-journal-qbo.sql.

**Personal-device sessions:** pin-gate's 5-min idle auto-sign-out is SKIPPED in
standalone display mode (Added-to-Home-Screen apps) — an installed app is a personal
device whose lock screen is the security boundary, and iOS firing the expired idle
timer on resume forced a PIN on every open. Sign in once per install; the 5-min
relock still applies to regular browser use on shared store machines. (Each iOS
home-screen install is its own storage silo — separate sign-ins per installed app
is Apple behavior, not ours.)

**Expenses (mobile receipt recorder):** `expenses.html` (PRIVILEGED nav 'Expenses',
permission key `expenses.record`, owner RLS) — the phone-first replacement for the
QuickBooks receipt app, designed to be Added to Home Screen (`assets/expenses-manifest.json`,
root-relative; standalone mode grows `--cpr-top-h` by `env(safe-area-inset-top)` so the
iOS status bar doesn't cram the nav top bar). Flow: snap/pick a receipt photo
(canvas-downscaled to ≤1600px JPEG) — **the `qbo` function's `extract_receipt` action
(Claude vision, haiku) then reads it and prefills amount/date/vendor**, filling only
fields the owner hasn't typed (✨ status line under the thumb; retakes cancel in-flight
reads via a sequence counter) → amount|date (two-col row) → Paid With (Bank/CC accounts,
**filtered by the Settings allowlist** — `qbo_config` key 'paywith', edited in Settings →
Integrations → QuickBooks Online → "Expenses · Paid With Accounts", re-checked on every
page open) → expense account (type-to-search combobox over the QBO chart of accounts +
last-5 recent chips) → Class, or **⚖️ Split Evenly Across Stores** (store toggle chips,
all pre-selected, tap one off for a 2-store split, min 2; remainder cent rides the first
line) → **Vendor combobox** over the QBO vendor list (`?action=vendors`) — an exact match
writes `qbo_vendor_id/_name` and the Purchase carries `EntityRef type Vendor` (server
also probes QBO by DisplayName for unlinked typed names); free text still books fine →
Save (fixed footer save bar, content scrolls above it). Save uploads the photo to the
private `receipts` storage bucket (`YYYY/MM/<uuid>.jpg`), inserts an `expense_receipts`
row (status `pending`), then calls the **`qbo` edge function's `create_expense`** action,
which books a QBO **Purchase** (PaymentType from the account type, one line per class on
splits) and attaches the photo (Attachable multipart) so the bank feed offers a one-tap
**Match**. Double-post safety: atomic claim (status `posting` + `qbo_claimed_at`, 2-min
stale takeover), `DocNumber = MRT-<id8>` idempotency key with a recovery probe (query
Purchase by DocNumber before creating), guarded final stamp; failures stamp status
`failed` + error and the page's Recent list offers tap-to-retry on the SAME receipt row
(409 `already_posted` counts as success). Chart of accounts/classes/vendors + allowlist
cache in localStorage (`cprExpQbo`, 1h) for instant paint. Note: elements hidden by a
CSS class rule need `style.display='block'` to show — `display=''` falls back to the
stylesheet's `display:none`. Schema: docs/sql/expenses-schema.sql (+ `qbo_config`).

**Monthly goals:** `commission_goals` (staff_id, month, accy_goal, device_goal,
device_attach_goal %, case_goal, sp_goal, power_goal, service_goals jsonb, note) —
per-employee monthly targets set during 1:1s **in the commission dashboard's Goals tab**
("🎯 Set goals" modal, manager/owner only via `can_see_staff` RLS; this/next-month toggle).
Employees see a "Meeting targets" progress card on the same tab. Only `accy_goal` affects
pay (it gates the accessory goal bonus); resolution is month goal → `commission_roster.accy_goal`
default, and a row may carry other targets with `accy_goal` null (consumers must null-check).
Consumers: commission-dashboard, commission-calculator (range's start month),
assets/commission-summary.js. There is deliberately no separate goals page.
The commission dashboard (My Commission) has a **viewed-month navigator** (pickers.js
month dropdown next to the tabs, future months blocked) — every tab (Overview / Goals /
Scoreboard) recomputes for the picked month, so employees browse past commissions and
that month's goals; past months render in final tense (no pace/projection cards, no
goal-review card) and the month label goes amber as a "viewing history" cue.

**Month-end archive:** `commission_snapshots` (staff_id, month, totals jsonb,
breakdown jsonb — the full engine output, cfg jsonb — the exact goal/earns/rules/rates
used, tips, total, finalized_by/at; unique staff_id+month; RLS: employees read own,
managers write). Live recompute means a rate/goal/roster change silently rewrites
history, so the archive is written **from the calculator at payroll**: the Summary tab's
**📸 Archive <month>** button (enabled only when the range is exactly one full, finished
calendar month — Quick range → Last month) opens a confirm modal listing everyone's
commission + tips as this run computed them, then upserts one snapshot per person
(rows without a linked staff_id are skipped; warns on re-archive overwrite and on a
tips-period ≠ month mismatch). This is the validation guarantee: what employees see IS
what payroll paid. The dashboard (My Commission) has no archive button — viewing an
archived month there shows the snapshot instead of recomputing: profile header says
"📸 archived", Overview carries an archived pill, the Scoreboard overlays snapshot
numbers, and the 12-month trend uses archived totals where they exist. The calculator
itself always stays live — it *generates* payroll; the archive freezes what it produced.

**Tips:** `commission_tips` (store, period 'YYYY-MM', pool, hours jsonb {name:{pp1}}) —
tip share = (your hours / store hours) × store pool; consumers sum pp1+pp2 so legacy
two-period rows still read. The calculator's Tips tab has **one hours box per person
per month**, pre-filled from `qbtime_timesheets` (hourly-synced from QB Time; PTO
jobcode seconds excluded) with a "↻ Refill from QB Time" overwrite button; number
inputs are spinner-free site-wide on that page. The pool auto-feeds from Square:
`tips_daily` (store, biz_date, amount; unique store+date; authenticated read,
edge-function write) is filled by the **`square-tips` edge function** — `?action=pull`
hits the Square Payments API per location (needs the `SQUARE_ACCESS_TOKEN` function
secret; locations auto-matched to stores by name) via the `square-tips-daily` pg_cron
(9:15 UTC, 3-day lookback), and `?action=ingest` accepts webhook JSON (Zapier/email
parser) — both auth by `TIPS_SECRET`. Every write rolls the month up into
`commission_tips`: pool = sum of the month's daily rows, hours refreshed from QB Time
for that store's staff (manual extra names preserved) — so employees' dashboard tips
update daily without manual entry.

**Contracts platform:** `contracts` (random `token` = the customer's capability URL;
status draft→sent→signed→paid | void; `terms` jsonb snapshots the template at creation so
signed contracts keep their wording forever; `contract_type`/`template_id`; signature png
+ signed_at/ip/ua; price, `diag_fee` (diagnostic already collected — default $49.99,
editable — credited against the price) and `collect` = the remaining balance;
`pay_mode` 'remote' = Square pay link right after signing, 'instore' = sign only —
payment runs through RepairQ → Square Terminal at the counter, closed out with the
"✓ Paid" list action) + `contract_templates` (many templates, each = intro with
{business}/{customer}/{date} placeholders + ordered clauses + optional repair
outcomes + optional `library` + approved/active — **contracts can only be created from
approved templates**; deletable — existing contracts keep their snapshot) +
`contract_clauses` (shared one-size-fits-all clauses — refund, warranty… — that
templates LINK as `{clause_id}` sections alongside inline template-specific clauses;
editing a library clause updates every linking template, and creation resolves links
to full text in the `terms` snapshot) + `contract_services` (per-`library` price
lists, grouped by vendor: default customer price + optional vendor cost + `tiers`
jsonb [{price, cost, devices:[…]}] for device-tiered pricing (per-tier vendor cost optional) — device names match
`device_models` (the curated model list) exactly). Surfaces: `contracts.html`
(Operations nav, any staff — template-first New Contract with a **device→vendor→service
workflow**: device autocompletes from device_models; when a library has multiple vendors
(e.g. VCC Board Repairs vs EZ Fix) the tech picks the vendor, then the service list shows only
that vendor's services priced for that device (tier match else default; 0 default = tier-only) and
the resolved price locks; table list Date/Status/Type/Customer/Device/Price/actions,
🖨 vendor work-order print — no prices on it — that travels with the device, RepairQ
ticket required) and `contract-sign.html`, a **public customer page with no gates/nav**
(the token is the credential): outcome pick (if the template has outcomes), canvas
signature, then a payment summary (price − diagnostic = due now) before the Square
payment link — sign → pay is one motion. Templates, the clause library, and service libraries are managed in
**Settings → Page settings → Contracts** (managers) — each a rail-list + detail-pane
editor like the Templates tab; `contract_libraries` is the managed category list
(services and templates reference a library by name, renames cascade). The `contracts` edge function does
the customer side (view / sign — creates the Square quick-pay link with a redirect back /
paystatus — flips to paid by checking the Square order / send — emails the link via
Resend/Gmail like notify). Store→Square location resolved by name like square-tips.

**LCD Buyback (screen harvest):** every pulled display from an iPhone / Galaxy S /
Galaxy Note / Galaxy Z / Pixel screen repair gets graded good/bad; **only GOOD pulls are
physical inventory** — labeled, boxed, expected by audits, valued. Bad pulls are
log-only (worth ~quarters; Apple KBB claims also require sending them back, which made
tracking them as inventory produce false "missing" flags). The accountability signal on
bads is statistical instead: a per-tech good/bad/bad-rate table on the page's All
records tab (managers) — a tech misgrading good screens to pocket them surfaces as an
outlier bad-rate. Audited when the recycler buys. Tables: `lcd_displays` (**ticket_no = the display's serial and the QR
content**; item_key disambiguates 2+ pulls on one ticket; store, model, status
good|bad, graded_by + resolved staff_id, status_history jsonb, label_prints,
audit_id/audit_result/audited_at, missing, deleted) + `lcd_audits` (store null = all,
start/end window, open→closed, summary jsonb frozen at close) + `lcd_audit_scans`
(bucket good|bad|aftermarket, recorded_status snapshot, is_match; unique
audit+ticket) + `lcd_prices` (per-model GOOD-pull value; key normalized —
whitespace collapsed, trailing 5G/4G stripped, case-insensitive match; **manager-only
by RLS** so techs never see dollars; edited on the page's Prices tab, unpriced
captured models float to the top; seeded from the recycler's cpr.parts sheet, OEM
column). Est. value shows managers a value column, box-value/missing-value tiles,
and payout + missing dollars frozen into the audit summary at close. Capture happens in the **myRepairTools Chrome extension** (see below):
adding a matching screen-repair line item pops a Good/Bad modal — the trigger is
text-based on the item NAME (family regex + "screen repair/replacement") so new
models need no update; families toggle in extension Options. Answers POST to the
**`lcd-buyback` edge function** (`x-cpr-secret` = `LCD_SECRET` function secret,
service-role writes; actions capture/get/printed/status). On a brand-new ticket the
answer waits in tab sessionStorage until the save produces a ticket number. Printing
the ticket label auto-appends a **Dymo 30334 send-display label** per logged display
(store, GOOD/BAD pill, model, ticket #, date, QR = ticket number, post-removal
checkboxes) — the extension's print gate holds RepairQ's auto-print until the label
is injected (4s safety net). Surface: `lcd-buyback.html` (Operations nav, all staff):
Queue (in the box) / Audits / All records tabs + store chips; managers get inline
status flip (appends to status_history), soft delete, and 🖨 label reprint
(assets/qrcode.js). **Audits** (managers, one per recycler visit): window = last
audit's end → picked date; three scan tabs (Good/Bad/Aftermarket) with a scan bar —
scan each label's QR into the bucket the recycler sorted it into; expected = every
unaudited display captured by the window end (plus still-missing strays, so lost
screens stay findable); closing stamps scanned displays, flags unscanned as
**missing** (keeping their recorded status — that's the theft/loss signal), and
freezes the summary jsonb (counts, grade accuracy, missing list). Scorecard /
commission tie-in deliberately deferred.

**Square virtual terminal (backup register):** a Square-logo button in the top bar
(nav.js, lazy-loads `assets/square-pay.js`) opens a **persistent** pop-down — closes
only on ✕ (dirty-confirm), never on outside clicks (menu-bar-app style, after Square's
discontinued Mac app). Store defaults from the signed-in tech (`window.CPRNavStaff`);
multi-store staff pick first. Three tabs: **To terminal** (Terminal API pushes the
charge to the store's Square wedge — card-present rates, live status poll + cancel;
the RepairQ-down backup), **Payment link** (quick-pay link, texted from the store's
RingCentral line via `messaging` or copied), **Key in card** (Web Payments SDK; tab
self-enables once the `SQUARE_APP_ID` secret is set — card-not-present rates, for
phone payments). Backend: **`square-pay` edge function** (same `SQUARE_ACCESS_TOKEN`
as square-tips/contracts; store→location fuzzy name-match; devices from paired
device codes). Every attempt logs to `square_payments` (store, mode, amount, ticket,
taken_by, Square ids, status — authenticated read). Payments taken here still need
manual entry on the RepairQ ticket; `reference_id` carries the ticket # for
reconciliation. Refunds deliberately stay in Square's dashboard.

**Customer messaging (RingCentral SMS):** texting customers runs through our own
RingCentral pipe (no Zapier). The **`messaging` edge function** is the proxy — all
RingCentral creds (`RINGCENTRAL_CLIENT_ID/_CLIENT_SECRET/_SERVER/_WEBHOOK_SECRET` +
per-store JWTs) stay server-side; it JWT-auths to cached access tokens, sends via the
RC SMS API from the store's own line, screens opt-outs, and logs every send to `sms_log`
(store-tagged). **Multi-store:** `store_lines` (store PK = canonical RepairQ name,
sms_number, jwt_secret_key, aliases jsonb, active) maps each store to its line + the
function secret holding that store user's Personal JWT (`RINGCENTRAL_JWT` =
Salem/default, `RINGCENTRAL_JWT_EUGENE`, `RINGCENTRAL_JWT_CLACKAMAS`). Store users'
developer-portal logins are **separate dev orgs that cannot authorize the main app**
(three failed attempts proved it), so each store runs its own tiny RC app (JWT auth
flow; scopes SMS + Read Messages + Read Accounts) and mints its JWT against THAT app:
optional secrets `RINGCENTRAL_APP_KEY_<suffix>` / `RINGCENTRAL_APP_SECRET_<suffix>`
(suffix from jwt_secret_key, e.g. `_CLACKAMAS`) switch that line's token exchange to
the store's own app; unset → main-app creds. Send resolves store → line via aliases; a
store whose JWT is missing **or fails auth falls back to the default line**
(`RINGCENTRAL_FROM_NUMBER`) so sends never bounce. Warm edge instances keep boot-time
env — after changing an RC secret, redeploy `messaging` to pick it up.
Status/monitoring: **Settings → Integrations → RingCentral** (owner tab) — per-store
LIVE/FALLBACK/AUTH-ERROR pills via the `test` action, per-store test-send, month send
counts + opt-outs. New store = RC user + number, create the store's app + Personal JWT
(developers.ringcentral.com as that store's user), add the three secrets, `store_lines`
row, A2P/TCR registration. Inbound SMS + STOP/START opt-outs (`sms_opt_outs`) are polled from every
configured store's RC message-store by a `messaging-poll-inbound` pg_cron (webhook
subscribe is blocked — the app lacks that permission), applying STOP/START in
chronological order. **The browser never holds a
RingCentral secret** — the extension calls the function through `bg.js` (`sms:<action>`
messages → `messaging` with the public anon key). Actions: `send` (E.164 validate,
opt-out screen, `agent_name` audit trail), `poll`, `contact_set/get/delete`.
`ticket_contacts` (ticket_no PK, method `text|call|email|return`, contact_name/number/
email, note, set_by_name) is the **per-visit follow-up preference** — how THIS customer
wants to hear their repair is ready, saved to the ticket only (never the customer
profile), deleted when the ticket closes. Two extension surfaces (both under Options →
RingCentral SMS, default ON): **`readyText.js`** intercepts RepairQ's **Ready for
Pickup** button — reads the saved `ticket_contacts` preference: an automated `text`/`call`
pops a **confirm over the button** ("Confirm Call/Text to <Primary|Alt> <number>" vs
"Proceed without automated contact" — it no longer fires on a timer), a *manual*
`call`/`email`/`return` shows a reminder toast (no send), nothing-saved falls back to a
manual Primary/Alt chooser; **`followUp.js`** pops
a capture modal right after a ticket's first save (method + number combobox that drops
the ticket's Primary/Alt on focus + name), writes `contact_set` **and** a RepairQ ticket
note as a permanent backup, and drops an editable "📣 Follow-up" chip by the customer
summary. Numbers/name are scraped from RepairQ's read-only customer `<dl>` (Contact
Number / Customer Name / Contact Method / Email). Automated **voice calls** (method
`call`): Ready-for-Pickup on a ticket whose saved preference is `call` places an
automated Twilio voice call (same 5-second Undo as texts, ticket note logged) via the
**`twilio-call` edge function** (secrets `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`;
actions `status` / `call`; logs to `call_log`, authenticated read). The call speaks a
ready-for-pickup message twice (voicemail-friendly, Polly voice) and presents the
store's own RingCentral number as caller ID once that number is added as a Twilio
**Verified Caller ID** (Console → Phone Numbers → Verified Caller IDs — Twilio calls
the store, someone enters the code; per store, one time); unverified stores fall back
to a Twilio-owned number if any exist, else the call errors and the toast says so.
bg.js proxies `call:place`/`call:status`. A top-bar SMS inbox/compose panel is still
deferred. When changing SMS/call behavior, keep `readyText.js` + `followUp.js` +
`bg.js`'s `sms:`/`call:` proxies + the `messaging` and `twilio-call` functions in sync.
**Editable message wording:** `message_templates` (store null = shared default else
canonical store name, `template_key`, `body`, updated_by/at; unique on
`(coalesce(store,''), template_key)`; RLS read-open, write `is_admin()`) holds the
customer-facing text. First `template_key` is `ready_for_pickup`. The **body carries
short codes** — `{name}`/`{first}`, `{device}`, `{store}`/`{location}`, `{tech}`
(signed-in RepairQ user), `{hours}` (today's store hours) — that `readyText.js` fills in
per send (falling back to built-in wording if the template hasn't loaded). Managers edit
it in **Settings → Integrations → RingCentral → Message templates** (default + per-store
override, live preview); the extension reads the resolved template via the `messaging`
function's `template_get` action (store override → default) and caches it in
`storage.local` so send-time stays instant. New automated messages should become new
`template_key` rows here rather than new hard-coded strings.

**Chrome extension (`extension/`):** **myRepairTools** — MV3 extension for
`cpr.repairq.io`, the rebranded merge of the old Price Calculator popup ("CPR Tools")
and Ben's RQ Mods (all its content scripts absorbed as-is; feature toggles preserved
in Options). New parts: `scripts/bg.js` (print gate injector + LCD API proxy — the
edge-function URL and LCD secret live here), `scripts/lcdCapture.js` (ticket-item
watcher + Good/Bad modal), `scripts/lcdLabel.js` (send-display label at
/ticket/printLabel), vendored `scripts/qrcode.js`, and
`scripts/assistantOverlay.js` — a ✨ FAB in RepairQ opening `assistant.html`
(iframe): the same cpr-assistant chat widget in embed mode
(`window.CPR_ASSISTANT_EMBED`, full-viewport, auto-open, iframe-allowed), with
the RepairQ page context (ticket #, store, tech, line items) posted in via
postMessage and prepended to the first message. Auth rides the MRT origin's
Supabase session (sign in once per browser); Options has an AI Assistant toggle.
**What's Next?** (`scripts/whatsNext.js`) — the "McDonald's order board": a 🍔 button in
RepairQ's top bar fetches RepairQ's own ticket list (same-origin, follows the
`Ticket_page` pager), keeps workable tickets only (New / New Claim / In Diagnosis /
Ready for Repair; excludes Waiting*, Pending Notification, pickup/closed — those "Est."
times are customer appointments, not repair dues), ranks express → overdue → due-soonest
→ oldest, and shows NEXT UP with Open/Skip plus a 📺 board mode (top 12, urgency colors).
Rows parse defensively from `tr[data-id]` + `td[data-column]` (id/items/status/est);
tuned against a saved copy of the real Active Repair Queue view. Workable tickets with
no due time get a red pill + a "⚠ N without a promise time" banner. **Promise-Time
Advisor** (`promiseTime.js`): every RepairQ tab keeps a 5-min queue snapshot
(chrome.storage.local `mrt_queue_snapshot`); ticket create/edit pages show a chip —
"N repairs in the queue → tell the customer <time>" (lead = (depth+1)×minsPer, rounded
up to :30, rolled past close−30min to open+1h next day, never before opening) — whose
"Use it" writes RepairQ's OWN Promised-on fields (bg.js MAIN-world: jQuery
datepicker.setDate then picks the nearest not-earlier slot in the dynamically-populated
`TicketForm[repair_estimated_time]` select). Saving with no promise time opens a soft
gate (suggested/+2h/+4h/EOD/tomorrow, skip allowed). A 🕐 pill in the header (the spot
left of the search bar) is the always-on clock: "New repairs by <time> · N in queue ·
~M min/repair", re-rendered every minute and on snapshot changes. Pace is LIVE: each
refresh diffs workable ticket-ids vs the previous snapshot — departures over a 90-min
window set observed mins/repair (≥2 departures, clamped 10..2×minsPer, else the
configured default), so banging out repairs pulls promises in and a growing queue
pushes them out. Store hours come from RepairQ's own page (the `$.app.page.init` location object's per-day `monday_start/end`… fields), parsed from the inline script and cached per store name (chrome.storage.local `mrt_store_hours`); today's real hours drive the suggestion + presets (Sat closes early, Sun closed → rolls to next open day). Falls back to the Options default (wn.open/wn.close) only when unread. Config in Options (wn.promise, wn.minsPer 45, wn.open/wn.close fallback). **RepairQ workflow
tools** (absorbed from MyCPRTools, a fellow franchisee's extension): `mcprUtils.js` +
`mcprConfig.js` (fetch-based; dynamic assignee lookup — no hardcoded roster) power
Parts Gate (`partsGate.js`, blocks closing tickets whose "Repair - X" labor lacks a
bundled "Part - X"; a "no part needed" note or diagnostic/unlock keywords exempt; claims
with "without frame" screens also need front+back adhesive — default OFF), Update
Assignee (one-click assign-to-me, default ON), Status Override (`statusOverride.js`,
default **OFF** — an always-available "⚙ Force status" dropdown + Apply injected onto the
ticket that POSTs straight to RepairQ's `/ajax/ticket/updateTicketProperties` (same call
Update Assignee makes), so a ticket can be reopened / re-statused after RepairQ hides its
own control — a closed ticket or the day-rollover "button that disappears after midnight";
Brett's MyCPRTools shipped this as an empty planned stub, this is the real build), Stock
Badges (on-hand qty badges on MobileSentrix/cpr.parts tiles, default ON), Price Overlay
(`priceOverlay.js`, ours not MyCPRTools', default ON — customer Repair price (part+$100
labor, fee-loaded, CPR-rounded) + Add-on price (2×/1.5×/+$25 markup, fee-loaded) under
each supplier tile; math mirrors `popup/popup.js`, keep in sync), Quote Builder
(`quoteCart.js`, default ON — a "＋ Quote" button per MobileSentrix/cpr.parts tile + a
floating fixed cart (top-right) that totals a multi-part repair live: priciest part billed
as the Repair, rest as Add-ons (☆ re-picks the Repair line), 📋 copies it; cart persists
in `chrome.storage.local` across product pages; same pricing math + `mcpr.priceModel` as
Price Overlay, keep in sync). **Stock Badges, Price Overlay + Quote Builder live under
their own "MobileSentrix Tools" Options card** (the rest under "Workflow tools"). KBB
Returns (`kbbReturns.js`, default ON —
Apple Known-Bad-Board return matcher across cpr.parts `/kbbprocessing` + RepairQ
`/rmaTracking`: scan return-order #s once → ticks matching cpr.parts rows and harvests each
row's RQ ticket # + KBB serial into a chrome.storage.local batch → on RepairQ ticks rows by
KBB serial (identical cross-system) else ticket # for no-serial parts; turns ~1hr of manual
cross-referencing into seconds), Popup Blocker (auto-advances claim
walkthrough / T&C / signature — bg.js injects a jSignature stroke MAIN-world — **default
OFF** because it signs forms), and Clock Guard (blocks early clock-in, configurable
time, default OFF). All toggles in Options (storage.sync objects `wn`, `mcpr`). Install unpacked or publish to the
Chrome Web Store (steps in `extension/README.md`). When changing LCD behavior, update
the extension AND check `lcd-buyback.html` + the `lcd-buyback` edge function stay in
sync. **RepairQ ticket notes must be 3-byte-utf8-safe:** RepairQ's MySQL silently
truncates a note at the first 4-byte char (most emoji), so an emoji-PREFIXED note
stores completely blank — and a blank note blocks the whole ticket from saving
(the v2.5.80 Eugene incident). Every extension `writeNote` strips astral chars
before posting and note prefixes stay ASCII/BMP (✔ ⚠ ⛔ are safe; 📣 🛡 are not).
Safety net: `repairq-query`'s `sweep_blank_notes` action (the
`repairq-blank-note-sweep` pg_cron, :20/:50 hourly) scans the active ticket list
and deletes any empty-bodied note.

**Knowledge Base ("the brain"):** `kb_categories` + `kb_articles` (light-markup body —
same family as Communications, plus # headings, [links](url), ![images](url) from the
public `kb-media` storage bucket; tags, summary, status draft→published→archived,
`min_role` employee|manager, `require_ack`, trigger-maintained weighted tsvector) +
`kb_article_versions` (snapshot on every save) + `kb_reads` (per-person first_read_at +
acknowledged_at — the compliance record) + `kb_feedback` (👍/👎 per person). Authoring is
**manager-only** (RLS `is_admin()`); employees read published `min_role='employee'`
articles. Surface: `knowledge.html` (My Hub, everyone) — search-first (RPC `kb_search`:
strict websearch + loose OR fallback, both role-safe via RLS), category pills, cards
with unread dots, article view records the read and shows the ack bar for required
articles, 👍/👎 footer; managers additionally get the inline editor (toolbar + image
upload to kb-media + preview; publish/unpublish/archive), a Drafts pill, and a
**Compliance tab** (per required article: acknowledged vs outstanding roster with
"read but not acked" / "never opened" flags, overall % tiles). First publish (and
🔁 Reset acknowledgments — re-certification) auto-posts to Communications
(`source_key 'kb:<id>:…'`). Deep links: `knowledge.html#a=<slug>`. Dashboard
**Knowledge widget** (`assets/kb-summary.js`, `window.CPRKnowledge.forMe()`) shows
required-reading queue + newest articles. **AI: the `cpr-assistant` edge function does
KB RAG** — every question runs `kb_retrieve(q, mgr)` (SECURITY DEFINER, execute revoked
from browser roles; strict-then-loose FTS) and injects the top articles into the system
prompt with citation rules (`from: [title](link)`); the assistant must never state
CPR-specific policy that isn't in the KB. cpr-assistant's source now lives in
`supabase/functions/cpr-assistant/` (recovered from the deployed eszip — keep it
committed). Nag reminders for unacknowledged required reading are deliberately deferred
to the notifications project. Importing existing docs: give them to Claude in a session —
it converts and inserts articles directly.

**Communications (team feed):** `communications` (kind, title, body, source_key for
automated idempotency, created_by) + `communication_reads` (per-user first_read_at,
seconds-on-post, dismissed_at). Client lib `assets/comms.js` (`window.CPRComms`);
surfaces: the dashboard Communications widget (unread badge, manager ＋ quick-post,
expand = mark read + time tracking, per-user dismiss) and `communications.html` (My Hub
nav) with full history + read receipts (managers see who read / seconds spent). Posting
is manager/owner (RLS `is_admin()`); reads/dismissals are per-user rows. Automated posts:
milestones cron writes day-of birthdays/anniversaries; any notification rule routed to an
**In-app · Communications** channel (notify function `type='inapp'`) posts here too.
Distinct from **Alerts** (personal/actionable — see below).

**Alerts (personal notification feed):** `alerts` table (staff_id, kind
task|schedule|kb|goal|system, title, body, link = deep link, icon, read_at,
dismissed_at; RLS select/update own rows only; INSERTS are service-role only —
sources are edge functions/crons, the page never writes new rows). Surface:
`alerts.html` (My Hub; any signed-in staff) — 30-day feed grouped by day, unread
accent + dot, tap = mark read + follow the deep link, Mark all read. The top-bar
🔔 bell navigates here and carries a live unread-count badge (nav.js queries the
count per page load, and mirrors it onto the installed-app icon via
`navigator.setAppBadge`). **The `alerts` edge function is the single fanout**:
`POST {action:'send', kind, title, body?, link?, staff_ids|all_active, secret?}`
(auth = NOTIFY_SECRET for crons/server, or admin/manager/owner JWT for browser
surfaces) — always writes the feed rows, then fans out per `alert_prefs`
({kind:{push,sms}}; missing = push ON, sms OFF; kind 'comms' push is LOCKED ON):
Web Push (VAPID_* secrets; npm:web-push; dead endpoints pruned) to every device
in `push_subscriptions`, and SMS via the messaging function's secret-guarded
`system_send` action, which sends from the OFFICIAL company line
(`ALERTS_FROM_NUMBER` secret — the 1-855; toll-free numbers must be TF-verified
for SMS — falls back to RINGCENTRAL_FROM_NUMBER). Push arrives via sw.js
(`push` → showNotification, `notificationclick` → deep link). Wired sources:
milestones (goal hits → the person, kind 'goal'; day-of birthdays/anniversaries
→ the person), Schedule Admin's Notify button (kind 'schedule', everyone), KB
required-reading publish (kind 'kb', everyone), and the **end-of-shift task
nudge** — `tasks?action=nudge` (pg_cron `tasks-nudge-halfhourly`, */30): anyone
whose shift ends within 45 min with open tasks due today (assigned to them, or
'each' without their completion; unassigned any-pool tasks deliberately skipped)
gets one alert per day (notify_log `nudge:<staff>:<date>` dedupe). Email prefs
deliberately not offered yet.

**My Profile (`profile.html`):** every employee's self-service page (avatar menu →
My Profile; the mobile drawer header also links here). Onboarding-ready: a
progress checklist (contact → emergency → notifications → app install → PIN)
drives `staff_profiles.onboarding` jsonb. Sections: contact/emergency/address/
shirt size (autosaved to `staff_profiles` — self-RLS, admins read; phone is
E.164 and feeds the SMS channel), notification preferences matrix (Push/Text per
kind; comms push locked), Enable Push flow (Notification.requestPermission →
pushManager.subscribe with the VAPID public key → `push_subscriptions` upsert on
endpoint), change PIN (cpr-auth `change_pin`: verifies current, enforces 4-8
digits + uniqueness across active staff), Add-to-Home-Screen instructions.

**Service worker (`sw.js`, registered by nav.js):** NETWORK-FIRST — every request
goes to the live site (navigations force revalidation), the cache is only an
offline fallback. Exists because iOS home-screen apps cling to stale caches
(owners saw old code until delete/re-add). Normal deploys need no SW changes;
bump its VERSION only to GC the cache bucket. Push notifications will live here.

**Mobile app shell (nav.js):** nav.js owns standalone (A2HS) safe-area handling
site-wide — it flags `html.mrt-standalone`, patches `viewport-fit=cover` into the
viewport meta when a page didn't declare it, and grows `--cpr-top-h` by
`env(safe-area-inset-top)` so the iOS status bar never crams the top bar on ANY page.
The assistant chat is a full-screen sheet below 860px (safe-area padded, 16px input,
visualViewport keyboard tracking). Below 860px the site behaves like a native app —
a fixed **bottom tab bar** (Home / Tasks / My Time / Commission / ☰ More; More
opens the slide-in menu, replacing the hamburger) with safe-area padding and a
pinned view-transition-name. The top bar keeps clock-in + 🔔 bell + avatar; the
Square button hides on mobile and lives as a "Square · Backup Register" row under
More instead. `--cpr-bb-h` (0 on desktop, bar height on mobile) is set on :root —
pages with their own fixed footers must use `bottom:var(--cpr-bb-h,0px)`
(expenses.html does), and nav.js lifts the assistant ✨ FAB above the bar.
Per-user tab customization is planned (dashboard_layouts pattern), not built.
  **Nav icons are inlined Lucide SVGs** (`NAV_SVG` map + `navIcon(name,size)` in nav.js;
  stroke `currentColor`, so they tint with row/tab state) — the emoji era in the nav is
  over. New nav entries use a Lucide icon NAME in `icon:`; unmapped strings still render
  as text so nothing breaks. Add new glyphs to NAV_SVG from the `lucide-static` npm
  package (ISC). Page-content emoji (h1s, widget titles, alert-feed tiles) are a
  separate call — swap them page-by-page only when redesigning that page.

**Time-off requests:** employees request via a **3-step wizard modal on `my-schedule.html`**
(never an inline form): 1) calendar date pick — shows teammates' pending/booked days AND the
requester's own existing requests (ME chips); 2) their expected schedule for those dates
(recurring + overrides + holiday clamp) with per-day PTO checkboxes and an hours input
capped at the scheduled hours (lower is allowed to stretch the bank); 3) review + description
(required for Vacation/Personal; optional for Sick — Oregon sick-time law — and Unpaid) +
overlap acknowledgment, then submit. Paid hours are **capped at the QB Time balance**
(Sick draws a Sick bucket when one exists, else PTO; no cap when QB isn't linked). A day
can be **½ Partial** (`partial_days jsonb`) — away X hours, working the rest: schedule
views (My Time, Schedule Admin This Week/coverage) show a partial chip and keep the person
counted/working, and the tasks engine does NOT treat them as off. Dates can be
**back-dated up to 60 days** (late sick filings). Rows carry `hours` (total, what admin
pages/QBO use) plus `day_hours jsonb` ({date: hours}); `qbtime-sync` writes exactly those
per-day entries to QB Time with a **14-day lookback** for late filings (falls back to an
even split for legacy rows; a 0-hour request — all days fell on regular days off — is
marked synced without writing). `time-off.html` shows real request hours (hover for
per-day) with a ½-partial flag.

**Checklist (store tasks):** `task_templates` **generate** `task_instances` — never render
templates directly; the checklist shows instances. Template shape: recurrence
(`oneoff|daily|weekly|monthly|flexible` + weekdays / month_dates / flex N-per-window),
target (`person`+fallback / `shift` resolved from the schedule / `role` any-tech-or-manager /
`group` pool with strategy `fixed|rotate`), completion (`any|each` — each stores per-person
`task_completions` rows and shows a completion grid), priority (normal/asap/must), a
linkable phrase in the name (link_text/link_url), due_time, instructions. Generation is the
**`tasks` edge function** (`?action=generate`, idempotent on `(template_id, gen_key)`):
pg_cron `tasks-generate-daily` (10:10 UTC) plus a page-load top-up call (any signed-in JWT
works — safe because idempotent). It resolves the day's assignee (round-robin advances
`rotation_pos`, skips people on approved time off), snapshots name/priority/assignee onto
the instance, and auto-closes yesterday's open dailies as `missed` (they regenerate fresh).
Weekly/monthly/one-off misses stay open and surface in Task Admin's **follow-up queue**
(Reopen & reassign → old instance `missed` + fresh instance `gen_key reopen:<id>`; or Close
as missed). Surfaces: `checklist.html` (My Hub, everyone; My tasks/Store views; employees
can create **personal** tasks — RLS-scoped to creator) and `task-admin.html` (Employees
nav, managers: Library list+calendar, Reporting by calendar month, Fairness rotation
ledger). Dashboard My Tasks widget uses `assets/checklist-summary.js`
(`window.CPRChecklist.forMe()/markDone()`). On-time = done_at ≤ due_at, stored on the
instance/completion at check-off. End-of-shift nudges ship via the alerts fanout (see Alerts).

When changing a tool's data layer, check which generation it uses first — they share no code.

## Conventions when editing

- **Title Case for UI titles.** Panel/page/section/tab titles capitalize each word
  ("Square · Backup Register", "Payment Link") — owner preference. Sentence case is
  fine for body copy, hints, and toasts.

- Keep a tool's CSS/JS inline in its own file; don't extract to shared assets unless it is
  genuinely cross-tool (the bar for adding to `assets/` is high).
- Reuse `CPRLocations` for any store dropdown/normalization rather than re-listing stores.
- **Store switching = a brand `<select>` dropdown, never pills/chips** (the store list will
  grow). Pattern from cash-journal.html: `.storesel` (196px, 36px tall, 1.5px `--border`,
  radius 8, Nunito Sans 700 .92rem, blue focus ring `0 0 0 3px rgba(79,176,227,.15)`),
  values = canonical `CPRLocations.names()`, labels = `'CPR ' + display(name)`. Converted
  so far: cash-journal, checklist; convert other pages' pills when touching them. (The
  design project's CLAUDE.md + `@myrepairtools/design-system` record the same rule —
  StorePills is deprecated for location switching.)
- **Persist view state across refresh — and deep-link it.** Any tool with tabs /
  sub-views remembers the active one in `localStorage` (e.g. `cprSetTab`) AND mirrors it
  in the URL hash (settings.html is the reference: valid hash > localStorage > default at
  load; every switch does `lsSet` + `history.replaceState(null,'','#'+tab)` — never
  pushState, never a bare `#`; a `hashchange` listener routes through the page's own
  switch function so links and back/forward work). Wired across the site: settings
  (#staff/#loc/#notif/#pages/#commission/#integ/#roles), commission-dashboard,
  commission-calculator, lcd-buyback, hyla-orders, consumption-report, checklist,
  task-admin, my-schedule, schedule-admin, contracts (status filter), knowledge
  (`#a=<slug>` articles + `#c=<category>`). New tabbed tools must ship with both.
- **Cross-page transitions:** nav.js opts every page into cross-document view
  transitions (`@view-transition{navigation:auto}`, .18s crossfade) and pins the app
  chrome (`view-transition-name` on `.cpr-topbar`/`.cpr-rail`/`.cpr-pane`) so the nav
  holds still while content fades; `prefers-reduced-motion` disables it. Browsers
  without support fall back to instant navigation — never rely on the transition for
  correctness.
- **Perf:** nav.js hover-prefetches same-origin `.html` links (pointerover/touchstart →
  `<link rel=prefetch>`, plain `fetch` fallback for Safari) so clicks land on
  already-downloaded pages. The `edge-warm-interactive` pg_cron (*/4 min) pings
  `cpr-auth` + `qbo` (`{action:'ping'}`, answered before any auth/DB work) so
  interactive tools don't hit cold edge boots; add new latency-sensitive functions to
  that job (and remember warm instances keep boot-time env — redeploy after secret
  changes).
- Endpoint URLs, API tokens, and the Supabase anon key are committed in the source on
  purpose (this is a deterrent-level internal tool on public hosting). `robots.txt`
  disallows all crawlers.
- **Week/date navigation → use the calendar date-picker pattern.** For any page with a
  week or month navigator, the label between the `‹ ›` arrows is a clickable button that
  drops down a calendar popover instead of arrow-stepping: week picker = month calendar,
  pick any week row, page months, "Jump to this week"; month picker = year pager + month
  grid. **Use `assets/pickers.js`** (`window.CPRPickers.week(anchor,{get,set,maxWeek})` /
  `.month(anchor,{get,set})`) — `maxWeek` greys future weeks on backward-looking reports.
  Wired everywhere with date nav: schedule-admin (This Week + Monthly), my-schedule (week
  labels, Month view, time-off wizard — those predate the lib and keep local copies),
  time-entries, report-overtime, task-admin (Library calendar + Reporting). New pages with
  date nav must include pickers.js and wire the label.
