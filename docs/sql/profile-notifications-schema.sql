-- My Profile + notification preferences + web push (notifications phases 2-3).
--
-- staff_profiles: SELF-editable employee info — deliberately separate from the
-- sensitive staff table (role/wage/pin_hash stay out of employee reach). Doubles
-- as the employee-onboarding surface: `onboarding` tracks the setup checklist.
create table if not exists public.staff_profiles (
  staff_id       bigint primary key,
  phone          text,                             -- E.164; feeds the text channel
  personal_email text,
  emergency      jsonb,                            -- {name, phone, relation}
  address        jsonb,                            -- {street, city, state, zip} (onboarding)
  shirt_size     text,
  photo_path     text,                             -- avatars bucket (later)
  onboarding     jsonb not null default '{}'::jsonb, -- {contact,emergency,notifications,app,pin: true}
  updated_at     timestamptz not null default now()
);
alter table public.staff_profiles enable row level security;
drop policy if exists sp_self on public.staff_profiles;
create policy sp_self on public.staff_profiles for all to authenticated
  using (staff_id = (select id from staff where auth_uid = auth.uid()))
  with check (staff_id = (select id from staff where auth_uid = auth.uid()));
drop policy if exists sp_admin_read on public.staff_profiles;
create policy sp_admin_read on public.staff_profiles for select to authenticated
  using (is_admin());

-- alert_prefs: per-person delivery choices. prefs = {kind:{push,sms,email}}.
-- Kinds: comms | task | schedule | kb | goal | birthday | anniversary.
-- comms push is LOCKED ON by policy (enforced in the alerts sender + greyed in UI).
-- Missing row / missing kind = defaults (push on, sms off, email off).
create table if not exists public.alert_prefs (
  staff_id   bigint primary key,
  prefs      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.alert_prefs enable row level security;
drop policy if exists ap_self on public.alert_prefs;
create policy ap_self on public.alert_prefs for all to authenticated
  using (staff_id = (select id from staff where auth_uid = auth.uid()))
  with check (staff_id = (select id from staff where auth_uid = auth.uid()));

-- push_subscriptions: one row per installed device. Client inserts/refreshes its
-- own; the alerts sender (service role) reads them and prunes dead endpoints.
create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  staff_id   bigint not null,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  ua         text,
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);
create index if not exists push_subs_staff on public.push_subscriptions (staff_id);
alter table public.push_subscriptions enable row level security;
drop policy if exists ps_self on public.push_subscriptions;
create policy ps_self on public.push_subscriptions for all to authenticated
  using (staff_id = (select id from staff where auth_uid = auth.uid()))
  with check (staff_id = (select id from staff where auth_uid = auth.uid()));
