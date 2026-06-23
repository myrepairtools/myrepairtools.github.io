# Employee Records → Supabase — Migration Plan

> **Status: scoping complete, not yet implemented.** Owner asked to move
> `employee-records.html` onto the new Supabase system and **retire**
> `staff-management.html` afterward. This doc is the concrete plan to do that.
> Branch: `claude/auth-roles-permissions-design-5yz462`.

## 0. Decisions locked (2026-06-23, with owner)

- **Everyone is a `staff` row.** With PIN-only login, every active person signs
  in with a PIN and is on the roster. Terminated staff remain as **archived**
  rows (no active login) so their records persist. No blank-passcode "roster
  only" people anymore.
- **Migrate all history** — every entry/PIP, including terminated staff.
- **Visibility is store-scoped:** Owner → everyone. **Admin → only Team Member
  staff at the store(s) the admin manages.** Admins do **not** see other admins
  or the owner in records. Team Members → no records access.
- **"Stores an admin manages" = the admin's `authorized_stores`** (which always
  includes `home_store`). Reuses the field Settings already manages — no new
  "manager-of-store" concept. A Team Member is visible if their `home_store` or
  any of their `authorized_stores` overlaps the admin's `authorized_stores`.
- **Sequencing:** the staff.role hard cutover (`admin`/`team_member`) is a
  separate gated live release. The records **schema below is additive/safe** and
  uses role-tolerant RLS (accepts `admin`+`manager`, `team_member`+`employee`),
  so it can land before or after the cutover.

## 1. Where things stand today (the legacy stack)

`employee-records.html` is a hand-authored HR tool that reads from **two
separate Google Apps Script backends**:

| Data | Backend | Calls |
|---|---|---|
| **Roster** (people) | "CPR Auth Service" (`CPRGate` / `admin-gate.js`) | `listEmployees`, `saveEmployee`, `deleteEmployee` |
| **Coaching Entries + PIPs** | "Employee Records backend" (`API_URL`, `AKfycbz5B5NE…/exec`) | `getAll`, `saveEntry`, `deleteEntry`, `savePIP` |

`staff-management.html` is the roster CRUD UI on the **same** CPR Auth Service.

**Data shapes observed in the page:**

- **Roster row:** `id, name, store, altStores, title (job title), role
  (owner|admin|employee access), passcode(hidden), active, startDate, status,
  notes, archived`.
- **Entry (coaching log):** `employeeId, id, date, incidentDate, subject,
  category, entryType (observation|…), discussed (bool)` **plus** a flexible
  `sections` object (spread in at save time — variable fields).
- **PIP:** a flexible **JSON document** — saved as `{ employeeId, id,
  type:'pip', data: <JSON> }`; the doc carries `status, outcomeNotes,
  outcomeDate, goals, …`.

## 2. Where things are going (the Supabase stack)

`staff` already covers most of the roster, but is **missing the HR fields** and
has **no coaching tables**. Current `staff` columns: `id, auth_uid,
display_name, first_name, last_name, username, role, home_store,
authorized_stores, pin_hash, active, created_at`.

### 2a. Extend `staff` with HR fields
```sql
alter table public.staff
  add column if not exists title       text,        -- job title (legacy "Title")
  add column if not exists start_date  date,
  add column if not exists hr_status   text default 'active',  -- active|notice|terminated
  add column if not exists notes       text,
  add column if not exists archived    boolean not null default false;
```
(`active` already exists = account enabled; `archived`/`hr_status` are the HR
display fields, kept distinct, matching the legacy model.)

### 2b. New coaching tables
```sql
create table public.staff_entries (
  id            uuid primary key default gen_random_uuid(),
  staff_id      bigint not null references public.staff(id) on delete cascade,
  entry_date    date,
  incident_date date,
  subject       text,
  category      text,
  entry_type    text default 'observation',
  discussed     boolean default false,
  sections      jsonb default '{}'::jsonb,   -- flexible section fields
  created_at    timestamptz not null default now()
);
create table public.staff_pips (
  id            uuid primary key default gen_random_uuid(),
  staff_id      bigint not null references public.staff(id) on delete cascade,
  status        text,
  start_date    date,
  outcome_date  date,
  doc           jsonb not null default '{}'::jsonb,  -- full PIP document
  created_at    timestamptz not null default now()
);
create index on public.staff_entries(staff_id);
create index on public.staff_pips(staff_id);
```

