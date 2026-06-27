# Checklist & Tasks — Design Spec (v1)

Working spec for the Checklist project. Red-line freely (Ben included). Decisions
here drive the schema and the prototype. Principle throughout: **clean data the AI
can read and act on** (per CLAUDE.md standing directive).

---

## 1. Two surfaces

| Surface | Who | Purpose |
|---|---|---|
| **Task Admin** | managers (`checklist.manage`) | The **library** of task templates + their properties (recurrence, assignment, due policy), plus **reporting**. Where rotation / shift assignment / coverage live. |
| **Checklist** | everyone (`checklist.view`) | The daily **do & track** view: my tasks today, check off, KPI tiles, **my own performance**, and **quick self-add** of personal tasks. |

*Defining* tasks is an admin job; *doing* them is everyone's. Employees never see
rotation rules — only today's resolved list.

**Reporting scopes:** managers see everyone / store / trends; employees see **their
own** performance (completion %, on-time %, misses, streak). "If they see it, they
know I see it." Same data, filtered by permission.

---

## 2. The core model: templates → occurrences

A task is **not** one row. A **template** (the library entry) generates dated
**occurrences** (what actually shows up and gets checked off). Occurrences are what
make rotation, coverage, performance, and overrides possible — they're the record of
*what was expected* vs *what got done*.

### `task_templates` (the library)
- `title` — supports inline links (see §6)
- `instructions` — single rich-text field, supports clickable links (§6)
- `store` (nullable = any), `category`, `priority` — see §5
- **recurrence** (§4): `recurrence_kind` = `once | fixed | flexible`
- **assignment** (§3): `assign_type`, `assign_target`, `assign_strategy`, `completion_mode`, `fallback`
- **due policy** (§4): `due_kind` (`same_day | offset_days(N) | end_of_window | specific`) + `due_time`
- `active`, `created_by`, `created_at`

### `task_occurrences` (generated instances — what people see)
- `template_id`, `occur_date` (or `window_start`/`window_end` for flexible)
- `due_at` (computed datetime)
- `eligible_staff_ids[]` (resolved pool) and/or `assigned_staff_id`
- `completion_mode` (copied from template)
- **completion folded in:** `done_at`, `done_by`, `note` → status derives to `open | done | missed`
- **override fields:** `overridden_by`, `overridden_at` (manager can change assignee / due_at / priority on *this* instance without touching the template)

### `task_rotation_state` (fairness ledger — concept, review before committing)
Per rotating template: who's been assigned, how many times each, and the cursor — so
rotation stays **even over time** and resumes correctly. Shown as a concept in the
prototype before we commit. (§3 rotation.)

### `task_performance` (rollup — feeds KPIs + commission)
Per `staff_id` × period: assigned / completed / on-time / pct. Materialized by the
nightly job for fast tiles and as the **commission qualifier** source (§9).

> This replaces the simpler `checklist_items` / `checklist_completions` tables stood
> up earlier — nothing is built on them yet, so we evolve cleanly.

---

## 3. Assignment — flexible by design

**`assign_type`** (who the task targets):
- **person** — a specific employee (Vince).
- **shift** — a shift slot at a store ("the closer at Eugene"); resolved per-day via the **schedule** (`staff_schedule`).
- **role** — a role at a store ("any manager at Salem").
- **group** — a set: multiple people and/or multiple shifts ("either of the two closers").

**`assign_strategy`:**
- **fixed** — always the resolved target/set.
- **rotate** — round-robin across the pool, governed by the fairness ledger; **skips
  people who aren't scheduled** that period (covered *and* fair).

