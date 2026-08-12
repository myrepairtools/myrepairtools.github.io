# Return handoff: KB + Onboarding — code → design

**Direction:** this is the reverse of the usual handoff. Design's KB/onboarding package
(mocks 4a, 5a, 5b, 6a, 6b, 7a, 8a, 8b) was built — and then the system kept growing in
code during real use. This document is the current ground truth to design against:
what shipped faithfully, where implementation deliberately diverged, what now exists
with **no mock at all**, and one feature that is **decided but deliberately unbuilt,
waiting on design**. Section 6 is the concrete request list.

Everything here is live at `knowledge.html`, `kb-compliance.html`, `intake.html`, and
Settings → Team Members, backed by Supabase (schemas in `docs/sql/`).

---

## 1. Scorecard — the seven mocks as shipped

| Mock | Screen | Verdict |
|---|---|---|
| 4a + 5a | KB Library + Viewed column | Shipped, **one big structural divergence** |
| 5b | My Onboarding | Shipped, **extended well past the mock** |
| 7a | Article reading view | Shipped as designed |
| 6a | Quiz taking | Shipped as designed |
| 8a | Quiz result (fail) | Shipped as designed — see note on the label contradiction |
| 6b | Compliance | Shipped, extended (assignment changed its math) |
| 8b | Article editor | Shipped with layout + taxonomy differences |

### 4a/5a — Library
- **The 230px on-page Browse sidebar did not ship — and should not return.** Browse
  lives in the site's **nav pane** (the left slide-out): `nav.js` has a dedicated `kb`
  area that renders My Onboarding (red outstanding-count badge), All Articles, the
  categories with counts, and the Manage group (Drafts, Archived, Onboarding Setup,
  Compliance), fed live from a `localStorage` cache (`cprKbNav`) the page publishes on
  every draw. The page content is **full-width list rows**. Future mocks should treat
  the left rail + nav pane as the browse surface and give the page the full width.
- Everything else in the rows shipped as drawn: 34px emoji tile, unread dot + bold,
  single status chip, one-line summary, category/updated meta, and the **Viewed**
  column — "Never" in amber `#B87A00`, red when the article is required, dates
  otherwise. Search is the big field (server-side FTS, strict then loose).

### 5b — My Onboarding
Shipped with the exact state grammar (✓ green / ▶ blue `#F3F9FD` row + 3px blue border
+ "Start reading" / 🔒 dimmed; module gating with the "Unlocks when…" note; quiz chips
both states). Two things the mock never showed now live inside the same track — see §3.

### 7a — Reading view
As designed: 820px measure, 3px blue top border, meta line, amber callouts (authored
via a `!> ` prefix in the article's light markup), footer bar with `✓ Mark as read` +
"logs your read receipt" note and the red quiz CTA. Mark-as-read writes
`kb_reads.acknowledged_at` — the single receipt that feeds the Viewed column,
onboarding progress, and compliance.

### 6a / 8a — Quiz flow
As designed, including the security posture: correct answers live in a table the
browser **cannot read** (`kb_quiz_answers`); grading is a server-side RPC
(`kb_quiz_grade`) that returns only ok/hint per question. 80% pass, unlimited
attempts, best kept.

> ⚠ **8a label contradiction, resolved:** the canvas option label says "correct
> answers shown for misses" but the mock body and the README both show only the
> "Covered in: {section}" hint. The README rule ("never reveal the correct answer")
> is what shipped, and the schema enforces it. Keep future mocks on that rule.

### 6b — Compliance
Shipped: header + role chip, `.storesel` Store dropdown (canonical values, display
labels), the three stat tiles (overdue tile red-accented), house table with progress
bar + ⚠ overdue line, quiz counts, receipt pills, View ›. Divergences:
- Receipt-pill columns are the **4 most recent required articles** (dynamic), not two
  fixed columns.
- `View ›` opens a **per-person modal** the mock never drew — it grew into the main
  management surface (§3) and is the top design request.
- Progress math changed meaning when assignment landed (§3): a person's denominator
  is now **the modules assigned to them**, and an unassigned person reads
  "Nothing assigned", not 0%.

### 8b — Editor
Shipped as a sidebar-card editor with Draft/Published chip, Publish, toolbar, writing
surface, and the settings/onboarding/readers cards — plus unmocked additions:
per-article **emoji picker**, **quiz question editor** (modal; README left it to us),
archive/restore, and publish auto-announcing to the Communications feed + alerts.
Two taxonomy mismatches for future mocks:
- **Categories:** the mock's list (Policies, Repairs, Training, Tools & Systems,
  Ordering, Store Ops) never existed. Live categories: **SOPs & Policies, Repair
  Knowledge, Insurance & Claims, Training, Tools & Systems, Vendors & Contacts**.
