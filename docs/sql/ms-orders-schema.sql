-- MobileSentrix (cpr.parts) order mirror — filled hourly by the mobilesentrix
-- edge function (?action=sync) from each store's own cpr.parts account
-- (integration_tokens provider 'ms:<store>'). QBO booking stamps land on the
-- same row (Purchase per order, DocNumber MS-<increment_id>).
create table if not exists public.ms_orders (
  entity_id bigint primary key,          -- Magento order entity id (unique across cpr.parts)
  store text not null,                   -- canonical store name (stores.store)
  increment_id text,                     -- customer-facing order number
  status text,
  ordered_at timestamptz,               -- Magento created_at (UTC)
  updated_at timestamptz,               -- Magento updated_at (UTC) — sync watermark
  grand_total numeric,                   -- what the card was charged
  subtotal numeric,
  shipping_amount numeric,
  tax_amount numeric,
  discount_amount numeric,
  payment_method text,
  cc_type text,
  cc_last4 text,
  tracking_number text,
  items jsonb,                           -- [{sku,name,qty,price,row_total}]
  raw jsonb,                             -- full API order object
  synced_at timestamptz not null default now(),
  -- QBO booking stamps (mirrors expense_receipts' double-post safety)
  qbo_purchase_id text,
  qbo_doc_number text,
  qbo_posted_at timestamptz,
  qbo_amount numeric,
  qbo_error text,
  qbo_claimed_at timestamptz
);
create index if not exists ms_orders_store_updated on public.ms_orders (store, updated_at desc);

alter table public.ms_orders enable row level security;
drop policy if exists "admin read" on public.ms_orders;
create policy "admin read" on public.ms_orders for select using (is_admin());
-- writes are service-role only (edge functions)

-- Consumption-report integration: how many of each SKU were ACTUALLY ordered
-- on cpr.parts for a store on a given (Pacific) day. SECURITY DEFINER so any
-- signed-in staff can see ordered quantities without opening the ms_orders
-- table (which carries order dollar totals) beyond admins.
create or replace function public.ms_ordered_for_day(p_store text, p_day date)
returns table(sku text, qty numeric)
language sql
security definer
set search_path = public
as $$
  select it->>'sku' as sku,
         sum(coalesce((it->>'qty')::numeric, 0)) as qty
  from ms_orders o
  cross join lateral jsonb_array_elements(o.items) it
  where o.store = p_store
    and (o.ordered_at at time zone 'America/Los_Angeles')::date = p_day
    and coalesce(o.status, '') not in ('Canceled', 'Closed')
  group by 1
$$;
revoke execute on function public.ms_ordered_for_day(text, date) from public, anon;
grant execute on function public.ms_ordered_for_day(text, date) to authenticated;

-- Live product cache: price + availability for SKUs the consumption report is
-- about to order, fetched on demand from cpr.parts (30-min freshness) by the
-- mobilesentrix function's 'products' action. price = OUR account's cost.
create table if not exists public.ms_products (
  sku text primary key,
  name text,
  price numeric,
  in_stock boolean,
  stock_qty integer,
  saleable boolean,
  order_status text,
  url text,
  image_url text,
  synced_at timestamptz not null default now()
);
alter table public.ms_products enable row level security;
drop policy if exists "staff read" on public.ms_products;
create policy "staff read" on public.ms_products for select to authenticated using (true);

-- Ordered-but-not-yet-shipped per SKU: RepairQ only shows a PO once MS ships
-- it (reserve/delayed orders land 4-5pm), so these units bridge the gap in the
-- consumption report's On Order math. Per-item qty_shipped makes the hand-off
-- exact: as MS ships, this shrinks precisely as RepairQ's on_order grows.
create or replace function public.ms_pending_for_store(p_store text)
returns table(sku text, qty numeric)
language sql
security definer
set search_path = public
as $$
  select it->>'sku' as sku,
         sum(greatest(0,
             coalesce((it->>'qty')::numeric, 0)
           - coalesce((it->>'qty_shipped')::numeric, 0)
           - coalesce((it->>'qty_canceled')::numeric, 0)
           - coalesce((it->>'qty_refunded')::numeric, 0))) as qty
  from ms_orders o
  cross join lateral jsonb_array_elements(o.items) it
  where o.store = p_store
    and o.ordered_at >= now() - interval '30 days'
    and coalesce(o.status, '') not in ('Canceled', 'Closed')
  group by 1
  having sum(greatest(0,
             coalesce((it->>'qty')::numeric, 0)
           - coalesce((it->>'qty_shipped')::numeric, 0)
           - coalesce((it->>'qty_canceled')::numeric, 0)
           - coalesce((it->>'qty_refunded')::numeric, 0))) > 0
$$;
revoke execute on function public.ms_pending_for_store(text) from public, anon;
grant execute on function public.ms_pending_for_store(text) to authenticated;
