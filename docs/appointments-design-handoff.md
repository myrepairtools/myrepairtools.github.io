# Appointments — Design Handoff (build the UI)

**For the Design session.** Nothing is built yet — this is a **new tool**, the
largest single build on the site since Contracts. This doc fixes the behavior,
the data model and the decisions the owner has already made, so the design
session can spend its whole budget on the screens.

**Read `CLAUDE.md` first** for brand + page conventions. Two that bite hardest
here: **no explainers anywhere in the UI**, and **Lucide icons, never emoji**,
in every piece of chrome.

---

## 1. What this is

Technicians schedule customers for **consultation services** — a computer
consult, a data-recovery consult, whatever the services library holds. Two ways
in: a tech books it from inside MRT, or the customer books themselves from a
link we send them.

This is **not** Bookings (`interviews.html`). Bookings is hiring — a candidate
picking an interview slot with a hiring manager. It stays exactly as it is and
**must not be touched**. We are free to copy its *patterns* (computed slots,
capability-token public page, the reminder-pass cron), and this doc does, but
appointments gets its own tables, its own edge function and its own pages.

The core difference: Bookings hosts **declare their own windows by hand**.
Appointments derives availability from **the real work schedule** — which means
it inherits a problem Bookings never had, and §4 is how we solve it.

---

## 2. Decisions the owner has already made

These are settled. Design to them; don't re-open them.

| # | Decision |
|---|---|
| 1 | **Consultation windows are per store, per weekday.** Set once in Settings, not per service. Any service can be booked inside any window. A window is a ceiling, not a schedule — the tech still has to actually be working. |
| 2 | **One appointment at a time, per store.** Booking anyone at 2pm takes 2pm off the board for that store. Stored as `max_concurrent` (default 1) so it can be raised later without a migration. |
| 3 | **A schedule change never silently cancels a customer.** When the schedule moves out from under a booked appointment, the system tries to **auto-reassign** to another tech who is linked to that service and free at that time. Only if nobody qualifies does it flag and alert. |
| 4 | **Call them Reminders, not Notifications** — everywhere the customer or a setting can see the word. Contact method is **chosen at booking**, by the customer or by the tech booking for them. |

Channel rules for #4:
- **SMS sends from that store's own RingCentral number** (the `messaging`
  function + `store_lines` already do this — Contracts and Bookings both use it).
- **Email sends from `appointments@myrepairtools.com`, reply-to the store's own
  email** (`stores.email`).

---

## 3. The availability math

The single hardest thing in this build, and the thing an off-the-shelf booking
UI gets wrong. A time is offerable only if **all five** hold:

1. **Inside a consultation window** for that store on that weekday
   (`appt_windows`). Several windows per day are allowed — 11–1 and 3–6 is a
   legitimate setup.
2. **A tech linked to the requested service is actually working** at that store
   at that time. Resolve their day the way the rest of the site does:
   `schedule_overrides` → recurring `staff_schedule.shifts[weekday]` →
   `shift_hours(shift_id, store, weekday)`. Never re-implement this loosely —
   `my-schedule.html` is the reference.
3. **They are not on approved time off** (`time_off_requests`). Site convention
   holds: **a ½-partial day does NOT block** — that person is working.
4. **The store has capacity** — no other appointment overlaps (`max_concurrent`,
   default 1), counting the service's gap.
5. **Lead time and horizon** allow it — no booking inside the minimum notice,
   nothing past the horizon.

Then subtract blackouts (`appt_blackouts`, store-wide or one person).

**Slots are computed on every request, never generated into a table.** That is
the one thing Bookings got exactly right and it is why it has no cron to
backfill and nothing to go stale. Availability is a *view* of the schedule, so
when a manager republishes the schedule, tomorrow's openings are already correct.

**A tech is bookable only where a service links them.** There is no "available
by default" — Vince never appears for a computer consult because nobody linked
Vince to it. Working is the ceiling; the service link is the door.

---

## 4. The orphaned appointment — design this properly

Ben has a 2pm Thursday consult. Schedule Admin republishes and Ben is off
Thursday. The customer is still coming.

**Never auto-cancel. Never block the publish.** The manager's schedule work is
not held hostage by a booking, and a customer is never silently dropped.

Instead, on any change that orphans an appointment, try to **reassign**: find a
tech who is (a) linked to that service, (b) working that store at that time, and
(c) free. Then:

