-- ============================================================================
-- Spoken store hours for automated ready-for-pickup calls (twilio-call)
-- ============================================================================
-- Replaces the hand-seeded store_lines.hours_text (no UI, went stale) with a
-- real per-store setting, edited in Settings → Integrations → RingCentral →
-- Automated calls:
--
--   hours_source 'google' (default) → the call computes TODAY's hours — with
--     holiday specialHours overriding the regular week — from the latest
--     gbp_profile_snapshots row for the store. RepairQ hour/holiday edits flow
--     to Google, gbp-sync pulls Google nightly, so nothing is hand-typed and
--     holiday closures are spoken correctly ("closed today, open tomorrow…").
--   hours_source 'manual' → speaks hours_text verbatim after "Our store hours
--     are …". Also the fallback whenever Google data is missing.
--
-- store matches store_lines.store (canonical RepairQ name, e.g. "CPR Eugene").
-- Reads: any signed-in staff (the settings tab itself is owner-gated).
-- Writes: managers via is_admin() — the browser edits this table directly;
-- store_lines stays service-role-only (it holds secret-key references).
-- ============================================================================

create table if not exists call_settings (
  store        text primary key,
  hours_source text not null default 'google'
               check (hours_source in ('google','manual')),
  hours_text   text,                -- spoken verbatim when source = manual
  updated_by   text,
  updated_at   timestamptz not null default now()
);

alter table call_settings enable row level security;

drop policy if exists call_settings_read on call_settings;
create policy call_settings_read on call_settings
  for select to authenticated using (true);

drop policy if exists call_settings_write on call_settings;
create policy call_settings_write on call_settings
  for all to authenticated using (is_admin()) with check (is_admin());

-- Seed one row per active store line, carrying over any legacy manual text so
-- the manual fallback keeps working (source still defaults to google).
insert into call_settings (store, hours_source, hours_text)
select store, 'google', hours_text
from store_lines
where active
on conflict (store) do nothing;
