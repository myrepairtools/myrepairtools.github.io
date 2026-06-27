# Future features

A running list of ideas to build later. Add items here so they don't get lost.

## Commission improvement / goal plans (temporary override plans)

A modal/workflow for creating a **custom commission improvement plan** (a.k.a. goal
plan) that temporarily replaces the normal commission setup to push performance.

**Idea**
- A guided workflow to spin up a short-term incentive plan.
- The plan **overrides ALL other commission settings** (base, store, role, and
  per-person overrides) for whoever it's assigned to, while it's active.
- The plan runs for a **set period chosen during the workflow** — e.g. "next 4
  weeks" or "2 months" — with a start and end date. Outside that window the normal
  commission settings apply again automatically (no manual cleanup).
- Purpose: temporarily set **better incentives** (richer tiers / payouts / lower
  gates / special bonuses) to improve a tech's or store's numbers for a stretch.

**Open questions to settle when we build it**
- Scope: assign a plan to a person, a store, a role, or a hand-picked group?
- Precedence: a plan fully replaces the layered stack while active (cleanest), vs.
  layers on top of it. (Leaning: full replace for the assignees.)
- Overlap: what happens if two plans cover the same person/period? (Pick one —
  most recent, or highest payout.)
- The calculator/dashboard should clearly badge when a payout came from a plan vs.
  normal settings, and show the plan's date range.
- Storage: a `commission_plans` table (assignee, start/end, the full rule+rate+earns
  payload) that the engine checks first when a biz_date falls in range. **The plan
  lives on the employee's record** — surfaced in the Team Member modal (e.g. an
  "Improvement plan" section/row showing the active plan + its date range), so it's
  managed right where the rest of that person's commission config lives.
- Auto-expiry handled purely by date range (no cron needed) since payouts are
  computed per period.

## Category / custom goals + spiffs

Let the owner set **per-category accessory goals** (Cases, Screen Protectors,
Power, Misc, Other) — and goals on other values too — scoped at three levels:
**store**, **role**, and **individual employee** (same layered model as the
commission overrides: store ← role ← person).

- Today the dashboard's "Sales by category — units vs target" derives targets by
  spreading the accessory $ goal across the category mix. This feature makes those
  targets **real and owner-set per category**, not derived.
- Then: **attach commission or spiffs to a goal/value** — e.g. "$5 spiff per
  screen protector over the monthly target," or "+1% accessory rate if you hit the
  Cases goal." So goals aren't just motivational bars — clearing one can pay.
- Ties into the **commission improvement plan** idea above (a plan could bundle a
  set of category goals + their spiffs for a date range).
- Storage: a `commission_category_goals` table (scope = store/role/staff, category,
  target, optional spiff payout/rate, period or date range). The dashboard Goals
  tab reads it for targets; the engine reads the spiff side when computing payout.
- The Goals tab's "Monthly goal review / lock in next month's targets" modal is the
  natural place for an employee/manager to set or accept these.
- **Where each is set (decided 2026-06-25):** store + role goals live in **commission
  settings** (the scoped settings tile); **individual** goals live in the person's
  **Commission setup** sub-page (Team Member → Commission), beside their other overrides.
  Settable at any level, layered store ← role ← person like the rest of the config.
- **Manual vs. formula toggle:** each person's category goal has an on/off switch. When
  **off**, the dashboard falls back to the current **calculated/derived** target (the
  accessory $ goal spread across the category mix); when **on**, the hand-set number wins.

## My Hub — employee snapshot dashboard ("widgets")

A read-only **employee landing page** with glanceable **snapshot cards**, each linking
into the full tool. Scoped as *snapshots*, NOT a full customizable widget engine (that's
the bigger version below).

**First-cut cards**
- **Schedule** — "my week": this/next week's shifts (store, shift name, derived times)
  from `staff_schedule` + `shifts`/`shift_hours`. **Data ready now.** → Schedule tool.
- **Commission** — MTD earned, on-pace projection, **$ to goal**, attach %, board rank.
  Reuses the commission engine + queries verbatim. **Logic ready now.** → commission dash.
- **Alerts** — start **derived** (free): "you're $X behind pace," "leading the attach
  bonus," "schedule updated" — straight from existing data. Add one owner-set
  **announcement** (a small settings value). A real alerts *feed* (manager messages,
  time-off approved/denied) needs an `alerts` table and ties into the notifications work.