- **Visibility:** the mock offered Everyone / Managers & up / Owner only. The live
  model is two tiers (`employee` | `manager`). An owner-only tier is a small schema
  change if genuinely wanted — say so explicitly if a mock depends on it.

---

## 2. Convention change since the mocks: Lucide, not emoji

Owner call (2026-07-25), after this package was drawn: **UI chrome uses Lucide SVG
icons, not emoji** — h1s, section titles, buttons, nav. The mocks' 📚 🎓 📋 headers and
🔎 search glyph predate this. Emoji inside *content* (the per-article emoji tile, KB
article bodies) are fine and stay. Future mocks: Lucide names for chrome
(`graduation-cap`, `clipboard-list`, `search`…), emoji only as content.

Also carried forward, unchanged: store switching is the brand `.storesel` Select
(never pills); display labels CPR Eugene / CPR Salem / CPR Clackamas over canonical
values; date navigation uses the `pickers.js` popovers.

---

## 3. Built since the handoff, with no mock — needs design eyes

These exist and work today, wearing utilitarian developer UI. In track order:

### 3a. Task steps in the onboarding track
A module's track mixes **articles** with **task steps** — real-world to-dos like
"I-9 employment eligibility verification" or "Sign in & set your PIN". Each step is
owned by `employee` (self-tick, "Mark done ✓") or `manager` ("Done with your manager",
shows a "Waiting on your manager" chip when it's the next item; managers tick it from
Compliance). A seeded module — **Getting Set Up — HR & Accounts**, 8 steps — is the
day-one paperwork track. The mock's visual grammar only covers articles+quizzes;
steps currently borrow the same row style with a ☑️/🧑‍💼 tile.

### 3b. Sections — a third level inside a module
`Week 2 → iPhone Repairs → Screen removal`. A module's items can group under named
sections; ungrouped items sit at module level, and both **interleave** in one order
(`Week 1 → How to answer the phone` above the `Important Policy` section works).
Sequential unlock is unchanged — sections are purely presentation.
- Employee view: a section header row (`.secthd` — grey strip, name left, "1 / 3"
  count right). Functional, unstyled beyond that.
- Setup view: each item row grew a small `<select>` to place it in a section; sections
  are managed as chips (＋ Add a section / rename / delete) in the module footer.
- One shared library (`assets/onboarding-track.js`) guarantees all three surfaces
  render identical order — any redesign must keep one visual order too.

### 3c. Modules are now assignable bundles (the biggest change)
A module no longer shows to everyone. One assignment row per **(person, module)**,
with `assigned_by`, `assigned_at`, and an optional **due date**. Modules can
**auto-assign**: a role + a "hired on or after" date, so arming Week 1 for new
team-members doesn't retro-dump it on the whole team. Current UI:
- **Compliance modal**: an "Assigned modules" list — ＋/✓ pill toggles assignment, a
  raw `<input type=date>` sets the due date. It works; it isn't designed.
- **Roster**: per-person progress counts only assigned modules; unassigned people show
  "Nothing assigned"; a module past its due date adds a red "⚠ N modules past due"
  line and feeds the Overdue tile.
- **Setup**: a plain strip under the module header — "Auto-assign to [role] hired on
  or after [date] [Save rule]" with a warning that clearing the date assigns current
  staff too.
- **Employee**: My Onboarding shows only assigned modules; empty states distinguish
  "Nothing assigned yet" from "your modules are empty".

### 3d. New-hire intake (`intake.html` + Settings → Team Members)
Step 1 of the hiring flow: **intake → QuickBooks (Workforce self-setup) + RepairQ
credentials from corporate → create in MRT + onboarding auto-assigns**. A public,
token-is-the-credential page (same pattern as contract signing / interview booking):
legal name, preferred name, pronouns, DOB, phone, personal email, address, emergency
contacts ×2, shirt size, transportation, availability, I-9 plan. Deliberately **no
SSN / bank / W-4** — those go straight into QuickBooks, and the form says so.
Manager side lives on Settings → Team Members: create + copy link, status chips
(Waiting on them / Ready to review / Set up), a label/value review card, and
"Copy onto their record" once the staff row exists. Built phone-first and functional;
it has never seen a design pass, and it's the most customer-grade surface here — a
new hire's literal first impression of the company's tooling.

---

## 4. Decided but NOT built — waiting on design: the New-Hire Setup Checklist

The owner's ask, verbatim: *"I need onboarding to help me with things like — have I
given the employee a schedule?"* The design principle agreed: **split verifiable from
trust-me.** A tick-box records that you remembered; most of this list can instead be
*verified against the data*, live.

**Auto-verified rows** (computed, never ticked):

