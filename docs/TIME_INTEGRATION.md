# Time Integration — plan of record

QuickBooks Time (account `eugeneirepairs`) is connected. OAuth + token auto-refresh +
employee sync live (`qbtime-oauth`, `qbtime-sync`, `integration_tokens`, `qbtime_users`).
This file plans the build-out from the owner's list.

## Shape of it: 3 foundations, then features on top

Almost everything depends on three shared pieces. Build these first.

### Foundation A — Rock-solid employee mapping  *(keystone, quick)* — ✅ BUILT
> **Redesign (owner call): identity lives on the employee profile, not in the integration.**
> Mapping was a one-time back-fill chore (two rosters that grew up apart), not a permanent
> integration setting. The ongoing model:
> 1. Create the hire in **QuickBooks** → 2. the sync **auto-creates the MRT staff row** with the
> legal name and links it (`qbtime_users.staff_id`) on the spot → 3. the owner opens the new
> person in **Employee Records**, sets a **Preferred name** (`staff.preferred_name`; blank → legal),
> and finishes setup (PIN/store) → 4. preferred overrides legal everywhere in MRT
> (`display_name = preferred_name || legal`), except RepairQ-report names, which keep their own.
> - **Auto-create is dupe-guarded:** only fires for a *first-time-seen* QB `qbt_id` that's active,
>   name-unmatched, and has no last-name collision with existing active staff — so the existing
>   roster (already in `qbtime_users`) never spawns a second row. New hires come in as **stubs**
>   (no PIN/store/login until the owner finishes setup — `pin_hash`/`home_store`/`authorized_stores`
>   are now nullable for exactly this).
> - **The QB Time link + preferred name live on the profile** (`employee-records.html`), owner-editable
>   (admins see it read-only). The Settings → Integrations mapping panel is **retired**; the QB Time
>   page is just **Connection + Sync** now, and the sync reports created / linked / inactive counts.
> - **Terminations surface on the profile too:** a linked QB user gone inactive shows
>   "⚠ inactive in QB" on their record; the owner flips Employment status to Terminated. (Still
>   never the reverse — MRT never writes terminations back to QBO.)
> - The nickname matcher below is now just the bridge for the *existing* roster; new hires are
>   id-linked from birth.

