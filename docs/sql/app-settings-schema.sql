-- Global key-value app settings (owner-managed toggles). First key:
-- schedule.store_scoping = whether My Time / coverage separate staff by store.
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default 'null'::jsonb,
  updated_by bigint,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
drop policy if exists app_settings_read on public.app_settings;
create policy app_settings_read on public.app_settings for select to authenticated using (true);
drop policy if exists app_settings_write on public.app_settings;
create policy app_settings_write on public.app_settings for all to authenticated
  using (is_owner()) with check (is_owner());
insert into public.app_settings(key, value) values ('schedule.store_scoping', 'false'::jsonb)
  on conflict (key) do nothing;