| Check | Source of truth |
|---|---|
| Staff record + PIN set | `staff.pin_hash` |
| Home store + authorized stores | `staff.authorized_stores` |
| **Recurring schedule exists** | `staff_schedule` row |
| Onboarding modules assigned | `onboarding_assignments` count |
| Phone on file (feeds SMS) | `staff_profiles.phone` |
| Emergency contact | `staff_profiles.emergency` |
| Birthday (milestones post) | `staff.birthday` |
| Commission plan | `commission_roster` — **only if their role earns accessory/device**, or it cries wolf on admins |

**Manual steps** (no data to check — stay as ticks, live in the HR module today):
I-9 collected · QuickBooks **Workforce invite sent** (replaces the current "manager
adds your direct deposit details" step — the owner never handles bank details) ·
RepairQ credentials requested from corporate · plus owner-proposed additions pending
confirmation: shirt ordered, keys/alarm code, added to team chat.

**Where it lives:** the Compliance per-person modal (which is already the "is this
person ready?" screen) + a compact readiness indicator on the roster so an incomplete
setup is visible without opening anyone. Needs designed states for: verified ✓ /
missing ✕ / not-applicable / manually-ticked-with-by-whom-and-when.

Run against the current roster this catches real gaps today: 3 of 9 staff have no
emergency contact, 0 of 9 have a birthday, 2 lack commission-roster rows.

---

## 5. The data reality to design for

The mocks show a mature, fully-populated system. Launch reality (2026-08-11):

| Fact | Value |
|---|---|
| Articles | 76 — **64 draft / 12 published**, only 1 required-read |
| Articles attached to any module | **0** |
| Quizzes | **0** (schema ready, none authored) |
| Sections in use | **0** (just shipped) |
| Assignments | **0** (deliberate — existing staff start clean) |
| Modules | 3 — HR & Accounts (8 task steps), Week 1 + Week 2 (**empty**) |
| Read receipts | 20, from only 4 of 9 people |
| Categories most in draft | Repair Knowledge 15/0 published, Insurance & Claims 12/0 |

Implication: **the zero and near-zero states are the real launch UI.** "No quiz yet"
on an article, an empty module in Setup, a person with nothing assigned, a library
where most of a category is Drafts — these deserve the same care as the happy paths,
and none of them are mocked.

---

## 6. Design request list (in priority order)

1. **Compliance per-person modal** — it became the management hub: manager step
   tick-offs, assign/unassign modules, due dates, section-grouped item list, and
   (future) the §4 setup checklist. Deserves a proper sheet/panel design rather than
   the current stacked rows + raw date input. Mobile matters (owner uses a phone).
2. **New-Hire Setup Checklist** (§4) — the one thing blocked on design before build.
   Modal section + roster indicator, with the four row-states.
3. **Section headers** in the employee track (+ how sections read in Setup's item
   list and the compliance modal) — per-section progress, and how a section header
   behaves around locked items.
4. **Due dates, both sides** — how "Week 1 · due Fri Aug 15" reads in the employee's
   module header, and what past-due looks like for them (currently it only surfaces
   to managers).
5. **Onboarding Setup** surface — never mocked at all: module rail, mixed item list
   with ↑↓ reorder, section chips, per-item section pickers, the auto-assign rule
   row, "＋ Add a task step" modal. Managers will live here while authoring the
   61-draft backlog into modules.
6. **Intake** — polish pass on the public form (it's the new hire's first touch) and
   the Settings review block; a designed "Ready to review" → promote flow.
7. **Zero states** (§5) across library, track, compliance.
8. **Lucide sweep** (§2) — replace chrome emoji in these screens as they're touched.

---

## 7. Open questions for the owner (carry into the design round)

1. Manual checklist items: shirt / keys & alarm / team chat — right list? Anything
   else on the real day-one list?
2. Setup checklist scope: new hires only, or run it against the whole team (it would
   immediately flag the 3 missing emergency contacts + 9 missing birthdays)?
3. Week 1 content: counter-first (check-in, quoting, phone) or bench-first (repairs)?
   Decides how the 61 drafts get sequenced into sections.
4. Quiz authoring: 0 exist. Read receipts alone are the compliance record today —
   are quizzes round-2, or does Week 1 launch with them?

---

## Appendix — pointers for whoever builds the next round

- Track logic (merge/order/group/unlock): `assets/onboarding-track.js` — the one
  implementation all three surfaces import. Renders must not fork from it.
- Schemas: `docs/sql/kb-onboarding-schema.sql`, `onboarding-steps.sql`,
  `onboarding-sections-assign.sql` (sections + assignment + auto-assign RPCs),
  `staff-intake-schema.sql`.
- Nav KB pane: `assets/nav.js` (`kb` area, `cprKbNav` cache, `window.CPRKbNav.refresh()`).
- Employee track render: `knowledge.html` (`drawOnboarding`); compliance roster +
  modal: `kb-compliance.html` (`draw`, `openDetail`).
- The site-wide mobile shell (bottom tab bar <860px, safe-area handling) is owned by
  `nav.js`; new surfaces inherit it.
