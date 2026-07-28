-- Inventory Review (monthly) — data layer.
-- part_perf_monthly: per store/month/sku, RepairQ consumption (from Look 5774
--   with the date filter overridden per month) + cpr.parts buys (ms_orders).
--   Backfilled via repairq-query action 'perf_backfill'; RepairQ holds the full
--   history so run-rate + streaks warm up without waiting months. Buys only
--   exist from ms_orders' start (2026-05); consumption goes back further.
-- inventory_policy: the acknowledge loop's memory — a human tag per store/sku
--   (keep on hand / trim / normal + note + min_on_hand) that survives months,
--   freezes 'keep' parts out of trim suggestions, and feeds the daily report.

create table if not exists part_perf_monthly (
  store text not null,
  month text not null,               -- 'YYYY-MM' (store-local)
  sku text not null,
  name text,
  used_units numeric not null default 0,   -- consumed (Pulled+Sold) that month, from RepairQ
  buy_units numeric not null default 0,     -- ordered on cpr.parts that month, from ms_orders
  buy_orders int not null default 0,
  buy_spend numeric,                        -- sum(qty*our cost) when known
  updated_at timestamptz not null default now(),
  primary key (store, month, sku)
);
alter table part_perf_monthly enable row level security;
drop policy if exists ppm_read on part_perf_monthly;
create policy ppm_read on part_perf_monthly for select to authenticated using (true);

-- Human review tags — the acknowledge loop's memory (industry knowledge as data)
create table if not exists inventory_policy (
  store text not null,
  sku text not null,
  disposition text not null default 'normal',  -- normal | keep | trim
  min_on_hand int,                              -- floor for 'keep on hand'
  note text,
  reviewed_by text,
  reviewed_at timestamptz not null default now(),
  primary key (store, sku)
);
alter table inventory_policy enable row level security;
drop policy if exists ip_read on inventory_policy;
create policy ip_read on inventory_policy for select to authenticated using (true);
drop policy if exists ip_write on inventory_policy;
create policy ip_write on inventory_policy for all to authenticated using (is_admin(store)) with check (is_admin(store));
