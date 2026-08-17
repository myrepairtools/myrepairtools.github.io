-- Recurring schedule drafts (Schedule Admin → Recurring → Publish)
--
-- staff_schedule is what employees see: My Time, the dashboard widget and the
-- weekly-preview cron all read it live. That made rebuilding the recurring
-- schedule impossible — every click landed on someone's phone mid-rework.
--
-- Edits in the Recurring view now land HERE instead. Nothing employee-facing
-- reads this table, and RLS keeps it to admins of the store, so a half-built
-- schedule is invisible until Publish copies it onto staff_schedule.
-- One row per person, same shape as staff_schedule.

create table if not exists public.schedule_drafts (
  staff_id    bigint primary key references public.staff(id) on delete cascade,
  store       text,
  shifts      jsonb not null default '{}'::jsonb,
  work_days   jsonb not null default '[]'::jsonb,
  updated_by  bigint references public.staff(id),
  updated_at  timestamptz not null default now()
);

alter table public.schedule_drafts enable row level security;

drop policy if exists schedule_drafts_read  on public.schedule_drafts;
drop policy if exists schedule_drafts_ins   on public.schedule_drafts;
drop policy if exists schedule_drafts_write on public.schedule_drafts;
drop policy if exists schedule_drafts_del   on public.schedule_drafts;

create policy schedule_drafts_read  on public.schedule_drafts for select using (is_admin(store));
create policy schedule_drafts_ins   on public.schedule_drafts for insert with check (is_admin(store));
create policy schedule_drafts_write on public.schedule_drafts for update using (is_admin(store)) with check (is_admin(store));
create policy schedule_drafts_del   on public.schedule_drafts for delete using (is_admin(store));

create or replace function public.schedule_drafts_touch() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

drop trigger if exists schedule_drafts_touch on public.schedule_drafts;
create trigger schedule_drafts_touch before update on public.schedule_drafts
  for each row execute function public.schedule_drafts_touch();