- **Reassigned successfully** → the appointment quietly moves. New tech gets a
  reminder. **The customer is told only if they picked that person by name** —
  if they booked "anyone available", the swap is not their problem and a
  message about it just creates confusion. `appointments.any_staff` records
  which it was.
- **Nobody qualifies** → the appointment is flagged `needs_attention` and a
  manager is alerted. It renders **red on the calendar and pinned to the top of
  the list view** until a human resolves it. This state needs a real design —
  it is the one moment this tool can embarrass the business, and it must be
  impossible to miss.

Resolution actions on a flagged appointment: **Reassign** (pick from whoever is
free), **Reschedule** (opens the slot picker, re-sends to the customer), or
**Cancel** (explicit, with the customer notified).

---

## 5. Screens to design

### A. `appointments.html` — the staff surface
Operations nav, icon `calendar-check`, permission `appointments.view` (everyone).

Four views, tabs persisted in hash + `localStorage` per the site rule:

- **Day** — the working view. A tech's answer to "what's happening today".
  Time-axis column, appointment blocks, gaps visible.
- **Week** — schedule-shaped, closest to how managers already think.
- **Month** — density and overview; who's booked solid, where the holes are.
- **List** — the manager's view. Filterable, sortable, the one you scan.

Shared chrome: `.storesel` store dropdown (**never pills** — site rule), a
`.cpr-navbox` date navigator from `assets/pickers.js` (**do not restyle it**),
and a scope control for **My appointments / This store / All stores**.

