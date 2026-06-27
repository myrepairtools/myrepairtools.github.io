# Checklist — Design Handoff

For the designer. This captures the **requirements, features, and review feedback** for
the Checklist project so the visual design can be locked. Build natively on the
**myRepairTools design system** (the `--mrt-*` tokens) and match the table aesthetic of
**Cash Tracker / Consumption & Ordering / Hyla Orders**.

> No mockups are referenced here on purpose — design from these requirements.

---

## 1. What it is
A system for assigning and completing **recurring (daily / weekly / monthly) and one-off
tasks**. Managers define tasks; employees do them; everyone can see performance. It will
later connect to clock-in/out, a notifications feed, and commission — design with that
future in mind, but the scope here is the two checklist surfaces.

## 2. Two surfaces
| Surface | Who | Purpose |
|---|---|---|
| **Checklist** | everyone | Daily **do & track**: my tasks today, check off, KPI tiles, my own performance, quick self-add. |
| **Task Admin** | managers/owners | The **task library** + properties (recurrence, assignment, due policy) + **reporting/compliance**. |

- *Doing* tasks is everyone's; *defining* them is a manager job → two separate pages.
- **No admin/employee switcher** on the Checklist (the admin work lives on Task Admin).
- **Reporting is two-scoped:** managers see everyone/store/trends; employees see **their
  own** performance. (Principle: "if they see it, they know I see it.")

## 3. Brand / design system
- Use the design-system tokens: `--mrt-font-head` (**Nunito**, 800–900 for headings),
  `--mrt-font-body` (**Nunito Sans**); colors `--mrt-red #DC282E`, `--mrt-dark #2D2D3B`,
  `--mrt-dark-grey`, `--mrt-blue #4FB0E3`, `--mrt-green #2E9E5B`, `--mrt-amber #C9820B`,
  `--mrt-purple #8B5CF6`, `--mrt-grey #B9BDCB`, `--mrt-light-grey #F3F2F2`, `--mrt-white`;
  `--mrt-border`, `--mrt-radius-sm/md/lg/pill`, `--mrt-shadow-card/hover`.
- **Standard page header** like the other tools (page title + subtitle). **Do not** use a
  custom sub-header band — keep it consistent with the rest of the site.
- **KPI tiles** in the same style as the other tools (white card, colored top accent).
- **Location selector** in the site-standard pill style (for staff authorized in multiple
  stores).

---

## 4. The Checklist surface

**Header row:** standard page header + location pills + a **notification bell** (badge +
dropdown — see §10, part of the larger feed project).

**Controls:**
- **View toggle:** **My tasks** (default) ↔ **Store** (all store tasks). The assignee
  dropdown is a manager tool; techs use My/Store instead.
- **Time filter:** Today (default) ↔ This week.
- **+ New task** button (opens the create modal).

**KPI tiles** (top): Done today · Still to do · **Overdue** · **On-time % (this month)**.

**Task table** (Cash Tracker / Hyla aesthetic):
- Columns: **☐ done** · **Task** (name) · *Assignee (Store view only)* · **Due** (day +
  time) · **Recurs** (chip) · row actions (**view 👁 / edit ✎**).
- **One-click complete** via the checkbox. Binary **Done / Not Done** only — no
  multi-status, no "date assigned" column, one info field (see §8).
- **Priority flags** inline on the name: "Must do today" (red), "Please do ASAP" (amber).
- **Links inside the task name** render as real links (§8).
- **Overdue rows show a red bar** (left edge) and red due text. Done rows read as
  completed (struck/faded).
- Keep rows equal height; pending/overdue states must not change row height.

**Row interactions:**
- **Click the name or 👁 → detail popup** (all info + full instructions + links) — the
  "click the item" experience. 
- **✎ → edit** the task **without** opening the detail popup (managers).

