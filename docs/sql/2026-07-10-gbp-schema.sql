-- Google Business Profile ("Google Traffic") — Phase 1 "Measure" schema.
--
-- Nightly, the gbp-sync edge function (service role) pulls per-store GBP data:
--   · daily performance metrics (impressions ×4, calls, directions, website clicks)
--   · monthly search keywords (Google publishes these after month end)
--   · the full review list (upsert by Google review id; soft-delete on disappearance)
--   · a profile snapshot (categories/services/hours/attributes) for drift detection
-- Surfaces: google-traffic.html (managers) + the Google Reviews dashboard widget.
-- Design: docs/GBP_DESIGN_HANDOFF.md · Deploy: docs/GBP_SESSION_HANDOFF.md
--
-- Idempotent: safe to re-run. The cron block at the bottom stays COMMENTED — run
-- it manually with the real GBP_SYNC_SECRET substituted (step 5 of the runbook).

-- ---------- per-store connection + sync state ----------
create table if not exists gbp_locations (
  store             text primary key,          -- CPRLocations canonical name
  google_location_id text not null,            -- "locations/1234567890"
  google_account_id  text,                     -- "accounts/1234567890" (v4 review calls need it)
  place_id          text,                      -- for the public write-review link
  title             text,                      -- listing title as Google has it
  connected_at      timestamptz not null default now(),
  last_sync_at      timestamptz,
  last_error        text                       -- null = last sync clean
);

-- ---------- daily performance metrics ----------
-- metric = Google's DailyMetric enum string VERBATIM (BUSINESS_IMPRESSIONS_DESKTOP_MAPS,
-- BUSINESS_IMPRESSIONS_DESKTOP_SEARCH, BUSINESS_IMPRESSIONS_MOBILE_MAPS,
-- BUSINESS_IMPRESSIONS_MOBILE_SEARCH, CALL_CLICKS, WEBSITE_CLICKS,
-- BUSINESS_DIRECTION_REQUESTS). Don't invent friendlier keys; the UI maps labels.
create table if not exists gbp_metrics_daily (
  id     bigint generated always as identity primary key,
  store  text not null,
  date   date not null,
  metric text not null,
  value  bigint not null default 0,
  unique (store, date, metric)
);
create index if not exists gbp_metrics_daily_store_date_idx on gbp_metrics_daily(store, date desc);

-- ---------- monthly search keywords ----------
-- is_threshold: Google returns "<15" for rare terms as a threshold, not a count —
-- the UI renders "<15", never 0. is_branded is OUR derived classification
-- (keyword contains "cpr" / a store name = branded), recomputed at write time.
create table if not exists gbp_keywords_monthly (
  id           bigint generated always as identity primary key,
  store        text not null,
  month        text not null,                  -- 'YYYY-MM'
  keyword      text not null,
  impressions  bigint not null default 0,
  is_threshold boolean not null default false, -- true = Google said "<15"
  is_branded   boolean,                        -- null = unclassified
  unique (store, month, keyword)
);
create index if not exists gbp_keywords_monthly_store_idx on gbp_keywords_monthly(store, month desc);

-- ---------- reviews ----------
-- id = Google's full review resource name (accounts/…/locations/…/reviews/…) —
-- globally unique and stable across edits. Customers can edit or delete reviews:
-- upsert by id; a review missing from a full pull gets deleted_at stamped
-- (soft delete — history is part of the record).
create table if not exists gbp_reviews (
  id            text primary key,
  store         text not null,
  stars         int not null check (stars between 1 and 5),
  comment       text,
  reviewer_name text,
  created_at    timestamptz not null,
  updated_at    timestamptz,
  reply_text    text,
  replied_at    timestamptz,
  deleted_at    timestamptz,                   -- review vanished from Google
  raw           jsonb,
  synced_at     timestamptz not null default now()
);
create index if not exists gbp_reviews_store_idx on gbp_reviews(store, created_at desc);

-- ---------- profile snapshots (drift detection) ----------
create table if not exists gbp_profile_snapshots (
  id         bigint generated always as identity primary key,
  store      text not null,
  taken_at   timestamptz not null default now(),
  categories jsonb,
  services   jsonb,
  hours      jsonb,
  attributes jsonb,
  media_count int,                             -- photo freshness signal
  latest_media_at timestamptz
);
create index if not exists gbp_profile_snapshots_store_idx on gbp_profile_snapshots(store, taken_at desc);

