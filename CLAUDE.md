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

## Standing directive: notifications are personal, not broadcast

**Default every automated notification to a PERSONAL alert the recipient can
manage. The Communications feed is an all-staff broadcast nobody can opt out
of — use it only where the owner has explicitly asked for one.** Apply this by
default; it does not need to be re-requested.

- **Personal alert** — the `alerts` fanout (`{action:'send', kind, staff_ids}`),
  which honours `alert_prefs` and is muteable per kind in profile.html. This is
  the default for anything a cron or an edge function raises.
- **Communications** (`communications` table) — something a human deliberately
  wrote for everyone, or an automated post the owner has explicitly sanctioned.
  The sanctioned example is **Schedule Admin's 📣 Notify staff button**: a
  manager choosing, in the moment, to tell the team. That is a person deciding
  to broadcast, not a robot deciding for them.
- **Never both for the same event.** A goal hit that alerts the person AND posts
  to the feed bills one event twice.

**Why:** every Communications row pushes an unread badge onto every employee.
Automated status lines in a feed nobody can mute crowd out the posts that
matter and train people to ignore the badge entirely. The GBP weekly digest
("🤖 8 review replies auto-posted last week") was deleted from `gbp-sync` for
exactly this on 2026-08-20 — owner's words: *"Employees don't need to see the 8
review replies posted this week. Neither do managers and really I don't
either."* The data was never lost: every auto-reply is in google-reviews.html
with an AUTO label, which is where someone who cares goes to look.

**When adding a notification, ask who ACTS on it** and route it to them. If the
honest answer is "nobody acts on it, it's just status," it belongs on the page
that owns the data — not in anyone's feed.

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

- **`nav.js`** — the navigation shell. **Rail-only desktop nav (owner redesign
  2026-08-12):** the fixed dark rail is the whole desktop nav — EXPANDED
  (default, 216px) it shows icon + section name per row (Home · Knowledge
  Base · Training · My Hub · Sales & Pricing · Ordering & Inventory ·
  Operations · Employees · Reports · Admin & Owner · Settings); the chevron
  collapses it to the classic 64px icon rail. Hovering (or clicking) an AREA
  row opens the tools **flyout** in either state — the white menu pane is
  `display:none` on desktop and survives only as the mobile (<860px) slide-in
  drawer. The admin flyout carries the full PIN-unlock card
  (wirePriv/doUnlock take a root element). nav.js still defines the canonical tool lists (`OPERATIONS` + `TOOLS` — a
  "Tools" sub-group rendered under Operations for single-purpose utilities like the
  Label Resizer — + `PRIVILEGED` + `SETTINGS` et al.), and owns role-based visibility. **When you add or rename a tool,
  update the right area array here** (and the tile in `index.html`) or it won't appear in
  the nav. **The rail-bottom gear is a real area** (not a link): clicking it swaps the pane
  to the `SETTINGS` list (Locations, Notifications, Page Settings, Commission,
  Integrations, Roles & Permissions) and highlights the gear like any area icon. Every row
  deep-links to `settings.html#<tab>` (loc/notif/pages/commission/integ/roles — the
  page opens that tab from the hash, listens to hashchange, keeps the hash synced via
  replaceState, and owner-gates integ/roles).
  **Team Members is consolidated into `employee-records.html`** (Employees nav, minRole
  admin) — the Settings staff tab is deleted and `settings.html#staff` redirects there.
  That one page is the whole staff surface (design handoff "Team Members Redesign"):
  a landing roster table (grouped by home store via `stores.display_order`, owner rows
  pinned, Active/Terminated segment, owner-only "↻ Sync employees" from QB Time — no
  "+ Add member" anywhere; hires auto-create on sync and carry a "Needs setup" chip)
  and a full-width per-person profile with tabs Profile · Log · PIPs & Reviews ·
  Tech Damage · Documents · Time · PTO · Commission. **Notifications tab** = the per-kind
  push/text matrix + this device's push enrollment, ported from profile.html
  (`alert_prefs`, `push_subscriptions`, the same two-tier locking); it renders
  ONLY on your own profile, since both tables are self-RLS. Profile tab = 4 form cards + dirty-tracked
  save bar (cpr-auth `update_staff` + `set_pin`; an admin PIN reset shows ONCE in a
  modal); phone/email live in `staff_profiles.phone/personal_email` (routed through
  update_staff — the SMS pipeline reads the same field, never duplicate onto `staff`);
  the QB Time link select is owner-only. Terminate is a modal writing a real record
  (`staff.terminated_at/termination_reason/termination_note/rehire_eligible/terminated_by`
  — docs/sql/team-members-consolidation.sql); terminated profiles stay fully browsable
  (record box + Reinstate). **Documents tab = the HR file** (`staff_documents`
  + the private `hr-private` bucket under `staff/<staff_id>/`;
  docs/sql/staff-documents.sql): converting a candidate FREEZES their signed
  paperwork to PDFs and files it against the person — offer letter, handbook
  acknowledgment and new-hire form, three separate documents, built by the
  intake fn's `archiveDocs()` inside `promote`. Frozen, never regenerated:
  the acknowledgment renders from live KB articles, so a rebuilt copy would
  show today's wording instead of what they signed. The intake row is a
  HIRING record and leaves the Onboarding board on promote, so it must never
  be the only home for a signed document. **The tab is a ledger** (design handoff
  "1a — The Ledger", 2026-08-16): a table — file-type tile, title over
  filename·size, kind chip, green ✓ Signed / grey Added, who filed it, and
  ↓/Open mini-buttons — where a row click opens a **preview drawer** (440px,
  slides in from the right; a bottom sheet under 640px) that renders the real
  document inline: PDFs through the vendored `assets/pdfjs/`, images direct,
  both off a fresh 120-second signed URL fetched on open. Esc and the scrim
  close it. On mobile the ledger folds to one line per document (date moves
  under the title) and Add pins to the bottom. Managers can also file anything by
  hand (kind 'upload'), and "Re-file signed paperwork" backfills anyone
  converted before this existed (intake `archive_docs`, idempotent on
  `(staff_id, kind, source)`). The page never holds a URL to a file — it mints
  a 120-second signed one per download; storage policies open only the
  `staff/` prefix, only to `is_admin()`. Commission tab: Settings sub-view = the per-person overrides
  editor over `commission_roster` (inherited placeholders via CommissionEngine —
  never re-implement the merge); History = `commission_snapshots` (total = commission
  only; tips separate) + a live current-month recompute mirroring
  assets/commission-summary.js. Deep links: `#e=<staff id>/<tab>` and `#terminated`.
  settings.html's own tab strip is hidden
  (kept in the DOM so bindings stay harmless); a dynamic per-section header renders in its
  place. The nav Settings pane is the only section switcher — don't add page-level ones.
  The Locations tab manages the `stores` table (RQ name, color, active, address/phone/email); the canonical
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
- **`fonts.css` + `fonts/`** — **self-hosted Nunito / Nunito Sans** (SIL OFL,
  variable woff2, latin + latin-ext, ~140KB total). The Google Fonts CDN was a
  third-party request that could be slow or blocked; when it failed, pages fell
  back to the browser default — which is why an iPhone showed **Times** on some
  screens while the Mac showed Nunito (owner report 2026-08-14). Every page now
  links `assets/fonts.css` instead. Belt and braces: every `font-family` on the
  site carries a `sans-serif` fallback (332 declarations were missing one, so a
  failed font meant serif). **New CSS must end its font stack with a generic
  family** — and never reference fonts.googleapis.com again.
- **`qrcode.js`** — vendored qrcode-generator (MIT); global `qrcode(type, ecc)`. Used by
  `lcd-buyback.html` for send-display labels; the extension carries its own copy.
- **`pdfjs/`** — vendored pdf.js (pdfjs-dist 4.10.38, Apache-2.0; `pdf.min.mjs` +
  `pdf.worker.min.mjs`, update steps in its README). Used by `label-resizer.html`
  (Operations nav): drop any letter-size shipping-label PDF (or image / pasted
  screenshot), drag-select the label (or ＋ whole page, auto-trimmed of white
  margins), and print a clean **4×6** — one page per queued item, sideways crops
  auto-rotate upright (per-item ↻ override). Replaces the paid "label resizer"
  service; fully client-side, no backend.
- **`xlsx.min.js`** — vendored SheetJS `xlsx.mini.min.js` v0.18.5 (Apache-2.0); global
  `window.XLSX`, read-only `.xlsx/.xls/.csv` parsing. Loaded as a classic `<script>` by
  `inventory-editor.html`. Update: `npm pack xlsx@<ver>` → copy `package/dist/xlsx.mini.min.js`.
- **`kb-markup.js`** — the ONE renderer for the KB's light markup
  (`window.CPRMarkup.render(body,{autolink})`), used by knowledge.html's reading
  view, training.html's in-page reader and intake.html's candidate handbook
  accordion — never re-implement it per page. Syntax: `#`/`##`/`###`/`####`
  headings · `- ` / `1. ` lists that **nest by two-space indentation**
  (sub-numbers render a./i.) · `!>` amber callout with `!r>`/`!g>`/`!b>` red /
  green / blue variants `!n>` a plain grey box and `!d>` a solid
  dark-blue (nav `--dark`) box with white text; the editor picks these from a
  **swatch palette** (colors only, names in tooltips — no labels); its ＋ chip
  opens a second shelf of 12 ready-made colors (purple/indigo/teal/sky/lime/
  orange/rose/greys/slate + solid forest, CPR red, CPR blue) plus a
  fill/outline/text color picker. Those all store as
  `!#fill|#outline|#text>` — colors live IN the markup, so a custom box
  survives the PDF, search and every reading surface without new syntax per color; a box may
  carry a heading — `!> ## Title` — which the size dropdown edits in place
  (formatBlock on the box itself would delete the box) · **pipe tables**
  (`| a | b |`, a `|---|---|` row under the first makes it a header) · `---`
  divider · `**bold** *italic* __underline__ `code` [text](url) ![alt](img)`.
  Structural CSS (callout tints, tables, sub-list markers) is **injected by the
  script** like pickers.js does; pages keep their own `.artbody` typography.
  The editor's markup→editable-HTML pass stays in knowledge.html (it needs
  contenteditable-shaped output) but writes this same syntax, and the handbook
  PDF builder (intake fn `kbToPdfMarkup`) degrades tables to `cell — cell` rows.
- **`markup-editor.js`** — the ONE light-markup WYSIWYG
  (`CPRMarkupEditor.mount(host,{value,upload,source,minHeight,toast})` →
  `{getMarkup,setMarkup,focus}`). Lifted out of knowledge.html so every surface
  that stores this markup edits it identically — the KB article editor and both
  Communications composers (page modal + dashboard widget ＋) today. It ships
  its own CSS and borrows kb-markup.js's parsers, so **load kb-markup.js first**;
  `source:false` hides the raw-markup toggle, omitting `upload` hides the image
  button. Storage is unchanged: markup in, markup out. The toolbar is sticky only
  where the PAGE says so (knowledge.html) — a modal composer must not stick.
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
- **`cash-summary.js`** — one call (`window.CPRCashStatus.forStores()`) returning the
  newest CLOSED cash audit per visible store (`{ stores, byStore, defaultStore }` —
  per-drawer/safe counted amounts + over/short from `cash_audit_locations`, days since
  close, and an in-progress flag when a newer audit is open). RLS `is_admin(store)`
  scopes it to the manager's stores. Powers the Store Cash Status widget (manager+,
  store dropdown when several stores are visible, links to cash-admin.html).

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

**Claim payouts (`claim-payouts.html`) — payout_date auto-fill:** claims sync in
via `repairq-query`'s `sync_claims` (Looks 5759 repairs / 5760 parts → `ingest` →
`claim_repairs`/`claim_parts`), but those Looks carry **no deposit/payout date**,
so payout_date used to be 100% manual (every new claim invoice landed "undated" red
until someone hand-set it; `ingest` only propagated a set date to same-invoice
siblings via its invMap). `fillClaimPayoutDates()` (repairq-query) now pulls the
REAL date from RepairQ — `transaction.deposit_posted_date` per ticket (plain Looker
query on the `ticket` explore, warranty_provider≠empty, 180-day window) — and fills
any `payout_date` still NULL (matched by ticket_id; **never overwrites a manual
date**). Runs at the end of `sync_claims` (daily `repairq-claims-sync` cron) and is
backfillable via `{action:'sync_claim_payouts'[,dry_run,days]}`. Claims with no
deposit yet stay undated (genuinely unpaid) and fill automatically once Assurant
deposits. The tool's manual set-date button + invMap propagation still work as the
override path.

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

**Intuit token refresh is SINGLE-FLIGHT (qbtime-sync + qbo):** TSheets refresh
tokens are single-use and Intuit rotates QBO's — two concurrent refreshes spending
the same stored token corrupt the connection (that's what killed QB Time
2026-07-23: the timeoff-sync-15min + qbtime-timesheets-hourly crons fired in the
same second inside the refresh window, and the old code never checked its persist
write). Both functions now refresh only after winning the atomic
`claim_token_refresh(provider, seen_refresh_token)` RPC
(docs/sql/token-refresh-lock.sql — claim succeeds only if the stored refresh token
still equals the one read and no live claim exists, 90s stale takeover); losers
keep using the current access token (the early-refresh window guarantees it's
valid) or briefly wait+re-read when hard-expired. The rotated pair persists with
retries, and a **definitive refresh failure fires a system-tier alert to owners**
(20h dedupe via `integration_tokens.meta.last_refresh_alert_at`) so a dead
connection surfaces in minutes, not days. Any new rotating-token integration must
reuse this claim pattern — never refresh unguarded.

