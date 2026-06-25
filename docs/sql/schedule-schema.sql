-- Employee scheduling (Phase 1: weekly recurring editor + work-day pace).
--
-- shift_presets: the selectable shift choices PER LOCATION (managed in Settings later).
--   label e.g. "9:00AM - 7:00PM"; start_min/end_min for sorting; color for the grid.
create table if not exists shift_presets (
  id bigserial primary key,
  store text not null,
  label text not null,
  start_min int, end_min int,
  color text, sort int default 0,
  unique(store, label)
);
alter table shift_presets enable row level security;
create policy shift_presets_read on shift_presets for select using (true);

-- staff_schedule: each employee's RECURRING weekly pattern.
--   work_days  jsonb array of weekday ints [0=Sun..6=Sat] that are worked (drives pace).
--   shifts     jsonb { "<weekday>": "<label>" } — the per-day shift for the editor/display.
--   store      the employee's store (for location-scoped RLS).
alter table staff_schedule add column if not exists shifts jsonb not null default '{}'::jsonb;
alter table staff_schedule add column if not exists store text;

-- RLS: anyone signed in can READ a schedule (pace reads your own; viewer reads your store).
-- Only an admin/owner authorized for the row's store can WRITE it (location-scoped editing).
create policy staff_schedule_read on staff_schedule for select using (true);
create policy staff_schedule_write on staff_schedule for update to authenticated
  using (is_admin(store)) with check (is_admin(store));
create policy staff_schedule_ins on staff_schedule for insert to authenticated
  with check (is_admin(store));

-- Phase 1 = schedule.html weekly editor (admin) + work-day pace on the dashboard.
-- Next: monthly view + drag-and-drop, the My Hub read-only viewer (location-scoped read),
-- then time-off requests/approvals and notifications.
