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
  for everyone else; the page itself stays gated. Follow this pattern for new admin pages.
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
   time-entries, monthly-goals, checklist, task-admin.

**Monthly goals:** `commission_goals` (staff_id, month, accy_goal, device_goal,
device_attach_goal %, case_goal, sp_goal, power_goal, service_goals jsonb, note) —
per-employee monthly targets set during 1:1s **in the commission dashboard's Goals tab**
("🎯 Set goals" modal, manager/owner only via `can_see_staff` RLS; this/next-month toggle).
Employees see a "Meeting targets" progress card on the same tab. Only `accy_goal` affects
pay (it gates the accessory goal bonus); resolution is month goal → `commission_roster.accy_goal`
default, and a row may carry other targets with `accy_goal` null (consumers must null-check).
Consumers: commission-dashboard, commission-calculator (range's start month),
assets/commission-summary.js. There is deliberately no separate goals page.

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
overlap acknowledgment, then submit. Rows carry `hours` (total, what admin pages/QBO use)
plus `day_hours jsonb` ({date: hours}); `qbtime-sync` writes exactly those per-day entries
to QB Time (falls back to an even split for legacy rows; a 0-hour request — all days fell
on regular days off — is marked synced without writing).

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
  week (or day) navigator, the label between the `‹ ›` arrows should be a clickable button
  (`data-wkpick`) that opens a month-calendar popover: pick any week row, page months with
  `‹ ›`, "Jump to this week". The canonical implementation is `openWeekPicker()` in
  `schedule-admin.html` (selected week highlighted, today marked, whole-row hover, popover
  positioned under the anchor). Reuse that shape rather than plain one-week-at-a-time arrows
  — it lets users jump to a future week in another month. Prime candidates to retrofit:
  the schedule pages (`schedule.html`, `my-schedule.html`, `time-off.html`,
  `report-overtime.html`, `time-entries.html`).
