-- ============================================================================
-- Commission system schema (Phase 1) — CPR Oregon
-- Migrates commission-calculator off Apps Script onto Supabase, and is the
-- shared data layer for the employee Commission Dashboard.
--
-- Sales arrive from three RepairQ→Looker reports (per employee / day / store),
-- each upserting its own columns into commission_sales keyed by
-- (biz_date, store, employee):
--   1. Accessories: Accy Tkt # -> tickets, Accy Count -> accy_units,
--      Accy Total -> accy_net, Accy GP -> accy_gp
--   2. Devices: Device Sales -> device_units, Device Returns -> device_returns,
--      Device Net Sales -> device_net, Device Gross Profit -> device_gp
--   3. Services: per-SKU daily counts -> services jsonb {sku:count}
-- Store names are normalized ("CPR Clackamas OR" -> "CPR Clackamas") on ingest.
-- ============================================================================

-- ---- sales (ingest target) -------------------------------------------------
create table if not exists commission_sales (
  id             bigint generated always as identity primary key,
  biz_date       date    not null,
  store          text    not null,
  employee       text    not null,
  staff_id       bigint  references staff(id) on delete set null,
  -- accessories
  tickets        integer not null default 0,
  accy_units     integer not null default 0,
  accy_net       numeric not null default 0,
  accy_gp        numeric not null default 0,
  -- devices
  device_units   integer not null default 0,
  device_returns integer not null default 0,
  device_net     numeric not null default 0,
  device_gp      numeric not null default 0,
  -- services (SKU-driven counts)
  services       jsonb   not null default '{}'::jsonb,
  -- per-category accessory breakdown {cat:{units,net}} — fed by a future
  -- Looker report (Cases/Screens/Power/Misc/Other); empty until then.
  categories     jsonb   not null default '{}'::jsonb,
  updated_at     timestamptz not null default now(),
  unique (biz_date, store, employee)
);
create index if not exists commission_sales_store_date_idx on commission_sales (store, biz_date);
create index if not exists commission_sales_staff_date_idx on commission_sales (staff_id, biz_date);

-- ---- service payouts (SKU-driven, global) ----------------------------------
create table if not exists commission_rates (
  sku        text primary key,
  label      text,
  amount     numeric not null default 0,
  sort       integer not null default 0,
  updated_at timestamptz not null default now()
);

-- ---- per-store rule overrides (engine fills defaults for missing keys) ------
create table if not exists commission_rules (
  store      text primary key,
  rules      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---- roster (commission-specific fields, tied to staff) --------------------
create table if not exists commission_roster (
  staff_id          bigint primary key references staff(id) on delete cascade,
  accy_goal         numeric not null default 0,
  commission_active boolean not null default true,   -- false = exempt (lead/mgr): services only
  commission_role   text,                            -- Tech / Manager / Bookkeeper (dashboard role)
  override          jsonb,                           -- per-employee rule override
  updated_at        timestamptz not null default now()
);

-- ---- tips (per store + pay period) -----------------------------------------
create table if not exists commission_tips (
  store      text not null,
  period     text not null,
  pool       numeric not null default 0,
  hours      jsonb not null default '{}'::jsonb,      -- {employee:{pp1,pp2}}
  updated_at timestamptz not null default now(),
  primary key (store, period)
);

-- ---- manual "accessories on device tickets" overrides ----------------------
create table if not exists commission_manual (
  period_key       text not null,                    -- "start|end"
  store            text not null,
  employee         text not null,
  acc_device_units numeric,
  updated_at       timestamptz not null default now(),
  primary key (period_key, store, employee)
);

-- seed default service payouts (engine defaults; owner edits in settings)
insert into commission_rates (sku, label, amount, sort) values
  ('cleaning','Device cleaning',10,1),
  ('express','Express fee',10,2),
  ('malware','Virus removal',10,3)
on conflict (sku) do nothing;

-- ---- RLS -------------------------------------------------------------------
alter table commission_sales  enable row level security;
alter table commission_rates  enable row level security;
alter table commission_rules  enable row level security;
alter table commission_roster enable row level security;
alter table commission_tips   enable row level security;
alter table commission_manual enable row level security;

-- sales: your store(s) (owner=all via can_see_store) + always your own rows.
-- Commission $ is computed client-side and never stored, so store-level SALES
-- visibility (for leaderboards) does not leak anyone's pay.
drop policy if exists commission_sales_read on commission_sales;
create policy commission_sales_read on commission_sales for select using (
  can_see_store(store) or staff_id in (select id from staff where auth_uid = auth.uid())
);
drop policy if exists commission_sales_write on commission_sales;
create policy commission_sales_write on commission_sales for all
  using (is_admin(store)) with check (is_admin(store));

-- rates/rules: readable by any signed-in user (How It Works renders from them);
-- admin-write.
drop policy if exists commission_rates_read on commission_rates;
create policy commission_rates_read on commission_rates for select using (auth.uid() is not null);
drop policy if exists commission_rates_write on commission_rates;
create policy commission_rates_write on commission_rates for all using (is_admin()) with check (is_admin());
drop policy if exists commission_rules_read on commission_rules;
create policy commission_rules_read on commission_rules for select using (auth.uid() is not null);
drop policy if exists commission_rules_write on commission_rules;
create policy commission_rules_write on commission_rules for all using (is_admin()) with check (is_admin());

-- roster: staff you can see, or yourself; admin-write.
drop policy if exists commission_roster_read on commission_roster;
create policy commission_roster_read on commission_roster for select using (
  can_see_staff(staff_id) or staff_id in (select id from staff where auth_uid = auth.uid())
);
drop policy if exists commission_roster_write on commission_roster;
create policy commission_roster_write on commission_roster for all using (is_admin()) with check (is_admin());

-- tips / manual: store-scoped.
drop policy if exists commission_tips_read on commission_tips;
create policy commission_tips_read on commission_tips for select using (can_see_store(store));
drop policy if exists commission_tips_write on commission_tips;
create policy commission_tips_write on commission_tips for all using (is_admin(store)) with check (is_admin(store));
drop policy if exists commission_manual_read on commission_manual;
create policy commission_manual_read on commission_manual for select using (can_see_store(store));
drop policy if exists commission_manual_write on commission_manual;
create policy commission_manual_write on commission_manual for all using (is_admin(store)) with check (is_admin(store));
