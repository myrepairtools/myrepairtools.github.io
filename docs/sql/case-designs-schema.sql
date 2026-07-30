-- Case Studio: customer case designs sent to a store for UV printing.
-- Customer side (case-designer.html) has NO Supabase session — all customer
-- reads/writes go through the `case-designs` edge function (service role),
-- same capability pattern as contracts. Staff side (case-orders.html) uses
-- the shared PIN session: direct RLS reads/updates + signed storage URLs.

create table if not exists case_designs (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,            -- short pickup code (the customer's credential)
  store text not null,                  -- canonical store name (CPRLocations)
  model_id text not null,               -- designer MODELS id, e.g. 'iphone-16-pro-clear'
  model_name text,
  price numeric,
  customer_name text,
  customer_phone text,
  design jsonb not null,                -- designer state (photo pixels stripped; print file is authoritative)
  print_path text,                      -- storage: 300 DPI print PNG (mask-clipped)
  mockup_path text,                     -- storage: preview/share image
  status text not null default 'new',   -- new -> printing -> ready -> picked_up | canceled
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  updated_by text
);

create index if not exists case_designs_store_idx
  on case_designs (store, status, created_at desc);

alter table case_designs enable row level security;

-- Staff (any signed-in PIN session) can see and work the queue.
-- No anon policies on purpose: customers only touch this via the edge function.
drop policy if exists "case_designs staff read" on case_designs;
create policy "case_designs staff read" on case_designs
  for select to authenticated using (true);

drop policy if exists "case_designs staff update" on case_designs;
create policy "case_designs staff update" on case_designs
  for update to authenticated using (true) with check (true);

-- Private bucket for print files + mockup previews.
insert into storage.buckets (id, name, public)
  values ('case-prints', 'case-prints', false)
  on conflict (id) do nothing;

drop policy if exists "case-prints staff read" on storage.objects;
create policy "case-prints staff read" on storage.objects
  for select to authenticated using (bucket_id = 'case-prints');
