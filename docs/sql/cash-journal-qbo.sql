-- New workbook months (Eugene Apr-Jun 2026). Salem's Apr-Jun rows in the
-- workbook are contaminated (Eugene's deposits copied over, no ending cash) — skipped.
insert into public.cash_journal (store, month, starting_cash, ending_cash, cash_deposited, note, updated_by) values
('CPR Eugene','2026-04',1405,10243, 8980,null,'workbook import'),
('CPR Eugene','2026-05',1263, 7910, 6405,null,'workbook import'),
('CPR Eugene','2026-06',1505, 8711, 7350,null,'workbook import')
on conflict (store, month) do nothing;

-- ── QBO journal-entry push ────────────────────────────────────────────────
-- Posted-JE receipt lives on the row itself (idempotency + UI state)
alter table public.cash_journal
  add column if not exists qbo_je_id      text,
  add column if not exists qbo_doc_number text,
  add column if not exists qbo_posted_at  timestamptz,
  add column if not exists qbo_posted_by  text;

-- Store → QBO account mapping (edited in Settings → Integrations → QuickBooks Online)
create table if not exists public.qbo_store_map (
  store                text primary key,          -- canonical CPRLocations name
  cash_account_id      text,                      -- QBO "Cash on Hand - <store>" account
  cash_account_name    text,
  revenue_account_id   text,                      -- QBO income account credited by the JE
  revenue_account_name text,
  updated_by           text,
  updated_at           timestamptz not null default now()
);
alter table public.qbo_store_map enable row level security;
drop policy if exists qbo_store_map_rw on public.qbo_store_map;
create policy qbo_store_map_rw on public.qbo_store_map for all using (is_owner()) with check (is_owner());

-- Audit log: every JE the function posts (service-role writes; owner reads)
create table if not exists public.qbo_post_log (
  id          uuid primary key default gen_random_uuid(),
  store       text not null,
  month       text not null,
  je_id       text,
  doc_number  text,
  amount      numeric(12,2),
  payload     jsonb,
  posted_by   text,
  posted_at   timestamptz not null default now()
);
alter table public.qbo_post_log enable row level security;
drop policy if exists qbo_post_log_read on public.qbo_post_log;
create policy qbo_post_log_read on public.qbo_post_log for select using (is_owner());

-- Class support: QBO P&L is class-segmented per store — the JE lines carry ClassRef
alter table public.qbo_store_map
  add column if not exists class_id   text,
  add column if not exists class_name text;
