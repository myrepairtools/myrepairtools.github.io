-- Phone Bill (owner's personal Verizon split tracker — SharePoint list replacement).
-- One row per billing cycle; `lines` holds ONLY the payer's line amounts
-- ({"5274": 75.26, ...} keyed by the last-4 of each line), payer_total is their
-- sum, status tracks whether the buddy has squared up (he pays by Zelle).
-- The page auto-creates the next cycle's row once its service period closes
-- (17th→16th cycles, due the 8th of the following month), cloning the latest
-- line amounts as estimates until the real bill is entered.
-- RLS owner-only — this is personal data, not store data.

create table if not exists phone_bill_months (
  id bigint generated always as identity primary key,
  due_date date not null unique,
  service_start date,
  service_end date,
  bill_total numeric(10,2),
  lines jsonb not null default '{}'::jsonb,
  payer_total numeric(10,2),
  status text not null default 'unpaid' check (status in ('unpaid','paid')),
  paid_at date,
  note text,
  updated_at timestamptz not null default now()
);

create table if not exists phone_bill_config (
  id boolean primary key default true check (id),
  payer_name text not null default 'Kevin',
  payer_phone text,
  zelle_note text,
  line_labels jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table phone_bill_months enable row level security;
alter table phone_bill_config enable row level security;

drop policy if exists phone_bill_months_owner on phone_bill_months;
create policy phone_bill_months_owner on phone_bill_months
  for all to authenticated using (is_owner()) with check (is_owner());

drop policy if exists phone_bill_config_owner on phone_bill_config;
create policy phone_bill_config_owner on phone_bill_config
  for all to authenticated using (is_owner()) with check (is_owner());
