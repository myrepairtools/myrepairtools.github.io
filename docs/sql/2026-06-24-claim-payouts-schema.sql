-- Claim Payouts (formerly Claim Ledger) — migrated off Apps Script + published
-- Google-Sheet CSVs. Column names match the frontend's canonical field names so
-- reads need no mapping. Owner-only via has_perm('claims.view').
-- Ongoing data flows Looker -> ingest function (feeds: claim_repairs, claim_parts).

create table if not exists claim_repairs (
  ticket_id text primary key,
  payout_date date, location text, provider text, program text,
  device text, description text, ticket_date date,
  total numeric, cogs numeric, royalty numeric,
  gross_profit numeric, claim_invoice text, tkt_status text,
  processed boolean not null default false,
  processed_date date,
  updated_at timestamptz not null default now()
);
create table if not exists claim_parts (
  id bigint generated always as identity primary key,
  ticket_id text, payout_date date, location text, provider text, program text,
  device text, part_name text, ticket_date date,
  consigned text, part_cost numeric
);
create index if not exists claim_parts_ticket on claim_parts(ticket_id);

-- single-row settings (Pcts / Profit First default + per-location overrides)
create table if not exists claim_settings (
  id int primary key default 1,
  default_pcts jsonb not null default '{"profit":20,"owner":10,"tax":10,"opex":60}',
  locations jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  constraint claim_settings_singleton check (id = 1)
);
insert into claim_settings (id) values (1) on conflict (id) do nothing;

do $$ declare t text; begin
  foreach t in array array['claim_repairs','claim_parts','claim_settings'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists claim_rw on %I', t);
    execute format('create policy claim_rw on %I for all to authenticated using (has_perm(''claims.view'')) with check (has_perm(''claims.view''))', t);
  end loop;
end $$;

-- ingest feeds (added to supabase/functions/ingest/index.ts):
--   ?feed=claim_repairs  -> upsert by ticket_id, preserving processed/processed_date
--   ?feed=claim_parts    -> replace the parts of each ticket present
