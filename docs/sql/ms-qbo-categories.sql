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
-- Seeded 2026-08-20 from the 14 SKUs that were blocking 10 card orders, plus
-- one the wider Repair Tools rule surfaced. The judgment calls worth keeping:
--   107082059047  Apple USB-C cable, 10-PACK -> Repair Tools. A single cable
--                 is a resale accessory; the pack stocks the workstations. The
--                 pack is its own SKU, so overriding it cannot mis-hit singles.
--   107082854870  Barcode scanner -> Repair Tools. Store equipment.
--   685642649370  Tempered Glass Gap Bubble Solution -> Repair Consumables.
--                 A liquid that gets used up: the name rules called it an
--                 accessory ("tempered glass") and the catalog type called it
--                 a tool. Neither was right.
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
      -- Any OTHER Repair Tools sub-type. The branches above name about a dozen
      -- by hand and MobileSentrix has many more (Fume Extractors, Pliers and
      -- Cutters, Testing Devices, Programmers and Boards, Others...); an
      -- unlisted one used to drop past the catalog rules into the NAME rules,
      -- where a fume extractor matches nothing and the line went uncategorized.
      when p_type ilike 'Repair Tools - %'                            then 'Repair Tools'
      -- no catalog row: fall back to the item name
      when p_name ~* 'screwdriver|pry tool|tape dispenser|tweezer|spudger|heat gun|separator machine'
                                                                      then 'Repair Tools'
      when p_name ~* 'cleaning|isopropyl|alcohol|polish|glue remover|adhesive remover|wipes|gloves|thermal paste'
                                                                      then 'Repair Consumables'
      when p_name ~* 'tempered glass|screen protector|phone case|wall adapter|car charger|power bank|earbud|headphone|charging cable'
                                                                      then 'COGS - Accessories'
      -- Bare 'adhesive' is a PART (display / back-cover adhesive with a rework
      -- kit). Safe here only because the consumables branch above already
      -- claimed adhesive and glue REMOVER.
      when p_name ~* 'oled|lcd|assembly|digitizer|back glass|back cover|batter|charging port|camera|flex|housing|frame|speaker|microphone|adhesive|button|antenna|sim tray|vibrat|disc drive|cooling fan|heatsink|power supply|logic board|keyboard|hinge|port'
                                                                      then 'COGS - Parts'
    end);
$$;

-- The split for one order. Totals the amount actually charged, which is
-- subtotal + shipping_amount.
--
-- Freight is NOT a residual. MobileSentrix's API returns a grand_total that
-- OMITS shipping: checked against the vendor's own PDF invoices for 16 orders,
-- every invoice reads "Grand Total = Subtotal + Shipping" and its "Paid" line
-- equals that to the cent, while the API's grand_total equals the SUBTOTAL
-- alone on each of the 5 that carried shipping. subtotal + shipping_amount
-- matched the amount paid 16/16; the old residual rule (grand_total - line
-- total) booked $0 freight on 44 of the 45 orders that were really charged.
--
-- shipping_incl_tax is NOT the billed figure. It reads exactly $3.99 above
-- shipping_amount on 16 orders and matched no invoice. Never use it.
--
-- Two different failures, two labels, neither mapped to an account so both
-- refuse to post: UNCLASSIFIED = the rules could not place a line item;
-- UNRECONCILED = the item rows do not add up to the subtotal.
create or replace function public.ms_order_split(p_increment_id text)
returns table (category text, amount numeric)
language sql stable as $$
  with o as (
    select increment_id, subtotal, shipping_amount, items
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
    select round(o.subtotal - coalesce((select sum(amt) from lines), 0), 2) r from o
  )
  select cat, amt from lines where amt <> 0
  union all
  select 'Freight & Delivery', round(shipping_amount, 2) from o where shipping_amount > 0
  union all
  select case when r > 0 then 'UNRECONCILED' else 'Discount' end, r
    from residual where r <> 0
  order by 2 desc;
$$;

revoke execute on function public.ms_categorize(text,text,text) from anon;
revoke execute on function public.ms_order_split(text)          from anon;