### 2c. RLS — store-scoped, via a SECURITY DEFINER helper
The visibility check must read **other people's** `staff` rows, but `staff` RLS
is `staff_self_read` (you only see your own row). So the check lives in a
`SECURITY DEFINER` helper (same pattern as `is_admin()`):
```sql
create or replace function public.can_see_staff(target bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from staff me
    where me.auth_uid = auth.uid() and me.active and (
      me.role = 'owner'
      or ( me.role in ('admin','manager')        -- role-tolerant during cutover
           and exists (
             select 1 from staff tgt
             where tgt.id = target
               and tgt.role in ('team_member','employee')
               and ( tgt.home_store = any(me.authorized_stores)
                     or tgt.authorized_stores && me.authorized_stores )
           ) )
    )
  );
$$;
```
Then both coaching tables gate read **and** write on it:
```sql
create policy staff_entries_rw on staff_entries for all
  using (public.can_see_staff(staff_id)) with check (public.can_see_staff(staff_id));
create policy staff_pips_rw on staff_pips for all
  using (public.can_see_staff(staff_id)) with check (public.can_see_staff(staff_id));
```
And `staff` gains an additive supervisor-read policy (so the records page can
read HR fields for the people it's allowed to see), alongside `staff_self_read`:
```sql
create policy staff_supervisor_read on staff for select using (public.can_see_staff(id));
```
The roster *names* are non-secret (already exposed via the public `staff_roster`
view); the sensitive coaching data is what `can_see_staff` protects.

## 3. Data migration (one-time)

The hard part: the legacy coaching data is keyed by the **Apps Script
`employeeId`**, which is **not** the Supabase `staff.id`. Steps:

1. **Reconcile people.** Pull the legacy roster (`listEmployees` / the auth
   service) and match each to a Supabase `staff` row by `username` first, then
   normalized `name`. Produce an `legacy_id → staff_id` map. Flag unmatched.
2. **Backfill HR fields** onto `staff` (title, start_date, hr_status, notes,
   archived) from the matched roster rows.
3. **Import entries.** `getAll` → for each entry, remap `employeeId`→`staff_id`,
   split known columns vs. `sections` jsonb, insert into `staff_entries`.
4. **Import PIPs.** Same remap; store the JSON doc in `staff_pips.doc`, lift
   `status`/dates into columns.
5. **Verify counts** per person against the live tool, then freeze the legacy
   backend (read-only) before cutover.

Done from this environment via the Supabase Management API (service access) +
fetching the Apps Script `getAll` endpoint.

## 4. Page rewrite (`employee-records.html`)

Swap the data layer only; keep the UI:
- `CPRGate.listEmployees()` → `sb.from('staff').select(…)` (RLS-filtered).
- `apiCall('getAll')` → `sb.from('staff_entries')` + `sb.from('staff_pips')`.
- `saveEmployee` → `sb.from('staff').update(…)` (or the `cpr-auth`
  `update_staff` action for fields it owns).
- `saveEntry/deleteEntry/savePIP` → `sb.from('staff_entries'|'staff_pips')`
  insert/update/delete.
- **Auth gate:** replace `admin-gate.js` (`CPRGate`) with the Supabase login
  used by `settings.html`/`cash-admin.html` (PIN → `cpr-auth` session), so the
  page runs entirely on the new system. Keep the local cache fallback.

## 5. Retire `staff-management.html`

Its roster CRUD is already replaced by **Settings → Team Members** (Supabase)
+ the new **Roles & Permissions** tab. After the rewrite:
1. Move any roster field `staff-management` had that Settings lacks (e.g. **alt
   stores** already exist as `authorized_stores`; **title/HR fields** added in
   §2a — surface them in the Team Members modal or in employee-records).
2. Remove `staff-management.html` from `nav.js` `PRIVILEGED` and the
   `index.html` tile.
3. Leave the file (and the Apps Script roster) in place, unlinked, for one
   release as a rollback, then delete.

## 6. Suggested phasing (each independently shippable)

0. **Schema** — §2a + §2b + §2c (additive; no UI yet). *Low risk.*
1. **Backfill + reconcile** — §3 steps 1–2 (HR fields onto `staff`). Surface
   title/start_date/status/notes/archived in the **Team Members** modal.
2. **Coaching import** — §3 steps 3–4 into the new tables (still read by the old
   page? no — gated behind the rewrite).
3. **Rewrite `employee-records.html`** to Supabase + new auth (§4).
4. **Retire `staff-management.html`** (§5).
5. **Decommission** the Apps Script Employee Records backend + CPR Auth roster.

## 7. Dependencies & resolved questions

- **staff.role hard cutover** — RLS is written role-tolerant, so the schema
  doesn't block on it; but the cutover should still ship so the data is clean.
- ~~Account vs. roster identity~~ → **Everyone gets a `staff` row.** PIN-only
  login means all active staff are on the roster; terminated staff are archived
  rows (records persist).
- ~~History fidelity~~ → **Migrate all** entries/PIPs, including terminated staff.
- ~~Who can see records~~ → **Owner: everyone. Admin: only Team Members at the
  store(s) in the admin's `authorized_stores`.** Encoded in `can_see_staff()`.