**Phone Bill (owner's personal Verizon split tracker):** `phone_bill_months`
(one row per 17th→16th billing cycle; `lines` jsonb = ONLY the buddy's line
amounts keyed by last-4, `payer_total` their sum, status paid|unpaid tracks
whether he has squared up — he pays by Zelle, so there is deliberately NO
payment link) + `phone_bill_config` (single row: payer name/phone, Zelle note,
line labels, `default_lines` = the recurring per-line amounts) + `bill_path`
→ the PDF in the private `phone-bills` bucket
(owner-only storage policy). RLS owner-only on both (docs/sql/phone-bill.sql).
**Drop a bill:** dragging the carrier PDF anywhere on the page (or the Drop a
Bill button) uploads it, then the **`qbo` function's `extract_phone_bill`**
action (owner JWT like every qbo action) downloads it service-side and reads
it with Claude via a base64 `document` block — `claude-opus-5` with retries
then a `claude-sonnet-5` fallback (a 529 overload on a 40-page document must
not make the owner re-drop the file), ~11s for a 40-page Verizon bill — returning service period, due date, bill total, and
EVERY line (owner · last-4 · device · amount), including the ones the summary
folds into "Remaining N lines" (their details live in the later charges-by-line
pages; the prompt says so explicitly). A review modal tick-boxes which lines
are the payer's (already-known last-4s pre-ticked, live total), then saves —
matching an existing month by due_date instead of duplicating it. Saved months
show a PDF chip that mints a 120-second signed URL. Surface:
`phone-bill.html` (PRIVILEGED nav 'Phone Bill', permission key `phone.bill`,
owner) — three tiles (Past Due · Current · Total, mobile-condensed), month
table with a PDF column and one column
per line (labels from config; columns ordered by the newest cycle's amount so
the phone leads — integer-like jsonb keys iterate ascending otherwise), status
pill tap-toggles paid (paid_at stamped), row click = edit modal (dates, bill
total, per-line amounts with ＋ Line for new lines — the buddy's kid's phone
lands as a new last-4 on whatever month it first bills, ＋ Line it there and
it carries forward), ⚙ config modal. **New cycles auto-create**, so an unpaid month
surfaces on its own: the `phone-bill-rollover` pg_cron (daily 15:30 UTC) calls
the **`phone-bill` edge function's** secret-gated `rollover`, and the page
tops up on load too — both insert every cycle whose service period has fully
CLOSED (never the in-progress one), due the 8th of the month after service
end, seeded from `default_lines` when set, else the previous month's amounts.
**Kevin's own view is `phone-bill-view.html`** — a PUBLIC page (no gates, no
nav) where his mobile number is the credential: the same function's `view`
action matches it against `payer_phone` (last 10 digits, so formatting never
matters) and returns only his months, totals and the Zelle note — never the
household's other lines, bill totals or PDFs. His card mirrors the owner
page's three numbers: Past Due as the hero, with Current and Total under it. The number is remembered in
localStorage so he doesn't retype it, and the catch-up text carries the link. "Text <payer>"
builds the catch-up message — every UNPAID month, split into "Past due" and
"Coming up" (a cycle closes on the 16th and its row generates on the 17th, so
the newest bill is a real charge before its due date lands) plus the combined
total and the Zelle note — and
opens a compose modal that sends it through the `messaging` function from
`phone_bill_config.send_from` — a dedicated RingCentral line (+1 971 348 3566)
that authenticates on the MAIN app JWT, so no store_lines row is needed. The
send passes `from_number`, which `messaging` honors only for an owner JWT
(`_fromOverride`; RingCentral itself rejects a number the extension does not
own). With no `send_from` configured it falls back to an `sms:` deep link from
the owner's own phone. History
seeded from the owner's SharePoint list (Nov 2025→May 2026 paid) + the real
Verizon bills for Jun/Jul/Aug 2026 (parsed from PDFs: lines 5274 iPhone /
4245 + 1395 watches).

