-- Tech Damage Tracker schema (applied 2026-06-24)
-- damage_reports + master lists, all-staff read/log, admin manages lists.

create table if not exists public.damage_manufacturers (
  id bigint generated always as identity primary key,
  name text not null unique,
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists public.damage_parts (
  id bigint generated always as identity primary key,
  name text not null unique,
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists public.damage_reports (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  report_date date not null,
  tech_id bigint references public.staff(id) on delete set null,
  store text references public.stores(store),
  manufacturer text,
  part text,
  device text,
  cost_cents integer not null default 0,
  ticket text,
  how text
);
create index if not exists damage_reports_date_idx on public.damage_reports(report_date);
create index if not exists damage_reports_tech_idx on public.damage_reports(tech_id);
create index if not exists damage_reports_store_idx on public.damage_reports(store);

alter table public.damage_reports enable row level security;
alter table public.damage_manufacturers enable row level security;
alter table public.damage_parts enable row level security;

drop policy if exists damage_reports_read on public.damage_reports;
drop policy if exists damage_reports_insert on public.damage_reports;
drop policy if exists damage_reports_admin_upd on public.damage_reports;
drop policy if exists damage_reports_admin_del on public.damage_reports;
create policy damage_reports_read   on public.damage_reports for select to authenticated using (true);
create policy damage_reports_insert on public.damage_reports for insert to authenticated with check (true);
create policy damage_reports_admin_upd on public.damage_reports for update to authenticated using (is_admin()) with check (is_admin());
create policy damage_reports_admin_del on public.damage_reports for delete to authenticated using (is_admin());

drop policy if exists damage_mfr_read on public.damage_manufacturers;
drop policy if exists damage_mfr_write on public.damage_manufacturers;
create policy damage_mfr_read  on public.damage_manufacturers for select to authenticated using (true);
create policy damage_mfr_write on public.damage_manufacturers for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists damage_parts_read on public.damage_parts;
drop policy if exists damage_parts_write on public.damage_parts;
create policy damage_parts_read  on public.damage_parts for select to authenticated using (true);
create policy damage_parts_write on public.damage_parts for all to authenticated using (is_admin()) with check (is_admin());

alter table public.damage_reports add column if not exists tech_name text;
