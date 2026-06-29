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
   Tools currently on Apps Script: commission-calculator.

2. **Supabase** (newer; the active migration target — see recent "Cash Tracker Migration"
   commits). Project `xuvsehrevxackuhmbmry.supabase.co`, client imported from
   `esm.sh/@supabase/supabase-js@2`. Tools on Supabase: cash-tracker, cash-admin,
   consumption-report, settings, login-test, damage-tracker, employee-records, hyla-orders,
   claim-payouts.

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