**＋ New Appointment** — the counter flow, and it has to be fast. A tech
standing with a customer picks service → time → who → name and number. Staff
booking is permissive: it takes any time, and only refuses a genuine conflict.
Lead-time and horizon rules are for customers, not for the person at the counter.
(`interviews.html`'s `staff_book` is the precedent.)

An appointment opens a **detail panel**: who, what, when, contact, notes, and
the lifecycle actions — Check in / Complete / No-show / Reschedule / Cancel.

### B. `appointment.html` — the public booking page
No gates, no nav — the token is the credential, exactly like `contract-sign.html`
and `interview.html`. Phone-first; most of these will be booked on a phone.

The funnel, one step on screen at a time with a progress bar:

**Service → Location → Time → Your details**

- **Service** — cards from the services library: name, how long it takes, and
  the price when the service is set to show it.
- **Location** — one card per store with address, phone, directions, and the
  next opening. Skipped when a link pins the store.
- **Time** — month calendar plus a slot grid. Default is **"Anyone available"**;
  picking a specific person is an optional refinement, not a required step, and
  it should visibly cost them openings when they do it.
- **Your details** — name, mobile, email, and **"How should we remind you?"**
  → Text / Email / Both. This is a real step the customer answers, not a
  buried preference.

Then a confirmation card: when, where, who, add-to-calendar (.ics + Google),
directions, and Reschedule / Cancel. `?t=<token>` returns them to the same card
later. Bookings' 8a done card is the shape to follow.

Entry params: `?s=<service>` and `?store=<store>` both skip ahead, so a
lobby QR or a texted link can land mid-funnel.

### C. Dashboard widget — `Appointments`
The owner's preferred way to watch this: a widget on the dashboard board, which
is what lands on a phone home screen once the app is installed.

Push a module onto `index.html`'s `REG` registry — that is the whole widget
library — backed by a new **`assets/appointments-summary.js`**
(`window.CPRAppointments.forMe()`), following `checklist-summary.js` and
`cash-summary.js`: one call, one shaped answer, no page logic duplicated.

It answers two questions at a glance:

- **What's next for me** — my next appointment (time, customer, service), and
  today's remaining count. Empty state is a real state, not a blank card: most
  techs will have nothing booked most days and the widget must look deliberate
  when it says so.
- **What needs a human** — the count of `needs_attention` appointments, red,
  tapping straight through to them. Manager-gated via the widget's `can()`
  against `appointments.manage`; techs never see this row.

That second row is the reason the widget exists. An orphaned appointment that
nobody notices is the failure mode of this whole tool, and the dashboard is the
surface people actually look at every morning.

### D. Settings → Page settings → Appointments
Managers only, permission `appointments.manage`. Rail-list + detail-pane editor,
the same shape as the Contracts settings tabs.

- **Services** — the library. Name, duration, gap after, price, show-price
  toggle, active, and **which staff can perform it** (the link that drives
  everything in §3).
- **Consultation Windows** — per store, per weekday, multiple ranges per day.
- **Rules** — lead time, horizon, max per day, gap default, cancel cutoff,
  `max_concurrent`.
- **Days Off** — store-wide or per person, single day or a date range.

---

## 6. Data model

All new, prefixed `appt_`. Nothing here touches an `interview_*` table.

- **`appt_services`** — id, name, duration_min, gap_min (null inherits the store
  default), price, price_visible, active, sort_order, color.
- **`appt_service_staff`** — (service_id, staff_id) unique. The eligibility gate.
- **`appt_windows`** — (store, weekday 0-6, start_min, end_min, active). Several
  rows per store per day.
- **`appt_settings`** — store PK. slot_granularity_min, lead_hours, horizon_days,
  max_per_day, max_concurrent (default 1), default_gap_min, cancel_cutoff_hours,
  active.
- **`appt_blackouts`** — staff_id (null = whole store), store, block_date,
  optional start_min/end_min, reason.
- **`appointments`** — token, store, service_id + snapshotted service_name /
  duration / price, staff_id + staff_name, any_staff, starts_at, ends_at,
  customer_name / _phone / _email, remind_channel (`text|email|both|none`),
  status (`booked|completed|no_show|canceled`), needs_attention +
  attention_reason, notes, source (`staff|self`), created_by, per-send reminder
  flags, canceled_at/_by, repairq_ticket.

**Snapshot the service name, duration and price onto the appointment.** Renaming
a service or moving its price must never rewrite what a booked customer was
told — the same rule Contracts follows with its `terms` snapshot.

RLS scopes reads with `can_see_store`; managers write settings via `is_admin()`.
**Customer writes go only through the edge function's service role, never the
browser** — the public page has no key and no table access.

### Edge function `appointments`
Actions: `services` · `slots` · `book` · `view` · `cancel` · `reschedule` ·
`staff_book` (staff JWT) · `remind` (secret) · `reassign` (the §4 sweep).

`book` **re-derives the slot server-side** and refuses a posted time that is no
longer open. Two customers on the same slot is the failure this prevents, and
the client's opinion about availability is never trusted.

### Cron `appointments-remind`, `*/15`
Independent passes, **each with its own flag on the row** so nothing double-fires:
customer confirmation on booking; customer 24h; customer same-day 1h; assigned
tech 24h and 1h. Bookings' reminder matrix is the working reference — copy its
shape, not its table.

Staff reminders ride the existing `alerts` fanout as a new kind
`appointment`, **Notification tier** — push and feed by default, text opt-in per
person. Customer reminders are their own thing and obey `remind_channel`.

**A reminder goes to the assigned employee and nobody else.** Not the store, not
the manager, not everyone working that day — one appointment, one person told.
The single exception is the §4 flag: when an appointment is orphaned there IS no
assigned employee to tell, so that alert goes to a manager. That is an
exception because the rule can't apply, not a second audience.

### Shared asset
**`assets/appointments-summary.js`** — one call
(`window.CPRAppointments.forMe()`) returning the signed-in user's next and
today's appointments plus, for managers, the `needs_attention` count. The
dashboard widget renders from it. Never re-derive that in the widget.

### Permissions
- `appointments.view` — book, and see the calendar. **Everyone.**
- `appointments.manage` — services, windows, rules. Managers.

---

## 7. Dependencies to clear before build

- **`stores.email` is blank.** Reply-to is specified as the store's own address,
  so every active store needs one filled in Settings → Locations. Owner's call —
  never guess a store's email.
- **`appointments@myrepairtools.com` must exist as a Resend sender.**
  `hiring@myrepairtools.com` already sends on this domain, so the domain is
  verified and this should be an address, not a project.

## 8. Deliberately not in this build

- **Taking payment.** Services carry a price and the booking page shows it; the
  money is collected in store at the counter. The owner has mentioned charging
  for services, so keep the seam clean — Contracts' Square quick-pay link is the
  pattern to copy when we do it, and a `deposit` on the service row is where it
  would attach.
- **A customer table.** Name / phone / email live on the appointment, matching
  how `interview_bookings` does it. A soft match on phone can surface a repeat
  customer's history without us building a CRM. Linking to a RepairQ ticket is
  the obvious later seam; `repairq_ticket` is there for it.
- **Recurring appointments**, and **staff-side reschedule-by-drag**. Both real,
  neither is v1.
