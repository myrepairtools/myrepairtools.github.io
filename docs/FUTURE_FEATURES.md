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
