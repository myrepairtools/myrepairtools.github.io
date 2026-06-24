-- Feed-health monitor: one call returns each store's last stock sync, last
-- consumption sync, and most recent consumption business date. SECURITY DEFINER
-- so it can read the max timestamps, but scoped to stores the caller can see.
create or replace function feed_health()
returns table(
  store text,
  stock_synced_at timestamptz,
  consumption_synced_at timestamptz,
  consumption_last_date date
)
language sql security definer set search_path = public as $$
  select s.store,
    (select max(st.updated_at) from stock st where st.store = s.store),
    (select max(cl.updated_at) from consumption_log cl where cl.store = s.store),
    (select max(cl.biz_date) from consumption_log cl where cl.store = s.store)
  from stores s
  where can_see_store(s.store)
  order by s.store;
$$;
grant execute on function feed_health() to authenticated;
