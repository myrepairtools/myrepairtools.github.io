-- Cash Journal: monthly cash-on-hand / store-revenue / deposit reconciliation
-- (replaces the owner's "Cash on Hand Journal Entry Calculator" spreadsheet)

-- Owner-only helper (is_admin includes managers — too broad for bookkeeping)
create or replace function public.is_owner()
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from staff s
    where s.auth_uid = auth.uid() and s.active and s.role = 'owner'
  );
$$;

create table if not exists public.cash_journal (
  id             uuid primary key default gen_random_uuid(),
  store          text not null,                      -- canonical CPRLocations name
  month          text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),  -- 'YYYY-MM'
  starting_cash  numeric(12,2),                      -- carried from prior month's ending_on_hand (override allowed)
  ending_cash    numeric(12,2),                      -- entered: month-end cumulative cash (RepairQ)
  cash_deposited numeric(12,2),                      -- entered: total banked that month
  store_revenue  numeric(12,2) generated always as (ending_cash - starting_cash) stored,
  ending_on_hand numeric(12,2) generated always as (ending_cash - cash_deposited) stored,
  note           text,
  updated_by     text,
  updated_at     timestamptz not null default now(),
  unique (store, month)
);

alter table public.cash_journal enable row level security;

drop policy if exists cash_journal_read  on public.cash_journal;
drop policy if exists cash_journal_write on public.cash_journal;
create policy cash_journal_read  on public.cash_journal for select using (is_owner());
create policy cash_journal_write on public.cash_journal for all    using (is_owner()) with check (is_owner());

insert into public.permissions (key, label, category, description, sort, page, is_access)
values ('cash.journal', 'Access Cash Journal', 'Cash', 'Monthly cash-on-hand & QBO journal entry calculator', 25, 'Cash Journal', true)
on conflict (key) do nothing;

-- ── Seed: full history from the workbook (whole dollars) ──────────────────
insert into public.cash_journal (store, month, starting_cash, ending_cash, cash_deposited, note, updated_by) values
-- Eugene 2025
('CPR Eugene','2025-01',1135,11106,10106,null,'workbook import'),
('CPR Eugene','2025-02',1000, 6730, 5822,null,'workbook import'),
('CPR Eugene','2025-03', 908,13132,12100,null,'workbook import'),
('CPR Eugene','2025-04',1032, 9551, 8330,null,'workbook import'),
('CPR Eugene','2025-05',1221,11034,10260,null,'workbook import'),
('CPR Eugene','2025-06', 774,13685,12990,null,'workbook import'),
('CPR Eugene','2025-07', 695,12642,11840,null,'workbook import'),
('CPR Eugene','2025-08', 802,12510,11770,null,'workbook import'),
('CPR Eugene','2025-09', 740, 8755, 7920,null,'workbook import'),
('CPR Eugene','2025-10', 835, 9992, 8840,null,'workbook import'),
('CPR Eugene','2025-11',1152,10964,10270,null,'workbook import'),
('CPR Eugene','2025-12', 694,10265, 9160,null,'workbook import'),
-- Salem 2025
('CPR Salem Northeast','2025-01', 816, 9347, 8470,null,'workbook import'),
('CPR Salem Northeast','2025-02', 877, 9987, 9200,null,'workbook import'),
('CPR Salem Northeast','2025-03', 787,12505,11480,null,'workbook import'),
('CPR Salem Northeast','2025-04', 875,11732,10740,'Starting cash adjusted (Mar ended on hand $1,025)','workbook import'),
('CPR Salem Northeast','2025-05', 992,11853,10930,null,'workbook import'),
('CPR Salem Northeast','2025-06', 923,14089,13030,null,'workbook import'),
('CPR Salem Northeast','2025-07',1059,14869,14205,null,'workbook import'),
('CPR Salem Northeast','2025-08', 664,16185,15290,null,'workbook import'),
('CPR Salem Northeast','2025-09', 895,14014,13180,null,'workbook import'),
('CPR Salem Northeast','2025-10', 834,12622,11760,null,'workbook import'),
('CPR Salem Northeast','2025-11', 862,13481,12530,null,'workbook import'),
('CPR Salem Northeast','2025-12', 951,11952,11200,null,'workbook import'),
-- Eugene 2026
('CPR Eugene','2026-01',1105, 8060, 6840,null,'workbook import'),
('CPR Eugene','2026-02',1220, 7274, 6040,null,'workbook import'),
('CPR Eugene','2026-03',1234, 6305, 4900,null,'workbook import'),
-- Salem 2026
('CPR Salem Northeast','2026-01', 752,15367,14330,null,'workbook import'),
('CPR Salem Northeast','2026-02',1037,11132,10400,null,'workbook import'),
('CPR Salem Northeast','2026-03', 732,14812,13740,null,'workbook import')
on conflict (store, month) do nothing;
