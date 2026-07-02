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

## Stretch goals + spiffs — working spec (2026-07-01, pending co-owner feedback)

The monthly-meeting goals (`commission_goals`, set via the dashboard's 🎯 Set goals
modal) should be **pure upside**, never a moved penalty line. Designed with real June
data; Britt is bouncing it off the other owner before we lock and build.

**Principles (settled)**
- **The default accessory goal never moves.** `commission_roster.accy_goal` (e.g. $2,400)
  stays the gate for the regular goal bonus, always. Meeting goals must not make an
  existing bonus harder to earn. ⚠️ *This reverses current behavior* — today
  `commission_goals.accy_goal` **replaces** the gate in the engine call. When this ships,
  the month goal becomes the stretch line instead (consumers: commission-dashboard,
  commission-calculator, commission-summary).
- **Accessory stretch bonus:** the meeting accessory $ (e.g. $3,000) is a *second* goal.
  - Land ≥ default but < stretch → normal commission incl. the regular goal bonus.
  - Clear the stretch → **additional 10% × (actual sales − default goal)**.
    Example: $3,100 actual, $2,400 default → +$70.
  - **The cliff is intentional**: $2,999 pays $0 extra, $3,000 pays +$60. No smooth
    per-$100 ramp — Britt explicitly doesn't want to reward drifting past the goal
    they're already expected to hit; the pay is for committing to and hitting mark #2.
  - **Sales-based, not GP-based (decided).** Accessory margins run 81–90% (team avg
    ~86%, June data), so GP-based only saves ~$10–15 per stretch hit while hiding the
    number from employees. Sales $ is what their dashboard bar shows — keep it chaseable.
    Cost check: a $70 spiff on $700 incremental sales ≈ 11–12% of the ~$602 incremental
    GP — cheap incentive.
- **Category/scorecard spiffs (flat):** hit a scorecard target set in the meeting
  (cases, screen protectors, power units) → flat bonus, working number **$20 each**.
  Miss → nothing lost.

**Open questions (for the co-owner conversation)**
- Which targets carry the flat spiff — just case/SP/power, or also devices, attach %,
  and per-service targets?
- Is the $20 one global setting or a per-target $ field in the goal modal (e.g. $50 on
  cases for a push month)?
- Stretch percentage: 10% fixed, or configurable?

**Build notes (when locked)**
- Engine: add `stretchGoal` + `spiffs` inputs to `computeCommission` (or a post-pass) so
  the payroll calculator itemizes "Stretch bonus" and "Spiffs" lines; dashboard Meeting
  targets card shows the $ upside next to each bar ("+$20 if hit").
- Storage: already in place — `commission_goals` has all the targets; add spiff config
  (global setting or per-row columns) when the open questions resolve.
- Until this ships: leave the Accessory $ field **blank** in 1:1s (scorecard targets are
  display-only) so nobody's bonus line moves under current behavior.

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

## Notifications — more "Send to" channel types

Today a notification channel (`notification_channels`) is **email** or **webhook**
(Power Automate). Expand the "Send to" picker with more destination types as we build
them out:

- **Mobile / push** — reach staff on their phones directly (web push, or a native
  push once there's an app). Good for time-sensitive alerts (schedule change, goal
  hit, drawer variance).
- **In-app "MRT alerts" / Communications feed** — a first-class *internal* destination:
  the notification lands in the app's own alerts/Communications inbox (the Communications
  board / My Hub "Alerts" card), not just an external channel. Ties directly into the
  **Communications w/ Teams notifications** item on the main list and the My Hub "Alerts"
  feed above. Likely needs an `alerts` table (recipient scope, body, read state) that the
  notify backend writes to as a channel `type='inapp'`.
- Others to consider later: SMS, a Slack/Teams-native bot post (vs. the email/webhook
  bridge), or a digest email.

**Build notes**
- The delivery backend (`supabase/functions/notify`) already fans out per channel `type`;
  adding a type is: a new `deliver()` branch + a picker option in the channel modal
  (`settings.html` `channelModalHtml`). The per-event "Send to" config modal already lists
  whatever channels exist, so new types show up there automatically.
- The keyword field carries through regardless, so Power Automate routing still works
  alongside a native in-app feed.

## Checklist — notification triggers (deferred from the design handoff)

The checklist system (task_templates → task_instances, `tasks` edge function, checklist.html /
task-admin.html) shipped **without** notification delivery on purpose — it plugs into the
notifications project once that lands. Triggers documented in the design handoff:

1. **End-of-shift nudge** — outstanding tasks for the store pushed to the store Teams channel
   (~4:00 PM); the 🔔 popover on checklist.html already shows this exact grouping in-app.
2. **"Must do today" still open at N hours before close** — escalate to the manager.
3. **Task missed** (weekly/monthly/one-off window closed undone) — notify the manager;
   the Task Admin follow-up queue is the in-app surface for this today.
4. **Reopened/reassigned task** — tell the new assignee it landed on their list.
5. **Rotation turn** — "you're up this week" for rotating tasks (bathroom etc.).

Build note: emit these as `notification_rules` event keys (e.g. `checklist.shift_end`,
`checklist.missed`) from the `tasks` edge function / a small cron, so routing (Teams keyword,
email, in-app Communications) stays configurable per-event in Settings › Notifications like
everything else.
