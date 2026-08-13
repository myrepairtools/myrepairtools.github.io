-- inventory_edit_log — 2026-08-10
--
-- Server-side record of every bulk inventory-status change run from
-- inventory-editor.html (repairq-query's `inventory_status` apply mode). Before
-- this, the per-item receipt was returned to the browser only and built into a
-- download CSV — a page timeout / reset (or a closed tab) lost it, so failures
-- couldn't be reviewed afterward. Now each apply chunk logs here, grouped by a
-- client-generated run_id, so a run's failures survive the browser.
--
-- The page applies in 15-row chunks, so ONE run = several rows sharing run_id.
-- receipt holds that chunk's per-item results ({value, kind, name, status,
-- moved, error/reason, ...}); the summary columns are that chunk's tallies.
-- Writes are service-role only (the edge function); admins/owners read.

create table if not exists public.inventory_edit_log (
  id           bigint generated always as identity primary key,
  run_id       uuid,
  store        text not null,
  from_status  int,
  to_status    int,
  note         text,
  run_by_id    int,
  run_by_name  text,
  total        int,
  done         int,
  failed       int,
  skipped      int,
  moved        int,
  receipt      jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists inventory_edit_log_store_time_idx on public.inventory_edit_log (store, created_at desc);
create index if not exists inventory_edit_log_run_idx on public.inventory_edit_log (run_id);

alter table public.inventory_edit_log enable row level security;

-- read: admins/owners only (same audience as the tool itself). Inserts are
-- service-role from the edge function, so no insert policy is granted.
drop policy if exists inv_edit_log_read on public.inventory_edit_log;
create policy inv_edit_log_read on public.inventory_edit_log
  for select to authenticated using (public.is_admin());

grant select on public.inventory_edit_log to authenticated;
