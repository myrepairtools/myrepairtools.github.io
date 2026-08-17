# Onboarding Profile — Design Handoff (build the UI)

**For the page-improvements / Design session.** All the data and all the
merge/order/unlock logic already exist and are live. This is a **presentation
build**: turn `onboarding-dashboard.html` from a flat board into a
**roster → per-person profile**, the way `employee-records.html` works.

**Read `CLAUDE.md` first** for brand + page conventions. This doc covers only
what's specific to onboarding.

---

## 1. What the owner asked for

> New hires in the onboarding page open up to an onboarding "profile" where
> there will be cards for each module with all the items in that module.
> [...] a list of techs being onboarded, but then we hit a View button and it
> opens their onboarding profile with all their action items. Similar to how
> the team member profiles work.

And the reason the Compliance page isn't it:

> I know that we have compliance page, but really that is for ongoing
> trainings not onboarding.

So: **Compliance stays** — it's the roster-wide, ongoing-training view.
**Onboarding** becomes the place you work ONE new hire from start to ready.

## 2. What exists (don't rebuild any of this)

### `assets/onboarding-track.js` — the ONE track implementation
`window.CPRTrack.build(data)` merges a module's articles + task steps, groups
them by section, orders them canonically, and computes sequential unlock.
`knowledge.html`, `training.html` and `kb-compliance.html` all render from it.
**Never fork this math** — if the profile needs something it doesn't return,
add it there so every surface agrees.

Returns, per module:

```
{ mod, items, rows, done, total, complete, lockedModule,
  states, sections:{id:{done,total}}, due, pastDue }
```

`rows` is what you render — it interleaves section headers with items:

```
{type:'section', sec, done, total}          // presentation only
{type:'item', it, state:'done'|'next'|'lock'}
```

An item (`it`) is `{kind:'a', a:<kb_article>}` or `{kind:'s', s:<onboarding_step>}`.

Feed it: `modules, sections, articles, steps, assignments, reads, quizzes,
attempts, stepDone, signatures, today`. `kb-compliance.html`'s loader is a
working example of assembling all ten for one person.

### The three item states — the whole visual language
- **done** — read + acknowledged (and quiz passed, and signed if the article
  requires a signature)
- **next** — the one item they can act on now
- **lock** — sequential unlock; nothing past `next` is reachable

Unlock is **global across assigned modules** and ignores section boundaries —
sections are presentation only. **Nothing locks because it's past due.**

### Who has to do each step: `onboarding_steps.who`
- `employee` — they tick it themselves in Training
- `manager` — a manager ticks it for them
- `backoffice` — **hidden from the employee entirely**; owner/back-office work
  (e.g. "Add to QuickBooks Payroll"). `training.html` filters these out. The
  profile is a manager surface, so it SHOWS them — that's part of the point.

### The setup checklist (currently kb-compliance's slide-over)
Eight **auto-verified** rows — they tick themselves, nobody can mark them:
PIN set · home store · recurring schedule exists · can clock in (QB Time
linked) · modules assigned · phone on file · emergency contact · birthday.
Plus two commission rows that render **n/a** when the role doesn't earn that
type.

Five **manual** ticks in `staff_setup_checklist`, with who/when audit:
I-9 collected · RepairQ credentials requested · Shirt ordered · Shirt issued ·
Added to team chat.

A candidate is judged on the role they **start** on (`staff.role_on_start`),
not their current `candidate` role — otherwise commission rows read "n/a" for
a plan that must exist before their first sale.

### Where a person comes from
`staff` rows with `role='candidate'` (hired, not started) and recent hires.
`staff.role_on_start` holds what they become on their start date; the day-one
cron promotes them at 7:30am. Pre-conversion candidates live in
`staff_intake` and are NOT staff yet — see §5.

## 3. Content volume — design for near-empty

Today, honestly:

| Module | Articles | Task steps | Sections |
|---|---|---|---|
| Getting Set Up — HR & Accounts | 0 | 10 | 0 |
| Week 1 — Bench basics | 0 | 0 | 0 |
| Week 2 — Bench basics | 0 | 0 | 0 |

**Two of the three modules are empty shells**, and 61 employee-facing KB
articles exist but none are attached to a module. So the profile must look
right with one populated card and two empty ones — and must make "this module
has nothing in it yet" obviously a content problem, not a bug. Don't design
only the full case.

`onboarding_assignments` is also **empty company-wide** — nobody has a module
assigned. Assigning is a manager action that belongs on this profile.

### The one populated module, in full
"Getting Set Up — HR & Accounts" is the only module with content. Its ten
steps, in track order, with who owns each — this is the concrete thing the
first card has to render:

