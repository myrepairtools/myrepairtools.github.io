-- LCD Buyback — per-model recycler prices (GOOD displays only; bad/aftermarket
-- are treated as $0 everywhere). Keyed by the capture model string normalized
-- (trailing " 5G" stripped, whitespace collapsed) so Galaxy "… 5G" variants
-- share one row. Managed on lcd-buyback.html's Prices tab (managers); values
-- are manager-only by RLS — techs never see dollars.

create table if not exists lcd_prices (
  id bigint generated always as identity primary key,
  model text not null unique,          -- normalized capture model, e.g. "Samsung Galaxy S22 Ultra"
  value numeric not null default 0,    -- what the recycler pays for a GOOD pull
  updated_by bigint references staff(id),
  updated_at timestamptz not null default now()
);

alter table lcd_prices enable row level security;
drop policy if exists lcd_prices_read  on lcd_prices;
drop policy if exists lcd_prices_write on lcd_prices;
create policy lcd_prices_read  on lcd_prices for select to authenticated using (is_admin());
create policy lcd_prices_write on lcd_prices for all    to authenticated using (is_admin()) with check (is_admin());
