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
  into every page, defines the canonical tool lists (`OPERATIONS` + `PRIVILEGED`), and
  owns role-based visibility. **When you add or rename a tool, update the `OPERATIONS` or
  `PRIVILEGED` array here** (and the tile in `index.html`) or it won't appear in the nav.
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
  source of truth for the Commission Calculator + Dashboard. Never re-implement the math.
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
   commits). Project `xuvsehrevxackuhmbmry.supabase.co`, client imported from
   `esm.sh/@supabase/supabase-js@2`. Tools on Supabase: cash-tracker, cash-admin,
   consumption-report, settings, login-test, damage-tracker, employee-records, hyla-orders,
   claim-payouts, commission-calculator, commission-dashboard, schedule pages,
   time-entries, monthly-goals, checklist, task-admin, device-orders.

**Device ordering (`device-orders.html`, Ordering & Inventory nav):** used-device
consumption + suggested buys, the device-side sibling of the parts consumption report.
Data arrives by dropping the two RepairQ dashboard exports on the page (zip or csv):
"Device Inventory List (Sold)" → `device_sales` (upserted on RepairQ ID — history
accumulates across uploads) and "Device Inventory List" → `device_inventory` (full
snapshot, replaced each upload). Rows group by `model_key` (device name minus
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
function secret holding that store user's Personal JWT — one RC *app*, one JWT per
store user (`RINGCENTRAL_JWT` = Salem/default, `RINGCENTRAL_JWT_EUGENE`,
`RINGCENTRAL_JWT_CLACKAMAS`). Send resolves store → line via aliases; a store whose
JWT isn't minted yet **falls back to the default line** (`RINGCENTRAL_FROM_NUMBER`)
so sends never bounce. Status/monitoring: **Settings → Integrations → RingCentral**
(owner tab) — per-store LIVE/FALLBACK/AUTH-ERROR pills via the `test` action, per-store
test-send, month send counts + opt-outs. New store = RC user + number, mint Personal JWT
(developers.ringcentral.com as that store's user), add secret, `store_lines` row, A2P/TCR
registration. Inbound SMS + STOP/START opt-outs (`sms_opt_outs`) are polled from every
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
Pickup** button — reads the saved `ticket_contacts` preference: `text` auto-sends the
ready message with a 5-second Undo, `call`/`email`/`return` show a reminder toast (no
send), nothing-saved falls back to a manual Primary/Alt chooser; **`followUp.js`** pops
a capture modal right after a ticket's first save (method + number combobox that drops
the ticket's Primary/Alt on focus + name), writes `contact_set` **and** a RepairQ ticket
note as a permanent backup, and drops an editable "📣 Follow-up" chip by the customer
summary. Numbers/name are scraped from RepairQ's read-only customer `<dl>` (Contact
Number / Customer Name / Contact Method / Email). Automated **voice calls** (method
`call`) are reserved for a planned Twilio integration (verified caller ID = store number)
— not built yet. A top-bar SMS inbox/compose panel is likewise deferred. When changing
SMS behavior, keep `readyText.js` + `followUp.js` + `bg.js`'s `sms:` proxy + the
`messaging` function in sync.

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
with "without frame" screens also need front+back adhesive — default ON), Update
Assignee (one-click assign-to-me, default ON), Stock Badges (on-hand qty badges on
MobileSentrix/cpr.parts tiles, default ON), Price Overlay (`priceOverlay.js`, ours not
MyCPRTools', default ON — customer Repair price (part+$100 labor, fee-loaded,
CPR-rounded) + Add-on price (2×/1.5×/+$25 markup, fee-loaded) under each supplier tile;
math mirrors `popup/popup.js`, keep in sync), KBB Returns (`kbbReturns.js`, default ON —
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
sync.

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
Distinct from future "Alerts" (personal/actionable, top-right icon — not built).

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
instance/completion at check-off. Checklist notification triggers (end-of-shift nudges
etc.) are deliberately deferred to the notifications project.

When changing a tool's data layer, check which generation it uses first — they share no code.

## Conventions when editing

- **Title Case for UI titles.** Panel/page/section/tab titles capitalize each word
  ("Square · Backup Register", "Payment Link") — owner preference. Sentence case is
  fine for body copy, hints, and toasts.

- Keep a tool's CSS/JS inline in its own file; don't extract to shared assets unless it is
  genuinely cross-tool (the bar for adding to `assets/` is high).
- Reuse `CPRLocations` for any store dropdown/normalization rather than re-listing stores.
- **Persist view state across refresh.** Any tool with tabs / sub-views / a selected
  page-or-option should remember the active one in `localStorage` (e.g. `cprSetTab`,
  `cprSetPgtool`/`cprSetPgopt` in `settings.html`) and restore it on load, so a refresh
  returns the user to where they were instead of a default tab. Add this to new tabbed
  tools and when touching existing ones.
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