- **Checklist** — needs a small table. **Decide:** *personal* to-dos (simplest) vs a
  *store opening/closing* checklist the owner defines once (reuse the "list managed in
  Settings" pattern, like Hyla) with per-person/day check-off (more operational value).

**Build notes**
- Lives at `my-hub.html` (the employee landing), rides the existing employee auth
  session; each card deep-links into its tool. No drag/customize in the first cut.
- Two cards (schedule + commission) and derived alerts are essentially free; only the
  checklist (and a real alerts feed) need new schema.

**Later — customizable widgets (the bigger version)**
- **Tier 0:** a "Customize" mode that lets each employee **show/hide + reorder** the
  cards they already have; persist a per-user `{order, hidden}` JSON via an
  `auth.uid()`-scoped RPC (same pattern as `set_my_avatar` → `save_my_dashboard`).
- **Tier 1:** a few genuinely new widgets + two sizes (small/large) + a `user_prefs`
  table (or `staff.dashboard` jsonb) with own-row RLS.
- **Tier 2 (likely overkill for ~7 staff):** a generic widget registry + freeform
  **resizable** grid. Resize is the hard 20% in vanilla — would need careful CSS-grid +
  drag math or an `esm.sh` grid lib (Gridstack/Muuri). Avoid building a generic engine;
  a simple `WIDGETS = {key: renderFn}` registry beats an abstraction.
- Gut check: ship Tier-0 snapshots first and see if people actually customize before
  investing past it.

## QuickBooks Time + Checklists + Notifications feed (the "daily ops" loop)

A connected system: clock-in/out (QuickBooks Time) wraps the **checklist** feature,
and a shared **notifications feed** surfaces due-time alerts. All three are the same
spine viewed three ways: a tasks/notifications data model + a periodic rule engine +
a per-person feed, with AI as an optional summarizer.

**Decided:** clock-in/out happens **on MyRepairTools (Option A)** — the site punches
QuickBooks Time via the API so it can wrap the clock moment with checklist UX.
QuickBooks Time stays the system of record (hours flow to payroll unchanged).

### Clock-wrap UX (Option A)
- **Clock In** button → calls the QBO Time API to start the timesheet → immediately
  shows the employee's checklist / day overview (ideally AI-phrased).
- **Clock Out** → before punching out, checks for **incomplete tasks** for today and
  warns ("You have 3 unfinished: …. Clock out anyway?").

### Checklists (Phase 1 — STARTED; schema live, see docs/sql/checklists.sql)
- `checklist_items`: title, details, store, assignee_staff_id, recurrence
  ('once'|'daily'|'weekly'), weekdays int[], due_date, priority, est_minutes, active.
- `checklist_completions`: item_id, staff_id, done_date, done_at — unique(item_id, done_date)
  so a recurring task resets per day.
- Permissions: `checklist.view` (everyone, see/complete own) · `checklist.manage`
  (owner/admin, create & assign).
- v1 surfaces: **Checklist Admin** (manager creates/assigns, sees completion) +
  **My Checklist** (employee sees today, checks off). Mobile-friendly employee view.
- Later: assign by role/store ("whoever opens Eugene"), templates, est-minute budgets.

### Notifications / alerts feed
- Engine = a **scheduled job** (`pg_cron`) — the reliable heartbeat. It queries for
  due/overdue conditions (e.g. a Hyla order at the 7-day mark, `status` ≠ complete) and
  writes notification rows. Deterministic, cheap, never misses. (Scaffolding already
  exists: `notification_rules`, `notification_channels`, `notification_rule_channels`.)
- AI = the **smart layer on top** (optional): the same job can hand the day's pile to
  Claude to triage/prioritize/phrase ("3 things actually need attention today, here's
  why"). The cron is the trigger; the AI is the editor — never the other way around.
- A `notifications` table (what, target person/role/store, severity, due context,
  read/dismissed, source rule|ai) + a **site-wide feed UI** (bell/inbox in nav, filtered
  per person). Same source feeds the clock-in overview and clock-out reminder.

### QuickBooks Time (TSheets) integration
- OAuth2; tokens held server-side in an edge function (never the browser, same pattern
  as the AI key). Supports punching (start/stop timesheets — needed for Option A) and
  webhooks (clock events). Does **not** require a dedicated IP (unlike Mobile Sentrix).

### Mobile Sentrix API (separate item)
- Their API requires a **dedicated/static outbound IP**, which Supabase edge functions
  do not provide. Plan: route only the Mobile Sentrix calls through a **static-IP relay**
  (QuotaGuard Static / Fixie, or a small reserved-IP box) and allowlist that IP. Sync
  their data (pricing/stock) into Supabase on a schedule so pages read local/fast.
