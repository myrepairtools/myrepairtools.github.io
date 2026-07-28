-- Inventory Counts — daily physical-count entries.
-- One entry per store per consumption day, auto-created the NEXT morning from
-- (a) the prior day's consumption (consumption_log) and (b) parts received /
-- POs reconciled in RepairQ the prior day (the special-order catch). Many SKUs
-- consolidate into ONE entry. Assigned to whoever is on shift (schedule
-- resolution, like the checklist). A "Send to RepairQ" action assigns the
-- consolidated SKUs as a RepairQ inventory count; the entry can be marked
-- complete here OR (optionally, configurable) from the checklist.
create table if not exists inventory_counts (
  id bigserial primary key,
  store text not null,
  consumption_date date not null,          -- the day the parts moved (the day PRIOR)
  assigned_date date not null,             -- the day the entry was created / is to be counted
  assigned_staff_id bigint references staff(id),  -- resolved from shift; null if none on shift
  assigned_name text,                      -- snapshot for display
  status text not null default 'pending',  -- pending | sent | completed
  skus jsonb not null default '[]'::jsonb, -- consolidated [{sku, name, sources:[consumed|received]}]
  sku_count int not null default 0,
  sent_at timestamptz,                     -- when Send to RepairQ ran
  sent_by text,
  rq_assigned int,                         -- how many catalog items RepairQ accepted
  completed_at timestamptz,
  completed_by text,
  completed_via text,                      -- 'page' | 'checklist'
  created_at timestamptz not null default now(),
  unique (store, consumption_date)
);
alter table inventory_counts enable row level security;
drop policy if exists ic_read on inventory_counts;
create policy ic_read on inventory_counts for select to authenticated using (true);
-- writes: an admin of the store, OR the person it's assigned to (so the counter
-- can mark their own count complete). Service role (the daily cron) bypasses RLS.
drop policy if exists ic_write on inventory_counts;
create policy ic_write on inventory_counts for update to authenticated
  using (is_admin(store) or assigned_staff_id = (select id from staff where auth_uid = auth.uid()))
  with check (is_admin(store) or assigned_staff_id = (select id from staff where auth_uid = auth.uid()));

-- Config: how (and whether) the checklist mirrors these counts. app_settings
-- key 'inventory_counts.checklist' → { enabled, template_id } so completing a
-- linked checklist task marks the count done and vice-versa — a soft link the
-- owner turns on, never hard-wired.
insert into app_settings (key, value)
  values ('inventory_counts.checklist', '{"enabled": false}'::jsonb)
  on conflict (key) do nothing;
select 'created';