**`completion_mode`** (how many completions satisfy it):
- **any** — *one* person of the eligible set completes it for everyone (bathroom; "by
  end of day by one of the two closing"). One occurrence for the group; whoever does it
  is recorded in `done_by`.
- **each** — *every* eligible person must complete their own. Generates one occurrence
  **per person**.

**For shift/role/group + `any`:** the occurrence is a shared/pool item — anyone
eligible can check it off, and **we record who did** (`done_by`). That answers "if
assigned to a role/shift, we need to pick who completed."

**`fallback`** — optional person/role if the primary resolves to nobody (e.g., the
scheduled closer is out).

**Override** — managers can override **any occurrence**: assignee, due time, priority —
without changing the template. Template edits affect only **future** occurrences.

### The Vince coverage example
Template: *Consumption report — daily, `assign_type: shift` = "Eugene closer", due
same-day by close.* The generator reads the schedule each night and assigns **that
day's closer** — Vince his 4 days, whoever closes the other 3. No gap, no manual
reassignment. This is the payoff of keeping the schedule in clean data.

---

## 4. Recurrence & due

**`recurrence_kind`:**
- **once** — single `due_date`.
- **fixed** — explicit cadence: daily · specific weekdays · specific month-days
  (or nth-weekday). Due on those days.
- **flexible** — *N times per* `week | month`, **any day in the window**. (Bathroom:
  "once a week, any day — move it up or back.") The occurrence is due by the **end of
  the window**; the rotation assignee owns it.

**Due policy** (relative, lives on the template, computed per occurrence):
- `same_day` · `offset_days(N)` (e.g., +3 days) · `end_of_window` · `specific` time.
- `due_time` — time of day ("by 6pm"). Powers **"not completed in time"** (overdue =
  past `due_at`, not done) and reminders.

---

## 5. Priority
Ben's two flags + none: **"Must do today"** · **"Please do ASAP"** · normal. Drives
sort order and a colored flag in the table.

---

## 6. Links in titles **and** instructions
The SharePoint frustration, solved. A tiny safe link format renders **clickable links
mixed with text** in both the **task name** and the **instructions** field.
- Internal: *"Complete [Consumption Report] and order from MS"* → jumps to
  `consumption-report.html`.
- External: paste a knowledge-base URL → real clickable link.
- The create modal has an **"Insert link → pick a tool"** dropdown (Consumption Report,
  Hyla Orders, …) so nobody hand-types link syntax; it also accepts a pasted URL.

---

## 7. The engine (occurrence generation)
A nightly **`pg_cron`** job builds the next window's occurrences from active templates:
1. Expand recurrence → which dates/windows are due.
2. Resolve assignee: fixed person · next-in-rotation (skip those not scheduled) ·
   scheduled shift/role holder (from `staff_schedule`).
3. Compute `due_at` from the due policy.
4. `each` → one occurrence per person; `any` → one shared occurrence with eligible set.
5. **Coverage alert:** if a required task resolves to **nobody** → fire a notification.

Same heartbeat that drives the notifications feed (roadmap).

---

## 8. UI

**Checklist (everyone)** — table styled like Cash Tracker / Consumption Report / Hyla:
- **KPI tiles:** Done today · To do · **Overdue** · % complete · (mine) on-time % / streak.
- **Table columns** (minimal, per Ben — one info field, no "date assigned", no 3-status):
  `☐ · Task (linked) · Assignee* · Due (day+time) · Priority · ⟳`. *manager views only.
- **Create = modal.** **Row click = detail popup** (all info + instructions/links).
  Managers can also **edit inline** without the popup. Complete = one checkbox click
  (binary Done / Not Done).
- Filters: Today / Week / All · person · store.
- **My performance** strip for employees (their own stats).

**Task Admin (managers)** — the template library + properties + full reporting:
- Library table of templates; click → edit properties (recurrence, assignment strategy,
  completion mode, due policy, fallback).
- **Reporting:** completion % by person / store / period, on-time %, misses, trends.
  Retains all occurrence history (no hard deletes).

---

## 9. Commission tie-in (design now, build later)
Tie task performance to a **commissionable qualifier**:
- Nightly rollup → `task_performance(staff_id, period, assigned, completed, on_time, pct)`.
- The commission engine reads it as a **gate** ("≥90% on-time to unlock the accessory
  tier"), a **flat bonus**, or a **multiplier**.
- Fairness guardrail: measure % of **their assigned** tasks only — never penalize for
  tasks that were never theirs.

---

## 10. AI involvement (build everything AI-ready)
- Assistant can **read** all of it (Phase 2) and **complete/assign** via confirm-gated
  writes (Phase 3).
- Suggest a **fair rotation**, answer "who's responsible for the consumption report
  tonight?", **summarize performance** ("Nick 18/20 this week; 2 missed closing counts").
- Powers the **clock-in overview** and **clock-out reminder** (QBO Time, roadmap).

---

## 11. Phasing
- **P1** — templates + occurrence generation + Checklist (do/track) + person & self
  assignment + recurrence (once/daily/weekly/monthly + flexible) + due times + KPIs +
  link rendering.
- **P2** — shift/role/group assignment (schedule-driven) + rotation + fairness ledger +
  any/each completion + coverage alerts + full reporting (manager + employee).
- **P3** — reminders (Teams/SMS) + clock-in/out wrap + commission qualifier.

---

## 12. To confirm before build
1. Fairness-ledger behavior (round-robin vs. weighted-by-availability) — review the
   concept in the prototype first.
2. Reporting period (rolling 7/30 days vs. pay-period aligned — likely pay-period, to
   match commission).
3. Whether "each"-mode tasks should also support a single shared completion override.