-- ---------- audit (every outbound write to Google — Phase 2+, table ships now) ----------
create table if not exists gbp_audit (
  id      bigint generated always as identity primary key,
  actor   text not null,                       -- staff display name or 'cron'
  action  text not null,                       -- 'reply' | 'send-ask' | 'publish-media' | …
  store   text,
  payload jsonb,
  at      timestamptz not null default now()
);

-- ---------- views ----------
-- Monthly rollup for Compare/Trends (daily rows summed per store+month+metric).
create or replace view gbp_metrics_monthly as
  select store, to_char(date, 'YYYY-MM') as month, metric, sum(value)::bigint as value
  from gbp_metrics_daily group by store, 2, metric;

-- Lifetime per-store review stats for Compare cards + the dashboard widget.
create or replace view gbp_review_stats as
  select store,
         count(*)::int                                        as total,
         round(avg(stars)::numeric, 2)                        as avg_rating,
         count(*) filter (where reply_text is not null)::int  as replied,
         count(*) filter (where reply_text is null)::int      as unanswered,
         max(created_at)                                      as newest_at,
         min(created_at) filter (where reply_text is null)    as oldest_unanswered_at,
         percentile_cont(0.5) within group
           (order by extract(epoch from (replied_at - created_at)))
           filter (where replied_at is not null)              as median_reply_seconds
  from gbp_reviews where deleted_at is null group by store;

-- ---------- RLS ----------
alter table gbp_locations         enable row level security;
alter table gbp_metrics_daily     enable row level security;
alter table gbp_keywords_monthly  enable row level security;
alter table gbp_reviews           enable row level security;
alter table gbp_profile_snapshots enable row level security;
alter table gbp_audit             enable row level security;

-- Reads are deliberately all-staff on the core data (cross-store comparison is
-- the point of the tool, and the dashboard widget shows a snapshot to everyone).
-- Snapshots + audit are manager-only. ALL writes go through the edge function's
-- service role — no insert/update policies for browser roles, ever.
drop policy if exists gbp_locations_read  on gbp_locations;
drop policy if exists gbp_metrics_read    on gbp_metrics_daily;
drop policy if exists gbp_keywords_read   on gbp_keywords_monthly;
drop policy if exists gbp_reviews_read    on gbp_reviews;
drop policy if exists gbp_snapshots_read  on gbp_profile_snapshots;
drop policy if exists gbp_audit_read      on gbp_audit;
create policy gbp_locations_read on gbp_locations         for select to authenticated using (true);
create policy gbp_metrics_read   on gbp_metrics_daily     for select to authenticated using (true);
create policy gbp_keywords_read  on gbp_keywords_monthly  for select to authenticated using (true);
create policy gbp_reviews_read   on gbp_reviews           for select to authenticated using (true);
create policy gbp_snapshots_read on gbp_profile_snapshots for select to authenticated using (is_admin());
create policy gbp_audit_read     on gbp_audit             for select to authenticated using (is_admin());

-- ---------- cron (run MANUALLY at deploy — substitute the real GBP_SYNC_SECRET) ----------
-- Nightly pull at 11:05 UTC (~3–4am Pacific): re-pulls a 10-day metric window to
-- absorb Google's 3–5-day lag, plus review deltas and a profile snapshot.
-- Monthly keywords on the 4th (Google publishes keywords after month end).
--
-- select cron.schedule('gbp-sync-nightly', '5 11 * * *', $$
--   select net.http_get(
--     url := 'https://xuvsehrevxackuhmbmry.supabase.co/functions/v1/gbp-sync?action=pull&secret=GBP_SYNC_SECRET_HERE'
--   );
-- $$);
--
-- select cron.schedule('gbp-sync-keywords-monthly', '15 11 4 * *', $$
--   select net.http_get(
--     url := 'https://xuvsehrevxackuhmbmry.supabase.co/functions/v1/gbp-sync?action=keywords&secret=GBP_SYNC_SECRET_HERE'
--   );
-- $$);