**Create = modal** (the team specifically liked this pattern). Fields:
- **Task name** — with an **"insert link" helper**: type a phrase, pick a tool (or paste a
  URL), and that phrase becomes a link in the name (e.g. *"Complete [Consumption Report]
  and order from MS"*). Show a live "renders as" preview.
- **Instructions** — single rich field; URLs/links in it are clickable (§8).
- **Assignee** *(managers)* — person · shift ("whoever closes Eugene") · role · group ·
  rotation. *(Employees self-adding a personal task skip this — it's theirs.)*
- **Store**, **Priority** (Normal / Please do ASAP / Must do today).
- **Recurrence** (§6) with day pickers.
- **Default due** (§7) — always custom.

**Self-add:** employees can add their own personal tasks (simple: name, optional
instructions, due) to self-manage.

---

## 5. The Task Admin surface (managers)
- **Template library** — a table of all task definitions; managers manage their
  properties here. Longer-horizon planning lives here (this is where **monthly** tasks are
  most relevant — employees don't look months out). Offer **calendar + list** views.
- **Template editor** — recurrence, **assignment strategy**, **completion mode**, due
  policy, fallback (§6).
- **Reporting / compliance** (monthly, standard calendar — matches commission payout):
  completion % · **on-time %** · **late count** · miss count, by **person / store**, with
  trends. Retains all history (nothing hard-deleted).
- **Fairness ledger** for rotations — surface it as a viewable concept (who's up next,
  who's done it how many times) so a manager trusts the rotation is even. *Design this as a
  concept to review before it's committed.*

---

## 6. Assignment model (the UI must express this)
- **Assign to:** a **person** · a **shift** ("the closer at Eugene", resolved from the
  schedule each day) · a **role** · a **group** (multiple people/shifts).
- **Strategy:** **fixed** (always the same target) · **rotate** (round-robin across a pool;
  **simple fairness** — even over time).
- **Completion mode:**
  - **any** — *one* eligible person completes it for the group (e.g. clean bathroom; "by
    end of day by one of the two closing"). We record **who** did it.
  - **each** — *every* eligible person must complete their own (e.g. **a new training
    everyone must take**) → shows a **completion grid** of who's done it.
- **Rotation behavior (decided):** if the person whose turn it is isn't working the day a
  task recurs, it **auto-bumps to their next shift**; if they're on vacation / out for an
  extended stretch, **flag a manager to reassign** (don't silently skip).
- **Fallback:** a backup person/role if the primary resolves to nobody.
- **Coverage alert:** if a required task resolves to nobody, raise an alert.
- **Manager override:** a manager can override **any single instance** — assignee, due
  time, priority, or mark it done — without changing the template (template edits only
  affect future occurrences).

## 7. Recurrence & due
- **Recurrence:** One-off · Daily · **Weekly** (pick one or more **weekdays** — two = twice
  a week) · **Monthly** (pick one or more **dates** — e.g. payroll on the **5th & 20th**) ·
  **Flexible** ("N times per week/month, any day in the window" — e.g. the bathroom, which
  just needs doing once a week, movable).
- **Default due:** **always custom** (no presets) — "+N **days / weeks / months**",
  same-day, or a specific time. Include a **due time** of day ("by 6pm").

## 8. Overdue / late / miss (important — nothing disappears)
- An **overdue** task (past due, not done) **stays on Today** (red bar) and is still
  completable. **One-offs never auto-expire.** Tasks do not silently vanish.
- Completion records the outcome: **done on-time**, **done late** (done, but after due —
  and how late), or **missed** (window closed undone). This is how we still get the task
  done **and** track how often someone is late.
- *When a task leaves Today:* daily → end of that day (a fresh one generates tomorrow;
  doesn't pile up); weekly/monthly → end of its window; one-off → only when done or a
  manager closes it.

## 9. Priority
Two named flags + normal: **"Must do today"** · **"Please do ASAP"** · Normal. Drives
sort order and a colored flag.

## 10. Links in title & instructions
Both the **task name** and the **instructions** support **clickable links mixed with
text** (internal tool pages and external knowledge-base URLs). The create modal makes this
painless with the "link a phrase → pick a tool / paste URL" helper. (Solves the pl-ain-text
URL problem from the old system.)

---

## 11. Review feedback to honor

**Keep (the team liked these):**
- The **task table** layout.
- **KPI tiles** matching the other tools.
- The **New Task modal** UI, especially the **key-phrase → hyperlink** inserter.
- The **assignee dropdown** (managers/owners) — but techs get **My / Store** instead.
- A **location selector** in the site-standard pill style.
- Both **view and edit** options on a task.
- The **red past-due bar**.

**Avoid (the team didn't like these):**
- A **custom sub-header band** — feels inconsistent with the other pages. Use the standard
  header.
- An **admin/employee switcher** — not needed (Task Admin is its own page).
- **Preset-only "default due"** — make it always customizable, and include **months**
  (the earlier pass only had days/weeks).
- Surfacing **monthly tasks** to regular employees — that's manager planning; keep it in
  Task Admin.

**Open for design to explore:**
- Should **weekly / monthly** in Task Admin offer **calendar + list** views?
- How to **visualize the fairness ledger** (rotation order / counts).
- Final **KPI set** and the employee "my performance" strip.

## 12. Out of scope here (separate projects — context only)
- **Notification feed** (the bell + "new posts" dropdown) — its own project; the checklist
  feeds it.
- **Top nav bar** — a nav-shell decision to make separately (the site currently uses the
  side rail + menu as primary).
- **Clock-in/out wrap** (QuickBooks Time) and **commission qualifier** (tie completion % to
  pay) — later phases; design doesn't need to solve them now.