**Daily Digest (owner's morning scorecard):** `digest_raw` (one row per
`(capture_date, tile_key)`; `rows` jsonb = that Looker tile's records; RLS
`is_admin()`, writes service-role only — the `daily-digest-sync` pg_cron calls
`repairq-query`'s `sync_digest` every 30 min through business + close-out hours
(`0,30 0-4,15-23 * * *` UTC ≈ 8:00a–9:30p PDT, owner's pick — covers the ~6:30p
close-out pickups); history accumulates from 2026-07-21).
Surface: `daily-digest.html` (Reports nav, minRole admin, Lucide `sunrise`) —
tabs Today / Month / Team (hash `#today/#month/#team` + `cprDigestTab`),
`.storesel` All Stores default. Store scorecards are **collapsible**: collapsed
= name · rank chip · total · GP% glance line (`cprDigestOpen`, first store open
by default; a single-store filter forces open); expanded = phone card (sales +
tickets hero, accessory bar vs the **10% accy-of-revenue goal** — `ACCY_GOAL`
const, make data when goals move into MRT — and boxed GP / Attach / Accy-per-
Tkt), while ≥1000px always shows a dense label→value ledger instead. Derived
metrics (GP %, attach, accy %, accy/tkt) are **computed client-side** from raw
fields (Looker table calcs arrive null; formulas verified in
docs/daily-digest-design-handoff.md). Today tab also lists Devices Sold Today
and Claims Fulfilled Today (**grouped per store** in CPRLocations order, each
group headed by that store's claim count · net · GP and each claim row showing
its own net + GP — net is `ticket_item.all_net_repair_sale_total`, GP is
`all_net_sale_after_cogs_total`, both read off the raw row since Looker's own
`gross_profit` calc arrives null like every other derived metric here; the
section header carries the day's totals; claims flagged "pays out Thursday —
traffic signal" + 7-day payout chips from `claim_payout_weekly`); Team tab merges today's per-rep sales with
MTD cleanings / express / AKKO counts, sort persisted (`cprDigestSort`).
Unknown tile row keys are matched defensively (`pick()` regexes) since some
tiles captured 0 rows at build time. Empty states: signed-out, Managers Only
(role < admin), No Capture Yet, per-section "nothing yet today". `?demo=1`
renders built-in sample data for layout preview. The dateline is a **day
navigator** (‹ › + CPRPickers.day calendar, bounded first-capture→today):
picking a past day re-reads that day's final snapshot across every tab, cached
per date and fetched on demand, with an amber "Viewing history" chip.
A **Force Update** button sits in the dateline (managers only, today only — the
tiles are "today"-relative so forcing while viewing history would overwrite
today, not the past day): it calls `repairq-query`'s **`digest_refresh`** action
(the same `runDigestSync()` the cron runs, but gated by the manager's own
Supabase JWT instead of the proxy secret — the browser never holds the secret;
20-second server-side debounce against double-clicks), then re-pulls and
repaints. Don't call `sync_digest` (secret-gated, crons) from the browser.
Dashboard **Today's Numbers**
widget (`assets/digest-summary.js`, `window.CPRDigest.forToday()`) shows
Rank · Total · GP% per store, manager-gated via `can()`.

**Clock-in is the door (owner call 2026-08-17):** a candidate is promoted by
their first PUNCH, not by a date — someone who never turns up never gets the
store's tools. `staff_clocked_in(staff_id)` (docs/sql/activate-on-clock-in.sql)
is what the clock calls: it ticks every `onboarding_steps` row marked
`action='clock_in'` (today: "Download Workforce App" — a punch IS the proof
the app is installed) and then runs `activate_staff()`, which flips
`role_on_start` into their role and ticks the `action='activate'` step with
`done_by` null. Two callers: qbtime-sync's `clock_in` (the MRT top bar, instant)
and its timesheet sync (Workforce / a store machine, hourly). The day-one cron
no longer promotes — it texts them and tells the manager who is expected and
waiting on a punch.

**Personal-device sessions:** pin-gate's 5-min idle auto-sign-out is SKIPPED in
standalone display mode (Added-to-Home-Screen apps) — an installed app is a personal
device whose lock screen is the security boundary, and iOS firing the expired idle
timer on resume forced a PIN on every open. Sign in once per install; the 5-min
relock still applies to regular browser use on shared store machines. (Each iOS
home-screen install is its own storage silo — separate sign-ins per installed app
is Apple behavior, not ours.) **The idle lock renders the PIN box in place — it must
never navigate.** Reloading a machine that has been idle (wifi asleep) lands on
Chrome's "can't reach server" page instead of the lock, and only a manual refresh
escapes; signing back IN still reloads, which is safe because someone is at the
keyboard. **A resuming app is not a signed-out app:** an installed app (Expenses)
wakes with an expired access token and must refresh it — if the network isn't up
yet `getSession()` fails OR HANGS, and pin-gate used to fall straight to a PIN box
(useless offline, since signing in needs the same network). It now races
getSession with a 4s timeout and, whenever credentials are still in localStorage,
holds on "Reconnecting…" and retries — healing instantly on `online` /
`visibilitychange`. Only a genuinely credential-less device gets the PIN box
(supabase-js clears storage itself when a refresh token is really dead). sw.js also falls back to an `ignoreSearch` cache match for navigations.
**Iframe rule:** all gates skip inside iframes EXCEPT a `?embed=1` surface (the
extension's New Contract modal) — that iframe has its own partitioned storage, so
it can't see the top-level session and would otherwise sit blank forever; pin-gate
runs there so the tech can sign in inside the modal.

**Expenses (mobile receipt recorder):** `expenses.html` (PRIVILEGED nav 'Expenses',
permission key `expenses.record`, owner RLS) — the phone-first replacement for the
QuickBooks receipt app, designed to be Added to Home Screen (`assets/expenses-manifest.json`,
root-relative; standalone mode grows `--cpr-top-h` by `env(safe-area-inset-top)` so the
iOS status bar doesn't cram the nav top bar). Flow: snap/pick a receipt photo
(canvas-downscaled to ≤1600px JPEG) — **the `qbo` function's `extract_receipt` action
(Claude vision, haiku) then reads it and prefills amount/date/vendor/card_last4
— the four card digits printed on the slip pick the Paid With account by
`matchPayAccount()`: the digits already in the account NAME ("Spark - Clackamas
(8123)") cover a dipped card, the Settings `applepay` pairing covers an Apple
Pay device number, and a match is only accepted when exactly ONE account fits**, filling only
fields the owner hasn't typed (✨ status line under the thumb; retakes cancel in-flight
reads via a sequence counter) → amount|date (two-col row) → Paid With (Bank/CC accounts,
**filtered by the Settings allowlist** — `qbo_config` key 'paywith', edited in Settings →
Integrations → QuickBooks Online → "Expenses · Paid With Accounts", re-checked on every
page open. That row also carries **`applepay`** — `{accountId:'9095'}`, a per-card
last-4 typed in beside each allowed account — because **Apple Pay prints its own
device account number on the receipt, not the card's**, so a slip reading 9095 is
unmatchable to "Spark - Clackamas 8123" from memory when logging late; the picker
prints "<account> · Apple Pay 9095". The same row's **`cls`** maps each card to a
CLASS (`{accountId: classId}`, a dropdown beside it in Settings) so choosing the
card — by hand or from the receipt's digits — fills the store class too;
`applyPayClass()` skips once `CLS_TOUCHED`, so a hand-set class survives the next
card change) → expense account (type-to-search combobox over the QBO chart of accounts +
last-5 recent chips; the `accounts` action returns **`fqn`** (FullyQualifiedName)
+ `parent_id`/`sub` — searching matches the FULL path, so typing a parent
("Store Buildout Expenses") lists the parent AND every sub-account under it, and
rows show the path. Never go back to selecting `Name` alone: half this chart is
sub-accounts and a bare "Flooring" is unfindable and ambiguous. A cached
`cprExpQbo` payload with no `fqn` counts as stale so the page heals itself) → Class, (**Split by category** turns that one picker into
amount+account lines for a receipt covering two things — shop tools and signage
off one Home Depot run; lines must total the receipt, a new line prefills what's
left, and each line rides into `split` as its own `account_id`/`account_name`,
which `create_expense` reads per line, falling back to the row's single account
for older store-only splits) or **⚖️ Split Evenly Across Stores** (store toggle chips,
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

**Receipts (manager receipt drop → owner review → QBO):** `receipts.html`
(PRIVILEGED nav 'Receipts', permission key `receipts.submit`, owner+admin) —
the simple sibling of Expenses for managers who shouldn't categorize. One page,
two roles: a MANAGER gets photo (camera/photos/files, PDFs page-1-to-JPEG via
pdf.js) → `extract_receipt` autofill (amount/date/card; vendor stored silently)
→ Paid With → required Note → Submit; rows land in the SAME `expense_receipts`
table as status **'review'** with `submitted_by`/`source:'page'` (their My
Receipts list shows In Review/Booked). The OWNER gets the review log instead:
To Review queue (+ Booked), a modal with the photo (120s signed URL; `.pdf`
paths render in an iframe), editable fields, the FULL expense-account combobox
+ class, then **⬆ Book in QBO** = update the row + the same `create_expense`
pipeline Expenses uses (idempotent DocNumber; the attachment is now typed by
the file's real extension). Managers never see the chart of accounts: the qbo
fn's **`pay_accounts`** action (manager+ JWT, or NOTIFY_SECRET server-to-server)
returns only the Settings-allowlisted cards + Apple Pay pairings + card→class
map; `extract_receipt` is manager+ too. RLS: managers insert only
`status='review'` rows as themselves and read only their own; the receipts
bucket gained manager INSERT (reads stay owner-only);
`expense_receipts.expense_account_id`/`payment_account_id` went nullable (a
submission has no category yet — `create_expense` still refuses to post without
them; the live table carried a SECOND status check `_chk` that also had to
drop). **Email intake:** forwarding a receipt to the receipts address files it
automatically — Resend inbound (`email.received` webhook) POSTs to the
**`receipts-inbound`** edge function (`?s=RECEIPTS_INBOUND_SECRET`): each
PDF/image attachment is fetched (Resend attachments API, or inline
`content_b64` so a Zapier email parser can POST the same shape), stored in the
receipts bucket keeping its extension, AI-read (haiku, sonnet fallback; PDFs
via document block), card-matched through `pay_accounts`, and inserted as its
own review row — subject = the note, sender matched to staff by
`staff_profiles.personal_email`, unreadable amounts land as $0 for the owner to
fill. Idempotent on `source_ref` `email:<email_id>:<attachment_id>` (Resend
retries file nothing twice). The owner's queue lists rows where `source` IS NOT
NULL ('page'/'email'), so the owner's own Expenses rows never appear in it.
Resend side (one-time, dashboard): inbound MX on a SUBDOMAIN (e.g.
in.myrepairtools.com — never the root, it would hijack real mail), an inbound
address, and an email.received webhook pointing at the function URL with `?s=`.
Schema: docs/sql/receipts-submissions.sql.

**Brand Assets (print collateral library):** `brand_assets` (title, category
poster|flyer|sale_sheet|business_card|logo|other, file_path, file_name/ext/mime,
file_size, thumb_path, width/height, tags[], note, active, uploaded_by/_name; RLS
read + insert + update all `authenticated`, hard DELETE `is_owner()` only — removal
is a soft-delete `active=false` so an accidental delete never destroys a file).
Files live in the **public `brand-assets` Storage bucket** (`files/<uuid>.<ext>` +
generated preview `thumbs/<uuid>.jpg`); bucket write policies are authenticated-only,
read is public. Surface: `brand-assets.html` (Operations nav, all staff, icon
`images`) — a "grab & print in-store" library: category tabs (hash + `cprBrandCat`
persistence), search, thumbnail grid (each card: Print = open the file in a new tab,
Download via Storage's `?download=` param — the cross-origin `download` attr is
ignored, Edit). **Any signed-in staff can upload/manage** (owner's call — brand
consistency is a social norm, not an RLS gate). Upload generates a preview thumbnail
client-side: images via canvas downscale, **PDFs via the vendored pdf.js** (page 1 →
canvas → JPEG), white-filled so transparent logos read on the card; if thumbing fails
the card falls back to a type badge. Editable SOURCE files (.ai/.psd, live Canva
designs) deliberately stay in Google Drive / Canva — this bucket is the print-ready
distribution copy, not a design archive. Schema: docs/sql/brand-assets-schema.sql.

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

**Competitions (sales contests that pay out):** `competitions` (name, `metric`, `metric_key`,
fixed `start_date`/`end_date`, `bonus_amount`, `min_tickets` eligibility floor, active) +
`competition_results` (the FREEZE — place, metric_value, bonus_amount, `paid_month`; unique
competition+staff). Owner-write RLS (`is_owner()` — it spends money), read open to all
authenticated so employees see the contest they're in. Metrics, all off `commission_sales`:
`attach_rate` · `category_units` (metric_key 'Case'/'Screen Protector'/'Power' — units only,
there are no per-category dollars) · `service_units` · `device_units` (net of returns) ·
`accy_net` · `device_net` · `service_net` · `retail_net`. **Standings come from the
`competition_standings(id)` SECURITY DEFINER RPC, never from client-side ranking** —
`commission_sales` RLS is `can_see_store`, so ranking in the browser showed a single-store
tech a "company-wide" board containing only their own store. It ranks on the raw numeric
(not the rounded display) with `dense_rank` so ties genuinely share first place and each
takes the full bonus, excludes the owner by ROLE (not the old hardcoded name regex), and
returns ineligible people too so a tech sees how many tickets short they are.
**The bonus rides ALONGSIDE `commission-engine.js`, never inside it** — the engine is a pure
function of one person's own totals and a competition result is a ranking across people;
tips already established that seam. Surfaces: Settings → Competitions (owner-only tab, rail
+ detail editor with a live standings preview and Duplicate — the period is a fixed range,
so duplicating is how a monthly contest recurs; a frozen competition's rules go read-only),
the commission dashboard's Scoreboard cards, and the payroll calculator's **Bonus** column.
**Which run pays it: the one whose range contains `end_date`** — you pay a contest when it
concludes. Archiving the month freezes results from the same standings the run displayed and
stamps `paid_month` (the ledger that stops a second run paying the same award); a winner with
no payroll row in that run is flagged, not dropped. `commission_snapshots` gained
`bonus` + `bonus_detail` mirroring `tips`, and `assets/commission-summary.js` returns `bonus`
in its total (frozen results only — a running contest must never promise an employee money).
Schema: docs/sql/competitions-schema.sql.

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
paystatus — flips to paid by checking the Square order / send). Store→Square location
resolved by name like square-tips. **Delivery: `send` takes `method` `text|email|both`**
— email via Resend/Gmail like notify, text through the **store's own RingCentral line**
(it POSTs the `messaging` function's `send`, forwarding the staff JWT so `sms_log` records
the sender; `template_key:'contract_link'` appends the STOP hint). Omitted `method` =
email, falling back to text when only a phone is on file. Returns per-channel `results`
and only stamps `sent_at`/status when at least one channel succeeds. The page's 📤 Send
button (list row + share modal) opens a delivery picker offering only channels the
contract actually has a destination for. **Paid → notification:** both payment paths
fire the routed rule **`contracts.paid`** ("Contract paid → notify", Settings ›
Notifications — a Notification, deliberately NOT an urgent alert): the Square path from
`checkPaid` server-side (customer's own redirect, so it authenticates to `notify` with
`NOTIFY_SECRET`), and the in-store "✓ Paid" button from the page with the staff JWT.
Both are best-effort — a notification failure never blocks the paid flip. Route it to
channels in Settings; it ships routed to the Communications feed (kind 'shoutout').
NOTE: the paid flip is still **lazy** — `checkPaid` only runs on the customer's
view/paystatus hit, so a customer who pays and closes the tab leaves the row 'signed'
(and unnotified) until the link is opened again. A cron sweep of signed contracts with
a `square_order_id` would close that gap. **In-RepairQ entry point:** the extension's
`newContract.js` puts a "New Contract" button in the ticket's properties row **next to
Update Assignee** (owner's pick) and opens contracts.html in an embedded overlay. Its
page guard must accept RepairQ's real view URL **`/ticket/<id>`** — there is no
`/ticket/view/<id>`; a guard demanding view|edit silently disabled the button on every
view page (fixed v2.7.4).

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

**MobileSentrix API (parts ordering — pipeline in progress):** approved api-consumer
on cpr.parts (Consumer Name "iRepair Phone Shop, LLC" — the owner's real entity).
Magento OAuth 1.0a: creds live ONLY as Supabase function secrets
`MS_CONSUMER_KEY`/`MS_CONSUMER_SECRET` (+ `MS_START_KEY` gating the connect link) —
**never commit them**. **Each store has its own cpr.parts account**, so tokens are
per store: the **`ms-callback` edge function** is both the registered OAuth callback
and the connect surface — `?action=start&k=<MS_START_KEY>` renders a store picker,
logs a START marker (which store the flow is for), 302s into
`/oauth/authorize/identifier` (owner signs in with THAT store's account; sign out /
private window between stores), then the callback auto-exchanges at
`/oauth/authorize/identifiercallback` and upserts the long-lived token into
`integration_tokens` provider `ms:<store>` (`meta.access_token_secret`). Everything
logs to `ms_callback_log` (owner read). Owner-authed `?action=status` powers the
**Settings → Integrations → MobileSentrix** card (per-store Connect/Reconnect
buttons + status pills). All 3 stores connected; production API works straight
from the edge runtime (no IP whitelist — the droplet relay idea is dead). The
**`mobilesentrix` edge function** (`?action=sync`; cron `ms-orders-sync` hourly
:40, NOTIFY_SECRET; any staff JWT can kick it, 15-min freshness guard) mirrors
each store's orders into **`ms_orders`** (entity_id PK, items jsonb w/ sku+qty,
admin-only RLS; docs/sql/ms-orders-schema.sql). **Consumption report** wiring
(all SECURITY DEFINER RPCs — no order dollars exposed to staff):
`ms_ordered_for_day(store, day)` (per-SKU qty ordered that Pacific day) merges
into the ORDERED state so real cpr.parts purchases auto-check the Ordered column
(raise-only over manual/export marks; page kicks a background sync on load).
**Date-RANGE mode** (a "Day | Range" toggle by the date picker, `cprConsMode`):
when a store misses days, pick a from→to window — consumption_log is summed per
SKU across it (`usedMap()` already aggregates, so buildRows/export/count-sheet
dedupe to ONE row per SKU, fixing the day-by-day double-add to the MS cart),
`ms_ordered_for_range(store, from, to)` (docs/sql/ms-ordered-for-range.sql) sums
real orders across the window, and manual export-skip marks land on the range's
END day. Single-day stays the default;
`ms_pending_for_store(store)` (qty_ordered − shipped − canceled − refunded per
item, 30-day window) counts ordered-but-unshipped units as incoming in the
suggest math (`max − instock − onorder − pending`, amber `+N` chip on On Order) —
RepairQ only shows a PO once MS ships, so this bridges that gap and hands off
exactly as shipments post. The **`products` action** (staff JWT, ≤300 SKUs)
serves live cpr.parts price/availability (our account's cost) through a 30-min
`ms_products` cache (authenticated read): order rows show cost + a red
"MS out of stock" pill, and a **part-group's order SKU auto-picks the cheapest
IN-STOCK member** (★ default = tiebreak/fallback; member rows show per-SKU
price + MS stock). The **`sync_catalog` action** refreshes `ms_catalog` — the
Part Groups member-search source (`consumption-report.html` searches it on
sku/name) — from the live cpr.parts product catalog: newest-first
(`order=entity_id desc`), upserting **sku + name only** so the curated
make/model/quality on already-known SKUs (from the original 2026-06-18 bulk
import) is preserved while new parts get added. Incremental by default (stops
after 2 pages with no new SKUs); `full:true` + `page`/`pages` does a chunked
full pass (each page ~4.6s, so a full 33k+ pass is driven in chunks, never one
call — the worker resource limit kills a continuous multi-minute run). Cron
`ms-catalog-sync-weekly` (Mon 2:40a PT, NOTIFY_SECRET). Before this, ms_catalog
was a frozen June import and new SKUs never autocompleted. Cross-store transfer chips were built then removed at the
owner's request (2026-07-22) — don't resurrect without asking. **QBO booking from MS orders is deliberately NOT
built** — the owner will drive that step-by-step; never auto-post to QBO from
MS data without explicit direction (docs/mobilesentrix-pipeline.md).
**📋 Send to RepairQ** (consumption report header, any signed-in staff) assigns
the day's **consumed + ordered** SKUs as a RepairQ inventory count, **to whoever
clicks it** (self-managed, due ~7pm store-local). `repairq-query`'s
`count_people` (getManagers/getAssignees, **stripped to id+name** — RepairQ's raw
rows leak password hashes) + `assign_counts` (resolve SKUs → catalog ids via
Looker, then POST RepairQ's own `/ajax/inventoryCounts/assignCounts` —
`catalogItemIds` is a JSON-stringified array; the browser matches the signed-in
`display_name` to a RepairQ assignee). Print Count Sheet uses the same
consumed+ordered scope. **Blind spot still open:** a special-order part that
arrived and left without ever being on a ticket is never *consumed*, so it never
reaches this list — catching those needs a separate "recently received at store"
pull from RepairQ (not yet built).

**Who set a max stock level:** the Stock Level tab carries a **Last Changed By**
column. `max_overrides` / `group_max_overrides` / `groups` gained
`updated_by` + `updated_by_name`, stamped by the `stamp_max_author()` **trigger**
— never by the page: `auth.uid()` can't be spoofed by a hand-rolled request the
way a client-supplied name can, and any future writer is covered without
remembering to pass one. The trigger takes the max's column name as its argument
and only re-stamps when THAT column actually changes, so renaming or reordering a
part group leaves the max's author alone; a service-role write with no matching
staff row carries the previous author forward instead of blanking it. The name is
denormalized (like `inventory_edit_log.run_by_name`) because staff RLS hides other
people's rows from a team member, so a join would render blank for exactly the
people reading the report. The column names whichever layer `effMax` resolved to:
an un-overridden SKU reads **RepairQ** (that number is synced, not set by anyone),
and a row with no author at all reads `—`. Hovering the Max number gives the same
answer with the full date, which is how the **Daily order** tab (no room for the
column) and Part Groups surface it. **`updated_by_source` separates `live` (the
trigger read the caller's own `auth.uid()`) from `log`** — the 792-of-812-row
one-time backfill that reconstructed authors from the edge logs' JWT subjects by
timestamp; those render "from logs" and say "recovered from access logs" on hover,
and must never be collapsed into the same thing as a live stamp. **A backfill of
these tables has to run with the triggers DISABLED** — the no-change branch copies
the old author forward, so a live trigger writes null straight back over the
backfill and reports success. Schema: docs/sql/max-override-author.sql.

**Inventory Editor (bulk RepairQ status change from a file):** `inventory-editor.html`
(Operations → **Tools** nav, admin/owner — `minRole:'admin'`) does what a one-off RMA
pull-back needed: change hundreds of units' RepairQ status from a scanned list. Flow:
pick store + **From** status (default Instock) + **To** status (default RMA Credit) →
**paste** rows (from Excel/Sheets) or drop a **.csv/.xlsx** (every sheet read;
`assets/xlsx.min.js`) → **Preview** (resolve) → **Run** (apply). Input is one SKU/serial
per line; a 2nd column is a qty, or just repeat the line per unit (both aggregate); a
header row is ignored; **serials auto-detected**. All RepairQ writes run server-side in
the **`repairq-query` edge function's `inventory_status` action** (browser gated by a
signed-in admin/owner Supabase JWT via `admin.auth.getUser` — the RepairQ session never
touches the browser; the older `raw`/PROXY_SECRET path stays server-only). Two modes:
`resolve` (Looker maps SKU→`catalog_item.id`, unmatched values→`inventory_item.serial_number`;
`getStatusCounts` gives live per-status counts — the preview flags not-found, over-scan
"only N here", and nothing-to-move) and `apply` (**non-serialized SKUs move by qty via
`removeStock`** cond=1/carrier=0/supplier=0, verified against before/after counts + one
retry; **serials flip via their own `/inventory/edit/{id}` form** — `flipUnit`/`parseEditForm`,
which carries the unit's own condition/carrier/supplier, no bucket guessing). Move qty =
`min(scanned, live in from-status)`, so scanning more than stock just moves all available.
**Re-runnable/idempotent-ish:** every write re-reads live counts first and only moves what's
still in the From status, so an interrupted run is safe to re-upload (already-moved units
are left alone). The browser drives resolve in 40-row chunks and apply in 15-row chunks with
a progress bar, then offers a **receipt CSV** (per row: result, moved, detail). `removeStock`
ignores CSRF (a mismatched-session token still succeeded across 532 live writes), so the
action doesn't manage tokens for it; the edit-form POST parses a same-session token. RepairQ
status ids: 2 Instock · 8 Pulled · 3 Pending RMA · 96 RMA Credit · 95 RMA Sent · 94 RMA
Rejected · 97 Ordered · 93 Write Off · 99 Damaged · 98 Shrinkage · 1 Sold.

**Interview booking (our own scheduler — Microsoft Bookings replacement):** the host
declares weekly windows and NOTHING else gets a vote — no calendar sync, so nothing can
silently block a slot (the whole reason we left Teams). Tables (docs/sql/interviews-schema.sql):
`interview_settings` (per-host: active, slot_minutes 30, buffer_minutes 15, lead_hours 12,
horizon_days 21, max_per_day, blurb), `interview_availability` (staff_id, store, weekday,
start_min/end_min — store-local minutes), `interview_blackouts` (a date off; staff_id null =
everyone), `interview_bookings` (random `token` = the candidate's capability URL, status
booked|canceled|completed|no_show). **Slots are COMPUTED, never generated** — the
`interviews` edge function derives availability − bookings − blackouts − **approved
`time_off_requests`** (a ½-partial PTO day does NOT block — site convention: partial ≠ off)
on every request, so
there's no cron and nothing to backfill; `book` re-derives the slot server-side and refuses a
posted time that isn't currently open (double-book returns `slot_taken`); `staff_book`
(admin/manager/owner JWT) books on a host's behalf with ANY free-form time — only an
overlap with that host's existing bookings refuses (lead/slot rules don't apply to staff).
Surfaces:
**`interview.html`** — public, no gates/nav (the token is the credential). **Stepped
widget (design 8a — the canvas's newest frame trumps the README):** a red 3-segment
progress bar (Location / Time / Details) with ONE step on screen at a time. Step 1
"Choose a location" = one radio card per ACTIVE store (the `slots` response's `stores`
map carries every active store + display order, not just slot stores) with address and
"Next opening …" / "No openings in the next 3 weeks"; picking advances. Step 2 = compact
location bar (name/address + Change + tel/Directions links) over the month calendar and
a 2-up slot grid (host first name under each time) — **tapping a time advances**, no CTA.
Step 3 = location bar with a summary row (calendar glyph + "Wednesday, July 29 at 10:30
AM"), then Full name / Mobile / Email — **all three required**, per-field inline errors
after first submit (position field dropped) — CTA "Book 10:30 AM". A `?h=` link (or a
single bookable store) skips step 1 and hides Change. Confirmation + the `?t=` view share
the 8a done card: green check, When/Where/Who/You box, dark "Add to Calendar" (.ics),
Google Calendar + Directions row, Reschedule + Cancel. **`interviews.html`** (nav label **"Bookings"**, Employees, manager+) —
the management surface, three tabs: **Calendar** (month-grid overview of every host's
bookings — chips per day, day pane with Done/No-show/Cancel actions; the month label opens
the pickers.js month popover — remember `CPRPickers.month()` OPENS immediately, so call it
from the label's onclick, never at render); **Hosts** (who can get a booking — one card per
host with each availability day on its own line; tap the name to open that host's inline
editor for weekly windows, slot rules, and days off (admins edit anyone by RLS),
✕ removes, and "+ Add Host" (top-right) opens a picker modal that creates the
`interview_settings` row and drops straight into the new host's availability editor.
Windows are added via the "+ Add Availability" modal — set the time/store once (defaults =
open hours 10–19 with All/Mornings/Afternoons quick fills), check every weekday it applies
to, one row inserted per checked day. **Days off** blocks a single day OR a date range
(segmented control; a range inserts one `interview_blackouts` row per date — consecutive
same-reason rows re-coalesce for display, ✕ unblocks the whole range), and the host's
**approved PTO renders read-only** ("Approved PTO" pill, managed in Time Off) since the
slot math already subtracts it);
**Booking Links** (shared + per-host: Copy, `navigator.share`, and a QR dialog via
assets/qrcode.js). The **"+ New Booking" surface** books for
a specific host (pick an open slot OR any custom date/time via "Any time…") or "Anyone
free" (slots across all accepting hosts), requiring at least one contact method — it calls
`staff_book`, so confirmations + host/team notifications fire exactly like a self-serve
booking.
**Mobile pass (design handoff, ≤480px; desktop keeps the table/chip layouts):** the month
grid swaps text chips for status dots (blue booked / green done / red no-show, max 3 then
+N) with a legend strip, the day pane becomes per-booking blocks with tel:/mailto: links
and 44px actions, Hosts becomes 3b cards (initials avatar, `store · slot rules` sub-line,
"Next" strip from the earliest upcoming booking, windows per line, Edit Availability +
**Pause/Resume** — writes `interview_settings.active`; a paused host's links row offers
Resume instead of Copy/Share), and Add Availability + New Booking render as **bottom
sheets** (top:52px under the top bar; `.mback` is z-index 1200, above the 1001 bottom tab
bar). New Booking uses host chips, a horizontal day strip with open counts (full days
greyed), and a 2-up slot grid; the footer CTA names the time ("Book 10:00 AM").
Confirmations: SMS from the store's own
RingCentral line via `messaging`, email via Resend (live; `HIRING_FROM` =
hiring@myrepairtools.com) with a **Gmail SMTP fallback that is currently dead**
— its app password returns 535 bad-credentials, so Resend is the only working
transport; `preview_newhire` reports which one carried a send. **Reminder matrix** — the
`interviews-remind-hourly` pg_cron (now `*/15`; `?action=remind`, NOTIFY_SECRET) runs four
independent passes, each with its own booking flag so nothing double-fires: candidate
text/email at ~24h (window 20–26h before start — same-day bookings skip it, their
confirmation just went out) and again ~1h out (window 40–75min, with store address);
the HOST gets personal alerts (kind `interview`) at the same 24h and 1h marks. **Notifying the
team:** the HOST gets a personal alert (alerts fanout, kind `interview` — a Notification, push
on/text opt-in, in profile.html's prefs matrix) on book/cancel/reschedule, AND the routed rules
`interviews.booked` / `interviews.canceled` fire for the team (Settings › Notifications).
**Booking notifications are host-only by owner preference (2026-08-01):** those two routed
rules are deliberately **unrouted from every channel** (their links to the Communications Feed
were removed) so bookings no longer post to the all-staff feed — only the host's personal
`interview` alert fires. The rules stay enabled/available; don't re-route them to a team-wide
channel (e.g. Communications Feed) without the owner asking.
**Store contact info** (`stores.address/phone/email`, edited in Settings → Locations;
docs/sql/2026-07-26-stores-contact.sql) feeds the whole candidate surface: the public
page shows the CPR logo (assets/images/CPRLogo_NoAssurant_White.svg) and a per-day
location box (which store the interview is at + address + tel/mailto links — a
mixed-store day tags each time with its store instead), confirmations (text + email)
carry the address + store phone via `smsWhere`/`storeInfo`, the `slots` response
includes a `stores` contact map, and the confirmation/booking view offers
**Add to Calendar** (client-built .ics download + Google Calendar template link).
The three stores' address + phone came from **our own Google Business Profile**
(gbp-sync's secret-gated `?action=location_contact` reads each mapped listing's
storefrontAddress + primaryPhone — Google is the verification source, `stores` is the
runtime authority the owner can edit); email is **blank until the owner fills it in —
never guess store contact info, and don't source it from third-party directories.**

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
in Options). **The toolbar button opens a tool MENU** (popup/menu.html, v2.7.0):
Price Calculator (the old popup) + **Label Resizer** — opens `label/label.html`, a
bundled copy of label-resizer.html (own pdf.js copy; site tool stays as the
fallback). **Upload-first, like the labelresizer.com service it replaces** (ALL
tab-grabbing — fetch/debugger/screenshot — was removed at the owner's request
after Chrome's file:// and viewer restrictions kept degrading it): drop the label
PDF and the tool auto-detects the label — a pdf.js operator-list scan pulls each
page's embedded images (objs.get raced against a 1s timeout; group-scoped g_*
objects never resolve), scores them (≥80k px, 1.15–2.6 aspect, ≥85% grayscale
samples, 4–60% ink → labels; logos are colorful and fail), queues the winner per
page and label-less pages (packing slips) auto-trimmed — then **builds a 4×6 PDF
FILE (288×432pt pages, JPEG XObjects, no pdf lib) and auto-downloads it as
"<name> 4x6.pdf"**. Open + Download buttons re-emit it; manual crop stays as the
fallback for undetectable labels. New parts: `scripts/bg.js` (print gate injector + LCD API proxy — the
edge-function URL and LCD secret live here), `scripts/lcdCapture.js` (ticket-item
watcher + Good/Bad modal), `scripts/lcdLabel.js` (send-display label at
/ticket/printLabel), vendored `scripts/qrcode.js`, and
`scripts/assistantOverlay.js` — a ✨ FAB in RepairQ opening `assistant.html`
(iframe): the same cpr-assistant chat widget in embed mode
(`window.CPR_ASSISTANT_EMBED`, full-viewport, auto-open, iframe-allowed), with
the RepairQ page context (ticket #, store, tech, line items) posted in via
postMessage and prepended to the first message. Auth rides the MRT origin's
Supabase session (sign in once per browser); Options has an AI Assistant toggle.
**Quick links:** `customQuickLink.js` renders **Price Guide as a built-in
link** in RepairQ's nav (hard-coded to myrepairtools.github.io/price-guide.html,
always framed — no setting), plus **two** user-configurable custom links in
Options (the third slot was removed). **What's Next?** (`scripts/whatsNext.js`) — the "McDonald's order board": a 🍔 button in
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
time, default OFF). All toggles in Options (storage.sync objects `wn`, `mcpr`). **The site hosts the current build**: `downloads/myrepairtools-extension.zip` (+
`downloads/extension-manifest.json` for the version pill), downloaded from
**`extension.html`** ("Get the Extension", Tools nav) — store machines update from
there, no file shuttling. The zip keeps ONE canonical path, but the page reads the
manifest version and sets the anchor's `download` filename, so it saves as
`myrepairtools-extension-<version>.zip` (no ambiguous "(1)(2)" copies on store
machines) — nothing to change at build time. **Rebuild the zip on every extension change**
(`cd extension && zip -qr ../downloads/myrepairtools-extension.zip . && cp
manifest.json ../downloads/extension-manifest.json`). Install unpacked or publish to
the Chrome Web Store (steps in `extension/README.md`). When changing LCD behavior, update
the extension AND check `lcd-buyback.html` + the `lcd-buyback` edge function stay in
sync. **RepairQ ticket notes must be 3-byte-utf8-safe:** RepairQ's MySQL silently
truncates a note at the first 4-byte char (most emoji), so an emoji-PREFIXED note
stores completely blank — and a blank note blocks the whole ticket from saving
(the v2.5.80 Eugene incident). Every extension `writeNote` strips astral chars
before posting and note prefixes stay ASCII/BMP (✔ ⚠ ⛔ are safe; 📣 🛡 are not).
**A note that can't be written must say so:** followUp's `writeNote` used to
bail silently when the page had no `YII_CSRF_TOKEN` input — the Supabase
`ticket_contacts` row saved, the RepairQ note never appeared, and nothing was
logged (owner report 2026-08-18, ticket 16364927). It now looks for the token
in the input, a `meta[name=csrf-token]`, and the cookie (that read is
try/caught — `document.cookie` throws in an opaque document), and when there
is still no token it hands the write to bg.js anyway, whose in-tab path reads
the token off the page itself; bg.js therefore treats `csrf` as OPTIONAL and
only skips its direct fetch without one. Every remaining dead end files a
`kind:'debug'` row through `issue:report`. Safety net: `repairq-query`'s `sweep_blank_notes` action (the
`repairq-blank-note-sweep` pg_cron, :20/:50 hourly) scans the active ticket list
and deletes any empty-bodied note.
**A check-in stash may only land on ITS OWN customer's ticket (v2.8.2, issues
3105/3106):** the check-in modal fires before a ticket number exists, so the
choice waits in sessionStorage (`mrt_fu_pending`) and flushes onto the next
ticket page. The old rule flushed onto ANY New/edit ticket that loaded next in
the tab — an abandoned check-in put customer A's follow-up on customer B's
ticket, which read as both reported bugs at once (missing where the tech saved
it, present where they didn't; Ready-for-Pickup then found "pref: none" and
never texted). `pendMatchesTicket()` now matches the stash's phone/email
against the ticket page's own customer block before flushing (note
`suggestedPhones()` returns `{num,tag}` objects, not strings); a stash with no
contact data (return/skip) rides only the fresh post-save landing
(`mrt_fu_checkin`, consumed once); TTL is 15 min. A non-matching stash stays
put for its own ticket. Tests: `extension/test/` — `followup-ownership.test.mjs` (node+jsdom, boots
the real script and asserts what reaches contact_set; verified against the
pre-fix source so it demonstrably detects the bug) and `boot-smoke.test.mjs`.
See that folder's README to run them. Mock pages must mirror
RepairQ's real sidebar — `.sub-head h3` "Customer" + sibling `.block-content`,
≤480px wide — or `customerAnchor()` finds nothing and boot stalls in
`whenSummaryReady`).

**Google Business Profile (Google Traffic + Google Reviews):** measures why Eugene
wins on Google and runs the review-reply engine. Data layer (`docs/sql/2026-07-10-gbp-schema.sql`
+ `2026-07-22-gbp-phase2.sql`): `gbp_locations` (store ↔ Google listing map + lifetime
rating + `phone` + `last_photo_at`), `gbp_metrics_daily` (+ monthly view),
`gbp_keywords_monthly`, `gbp_reviews` (lifetime, upserted on Google review id),
`gbp_profile_snapshots`, `gbp_audit` (every write to Google), `gbp_reply_queue`
(auto-reply 3h hold), `gbp_notify_prefs` (per-user, self-RLS), `gbp_notify_log`
(dedupe), `gbp_config` (auto-reply toggles). All filled by the **`gbp-sync` edge
function** (secret `GBP_SYNC_SECRET` via `?secret=`; Google OAuth refresh-token secrets
`GBP_CLIENT_ID/_SECRET/_REFRESH_TOKEN` — account britt@irepairphoneshop.com; reviews +
replies ride the legacy **v4** API, the newer APIs don't have them). Crons:
`gbp-sync-nightly` (11:05 UTC — metrics 10-day window, reviews, snapshot, phone/photo
freshness), `gbp-keywords-monthly` (3rd, keywords finalize mid-following-month),
**`gbp-engine` (*/15 — the review engine)**: incremental review pull → 1–3★ alerts +
24h SLA alerts (recent reviews only; no 12h nudge — evening review + 3h hold +
9 AM posting window crosses 12h routinely; via the alerts function + direct SMS per
`gbp_notify_prefs`; 1–2★ ignores quiet hours) → auto-reply enqueue (**4–5★ only**, LLM
draft via `ANTHROPIC_API_KEY` or rotating thank-you for rating-only, 3h hold) → posts
due holds 9a–7p store time → Monday digest to Communications (kind 'gbp'). Guardrails
(design response §3): 1–3★ NEVER auto-posts; every post (human or auto) writes to
Google AND `gbp_audit`; 1–2★ drafts carry the store phone / take-it-offline; matching
Google listings to stores uses title + storefrontAddress (all three listings are titled
just "CPR Cell Phone Repair", and the Clackamas listing's city is **Happy Valley** — its
`gbp_locations` row was mapped manually; discover never overwrites it). Surfaces:
**`google-traffic.html`** (Reports nav, managers) — Compare (scoreboard matrix, columns =
stores, ★ Benchmark = the month's impressions leader with `#FFF8EE` tint, sparklines,
MoM deltas, gap badge rows, rule-generated "Why Eugene wins" / "Do next" right rail;
null metric = grey · never 0) / Trends (metric chips incl. Rating, YoY legend) /
Keywords (diff chips, `<15` threshold, `—` never appeared) with store dropdown + joined
month control + hash tabs; **`google-reviews.html`** (Reports nav, managers, red
unanswered nav pill via nav.js `badge:'gbp'`) — chronological feed (no month picker),
status pills (🤖 auto in Xh / ✓ auto-replied AUTO / amber→red at 24h), reply drawer
(desktop 430px / mobile full sheet: AI draft via `?action=draft`, ↻ regenerate, ✓
Approve & post via `?action=reply` with staff JWT, skip/stepper through unanswered,
once-per-session "public on Google" confirm), 🤖 Manage sheet (master + per-store
toggles `?action=config_set`, hold queue edit/post-now/cancel `?action=queue_op`), ⚙
notification settings (methods SMS/push/in-app, stores, triggers, quiet hours →
`gbp_notify_prefs`), deep link `#r=<review-id>`. Dashboard **Google Reviews widget**
(`assets/gbp-summary.js`, `window.CPRGbp.snapshot()`) → google-reviews.html. Browser
actions auth by staff JWT (manager+); cron actions by secret. **Department
listings** (corporate's "Electronics at CPR" / "Video Game Console Repair at CPR",
2 per store, manager access accepted 2026-07-22) live in `gbp_departments`
(docs/sql/2026-07-22-gbp-departments.sql); discover maps them by title+address
(address-equality fallback catches Happy Valley) and NEVER overwrites a store's
main-listing row. Their reviews land in `gbp_reviews` under the parent store with
`department` = listing title — feed (grey dept pill), counts, alerts, SLA, and
auto-reply all cover them; store lifetime rating/review_count stay main-only, and
review deletion sweeps are scoped per listing. Dept metrics/keywords deliberately
not synced. Store pill colors on both pages read `stores.color` (Settings →
Locations); the hard-coded palette is only a fallback. The ~1,200
pre-engine unanswered reviews are **retired**: `gbp_reviews.legacy_unanswered`
(one-time marking, docs/sql/2026-07-22-gbp-legacy-unanswered.sql — owner chose not
to answer the backlog) excludes them from every unanswered count/filter/SLA surface;
they render with a muted "no reply" pill and can still be answered by hand. New
reviews are never flagged — keep the `.eq('legacy_unanswered', false)` filter on any
new unanswered query. "Send asks…" (review-request engine) is the deferred Phase 2
remainder.

**Knowledge Base ("the brain"):** `kb_categories` + `kb_articles` (light-markup body —
same family as Communications, plus # headings, [links](url), ![images](url) from the
public `kb-media` storage bucket; tags, summary, status draft→published→archived,
`min_role` employee|manager, `require_ack`, trigger-maintained weighted tsvector) +
`kb_article_versions` (snapshot on every save) + `kb_reads` (per-person first_read_at +
acknowledged_at — the compliance record) + `kb_feedback` (👍/👎 per person). Authoring is
**manager-only** (RLS `is_admin()`); employees read published `min_role='employee'`
articles. Surface: `knowledge.html` (My Hub, everyone). **Browse redesign (design
handoff 13c/14a/17a/19a/20a, 2026-08-12) — the portal flow:** the `#c=all` landing
is a **search-first portal** (dark hero band + centered search, category tiles
overlapping the band bottom, "Most read this month" card from the
`kb_most_read(days)` SECURITY DEFINER RPC — returns (article_id,n) only, the page
joins against articles the caller can already see). Typing ≥2 chars morphs the
hero search into a results panel (kb_search RPC, ↑↓/Enter/Esc keyboard nav,
tiles dim behind, "All N results ›" expands). A category opens the **two-axis
topic view**: slim dark band with breadcrumb + scoped search + **sub-category
pills** (facet 1), **tag chips** on the surface (facet 2) — labels over each row
come from the category config (`kb_categories.subcat_label/tag_label`, e.g.
Device/Component — nothing baked into code), facets combine freely with live
filtered counts, cards carry sub-category badges when Device=All, and a category
with no facets renders the same card grid with no filter rows. Per-category
**landing option** (`kb_categories.landing`, owner ask 2026-08-13): 'articles'
(default, the pill view above) or 'subcats' — the category opens as
**sub-category CARDS you click into** (drill-down; Equipment & Software uses it):
no pills on the landing, articles without a sub-category render as normal cards
below the folder cards, any refinement (picked sub / tag / search) leaves the
landing, and in 'subcats' categories sub-category moves are pushState LEVELS
(Back walks cards ↔ articles) while tag clicks stay replaceState. Set per
category in the Categories settings ("Sub-category cards first"). Data:
`kb_subcategories` (+ `kb_articles.subcategory_id`) and category-scoped
`kb_tags` + `kb_article_tags` (docs/sql/kb-facets.sql; Repair Knowledge seeded
Device/Component per the handoff). Managers configure it all in **Categories**
(the KB page's ＋ menu → Categories, `#cats`): master–detail with a facet-status pill per
category ("Device · Component" / "—" = setup audit), group-label inputs,
drag-ordered sub-categories, tag pills. The article editor sidebar picks
sub-category + tags (category-scoped; save replaces the article's tag set).
Required/Drafts/Archived keep the pre-portal list layout. The article view
records the read and shows the ack bar for required
articles, 👍/👎 footer; managers additionally get the inline editor — a **WYSIWYG surface**
(owner call 2026-08-12: "a real full editor"): contenteditable styled with the
reading view's typography, an **icon-only toolbar** (Lucide via CPRNavIcon — labels live in
tooltips) with a text-size **dropdown** (Normal / Heading 1-4 → `#`..`####`),
B/I/U, lists with Tab/Shift+Tab sub-items, **Tables** (menu: insert, add/delete
row & column, delete table; Tab walks cells and adds a row off the last one),
**Note boxes in amber/red/green/blue plus a plain no-color box** (menu recolors
one in place; "Remove box" unwraps it), Link, Image, Divider, Clear format, Word/SharePoint
paste sanitizing (junk styles stripped, `·` paragraphs → real bullets, tables
flattened to bullets), image upload to kb-media, a pop-out Preview, and a
`</> Source` escape hatch for the raw markup. **Storage is unchanged** — the
body is still the light markup every other surface reads (training.html,
the candidate handbook accordion, the handbook PDF, kb_search's tsvector):
mdToEditor() renders markup → editable HTML on open, editorToMd() serializes
back on save (round-trip verified). Also a Drafts pill, and a
**Compliance tab** (per required article: acknowledged vs outstanding roster with
"read but not acked" / "never opened" flags, overall % tiles). First publish (and
🔁 Reset acknowledgments — re-certification) auto-posts to Communications
(`source_key 'kb:<id>:…'`). Deep links: `knowledge.html#a=<slug>` +
`#c={cat}&s={subcat}&t={tag}` facet URLs. Dashboard
**Knowledge widget** (`assets/kb-summary.js`, `window.CPRKnowledge.forMe()`) shows
required-reading queue + newest articles. **AI: the `cpr-assistant` edge function does
KB RAG **and Price Guide RAG** — pricing-flavored questions also FTS-search
`price_guide_entries` (imported from price-guide.html's tables via scratchpad
pg_import.py — re-import after editing the page; schema
docs/sql/price-guide-entries.sql) and inject matching rows with quote-exactly
rules, so the assistant answers prices/SKUs from the real guide. **Phase 2 is
LIVE (owner directive 2026-08-12: "access to everything, scoped by RLS"):
signed-in users get read-only db tools — `db_select` + `table_columns` — run
through a client built with the CALLER'S OWN JWT + anon key, so RLS scopes
every result to what that person already sees in the tools (owner sees all;
an employee asking for everyone's phone numbers gets only their own row —
verified both ways). The service-role client is never exposed to the model;
no raw SQL — filters/order/limit only, 100-row cap, reads only. Table map
from the `assistant_schema()` RPC (docs/sql/assistant-schema-fn.sql,
SECURITY DEFINER, execute revoked from browser roles; cached per boot — new
tables appear after a redeploy/cold start). Streaming is a server-side
tool-use LOOP (≤6 rounds) that forwards text deltas in Anthropic SSE shape —
the widget only reads content_block_delta/text_delta, so it needed no
changes. Anonymous (no-session) chats get no db tools. Phase 3
(permission-checked, confirm-gated writes) still ahead** — every question runs `kb_retrieve(q, mgr)` (SECURITY DEFINER, execute revoked
from browser roles; strict-then-loose FTS) and injects the top articles into the system
prompt with citation rules (`from: [title](link)`); the assistant must never state
CPR-specific policy that isn't in the KB. cpr-assistant's source now lives in
`supabase/functions/cpr-assistant/` (recovered from the deployed eszip — keep it
committed). Nag reminders for unacknowledged required reading are deliberately deferred
to the notifications project. Importing existing docs: give them to Claude in a session —
it converts and inserts articles directly.

**KB v2 — onboarding & quizzes (design-handoff rebuild):** knowledge.html is now the
full training surface. **The KB's white nav pane is RETIRED (owner call
2026-08-12, post-portal):** knowledge.html shows the standard menu pane like any
page, **Training has its own rail icon** (`cap` glyph, direct link — removed
from the HUB list; the mobile drawer carries an explicit Training row next to
Knowledge Base), and the pane's Manage rows collapsed into a **＋ menu** on the
KB page (hero top-right + topic band; managers only): New article · Drafts ·
Categories · Archived-when-any. The required-reading banner's text opens the
`#c=req` list; Drafts/Archived/Required views carry a "‹ Knowledge Base" crumb
back to the portal. nav.js's kb area, kbPaneHtml, `cprKbNav` cache, and
knowledge.html's publishNav are all deleted — don't resurrect them. The library is full-width list rows with
per-user **Viewed** column — "Never" amber, red when required-unacked), restyled
reading view (read-time meta, `!> ` amber callouts in the light markup, footer
"✓ Mark as read" = `kb_reads.acknowledged_at`, the read receipt that feeds
everything), **My Onboarding** (`#onboarding` — sequenced modules from
`onboarding_modules`; a module's track MIXES articles (`module_id`/`sort_order`) with
**task steps** (`onboarding_steps`: HR paperwork & account setups — I-9, W-4, QBO
payroll, QB Time, RepairQ credentials — each `who` employee|manager; completions in
`onboarding_step_done`, employee steps self-ticked, manager steps ticked per-person
from KB Compliance's detail modal); items unlock strictly in order, a step with a
quiz isn't done until the quiz passes; assignment row created lazily in
`onboarding_assignments`; a seeded "Getting Set Up — HR & Accounts" module ships the
standard steps), **Onboarding Setup** (`#modules`, manager-only, nav Manage group —
create/rename/reorder modules, order their mixed items, add/edit task steps, attach
articles; schema docs/sql/onboarding-steps.sql), **quizzes** (`kb_quizzes`/`kb_quiz_questions`
readable; **correct answers live in `kb_quiz_answers` with no client read** — grading
is the SECURITY DEFINER RPC `kb_quiz_grade` which records `kb_quiz_attempts` and
returns only ok/hint per question; managers author via `kb_quiz_set_answer`/
`kb_quiz_get_answers`; 80% pass, unlimited attempts, best kept), and the sidebar-card
**article editor** (per-article `emoji` + optional `icon_url` — an uploaded logo
image (kb-media `icons/…`, ≤128px PNG) that replaces the emoji on every row-icon
surface (cards, lists, search, article header, Training reader, Setup rows) via
knowledge.html's `artIconHtml()`, module slot, quiz editor modal, archive/
restore, publish still announces to Communications + alerts). `kb-compliance.html`
(nav 'KB Compliance', Employees, manager+, hidden:true — linked from the KB sidebar's
Manage section) is the roster view: store `.storesel` filter, stat tiles, per-person
onboarding %, quizzes passed, receipt pills per required article, overdue = required
still open 7+ days after publish. Schema: docs/sql/kb-onboarding-schema.sql.

**Training Center (round-2 design handoff, 2026-08-12):** the training surface
split three ways. **`training.html`** (My Hub 'Training', graduation-cap) is the
employee home, rebuilt to design 2a (handoff "Training Page — Employee Side",
2026-08-17): **one glance = what to do now.** An **onboarding banner** replaces
the module cards entirely — current module, n of m, the next VISIBLE item with
whose move it is ("— your move" / "— waiting on your manager"), a due chip, and
a red Open-my-onboarding button into the onboarding board's employee view;
module detail lives there, never here. Below it **"Do these — N"**, one ordered
card (signature-required first, then required reading / re-reads) where only the
TOP row carries the red button, so there is one obvious next action; empty state
is "You're all caught up", and the section always renders so the page shape is
stable. **Completed collapses to a single row** ("15 items completed · newest …",
localStorage `cprTrainDone`) so finished work stops pushing real work below the
fold. `#track` is the 9b module detail (section header
bands with per-section counts, next/lock/done rows, "Waiting on your manager" chip,
past-due = red chip+bar, NOTHING locks on past-due; sections are presentation only —
unlock stays strictly sequential). knowledge.html#onboarding redirects here.
**Assignment is per (person, module)** — `onboarding_assignments` rows carry
module_id/assigned_by/assigned_at/due_at (docs/sql/onboarding-sections-assign.sql;
the legacy one-row-per-person unique is gone); unassigned people see/count NOTHING
("Nothing assigned", never 0%). **`assets/onboarding-track.js`** (`window.CPRTrack`)
is the ONE merge/order/section/unlock implementation — training, kb-compliance and
knowledge Setup all render from it; never fork the math. **`kb-compliance.html`**
rebuilt per 9a: roster (Onboarding bar + New-hire setup tone chip — new hire =
started ≤60 days, others "—") + a right slide-over per person: **New-hire setup
checklist** — auto-verified rows computed LIVE (pin_hash, home store, staff_schedule,
assignments, staff_profiles phone/emergency, birthday, commission_roster gated by
whether the ROLE earns accessory/device → n/a otherwise) + 5 manual trust-me ticks
(I-9, QB Workforce invite, RepairQ creds, shirt, team chat) in `staff_setup_checklist`
with checked_by/at audit; assigned-module toggles + due-date chips (pickers.js);
next-up items with inline manager ticks. **`onboarding-dashboard.html`** (Employees
nav 'Onboarding', manager+) is the hiring pipeline, rebuilt per the
"Onboarding Roster → Per-Person Profile" design handoff (2026-08-17):
a full-width **roster** (avatar rows, stage pill, paperwork chips, progress
bar with a whose-move-is-it next line, mentor column, per-row ⋯ menu) where
View opens a **per-person profile board** (`#e=<staff_id>`, pre-conversion
candidates `#i=<intake_id>`): columns **Hiring → New-hire setup → one per
assigned module** (+ an Assign-training column when modules are unassigned).
The Hiring column is intake-derived and holds what used to be roster buttons —
offer/handbook/form as auto rows off the signature stamps, Review + Create-in-
QuickBooks as manager ticks (`staff_intake.reviewed_at/_by`,
`qbo_created_at/_by`) with their action links beside them, convert = the
existing find_employee → promote modal. Setup mirrors kb-compliance's
`setupRows` (keep the two in step); module columns render from
`CPRTrack.build` — never forked — with one-click tick/untick on manager +
back-office steps, `requires` rows saying what they wait on, due chips
(CPRPickers.day), and 100% columns auto-collapsing to a 54px strip
(localStorage `cprObFold`). **One page, two roles:** a non-manager landing
here gets their OWN board (or their mentee's) — module columns only,
back-office rows removed before unlock is computed (training.html's rule),
manager steps read-only, their next step tickable — reached from a banner on
training.html while onboarding is open. **Mentor** = `staff.mentor_staff_id`
(header select, staff at the hire's store), written via cpr-auth
`update_staff`; `is_my_mentee()` RLS (docs/sql/onboarding-profile.sql) lets a
mentor read their mentee's track and tick manager steps without being an
admin. The roster ends by stamping `onboarding_completed_at`/`canceled_at`
(⋯ menu; staff row via update_staff + mirror on the intake row); stamped
people leave the roster but stay reachable by deep link. A missing-docs
convert warns but is allowed — paper case. **Candidate stage (owner directive 2026-08-12): new hires start as
New Candidates.** The **New Candidate wizard** (4 steps, chips like the
Checklist Template wizard: Candidate → Offer Letter → Preview → Send) takes
name/store/position/pay/start + optional phone/email, then the **offer
letter** (prefilled from `app_settings` `hiring.offer_template` with
{name}/{position}/{pay}/{store}/{start} resolved live until the manager
hand-edits; the exact text is snapshotted to `staff_intake.offer_body` — what
they sign never changes after send. The live template is the owner's REAL
offer letter, parametrized). **The offer travels as a PDF** (intake fn,
pdf-lib lazy-import, US-Letter, CPR letterhead + store address/phone from
`stores`, light markup: '# '/'## ' headings + '• ' bullets): step 3 previews
the exact PDF (`offer_pdf` action → blob iframe), step 4 creates the row then
offers **Email the offer — PDF attached** (`send_offer`: Gmail SMTP w/
attachment, reply-to `app_settings` 'hiring.reply_to' = bbay@cpr-stores.com,
signing link in the body, stamps offer_sent_at/_via) / **Text the signing
link** (messaging fn, store's line, `candidate_link` template key) / Copy.
One link does the whole flow: **sign the offer** (accept, or decline with
an optional note → status 'declined', terminal, row kept + deletable) → **sign
the Employee Handbook** (accordion rendered LIVE from the KB's Employee
Handbook category via the intake fn — published employee articles only, so
candidates always sign current wording; the category is pinned by id in
`app_settings` `hiring.handbook_category_id`, since the old `%handbook%` name
match would render an EMPTY handbook — and still take a signature on it — the
day someone renames the category. Signing stamps a **manifest** into
`signed_meta.handbook`: every section's slug + title + `kb_articles.version`
that was on screen, plus the ack version. The live handbook is the one they
sign, so without that the record was only reconstructible by inference; the
manifest pins it against the `kb_article_versions` snapshots and prints on the
frozen acknowledgment PDF as "Sections signed: … (v2)". Editing an article
does NOT re-ask anyone already hired — that stays the deliberate
**Require re-read** / **Require new signatures** tick at publish) → the 5-step new-hire form. Signatures
follow the contracts pattern (png data-url + typed name + ip/ua in
`signed_meta`); server enforces order (submit refuses `docs_first`/`declined`)
and each milestone fires a best-effort **'hiring' alert** (new alerts kind,
Notification tier) to the manager who created the link. **`signed_pdf`**
(token-auth) renders the SIGNED record — offer + embedded signature block +
an Employee Handbook acknowledgment page — downloadable from the candidate's
done card and the manager review modal's "⬇ Signed offer (PDF)". Docs columns:
docs/sql/candidate-stage.sql. A link created with the docs checkbox OFF keeps
the original form-only flow (offer_body null).
**Who they can reach before day one:** a candidate had no phone number for a
human between signing and their start date. The intake fn's `contactPeople()`
resolves the owner + the store's manager (`stores.manager_staff_id`) with
phones from `staff_profiles.phone` — the same field the SMS pipeline uses,
never a copy on `staff`. Those two ride three surfaces: the welcome email
(contact block + a `CPR Contacts.vcf` attachment — `sendOfferEmail` takes an
optional extra-attachments array), the intake page's signed + done cards
("Your team" rows with tel: links and an **Add to contacts** button), and
`first-day.html`'s store numbers. The .vcf is served by the fn's **one GET
route** (`?action=vcard&t=<token>`, `text/vcard` + Content-Disposition) rather
than built as a browser blob — iOS hands a served vcard straight to Contacts
and ignores a blob download. To see the welcome email itself without burning a
test candidate (and texting that store's manager an "Offer signed" alert), the
intake fn's **`preview_newhire`** action (manager JWT, like `send_offer`) mails
it to any address off a made-up candidate — no row, so nothing is stamped.
**Intake:** `intake.html` is a PUBLIC token page (11a; candidate phases above,
then 5 steps: About you → Address
& work details → Emergency contacts → Availability with All day/Hours/Off per day and
Open/Close endpoints, stored structured jsonb → Review; no pronouns/transportation/
SSN/bank) driven by the **`intake` edge function** (get/sign_offer/decline_offer/
sign_handbook/submit by token; manager
create/promote/cancel by JWT — the browser never reads `staff_intake` from the
candidate side; managers read it directly under the is_admin RLS; promote copies onto
the staff row + staff_profiles fill-empty-only and applies each module's auto-assign
rule `auto_assign_role`+`auto_assign_from`, and refuses declined rows). **Module Setup is its own page
`onboarding-setup.html`** (manager+; knowledge.html#modules redirects there) with
the 9c controls: auto-assign rule bar, section chips, per-item section selects
(`onboarding_sections` + section_id on articles/steps); the three management
surfaces (Dashboard/Setup/Compliance) cross-link in their headers and are NOT in
the KB surface (they cross-link from their own headers; the KB pane itself is
retired — see above). Intake
rows are deletable from the dashboard (intake `cancel`, un-promoted only).
training.html reads articles IN-PAGE (`#read=<slug>` — mark-as-read + quiz CTA
stay in Training; only quiz-taking hops to knowledge.html). The editor's publish flow
gained **"Require re-read"** (published+required articles): checking it on Save &
publish nulls every `kb_reads.acknowledged_at` so the refreshed policy resurfaces in
Training → Assigned training; ordinary edits never auto-reset. Quiz authoring stays
the modal (11b full-page treatment deferred); the 9d Team Members intake review card
is covered by the dashboard's Review modal for now.

**Signature-required articles (policies employees SIGN):** `require_ack` is a
click; some documents need a real signature. `kb_articles.require_signature`
(implies require_ack, so every existing compliance surface keeps working
untouched) turns the article's read bar into a **Sign this document** button
that opens a signature modal (canvas pad + typed name — pointer events, DPR-
scaled backing store; the pad is deliberately NOT inline, since a canvas in a
long article gets scrolled past or drawn on by accident on a phone). Signing
goes through the **`kb-sign` edge function** — the browser NEVER writes
`kb_signatures` itself, because a signature record with no document behind it
is worthless. The function renders the article to a **frozen PDF** (own leaner
pdf-lib builder, CPR letterhead pulled from `hr-private/letterhead-logo.png`
rather than duplicating intake's base64 constant; light markup via its own copy
of `kbToPdfMarkup` — keep the two in sync), files it in `hr-private` under
`staff/<id>/` + `staff_documents` (kind `policy`, source `kb:<slug>:e<epoch>`),
writes `kb_signatures`, and stamps `kb_reads.acknowledged_at`. Frozen, never
regenerated — same rule as the handbook acknowledgment. `my_doc` mints a
120-second signed URL so an employee can download their OWN copy (storage
policies open `staff/` only to `is_admin()`).
**TWO version numbers, deliberately:** `kb_articles.version` bumps on every
save and is the audit record of the exact wording signed (it prints on the
PDF); **`signature_version` is the EPOCH — the obligation**, advanced only by
the author ticking **"Require new signatures"** at publish (the same shape as
"Require re-read"). Binding staleness to `version` would make a typo fix force
the whole team to re-sign. A new epoch files a SECOND document and keeps the
first, so the history of what someone agreed to stays intact;
`kb_signatures` is unique on `(staff_id, article_id, signature_epoch)`.
**Enforcement is two independent paths** — `assets/onboarding-track.js` treats a
signature article as not-done until signed for the current epoch (identical rule
to a quiz), so the track refuses to unlock past it and a new hire cannot walk
around it; and require_ack inheritance puts it in Training → Assigned training
for everyone else (a policy added today must reach people hired last year).
Signing always happens in knowledge.html — training.html's in-page reader can
only mark-as-read, so signature rows deep-link there, the same hop quiz-taking
already makes. Nothing hard-blocks clock-in; the levers are the track, the
compliance roster and alerts. Schema: docs/sql/kb-signatures.sql.

**Communications (team feed):** `communications` (kind, title, body, source_key for
automated idempotency, created_by) + `communication_reads` (per-user first_read_at,
seconds-on-post, dismissed_at). Bodies are the SAME light markup the KB stores and render through
`kb-markup.js` when it's loaded (headings, note boxes, tables, nested lists —
`fmtBody` keeps a basic fallback for pages without it); both composers use
`markup-editor.js`. Client lib `assets/comms.js` (`window.CPRComms`);
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
({kind:{push,sms}}; missing = push ON, sms OFF; kind 'comms' push is LOCKED ON;
**two tiers** — kinds `schedule`+`system` are ALERTS (urgent): push AND SMS are
auto-enrolled for everyone, prefs can't disable them (profile.html shows them
under a locked "Alerts — urgent" group); the rest are Notifications):
Web Push (VAPID_* secrets; npm:web-push; dead endpoints pruned) to every device
in `push_subscriptions`, and SMS via the messaging function's secret-guarded
`system_send` action, which sends from the OFFICIAL company line
(`ALERTS_FROM_NUMBER` secret — the 1-855; toll-free numbers must be TF-verified
for SMS — falls back to RINGCENTRAL_FROM_NUMBER). **Texts send SEQUENTIALLY (one
at a time, retried once)** — push fans out concurrently, but firing every SMS at
once overran the runtime's outbound-connection cap and silently dropped the tail
of a full-staff broadcast (never reaching messaging, so never logging); the
response also carries `sms_skipped_no_phone` since a recipient with no
`staff_profiles.phone` can't be texted. Push arrives via sw.js
(`push` → showNotification, `notificationclick` → deep link). Wired sources:
milestones (goal hits → the person, kind 'goal'; day-of birthdays/anniversaries
→ the person), Schedule Admin's Notify button (kind 'schedule', everyone — opens a
**modal that pre-fills what changed since the last broadcast**: schedule_overrides +
staff_schedule rows with `updated_at` (trigger-maintained,
docs/sql/schedule-notify-changes.sql) newer than the manager's own last
'Schedule updated' alert row, grouped week → person → weekdays. Each changed week is
a **checkbox** (with its affected stores tagged); the message rebuilds from the
selection until the manager hand-edits it, and the send is **scoped to the affected
stores' people** (home store or authorized there; "Send to every store anyway"
override; live To:-line with recipient count). **A day's affected stores are BOTH
the destination (the override's `store`) AND the origin** — the store the person was
recurringly scheduled at that weekday (`SCHED[staff].arr[getDay]`), so a move
(Eugene→Salem) or an off-day flags the origin store that's now short, not just the
destination. Send fans out alerts (staff_ids, **`push:false`** — the owner wants
this broadcast to be a **text only, not push + text**; the alerts fanout still
forces SMS for the urgent `schedule` kind and always writes the feed row, it just
skips web-push when the caller passes `push:false`). **Scoped sends skip the
routed rule** (owner report 2026-08-12: a 3-person send posted to the all-staff
Communications feed) — only true all-store broadcasts fire
`schedule.manual_broadcast`; a scoped send is alerts+SMS only and always
includes the SENDER in staff_ids so their own alert row keeps the
last-broadcast marker fresh. Keep the
alert title's 'Schedule updated' prefix — it's the last-broadcast marker), KB
required-reading publish (kind 'kb', everyone), and the **end-of-shift task
nudge** — `tasks?action=nudge` (pg_cron `tasks-nudge-halfhourly`, */30): anyone
whose shift ends within 45 min with open tasks due today (assigned to them, or
'each' without their completion; unassigned any-pool tasks deliberately skipped)
gets one alert per day (notify_log `nudge:<staff>:<date>` dedupe), and the
**Saturday weekly-schedule heads-up** — the `schedule-notify` edge function
(pg_cron `schedule-weekly-notify`, Sat 16:07 UTC ≈ 9a Pacific) compares every
active employee's UPCOMING week (coming Sun–Sat) against their recurring
`staff_schedule`; any `schedule_overrides` day that changes store/shift/off-status
vs the recurring cell fires a personal **`schedule_preview`** alert (a Notification,
NOT the urgent `schedule` tier — push-on/text-opt-in, muteable in profile.html as
"Weekly schedule preview") listing the changed days. Time off isn't an override so
self-requested PTO never triggers it (a manager "off" override mirroring the
person's approved PTO is suppressed too); deduped `schedwk:<staff>:<weekStart>`.
Dry-run: `schedule-notify {action:'weekly',dry_run:true,anchor?}` (admin JWT).
Email prefs deliberately not offered yet.

**My Profile (`profile.html`):** every employee's self-service page (avatar menu →
My Profile; the mobile drawer header also links here). Onboarding-ready: a
progress checklist (contact → emergency → notifications → app install → PIN)
drives `staff_profiles.onboarding` jsonb. Sections: contact/emergency/address/
shirt size (autosaved to `staff_profiles` — self-RLS, admins read; phone is
E.164 and feeds the SMS channel) · **birthday** (writes to `staff.birthday`, not
`staff_profiles` — that is where milestones and the new-hire setup checklist
read it; `staff` has no browser UPDATE policy, so it routes through cpr-auth's
self-service `set_birthday` action, same shape as `change_pin`. QB Time carries
NO date of birth, so a hire auto-created by the qbtime sync has none until the
intake form supplies it or they fill this in), notification preferences matrix (Push/Text per
kind; comms push locked), Enable Push flow (Notification.requestPermission →
pushManager.subscribe with the VAPID public key → `push_subscriptions` upsert on
endpoint), change PIN (cpr-auth `change_pin`: verifies current, enforces 4-8
digits + uniqueness across active staff), Add-to-Home-Screen instructions.
**Profile photo:** any employee sets their own from the contact card — the
picked image is centre-cropped square and shrunk to 256px JPEG in the browser,
uploaded to the **public `avatars` bucket**, and its path stored in
`staff_profiles.photo_path` (docs/sql/avatars-schema.sql). It replaces the
initials wherever a person renders: the top-bar identity (nav.js pulls it in
its existing staff query via the new `staff_profiles` FK, caches the URL in
`cprNavPhoto` so it paints without a flash, and shows a photo at every width
while initials stay mobile-only), the mobile drawer header, and
employee-records' roster + profile header. Replacing a photo deletes the old
file; RLS keeps writes to the person's own row.

**Service worker (`sw.js`, registered by nav.js):** NETWORK-FIRST — every request
goes to the live site (navigations force revalidation), the cache is only an
offline fallback. Exists because iOS home-screen apps cling to stale caches
(owners saw old code until delete/re-add). Normal deploys need no SW changes;
bump its VERSION only to GC the cache bucket. Push notifications will live here.

**Feedback (top bar):** two icon buttons by the bell — **Report an Issue**
(bug) and **Suggest a Feature** (lightbulb); on mobile they're rows under
More → Feedback. Both open a small modal and post through the same
`report-issue` edge function the extension uses: issues land in
`extension_issues` with `source='site'` (extension reports stay
`source='extension'`), feature requests in their OWN `feature_requests` table
(owner call: separate list; RLS `is_admin()`). Both text the owner
(`ISSUE_ALERT_NUMBER`), with reporter name + page URL attached automatically.
No triage surface yet — the owner works from the texts/tables.

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
  **Icons are Lucide SVGs, NOT emoji — everywhere (owner call 2026-07-25).** The
  `NAV_SVG` map + `navIcon(name,size)` in nav.js is the single glyph source, exported
  as **`window.CPRNavIcon(name, size)`** for page use (stroke `currentColor`, tints
  with context). New nav entries use a Lucide icon NAME in `icon:`; unmapped strings
  still render as text so nothing breaks. Add new glyphs to NAV_SVG from the
  `lucide-static` npm package (ISC). **Page chrome too:** new/edited h1s, section
  titles, and buttons use a Lucide icon (via CPRNavIcon, or the same SVG inlined
  statically like interviews.html's h1) — no new emoji in UI chrome, and no
  explainer/subtitle lines under page titles unless asked. Existing pages' emoji get
  swapped whenever a page is touched. (Emoji inside CONTENT — comms posts, KB
  articles, SMS bodies — are fine; this is about UI chrome.)

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
per-day) with a ½-partial flag. **Approve/deny** lives on `time-off.html` (permission
`timeoff.approve`, owner-only by default); on mobile the row's **Status pill is the
control** — tapping it opens an action sheet (the Actions column is hidden on phones,
where the table reflows to cards). An **owner's own** request auto-approves at creation
(they're the top approver) and owners may decide their own; everyone else's own request
stays pending and no one can self-approve.

**QuickBooks employees are NOT created by us (verified 2026-08-16).** Our QBO
OAuth app is granted `com.intuit.quickbooks.accounting` and nothing else — a
reconnect explicitly requesting `com.intuit.quickbooks.payroll` came back
accounting-only, with no error and no consent prompt (Intuit validates scope
after sign-in, so a server-side probe of the authorize endpoint can't tell you
this — both scopes return the same sign-in redirect). The Accounting API's
Employee entity is a CONTACT record: payroll reports it `NOT_ON_PAYROLL`, it
carries no hire date even when one is sent, it never triggers a Workforce
self-setup invite, and it shows in the inactive list. Real payroll employees
come from Intuit's first-party payroll API (id family `4000000xx`, vs the
small sequential ids Accounting hands out). So `hiring.qbo_autocreate` is OFF
and the intake fn's `createQboEmployee` is dormant — putting someone on
payroll is the **"Create in QuickBooks Payroll"** step of the onboarding
profile's Hiring column (a manager tick on `staff_intake.qbo_created_at`),
followed by the two QB Time configs it gates — "Add class in QB Time
(classic)" and "Map payroll accounts" (`qbt_class_at`/`payroll_map_at`). Don't rebuild this as an automation without new evidence that
Intuit will grant the scope; `qbo`'s `start` action takes an optional `scope`
(unioned with accounting, so testing can never cost the access we have) if you
want to re-test.

**Candidate role (hired, not started):** convert has to run BEFORE the start
date — Schedule Admin only lists real `staff` rows, so waiting until day one
means a new hire's first week can't be built in advance. Converting someone
with a future `start_date` lands them on the **`candidate`** role
(docs/sql/candidate-role.sql): `schedule.view` and nothing else, so they can
sign in, see their own schedule and do their training, but none of the store's
tools. `staff.role_on_start` carries the role the wizard actually picked, and
the **day-one cron** (`hiring-day-one-sms`, 14:30 UTC — the same run that sends
the 7:30am SMS) promotes every candidate whose `start_date` has arrived, then
fires a `hiring` alert to the owner + store manager. Five tools that were
reachable by any signed-in person (Contracts, LCD Buyback, Brand Assets, Label
Resizer, Get the Extension) gained permission keys so the ROLE decides
visibility — never hard-code a page allowlist per role; add the `acc:` key.
**Everyone now arrives through `candidate` (owner call 2026-08-17;
docs/sql/candidate-activation.sql).** Finishing the new-hire form
auto-converts them — the intake fn's `submit` calls the extracted
`promoteIntake()`, the same path a manager's Convert button runs, with
`forceCandidate` — so their first week's schedule can be built the day they
accept instead of the day they arrive. Because everyone sits in the role, it
is genuinely narrow: `schedule.view` + their own profile, and the Knowledge
Base / Training / Communications (open to any signed-in person before) gained
`kb.view` / `training.view` / `comms.view`, granted to owner+admin+team_member
and withheld here. The door out is an onboarding step: **"Activate employee"**
(`onboarding_steps.action = 'activate'`, manager). Ticking it promotes them to
`staff.role_on_start` via an AFTER INSERT trigger on `onboarding_step_done` —
a trigger, not page code, so every surface that can tick a step activates
correctly. **Un-ticking does NOT demote** (taking access away is a decision,
not an undo), and the day-one cron still promotes anyone whose start date
arrives un-ticked, then ticks the step — nobody is locked out of their first
shift because a box wasn't checked.

**Recurring schedule drafts (Schedule Admin → Recurring → Publish):**
`staff_schedule` is live to every employee the instant it is written (My Time,
the dashboard widget, the weekly-preview cron all read it), so reworking the
recurring schedule used to land on people's phones one click at a time.
Recurring edits now write **`schedule_drafts`** instead (same shape as
staff_schedule, one row per person, RLS `is_admin(store)` — nothing
employee-facing can even read it; docs/sql/schedule-drafts.sql). The Recurring
grid renders from the draft and drafted cells carry an amber outline. **Publish
is a permanent button in the schedule toolbar** (left of Notify staff, on every
schedule tab) — grey and disabled while the draft matches what employees already
see, green with the change count the moment it doesn't. **↺ Revert** sits beside
it and lights up and goes out with it — the two are the same decision — throwing
the draft away and putting the grid back to what employees see (a confirm, since
it destroys work); the Recurring tab carries an amber badge from any view.
Publishing itself takes no confirm step (owner call 2026-08-17 — no pop-up).
**A draft is a row in Postgres, not page state**: doing nothing saves it,
leaving the page keeps it, and coming back finds Publish and Revert still lit. Publish copies each draft onto
`staff_schedule` and deletes the drafts — that stamp is what the 📣 Notify
modal's "what changed since the last broadcast" detection then picks up, so the
flow is edit → publish → notify. **This Week and Monthly deliberately keep
rendering from `staff_schedule`** (an operational view must show what is
actually true), and per-week `schedule_overrides` still write straight through —
a one-off day change is meant to be immediate. A draft that matches live again
is deleted, so "unpublished" always means a real difference, and `shiftsOf()`
keeps a day's stored label when the day itself didn't change (some rows carry
explicit hours there, which is my-schedule's fallback when a shift has no hours
at that store). The recurring picker also carries a **Copy to** row — per-day
chips plus Mon–Fri / All days — that clones the open day's assignment; the
picker stays open so a five-day run is five taps.
**Shift hours — Copy to:** a Custom day in the Shifts & hours modal carries a
**Copy** button that opens a chip row under it (each other weekday + All days)
writing that day's start/end onto the targets; copied chips tick green and the
row stays open. **All days skips days marked Closed** — closed is a deliberate
statement, not a gap — while clicking a day by name always applies, so a closed
day can still be reopened on purpose.
**Shift hours edit in place:** an `<input type="time">` fires `change` the
moment its value parses, so the old re-render-on-change blew the field away
after one digit. `sedSetDef`/`sedDayTime` now repaint just the hour pills
(`sedRefreshHrs`) and leave the DOM — and the caret — alone.

**Handing over CPR credentials:** corporate answers the credentials ticket with
RepairQ / Outlook / GSX logins, and before `staff_credentials` there was nowhere
to put them — a text or an email leaves them in a phone and a sent folder
forever, and `staff_documents` is admin-only in storage so it isn't a delivery
path. One row per person (staff_id PK, `body` text, updated_by/at;
docs/sql/staff-credentials.sql), read by exactly two parties — that person, and
the managers `can_see_staff()` already covers — and written only by managers.
Deliberately NOT encrypted: the employee has to be able to read it, and a key
the browser can use is not a key; what makes it safe enough is scope and
lifetime. Surfaces: the onboarding profile's **Give credentials to the
employee** step (`onboarding_steps.action='credentials'`) carries an
Add/Edit-credentials action that opens a paste box and **ticks the step on save**
— handing them over and recording it are one action — plus a Clear button for
once they've changed their passwords; the employee reads them on **profile.html**
("CPR Credentials" card, copy button) and via View on their own onboarding board.

**Store scoping (`app_settings`):** a general owner-managed key-value settings table
(`app_settings` — key text pk, value jsonb, RLS read-all / write `is_owner()`;
docs/sql/app-settings-schema.sql). First key **`schedule.store_scoping`** (default
`false`): OFF = My Time coverage + time-off visibility span **all** stores (everyone sees
everyone — the single-region-owner-covers-all default); ON = scoped per store as the shop
grows. Toggle in **Settings → Locations → "Schedule visibility"** (owner-only). `my-schedule.html`
reads it (`SCOPE_BY_STORE`): `myStores()` returns all stores when off (or for any owner),
and `isTeammate(e)` widens the teammate filter — when on, a person shows in a store's view
if it's their home store OR one of their `authorized_stores` (so the owner, authorized
everywhere, always appears). New global toggles should become new `app_settings` keys.

**Checklist (store tasks):** `task_templates` **generate** `task_instances` — never render
templates directly; the checklist shows instances. Template shape: recurrence
(`oneoff|daily|weekly|monthly|flexible` + weekdays / month_dates / flex N-per-window;
weekly/monthly also carry `recur_interval` 1-4 + `recur_anchor` for every-N cadence —
bi-weekly = weekly interval 2, so "every other Sunday" fires only on weeks divisible by
the interval counted from the anchor week/month, never before it — plus `window_days`:
the instance generates on its scheduled day but is DUE N days later ("loads Monday, due
Wednesday" = 2; the wizard's Due dropdown is worded in days so day-counting is never
ambiguous). Open weekly/monthly instances persist in the daily list until done, and
on-time keys off due_at, so completing any day inside the window scores on-time),
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
**The template editor is a 4-step wizard** (Details → Schedule → Assignment → Review) and
**assignment is per-location, not one setting fanned out.** A multi-store task = one
`task_templates` row per store sharing a `group_id`; each store carries its OWN target,
people, and per-weekday overrides (`day_assignments` jsonb, keyed by DOW 0-6 — Salem runs an
opener/closer while Eugene works a mid). Step 2 sets the store list + per-store due times;
step 3 shows location chips to pick which store's assignment you're editing, plus "Copy this
store's assignment to all locations" (remaps store-specific people to each store's roster;
shift/role targets carry over untouched). Editing reconciles the whole group (updates
existing store rows, inserts added stores, archives removed ones). The generator's resolver
applies each day's `day_assignments[dow]` override (else the row's default) per store — so
"weekdays → Mid shift, weekends → Open shift" resolves the right person automatically.

**Cash audit detail (cash-admin.html):** the closed-audit view shows the whole
month's cash story: **Month Start** per location (the PRIOR closed audit's
carry_forward — the same source the audit math seeds from; '—' when no prior),
Month-start / Month-end (counted) / Carried-into-next-month header lines, and
the over/short arithmetic spelled out (counted − (start + sales − petty) = X).
**Two different metrics on purpose:** the headline over/short is counted-vs-
SALES (cash_audits.over_short, frozen at close by trueOverShort); the
per-location "Vs tracker" column is counted-vs-the-transfer-LOG — a diagnostic
that can be hundreds off while the audit itself balances (Eugene July 2026:
+$9.83 audit, −$420 Large Safe vs tracker, all of it one day's logged drops
that never matched an envelope). A **Petty Cash card** lists the window's
`to_location='Cash Expenses'` entries with notes, flags when their total ≠ the
audit's petty figure, and says so when the figure was typed at close with no
entries behind it. **🖨 Print** in the detail header + `@media print` CSS that
strips the app chrome and prints the detail as a report. writeCloseDeposits
failures now toast (they used to console.warn only — that's why pre-Aug-2026
audits have no [ac:] deposit ledger entries; only audit 12 was backfilled).
**✨ Claude Audit** (detail header, next to Print): downloads a zip a future
Claude session can reconcile the month from — INSTRUCTIONS.md (the playbook:
the two metrics, Open/Close-SET-balance semantics, skip `[ac:` rows, envelope
math, match unlogged pulls to RQ payouts), audit.json (audit row + per-location
results + month-start carry + prior audit), entries.csv (full window incl. the
RQ close fields payments/payouts/transfer_in/out/expected/counted),
envelope_days.csv, petty.csv, and the LIVE RepairQ slice rq_methods.csv /
rq_payouts.csv / rq_negative_payments.csv from `repairq-query`'s
**`cash_audit_pull`** action (admin/owner JWT, like digest_refresh — three
Looker plain queries on the `transaction` explore; `stores.rq_name` maps store
→ `location.short_name`; Looker's "A to B" date range is end-EXCLUSIVE so the
action pushes the audit's inclusive end out one day). Key RQ facts baked into
that pipe: trade-in buys are **payout transactions** (`transaction.payout_amount`
< 0, itemized per ticket); the Financial Summary "Cash" line = Cash
payments − Cash payouts (verified to the penny, July 2026 Eugene:
10,176.17 − 1,158.00 = 9,018.17); `payment_method.name` resolves only on the
`transaction` explore (view:'transaction'), not view:'ticket' — invalid Looker
fields/filters are dropped SILENTLY, so a wrong field name looks like null
data, not an error. The zip itself is built by a ~40-line stored
(uncompressed) zip writer inline in cash-admin.html — no library.
**The results come BACK into MRT:** `cash_audit_reports` (audit_id FK, title,
summary, html, created_by; docs/sql/cash-audit-reports.sql — browser READ-only
via the parent audit's `is_admin(store)`, delete `is_owner()`; writes are
service-role only). The zip's INSTRUCTIONS.md tells the auditing Claude
session to write its finished report as ONE self-contained brand-styled HTML
file (Nunito/Nunito Sans, light+dark, **every dollar traced to a ticket
linked as `https://cpr.repairq.io/ticket/<id>`**) and insert it here; the
audit detail then shows an **Audit Reports** card (row → opens the stored
HTML in its own tab via a `text/html;charset=utf-8` blob — the charset
matters, a bare 'text/html' blob mojibakes the en-dashes). July 2026 Eugene's
reconciliation is filed as the reference example. The detail's back control
is a profile-style `.backlink` ("← Audits") above the card, not a header
button.

When changing a tool's data layer, check which generation it uses first — they share no code.

## Conventions when editing

- **NO EXPLAINERS. EVER. (owner directive, restated 2026-08-14 — this is the rule
  broken most often.)** A field gets a **label**; a step gets a **name**; a button gets a
  **verb**. Nothing else. Never ship: a sentence under a page title, a description under
  a dropdown or step chip, a parenthetical inside a label ("Name (as you know it)"),
  a hint under a form field, or a caption under a button explaining what it will do.
  If the UI needs a paragraph to be understood, the UI is wrong — fix the UI. Explaining
  in the chat reply is fine; explaining in the interface is not. The one thing that may
  carry prose is an **error or result message**, because it reports something that
  happened. This applies to every page, modal, wizard and widget on the site, and it
  applies to the code being written, not only to what the owner catches afterwards.

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
- **`my-schedule.html` is full-width on desktop** (`body.web main{max-width:none}`),
  like Schedule Admin and Checklist. Watch for stray `<style id="__om-edit-overrides">`
  blocks after `</html>` — a visual editor left one here whose
  `#view .lbl{width:120px!important}` clipped the week-navigator label; it's deleted.
- **The on-screen keyboard hides the bottom bars.** iOS does NOT shrink the
  layout viewport for the keyboard, so a `position:fixed` bottom bar stays pinned
  to the bottom of the *layout* viewport — behind the keyboard, or stranded
  mid-screen once Safari scrolls, sitting on top of the field you're typing into
  (owner report 2026-08-17, Expenses). nav.js flags `html.mrt-kb` off
  `innerHeight - visualViewport.height` alone — **never subtract
  `visualViewport.offsetTop`**: iOS makes it positive exactly when it scrolls the
  focused field into view, cancelling the keyboard back out so the flag never
  fires on the first tap (that was the first attempt's bug). >150px is the
  keyboard outright; 90–150 also needs a focused field, so a collapsing URL bar
  doesn't count; focus re-checks at 0/120/300/600ms because the keyboard animates
  in and the resize can land either side of focus. The flag hides the bottom tab
  bar + assistant FAB and zeroes `--cpr-bb-h`.
  **A page with its own fixed footer must add `html.mrt-kb .yourbar{display:none}`**
  (expenses.html's save bar does). Don't try to float a fixed bar above the iOS
  keyboard — it can't be done reliably.
- **Form controls must be ≥16px on a phone.** iOS zooms the whole page whenever it
  focuses a field smaller than that, and the zoomed page then pans side to side —
  which reads as "the page moves around and is zoomed in" (owner report 2026-08-17,
  employee-records). Any page with inputs needs a `@media(max-width:860px)` rule
  putting `input/select/textarea` at 16px, with `!important` where an inline
  font-size is in play. Don't reach for `user-scalable=no` (Safari ignores it) or
  `overflow-x:hidden` on body (it breaks the sticky save bars).
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
  **Exception — knowledge.html browses like a SITE, not a tabbed tool** (owner
  call 2026-08-12): level transitions (portal → category → article →
  editor/quiz) use **pushState** (`goHash`) so the browser Back button walks
  back up the levels; facet pills/scoped search/save flows stay replaceState;
  and there is deliberately NO last-tab restore — a fresh visit always lands
  on the portal home (`cprKbCat` is gone).
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
  drops down a calendar popover instead of arrow-stepping. **The navigator's LOOK is the
  shared `.cpr-navbox`** (owner pick 2026-07-26, from Bookings): one joined white box,
  radius 10, arrows and the label as segments split by 1px borders — no dropdown caret —
  plus a separate `.cpr-navjump` pill ("Today"/"This Week"/"This Month") rendered ONLY
  when viewing a non-current period. Both classes are **injected by pickers.js** — load
  it and use the classes, never redeclare the styles locally. Converted site-wide
  2026-07-26: interviews, daily-digest, schedule-admin (week+month), my-schedule
  (week+month+desktop header), time-entries, report-overtime, task-admin (Library
  calendar + Reporting), commission-dashboard, google-traffic, cash-journal (year).
  Popover behavior: week picker = month calendar,
  pick any week row, page months, "Jump to this week"; month picker = year pager + month
  grid. **Use `assets/pickers.js`** (`window.CPRPickers.week(anchor,{get,set,maxWeek})` /
  `.month(anchor,{get,set})` / `.day(anchor,{get,set,min,max})` — a single-day month
calendar, e.g. the Daily Digest's history navigator) — `maxWeek`/`min`/`max` grey
out-of-range periods on backward-looking reports.
  Wired everywhere with date nav: schedule-admin (This Week + Monthly), my-schedule (week
  labels, Month view, time-off wizard — those predate the lib and keep local copies),
  time-entries, report-overtime, task-admin (Library calendar + Reporting). New pages with
  date nav must include pickers.js and wire the label.