-- ---------------------------------------------------------------------------
-- Shipping on an "Add to my existing order": a human has to look.
--
-- An add-to order normally ships free -- it goes in the box the parent order
-- is already paying for. 97 of 102 did. The 5 that were charged are ALL
-- Clackamas, and in every one the same-day combined total was far past the
-- $500 free-shipping threshold, which is the exact situation where
-- MobileSentrix refunded the shipping on 1500447592:
--
--   06-08  1500420924  $5.00      06-29  1500430974  $3.99
--   07-22  1500442336  $5.00      07-30  1500446076  $5.00
--   08-03  1500447592  $5.00   <- confirmed refunded
--
-- This CANNOT be automated. The order payload carries no refund data at all
-- (total_refunded, shipping_refunded, total_paid, total_invoiced are null on
-- every order), so a credited shipping charge is invisible to the sync; it is
-- only knowable from the credit log or the statement. Flag these for review
-- rather than inventing a rule.

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
--   Eugene   3988         Ben's card, on the Spark - Eugene account (acct
--                          309). Aliased PRE-EMPTIVELY -- it has never placed
--                          a MobileSentrix order, so this is only so the first
--                          one does not refuse.
--   Eugene   8590         A EUGENE card (acct 309) that was saved into the
--                          CLACKAMAS MobileSentrix account and used there for
--                          12 orders / $3,057.95 over 5/23 and 6/5-6/11. It
--                          looked missing from QBO only because the charges
--                          sit on the Eugene statement while the goods and the
--                          class are Clackamas.
--
-- That case is the reason pay account and class are resolved SEPARATELY: the
-- account comes from the CARD and the class from the ORDER'S STORE, so one
-- store's card paying for another store's parts books correctly without a
-- special case -- Spark - Eugene funds it, CPR Clackamas carries the cost.
--
-- An alias asserts that two card numbers settle to one statement. Guessing
-- books real spend against the wrong card, so only add one the owner has
-- confirmed.
--
-- The alias map is edited BY HAND -- Settings has no UI for it. Saving the
-- Paid With list there used to write {ids, applepay, cls} over the whole
-- paywith row, which deleted it: adding the Amex on 2026-08-20 wiped every
-- alias and would have made all 12 orders on the 8590 card refuse to post.
-- settings.html now merges onto the loaded row instead of replacing it.
-- Anything else stored under paywith is protected by the same fix.

-- ---------------------------------------------------------------------------
-- Go-forward posting: qbo_config key 'ms_post'.
--
--   { "cutoff": "2026-08-20", "enabled": true }
--
-- The 253 card orders before the cutoff were reconciled and categorised BY
-- HAND, so the tool must never see them. The cutoff is enforced inside the
-- edge function's postMsOrder(), not just in the sweep's query, so no caller
-- -- cron, page, or curl -- can reach back and duplicate an expense someone
-- already booked. Moving the date is a deliberate edit to this row.
--
-- The `ms-qbo-post-hourly` pg_cron (:45, after ms-orders-sync at :40) calls
-- the qbo function's `ms_post_sweep`. It posts every SHIPPED order since the
-- cutoff whose split is clean, and writes the refusal onto ms_orders.qbo_error
-- for every order that is not -- an unfiled SKU, a card with no QBO account, a
-- total that does not reconcile. The queue is retried on every run, so filing
-- the SKU IS the fix; nothing has to be re-queued by hand.
--
-- Only SHIPPED posts. An order still Processing or on Reserve Stock can still
-- gain or lose lines, and a Purchase booked at the wrong amount is worse for
-- the bank feed than one booked a day late.
--
-- Why post at all: a bank RULE was auto-ADDING every MobileSentrix charge to
-- COGS - Parts as one lump (297 of 300 rows in the owner's August export said
-- RULE APPLIED, 299 of 300 said Added, not Matched). A split Purchase gives
-- the incoming charge something to MATCH instead. That rule has to be off, or
-- it re-creates the problem this whole pipeline exists to solve.
