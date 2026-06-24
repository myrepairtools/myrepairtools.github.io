-- Hyla Device Orders — migrated off the Apps Script web app onto Supabase.
-- Four tables mirror the old Google Sheet (Orders, Devices, RMAs, Settings).
-- Gated by has_perm('orders.hyla') so anyone with Hyla access (owner included)
-- can read/write. Roster = active staff names for the Inspector dropdown.

create table if not exists hyla_orders (
  order_id text primary key,
  order_nbr text, tracking text,
  ship_date date, received_date date,
  inspector text,
  status text not null default 'open',
  created_at timestamptz not null default now()
);
create table if not exists hyla_devices (
  device_id text primary key,
  order_id text references hyla_orders(order_id) on delete cascade,
  order_nbr text, imei text,
  manufacturer text, model text, model_nbr text,
  storage text, color text, carrier text, grade text,
  cost numeric, unlock_code text,
  store text, sale_price text, packaging text,
  status text not null default 'pending',
  fail_reason text, fail_comment text,
  updated_at timestamptz not null default now()
);
create table if not exists hyla_rmas (
  rma_id text primary key,
  device_id text references hyla_devices(device_id) on delete cascade,
  order_id text, order_nbr text, imei text,
  model text, storage text, color text, cost numeric,
  reason text, comment text,
  status text not null default 'Needs Submission',
  tracking_nbr text, outcome text,
  credit_amt numeric, repair_cost numeric,
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);
create table if not exists hyla_settings ( key text primary key, value text );

create index if not exists hyla_devices_order on hyla_devices(order_id);
create index if not exists hyla_rmas_device on hyla_rmas(device_id);

do $$ declare t text; begin
  foreach t in array array['hyla_orders','hyla_devices','hyla_rmas','hyla_settings'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists hyla_rw on %I', t);
    execute format('create policy hyla_rw on %I for all to authenticated using (has_perm(''orders.hyla'')) with check (has_perm(''orders.hyla''))', t);
  end loop;
end $$;

create or replace function hyla_roster()
returns setof text language sql security definer set search_path=public as $$
  select display_name from staff where active = true and coalesce(display_name,'') <> '' order by display_name;
$$;
grant execute on function hyla_roster() to authenticated;
