-- Schedule Admin "Notify staff" change detection — 2026-07-25
--
-- The notify modal pre-fills "what changed since the last notify" from
-- schedule_overrides (per-date changes; ovr_date gives the exact week) and
-- staff_schedule (recurring-template edits). Both need a maintained
-- updated_at so edits — not just inserts — move the timestamp.

alter table public.schedule_overrides
  add column if not exists updated_at timestamptz not null default now();
-- backfill so pre-existing rows date from their creation, not this migration
update public.schedule_overrides set updated_at = created_at where updated_at > created_at;

alter table public.staff_schedule alter column updated_at set default now();

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists schedule_overrides_touch on public.schedule_overrides;
create trigger schedule_overrides_touch before update on public.schedule_overrides
  for each row execute function public.touch_updated_at();

drop trigger if exists staff_schedule_touch on public.staff_schedule;
create trigger staff_schedule_touch before update on public.staff_schedule
  for each row execute function public.touch_updated_at();
