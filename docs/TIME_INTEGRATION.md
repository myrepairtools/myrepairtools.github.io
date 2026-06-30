# Time Integration — plan of record

QuickBooks Time (account `eugeneirepairs`) is connected. OAuth + token auto-refresh +
employee sync live (`qbtime-oauth`, `qbtime-sync`, `integration_tokens`, `qbtime_users`).
This file plans the build-out from the owner's list.

## Shape of it: 3 foundations, then features on top

Almost everything depends on three shared pieces. Build these first.

### Foundation A — Rock-solid employee mapping  *(keystone, quick)*
Covers list items **#9 (name mismatches)** and **#6 (termination sync)**.
- The auto-match by name misses nicknames: QB Time carries **legal** names, MRT/RepairQ use
  **preferred** names. Real examples: Michael→**Vince** Amador, Joshua→Josh, Benjamin→Ben,
  Nicholas→Nick. (That's why "Michael Amador" landed in the unmatched 57.)
- Build: (1) a **nickname-aware** auto-match pass (Josh/Joshua, Ben/Benjamin, Nick/Nicholas…),
  (2) a **manual-map UI** — list QB Time users with `staff_id IS NULL`, pick the staff row to link.
  Stored on `qbtime_users.staff_id`.
- **One-way termination sync (#6):** when a *mapped* QB Time user goes inactive, mark the MRT
  `staff` row inactive/archived. **Never** the reverse (MRT termination must not touch QBO).
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
| 8 | **Class/jobcode on clock-in** | #7 | Multi-location staff have multiple QBO classes; prompt to pick one at clock-in (skip if only 1) so hours bill to the right store on the P&L. Capture each user's jobcodes during sync. |
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
- **Home-screen "widget" like Workforce?** An installable **PWA** (manifest + service worker) gives a
  home-screen icon that opens the clock page — the web equivalent. A true interactive iOS/Android
  widget is native-only (out of scope for a static site).
- **Multi-class billing (#8):** capture each employee's jobcodes/classes in the sync; at clock-in,
  show the class picker only when they have >1 (mirrors QBO skipping the ask for single-class).

## Research to nail before the clock-in build
- QB Time **clock in/out API** (open/close timesheets; on-the-clock state).
- QB Time **jobcodes ↔ QBO classes** mapping (for P&L by store).
- QB Time **platform-restriction** settings (to force MRT clocking).
- An **email-sending** service for the notification rail (Resend/SendGrid/SMTP).

## Recommended sequence
1. **A** (mapping/nicknames + manual-map UI + termination sync) — keystone, quick.
2. **B** (timesheets sync) → ship **#2 hours-this-week** as the first tangible win.
3. **C** (notification rail) → **#3 OT/pace alerts**.
4. **#10 PTO**, **#1 time-off push**.
5. **#7/#8 clock-in/out + class + geofence/PWA** (the big one; do the research first).
6. **#5 onboarding** (with the checklists tool).
