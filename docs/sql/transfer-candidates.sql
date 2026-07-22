-- Cross-store transfer suggestions (consumption report daily order):
-- for SKUs a store is about to BUY, surface other stores' surplus so a
-- transfer can beat a purchase. SECURITY DEFINER because store reads are
-- normally scoped by can_see_store() — this exposes only stock counts,
-- effective max, and 30-day usage for the asked SKUs (no dollars).
create or replace function public.transfer_candidates(p_store text, p_skus text[])
returns table(sku text, store text, in_stock numeric, eff_max numeric, used_30d numeric)
language sql
security definer
set search_path = public
as $$
  select s.sku, s.store,
         s.in_stock::numeric,
         coalesce(o.value, s.max_baseline, 0)::numeric as eff_max,
         coalesce(u.units, 0)::numeric as used_30d
  from stock s
  left join max_overrides o on o.store = s.store and o.sku = s.sku
  left join lateral (
    select sum(c.units) as units from consumption_log c
    where c.store = s.store and c.sku = s.sku
      and c.biz_date >= current_date - 30
  ) u on true
  where s.store <> p_store
    and s.sku = any(p_skus)
    and s.in_stock > 0
$$;
revoke execute on function public.transfer_candidates(text, text[]) from public, anon;
grant execute on function public.transfer_candidates(text, text[]) to authenticated;
