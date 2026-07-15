-- Expense recorder: owner snaps a receipt + records the expense in MRT; the qbo
-- function creates the QBO Purchase (receipt attached) so banking shows a Match.
create table if not exists public.expense_receipts (
  id                   uuid primary key default gen_random_uuid(),
  txn_date             date not null,
  amount               numeric(12,2) not null,
  vendor               text,
  memo                 text,
  payment_account_id   text not null,
  payment_account_name text,
  payment_account_type text,                       -- Bank | Credit Card (drives QBO PaymentType)
  expense_account_id   text not null,
  expense_account_name text,
  class_id             text,                       -- single-class expense
  class_name           text,
  split                jsonb,                      -- [{class_id,class_name,amount}] when split across stores
  receipt_path         text,                       -- storage object path in the private 'receipts' bucket
  qbo_purchase_id      text,
  qbo_attachable_id    text,
  status               text not null default 'pending'
    check (status in ('pending','posting','posted','failed')),  -- pending -> posting (claim) -> posted | failed
  qbo_claimed_at       timestamptz,                -- in-flight claim (double-post guard)
  error                text,
  created_by           text,
  created_at           timestamptz not null default now()
);
alter table public.expense_receipts enable row level security;
drop policy if exists expense_receipts_rw on public.expense_receipts;
create policy expense_receipts_rw on public.expense_receipts for all
  to authenticated using (is_owner()) with check (is_owner());

-- private receipts bucket + owner-only object access
insert into storage.buckets (id, name, public) values ('receipts','receipts',false)
on conflict (id) do nothing;
drop policy if exists receipts_owner_insert on storage.objects;
drop policy if exists receipts_owner_select on storage.objects;
drop policy if exists receipts_owner_delete on storage.objects;
create policy receipts_owner_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and is_owner());
create policy receipts_owner_select on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and is_owner());
create policy receipts_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and is_owner());

insert into public.permissions (key, label, category, description, sort, page, is_access)
values ('expenses.record', 'Access Expenses', 'Cash', 'Record expenses + receipts straight into QBO', 26, 'Expenses', true)
on conflict (key) do nothing;

-- v2 (2026-07-15): vendor link — when the typed vendor matches the QBO vendor
-- list, the Purchase carries EntityRef so vendor reports/matching work.
alter table public.expense_receipts add column if not exists qbo_vendor_id text;
alter table public.expense_receipts add column if not exists qbo_vendor_name text;

-- v2: QBO config knobs. key 'paywith' -> {ids:[account ids]} = which Bank/CC
-- accounts the Expenses page offers as Paid With (empty/missing = all).
-- Edited in Settings -> Integrations -> QuickBooks Online.
create table if not exists public.qbo_config(
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table public.qbo_config enable row level security;
drop policy if exists qbo_config_owner on public.qbo_config;
create policy qbo_config_owner on public.qbo_config
  for all to authenticated using (is_owner()) with check (is_owner());
