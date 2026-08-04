-- ms_ordered_for_range — 2026-08-04
--
-- Range variant of ms_ordered_for_day: per-SKU qty ordered on cpr.parts across a
-- date window (Pacific), for the consumption report's new date-RANGE mode. When a
-- store misses a few days and picks a range, consumption is summed per SKU (so a
-- part used on several days exports ONCE instead of per-day), and this RPC sums the
-- real cpr.parts orders across the same window so the Ordered column stays accurate.
-- SECURITY DEFINER (no order dollars exposed), execute granted to authenticated.

create or replace function public.ms_ordered_for_range(p_store text, p_from date, p_to date)
returns table(sku text, qty numeric)
language sql security definer set search_path to 'public'
as $fn$
  select it->>'sku' as sku,
         sum(coalesce((it->>'qty')::numeric, 0)) as qty
  from ms_orders o
  cross join lateral jsonb_array_elements(o.items) it
  where o.store = p_store
    and (o.ordered_at at time zone 'America/Los_Angeles')::date between p_from and p_to
    and coalesce(o.status, '') not in ('Canceled', 'Closed')
  group by 1
$fn$;

grant execute on function public.ms_ordered_for_range(text, date, date) to authenticated, service_role;