| who | step |
|---|---|
| backoffice | Add to QuickBooks Payroll |
| manager | I-9 Employment Eligibility Verification |
| backoffice | Get CPR Credentials |
| employee | Sign in to myRepairTools & set your PIN |
| employee | Add myRepairTools to your phone home screen |
| employee | Emergency contact & profile details |
| employee | Read the Employee Handbook & acknowledge each section |
| employee | Download Workforce App |
| manager | Go over the commission plan — structure, goals & the dashboard |
| manager | Review pricing procedures & the Price Guide |

Note the mix: three owners in one list, and the first item is one the new hire
can neither see nor do. Whatever the card looks like, it has to make "whose
move is it?" readable at a glance.

## 4. What the profile needs to show

Owner's words: *cards for each module with all the items in that module.*

- **Header** — name, store, position, start date, role (Candidate vs Team
  Member), overall progress. Same identity treatment as `employee-records.html`
  (avatar/photo via `staff_profiles.photo_path`).
- **Setup card** — the ten auto rows + five manual ticks from §2. This is the
  "can they actually work on day one" card.
- **One card per assigned module** — every item, in track order, showing its
  state; section headers where a module has sections; per-card progress; due
  date and past-due treatment.
- **Manager actions inline** — tick a `manager`/`backoffice` step, assign or
  unassign a module, set a due date.

Open questions for design to answer:
1. Full page or master–detail? Team Members is a full-width profile with a tab
   strip; Compliance is a slide-over. The owner said "similar to team member
   profiles," which suggests full page — but onboarding has fewer sections, so
   tabs may be overkill.
2. Do the module cards stack in one column, or grid at desktop width?
3. How loud should `lock` be? Every item after `next` is locked, so with a
   10-step module that's eight greyed rows. Muted, or collapsed behind a count?
4. Does the Setup card belong above the modules, or as its own tab?
5. What does "done" look like at the person level — do they drop off the
   onboarding list entirely, and if so, when?

## 5. The one structural question

There are **two populations** on this page today and they're not the same shape:

- **Candidates pre-conversion** — a `staff_intake` row, no staff record yet.
  They have paperwork state (offer signed / handbook signed / form submitted)
  and the three-button flow (Review · Create in QuickBooks · Check for QBO
  Records). **No modules, because there's no person to assign to yet.**
- **Converted hires** — a real `staff` row, assignments, reads, ticks. This is
  who the profile is for.

Design needs to decide whether the roster shows both with one row shape, or
whether pre-conversion candidates stay a separate section above. Suggest the
latter: their action is "finish the hire," not "work the track."

## 6. Prerequisites — a fourth thing to draw

An item can now name **one other item it waits on**
(`onboarding_steps.requires`, an item key like `s3` or `a17`). Live already;
the field is empty everywhere, so nothing behaves differently until someone
fills it in.

`CPRTrack` returns `blockers` per module — `{itemId: requiredItemId}` — for
anything locked by a named prerequisite rather than by its position. So a
locked row can say **what** it's waiting on instead of just going grey:

> Give Schedule — waiting on *Add to QuickBooks Payroll*

That's the state design needs to draw. It's visually distinct from an
ordinary `lock` (which just means "not your turn yet"), because this one is
actionable information: it tells a manager which item to go do first.

**It blocks in ADDITION to sequential order.** A prerequisite can never
unlock something the order already locked, which is what makes adding one
safe. Only steps can carry a prerequisite today; articles can't.

### The decision this surfaces

Prerequisites are most useful if strict sequential unlock relaxes — otherwise
order already blocks everything and `requires` only matters when a
prerequisite sits LATER in the list. The open question, for the owner not
design:

> Should items without a prerequisite unlock in parallel, so an employee can
> read the handbook while back-office does QuickBooks — with `requires` as
> the only thing that blocks?

Related, and currently inconsistent: **Training filters `backoffice` steps out
before computing unlock, KB Compliance doesn't.** So the same person is
"blocked" on the manager's screen and not blocked on their own. Whatever
design draws should assume that gets settled deliberately rather than
inherited.

## 7. Ground rules that aren't negotiable

- **NO EXPLAINERS** (CLAUDE.md, the rule broken most often). A field gets a
  label, a step gets a name, a button gets a verb. No sentence under a card
  title explaining what the card is.
- Icons are Lucide via `window.CPRNavIcon(name, size)` — no emoji in chrome.
- Store switching is a `.storesel` dropdown, never pills.
- Tab/sub-view state persists in `localStorage` **and** the URL hash; deep
  link a person as `#e=<staff_id>` (Team Members uses `#e=<id>/<tab>`).
- Mobile: this is a manager tool but managers use phones — the roster and the
  cards both need a phone layout.