Covers list items **#9 (name mismatches)** and **#6 (termination sync)**.
- The auto-match by name misses nicknames: QB Time carries **legal** names, MRT/RepairQ use
  **preferred** names. Real examples: Michael→**Vince** Amador, Joshua→Josh, Benjamin→Ben,
  Nicholas→Nick. (That's why "Michael Amador" landed in the unmatched.)
- Built: (1) a **nickname-aware** auto-match pass (`NICK_GROUPS` dictionary in `qbtime-sync`:
  exact legal → exact display → username → same-last-name + interchangeable first form);
  (2) a **manual-map UI** in Settings → Integrations — lists QB users still to link with a staff
  dropdown, plus a collapsed "Linked" list to re-point anyone. Saves to `qbtime_users.staff_id`
  via `qbtime-sync?action=map`; `?action=roster` feeds the UI.
- **Manual maps are sticky:** a re-sync **preserves** any existing `staff_id` (manual or prior)
  and only auto-matches QB users that have *no* mapping yet — so a hand link is never clobbered.
  (Verified: Michael→Vince and Jose Pelayo→Jose Vargas held across a re-sync.)
- **One-way termination sync (#6) — PROPOSE, never auto-apply.** When a *mapped* QB Time user is
  inactive while the MRT `staff` row is still active, the sync returns it as a
  `termination_candidate`; the owner confirms (**Deactivate in MRT**) or dismisses (**Keep active**)
  in the mapping panel. **Never** the reverse (MRT termination must not touch QBO). *Why propose:
  the first cut auto-deactivated and immediately nuked the owner's own row — her QB user is inactive
  but she's the active owner. Irreversible writes get a human in the loop (read → propose → confirm).*
- **Refinement (owner):** going forward, new hires are **created in QBO first**, which gives MRT the
  **legal** name on sync; the owner sets a **preferred** name on the MRT record and a blank preferred
  falls back to legal. That makes the link **id-based** (`qbt_id` ↔ `staff_id`) rather than
  name-guessed — the nickname pass is the bridge for the *existing* roster, not the long-term path.
- Why first: every feature below keys off a correct QB-user ↔ staff link.

### Foundation B — Timesheets sync  *(the actual-hours data)*
Pull QB Time timesheets (hours per employee per day, regular vs OT). Powers #2, #3, and OT.
- A `qbtime_timesheets` table (or daily rollup) keyed by qbt user + date, with jobcode/class.
- Auto-refresh already keeps the token alive; this is the first *recurring* sync (cron candidate).

### Foundation C — Notification rail: email → Power Automate → Teams  *(#4, reusable)*
The owner's "master workaround": Power Automate can't take webhooks without Premium, but it
**can** trigger on an inbound email. So MRT sends a structured email to the company inbox; a
Power Automate flow parses it and posts to Teams. **Reusable by every MRT tool**, not just time.
- Build a generic `notify` edge function (send email via a service — Resend/SendGrid/SMTP) with
  a structured subject/body Power Automate can route. SMS optional later (Twilio).
- Needed by #3 (OT alerts); useful everywhere (claim risk, repairs-w/o-parts, etc.).

## Features, in dependency order

| # | Feature | Needs | Notes |
|---|---------|-------|-------|
| 2 | **Hours worked this week** in My Schedule | B | First visible employee win; sits beside the existing schedule summary. |
| 10 | **PTO balances** | mapping | Pull QB Time time-off balances; show in My Schedule / hub / employee record. |
| 3 | **Overtime + pace + alerts** | B + C + schedules | Real-time hours vs their recurring scheduled hours; project end-of-week; flag pending OT → Teams/SMS alert. Define OT rule (OR: 40/wk). |
| 1 | **Time-off → QB Time** | approval flow + mapping | The my-schedule time-off request we built → on approval, write the time-off to QB Time so payroll reflects it. Round out approve/deny first. |
| 7 | **Clock-in/out via MRT** *(big keystone)* | B + mapping | Clock in/out from a mobile-friendly MRT page → create/close QB Time timesheets. The hook for enforcing checklist / repairs-w/o-parts / consumption workflows at clock-in. |
| 8 | **Class/jobcode on clock-in** | #7 | **Only if QB Time hard-requires it.** Owner doesn't need class/P&L attribution driven from MRT for its own sake — but if QB Time's workforce/time rules make a class a *required* field to log time, the clock-in must satisfy it: prompt to pick one (skip if only 1) so hours bill to the right store. Capture each user's jobcodes during sync; build the picker only if the requirement is real. |
| 5 | **Onboarding workflow** | new-hire trigger + checklists | Trigger = **new employee in QBO** (owner's call — QBO owns pay/tax/HR setup). MRT detects the new QB Time user via the sync diff and opens an onboarding/training checklist. No point rebuilding HR setup in MRT. |

## Answers to the open questions in the list
- **Onboarding trigger — QBO vs MRT?** QBO. It already prompts for self-setup / pay rates / tax /
  location / pay types. MRT's job is the onboarding+training **tasks**, kicked off when the new
  QB Time user shows up in our sync. Don't rebuild HR setup in MRT.
- **Force clocking into MRT (disable Workforce app)?** Likely possible via QB Time platform/group
  settings (restrict which platforms can track time) — **needs verification**; flagged as research.
  Either way MRT pushes clock events to QB Time via API, so both can coexist short-term.
- **Geolocate / IP-whitelist the clock?** Yes — capture browser geolocation at clock-in and validate
  against store coordinates, and/or check the request IP against a store whitelist server-side.
- **Home-screen "widget" like Workforce?** Owner confirmed a true iOS/Android lock-screen/home-screen
  **widget is native-only** — out of scope for a static site. The web compromise is an installable
  **PWA** (manifest + service worker): a home-screen **icon** that opens the clock page in one tap.
  Ship the PWA icon; don't chase a native widget.
- **Multi-class billing (#8):** capture each employee's jobcodes/classes in the sync; at clock-in,
  show the class picker only when they have >1 (mirrors QBO skipping the ask for single-class).

## Research to nail before the clock-in build
- QB Time **clock in/out API** (open/close timesheets; on-the-clock state).
- QB Time **jobcodes ↔ QBO classes** mapping (for P&L by store).
- QB Time **platform-restriction** settings (to force MRT clocking).
- An **email-sending** service for the notification rail (Resend/SendGrid/SMTP).

## Recommended sequence
1. ~~**A** (mapping/nicknames + manual-map UI + termination sync) — keystone, quick.~~ ✅ **done**
2. **B** (timesheets sync) → ship **#2 hours-this-week** as the first tangible win.  ← *next*
3. **C** (notification rail) → **#3 OT/pace alerts**.
4. **#10 PTO**, **#1 time-off push**.
5. **#7/#8 clock-in/out + class + geofence/PWA** (the big one; do the research first).
6. **#5 onboarding** (with the checklists tool).
