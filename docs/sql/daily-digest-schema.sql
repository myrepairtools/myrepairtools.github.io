-- Daily Digest capture: a lossless daily snapshot of RepairQ Looker dashboard
-- 2273's tiles (the owner's morning scorecard). Each tile's rows are stored as
-- jsonb so nothing is lost and the page can model them later. One row per
-- (capture_date, tile_key); the daily cron upserts.
create table if not exists public.digest_raw (
  id           bigint generated always as identity primary key,
  capture_date date not null,
  tile_key     text not null,
  element_id   text,
  rows         jsonb not null default '[]'::jsonb,
  row_count    int not null default 0,
  captured_at  timestamptz not null default now(),
  unique (capture_date, tile_key)
);
create index if not exists digest_raw_date_idx on public.digest_raw (capture_date desc);

alter table public.digest_raw enable row level security;
-- read: any signed-in manager/owner (the scorecard is management data)
drop policy if exists digest_raw_read on public.digest_raw;
create policy digest_raw_read on public.digest_raw for select using (public.is_admin());
-- writes are service-role only (the cron/edge function); no browser inserts
