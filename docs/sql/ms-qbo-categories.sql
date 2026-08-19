-- MobileSentrix order -> QBO Purchase, split by category.
--
-- Everything a MobileSentrix order needs in order to become a properly-coded
-- QBO Purchase lives here rather than in the edge function, for two reasons:
-- the rules are correctable without a redeploy, and the same split can be read
-- from SQL to check a month before anything posts.

-- Which QBO account each category books to. Data, not literals: another shop
-- (or a renamed account) is a row edit, never a code change.
create table if not exists public.ms_category_map (
  category          text primary key,
  qbo_account_id    text,
  qbo_account_name  text,
  sort              int  not null default 100,
  active            boolean not null default true,
  updated_by        text,
  updated_at        timestamptz not null default now()
);
alter table public.ms_category_map enable row level security;
drop policy if exists ms_cat_read  on public.ms_category_map;
drop policy if exists ms_cat_write on public.ms_category_map;
create policy ms_cat_read  on public.ms_category_map for select to authenticated using (is_admin());
create policy ms_cat_write on public.ms_category_map for all    to authenticated using (is_owner()) with check (is_owner());

insert into public.ms_category_map (category, sort) values
  ('COGS - Parts',        10),
  ('COGS - Devices',      20),
  ('COGS - Accessories',  30),
  ('Repair Tools',        40),
  ('Repair Consumables',  50),
  ('Freight & Delivery',  60)
on conflict (category) do nothing;

-- Per-SKU manual override. The rules below are good but never perfect (a
-- "PS5 HDMI Port (Soldering)" reads like a tool and is a part); this is where a
-- human corrects one without touching the rules or waiting on a deploy.
create table if not exists public.ms_sku_category (
  sku         text primary key,
  category    text not null references public.ms_category_map(category),
  note        text,
  updated_by  text,
  updated_at  timestamptz not null default now()
);
alter table public.ms_sku_category enable row level security;
drop policy if exists ms_sku_read  on public.ms_sku_category;
drop policy if exists ms_sku_write on public.ms_sku_category;
create policy ms_sku_read  on public.ms_sku_category for select to authenticated using (is_admin());
create policy ms_sku_write on public.ms_sku_category for all    to authenticated using (is_admin()) with check (is_admin());

-- One line item -> one category.
-- Priority matters: an explicit override wins, then MobileSentrix's own
-- product_type, and only then the item name. product_type OUTRANKS the name
-- because the name lies -- "(Soldering)" inside a part's description would
-- otherwise classify a console port as a repair tool.
create or replace function public.ms_categorize(p_sku text, p_name text, p_type text)
returns text language sql stable as $$
  select coalesce(
    (select category from public.ms_sku_category where sku = p_sku),
    case
      when p_type ilike 'Pre-Owned Device%'
        or p_name ~* '^\s*(Pre-Owned|Refurbished)'                    then 'COGS - Devices'
      when p_type ~* '(Mobile and Tablet|Console|Computer) Parts'     then 'COGS - Parts'
      when p_type ilike 'Accessories%'                                then 'COGS - Accessories'
      when p_type ~* 'Repair Tools - (Screwdriver|Pry Tools|Tape Dispenser|Storage|Soldering|Microscope|Heat|Machine|Station)'
                                                                      then 'Repair Tools'
      when p_type ~* 'Repair Tools - (Cleaning|Adhesive|Glue Removal|Cosmetic|Polish)'
                                                                      then 'Repair Consumables'
      -- no catalog row: fall back to the item name
      when p_name ~* 'screwdriver|pry tool|tape dispenser|tweezer|spudger|heat gun|separator machine'
                                                                      then 'Repair Tools'
      when p_name ~* 'cleaning|isopropyl|alcohol|polish|glue remover|adhesive remover|wipes|gloves|thermal paste'
                                                                      then 'Repair Consumables'
      when p_name ~* 'tempered glass|screen protector|phone case|wall adapter|car charger|power bank|earbud|headphone|charging cable'
                                                                      then 'COGS - Accessories'
      when p_name ~* 'oled|lcd|assembly|digitizer|back glass|back cover|batter|charging port|camera|flex|housing|frame|speaker|microphone|adhesive tape|button|antenna|sim tray|vibrat|disc drive|cooling fan|heatsink|power supply|logic board|keyboard|hinge|port'
                                                                      then 'COGS - Parts'
    end);
$$;

-- The split for one order. Guaranteed to total the amount actually charged:
-- freight is the RESIDUAL (grand_total - line total), never shipping_amount --
-- MobileSentrix stamps a shipping rate on orders where it was waived and never
-- billed, and booking that field overstates the Purchase so the bank feed
-- refuses to match it.
-- A null category means the rules could not place the line; it surfaces as
-- 'UNCLASSIFIED' so the caller refuses to post rather than guessing.
create or replace function public.ms_order_split(p_increment_id text)
returns table (category text, amount numeric)
language sql stable as $$
  with o as (
    select increment_id, grand_total, items
    from public.ms_orders where increment_id = p_increment_id
  ),
  li as (
    select coalesce(public.ms_categorize(it->>'sku', it->>'name', c.product_type), 'UNCLASSIFIED') cat,
           (it->>'row_total')::numeric amt
    from o, jsonb_array_elements(o.items) it
    left join public.ms_catalog c on c.sku = it->>'sku'
  ),
  lines as (select cat, round(sum(amt), 2) amt from li group by cat),
  residual as (
    select round(o.grand_total - coalesce((select sum(amt) from lines), 0), 2) r from o
  )
  select cat, amt from lines where amt <> 0
  union all
  select case when r > 0 then 'Freight & Delivery' else 'Discount' end, r
    from residual where r <> 0
  order by 2 desc;
$$;

revoke execute on function public.ms_categorize(text,text,text) from anon;
revoke execute on function public.ms_order_split(text)          from anon;

-- ---------------------------------------------------------------------------
-- Card -> Paid-With account, and why aliases exist.
--
-- The posting function matches an order's cc_last4 against the QBO account
-- NAME ("Spark - Clackamas (8123)"). That breaks the moment a card is
-- reissued, because the account keeps its old number in the name while
-- MobileSentrix starts charging the new one. qbo_config.paywith.alias carries
-- the extra numbers: { "<accountId>": ["8106", ...] }.
--
-- Known lineage (2026-08-19, from the owner):
--   Eugene   9928 -> 8106  (reissued 8/13; same Spark account, acct 309)
--   Salem    8223 -> 5082  (8223 hit by ~$15k fraud and cancelled mid-July;
--                           5082 is the replacement Smartly, acct 397)
--   Salem    Amex 4769     backup card, 3 orders on 7/15 only. NOT a Smartly
--                          card and has no QBO account -- those orders cannot
--                          post until one exists.
--   Clackamas 8590         12 orders 5/23-6/11, ran alongside 8123 then
--                          stopped. Unidentified -- do NOT alias it onto
--                          Spark - Clackamas without confirming the charges
--                          actually appear on that statement.
--
-- An alias asserts that two card numbers settle to one statement. Guessing
-- books real spend against the wrong card, so only add one the owner has
-- confirmed.
