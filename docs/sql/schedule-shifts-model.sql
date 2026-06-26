-- Schedule v3: named, reusable shifts whose hours vary per location and per weekday.
-- Replaces the flat shift_presets(store,label,…) model. shift_presets is LEFT IN PLACE
-- as a safety net until the Page Settings editor (PR3) fully moves off it.
--
--   shifts       = the named, reusable shift (Opener, Mid, Closer…) — global, one color.
--   shift_hours  = per (shift, store) default row (weekday NULL) + optional per-weekday
--                  override rows. Resolution: exact weekday row → location default → not offered.

-- 1. Tables -----------------------------------------------------------------
create table if not exists shifts (
  id     bigserial primary key,
  name   text not null,
  color  text,
  sort   int default 0,
  active boolean not null default true
);
create table if not exists shift_hours (
  id        bigserial primary key,
  shift_id  bigint not null references shifts(id) on delete cascade,
  store     text not null,                 -- must match stores/RepairQ exactly (CPRLocations)
  weekday   int,                           -- NULL = location default; 0..6 (Sun..Sat) = override
  start_min int, end_min int,              -- minutes from midnight; NULL only when closed
  closed    boolean not null default false,-- this (shift,store,weekday) is not offered
  enabled   boolean not null default true, -- on the weekday-NULL row: offered at this store at all
  unique(shift_id, store, weekday)
);

-- 2. RLS --------------------------------------------------------------------
alter table shifts enable row level security;
alter table shift_hours enable row level security;
-- read open (same as shift_presets); the shift NAME/COLOR is global so any admin may
-- write it, but per-location HOURS are gated to admins of that store.
drop policy if exists shifts_read on shifts;
create policy shifts_read on shifts for select using (true);
drop policy if exists shifts_write on shifts;
create policy shifts_write on shifts for all to authenticated using (is_admin()) with check (is_admin());
drop policy if exists shift_hours_read on shift_hours;
create policy shift_hours_read on shift_hours for select using (true);
drop policy if exists shift_hours_write on shift_hours;
create policy shift_hours_write on shift_hours for all to authenticated using (is_admin(store)) with check (is_admin(store));

-- 3. Migrate shift_presets -> shifts (dedup by label) + shift_hours defaults --
-- One shift per distinct label; color = the first preset's color (deterministic);
-- sort = earliest start time so shifts list chronologically.
insert into shifts (name, color, sort, active)
select label,
       (array_agg(color order by sort, store))[1] as color,
       min(start_min) as sort,
       true
from shift_presets
where label not in (select name from shifts)
group by label;

-- A shift_hours default row (weekday NULL) per ORIGINAL preset row — preserves
-- "this shift is offered at these stores, with these default hours."
insert into shift_hours (shift_id, store, weekday, start_min, end_min, closed, enabled)
select s.id, p.store, null, p.start_min, p.end_min, false, true
from shift_presets p
join shifts s on s.name = p.label
where not exists (
  select 1 from shift_hours sh
  where sh.shift_id = s.id and sh.store = p.store and sh.weekday is null
);

-- 4. Remap staff_schedule.shifts {store,label} -> {store,shift_id,label} -------
-- Keeps label as a fallback so rendering still works if a mapping is ever missing.
-- "Off" / storeless entries pass through untouched.
update staff_schedule ss set shifts = (
  select coalesce(jsonb_object_agg(k,
    case
      when (v->>'label') is null or (v->>'label') = 'Off' then v
      when (v->>'store') is null then v
      else v || jsonb_build_object('shift_id', (select id from shifts where name = v->>'label' limit 1))
    end
  ), '{}'::jsonb)
  from jsonb_each(ss.shifts) e(k,v)
)
where shifts is not null and shifts <> '{}'::jsonb;
