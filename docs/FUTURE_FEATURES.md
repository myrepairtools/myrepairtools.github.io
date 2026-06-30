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

## Meeting topics / talking points (owner & manager parking lot)

A quick capture spot for the owner/managers to jot down **things to bring up with the
team** when the moment isn't right — it needs to be in person, or the person is off.
Today there's no authoritative place, so topics get noticed-then-lost.

**Idea**
- A simple **running list**: add a talking point in one tap (a short note), optionally
  tagged to a person, a store, and/or a category.
- Each item has a status (open → discussed/done). **Marking it done can file it into one
  or more employee records** as a logged note (coaching point, kudos, 1:1 follow-up),
  so the conversation gets a permanent home on the person(s) it was about.
  Read → discuss → file → audit trail.
- Optional fields: who it's about (**0, 1, or many** staff), priority, a "raise at next
  1:1 / next team meeting" flag, optional reminder/due.

**Why it fits**
- Employee Records already exists, so filing a closed topic as a note on the staff
  record(s) is a natural extension — and a great owner habit to bake in.
- Owner/manager-gated; could surface in My Hub for managers as a "talk to my team" card,
  and the assistant could later draft/sort topics.

**Open questions to settle when we build it**
- Link to employee(s) at creation, at close, or both? (Lean: optional at creation;
  on close, choose whether/where to file.)
- Filing target: a free-form **note on the employee record** vs a structured "coaching
  log" entry type. Lean: a simple notes/timeline on the staff record this writes into.
- Many-to-many: one team-wide topic filed to several people needs a topic↔staff join.
- Scope/visibility: owner-only, or each manager keeps their own list scoped by
  `can_see_store`?
- Categories/tags (coaching, kudos, policy, scheduling, recurring meeting agenda?).

**Storage**
- `meeting_topics` (id, author_staff_id, title/body, status, priority, store?, created_at,
  closed_at) + a `meeting_topic_staff` join (topic_id, staff_id) for the 0/1/many "about"
  links and for filing into each person's record on close.
- On close-with-file, also write a note row to the employee-record notes/timeline table
  for each linked staff member.

## Employee onboarding workflow (kicked off by a new hire in QuickBooks)

When a new employee is added in QuickBooks (we're wiring QuickBooks **Time** now), automatically
start an onboarding workflow in myRepairTools instead of someone remembering every step by hand.

**Idea**
- A QuickBooks "new employee" event (webhook / sync) creates or links a `staff` record and opens an
  **onboarding checklist** for that person.
- Checklist covers the real first-day/first-week steps: paperwork, account + access provisioning
  (RepairQ, myRepairTools PIN, email, Square, etc.), training modules, equipment, store assignment,
  first-week schedule, commission setup.
- Track completion per new hire; assign who owns each step; surface "X of Y onboarding tasks done"
  on a manager view.

**Why it fits**
- Rides the QuickBooks Time integration we're building (employee sync is the trigger).
- Lands the new person straight into **Employee Records**, and reuses the **Checklists** tool/tables.

**Open questions to settle when we build it**
- Source of the new-employee event — QuickBooks **Time** vs **Online** (and whether their webhooks
  expose employee-created events, or we poll the employee list on a schedule and diff).
- Auto-create the `staff` row vs propose-and-confirm (match by name/email to avoid dupes).
- One global onboarding template vs per-role checklists.
- Step ownership (owner/manager/HR), due dates, reminders.

**Storage**
- Reuse `checklist_items` / `checklist_completions` (an "onboarding" category assigned to the new
  hire) or a dedicated `onboarding_tasks` table; a `staff.onboarding_status` (or a progress join)
  for the at-a-glance state.
