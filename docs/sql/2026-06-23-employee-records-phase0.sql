-- ============================================================
-- Employee Records migration — PHASE 0: schema (additive, safe)
-- Branch: claude/auth-roles-permissions-design-5yz462
-- Supabase project: xuvsehrevxackuhmbmry
--
-- Adds HR fields to staff + the coaching tables (staff_entries, staff_pips)
-- with store-scoped RLS. Nothing reads these yet, so this is non-breaking.
-- Idempotent. RLS is role-tolerant (accepts admin+manager / team_member+
-- employee) so it works before or after the staff.role hard cutover.
-- ============================================================

-- 1) HR fields on staff (legacy Roster: Title/StartDate/Status/Notes/Archived)
alter table public.staff
  add column if not exists title      text,
  add column if not exists start_date date,
  add column if not exists hr_status  text default 'active',   -- active|notice|terminated
  add column if not exists notes      text,
  add column if not exists archived   boolean not null default false;

-- 2) Coaching tables ------------------------------------------------------
create table if not exists public.staff_entries (
  id            uuid primary key default gen_random_uuid(),
  staff_id      bigint not null references public.staff(id) on delete cascade,
  entry_date    date,
  incident_date date,
  subject       text,
  category      text,
  entry_type    text default 'observation',
  discussed     boolean default false,
  sections      jsonb not null default '{}'::jsonb,
  legacy_id     text,            -- original Apps Script entry id (migration trace)
  created_at    timestamptz not null default now()
);
create table if not exists public.staff_pips (
  id            uuid primary key default gen_random_uuid(),
  staff_id      bigint not null references public.staff(id) on delete cascade,
  status        text,
  start_date    date,
  outcome_date  date,
  doc           jsonb not null default '{}'::jsonb,   -- full PIP document
  legacy_id     text,
  created_at    timestamptz not null default now()
);
create index if not exists staff_entries_staff_idx on public.staff_entries(staff_id);
create index if not exists staff_pips_staff_idx    on public.staff_pips(staff_id);

-- 3) Visibility helper (SECURITY DEFINER — must read other staff rows) -----
create or replace function public.can_see_staff(target bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from staff me
    where me.auth_uid = auth.uid() and me.active and (
      me.role = 'owner'
      or ( me.role in ('admin','manager')
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

-- 4) RLS ------------------------------------------------------------------
alter table public.staff_entries enable row level security;
alter table public.staff_pips    enable row level security;

drop policy if exists staff_entries_rw on public.staff_entries;
drop policy if exists staff_pips_rw    on public.staff_pips;
create policy staff_entries_rw on public.staff_entries for all
  using (public.can_see_staff(staff_id)) with check (public.can_see_staff(staff_id));
create policy staff_pips_rw on public.staff_pips for all
  using (public.can_see_staff(staff_id)) with check (public.can_see_staff(staff_id));

-- additive supervisor-read on staff (alongside the existing staff_self_read)
drop policy if exists staff_supervisor_read on public.staff;
create policy staff_supervisor_read on public.staff for select
  using (public.can_see_staff(id));

grant select, insert, update, delete on public.staff_entries, public.staff_pips to authenticated;
