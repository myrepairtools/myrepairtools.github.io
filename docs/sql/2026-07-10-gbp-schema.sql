-- ============================================================================
-- Google Business Profile (Phase 1: Measure) — CPR Oregon
-- Data layer for google-traffic.html + the Google Reviews dashboard widget.
-- Filled nightly by the gbp-sync edge function (never by the browser):
--   gbp_locations         store ↔ Google location mapping + lifetime rating
--   gbp_metrics_daily     one row per store/day/metric (Google's enum names)
--   gbp_keywords_monthly  the search queries each profile appeared for
--   gbp_reviews           every review, upserted by Google's review id
--   gbp_profile_snapshots categories/hours/services snapshots (drift detection)
--   gbp_audit             every outbound write to Google (Phase 2+)
-- Reads: any signed-in staff (the page itself is manager-gated).
-- Writes: service role only — no authenticated write policies on purpose.
-- See docs/GBP_DESIGN_HANDOFF.md for the full project plan.
-- ============================================================================

-- ---- location mapping ------------------------------------------------------
create table if not exists gbp_locations (
  store              text primary key,          -- canonical CPRLocations name
  google_account     text,                      -- "accounts/123..."
  google_location_id text,                      -- "locations/456..."
  place_id           text,
  new_review_uri     text,                      -- Google's direct write-a-review link
  maps_uri           text,
  title              text,                      -- the listing title on Google
  rating             numeric,                   -- lifetime average (from reviews pull)
  review_count       integer,
  connected_at       timestamptz,
  last_sync_at       timestamptz,
  last_error         text
);

-- ---- daily performance metrics ----------------------------------------------
-- metric holds Google's DailyMetric enum verbatim:
--   BUSINESS_IMPRESSIONS_DESKTOP_MAPS / _DESKTOP_SEARCH / _MOBILE_MAPS / _MOBILE_SEARCH
--   CALL_CLICKS · WEBSITE_CLICKS · BUSINESS_DIRECTION_REQUESTS
-- Google's numbers lag ~3–5 days; the nightly pull re-writes a trailing window.
create table if not exists gbp_metrics_daily (
  id     bigint generated always as identity primary key,
  store  text    not null,
  date   date    not null,
  metric text    not null,
  value  bigint  not null default 0,
  unique (store, date, metric)
);
create index if not exists gbp_metrics_daily_store_date on gbp_metrics_daily (store, date);

-- ---- monthly search keywords -------------------------------------------------
-- impressions: Google reports exact counts >=15; below that it returns a
-- threshold ("<15") — stored with is_threshold=true, impressions=15.
-- is_branded: keyword contains "cpr" as a word (brand vs discovery split).
create table if not exists gbp_keywords_monthly (
  id           bigint generated always as identity primary key,
  store        text    not null,
  month        text    not null,               -- 'YYYY-MM'
  keyword      text    not null,
  impressions  bigint  not null default 0,
  is_threshold boolean not null default false,
  is_branded   boolean not null default false,
  unique (store, month, keyword)
);
create index if not exists gbp_keywords_monthly_store_month on gbp_keywords_monthly (store, month);

-- ---- reviews -------------------------------------------------------------------
create table if not exists gbp_reviews (
  id             text primary key,             -- Google review resource name
  store          text not null,
  stars          integer,
  comment        text,
  reviewer_name  text,
  reviewer_photo text,
  created_at     timestamptz,
  updated_at     timestamptz,
  reply_text     text,
  replied_at     timestamptz,
  deleted_at     timestamptz,                  -- set when the review vanishes from Google
  synced_at      timestamptz,
  raw            jsonb
);
create index if not exists gbp_reviews_store_created on gbp_reviews (store, created_at desc);
create index if not exists gbp_reviews_unanswered on gbp_reviews (store) where reply_text is null and deleted_at is null;

-- ---- profile snapshots (only written when something changed) -------------------
create table if not exists gbp_profile_snapshots (
  id         bigint generated always as identity primary key,
  store      text not null,
  taken_at   timestamptz not null default now(),
  profile    jsonb not null                     -- {title, categories, regularHours, specialHours, serviceItems}
);
create index if not exists gbp_profile_snapshots_store on gbp_profile_snapshots (store, taken_at desc);

-- ---- audit log for outbound writes (review replies etc. — Phase 2+) ------------
create table if not exists gbp_audit (
  id      bigint generated always as identity primary key,
  actor   text,
  action  text not null,
  store   text,
  payload jsonb,
  at      timestamptz not null default now()
);

-- ---- monthly rollup views (what the page actually reads) -----------------------
create or replace view gbp_metrics_monthly with (security_invoker = true) as
  select store, to_char(date, 'YYYY-MM') as month, metric, sum(value)::bigint as total
  from gbp_metrics_daily
  group by 1, 2, 3;

create or replace view gbp_reviews_monthly with (security_invoker = true) as
  select store,
         to_char(created_at at time zone 'America/Los_Angeles', 'YYYY-MM') as month,
         count(*)::int                        as reviews,
         count(reply_text)::int               as replied,
         round(avg(stars)::numeric, 2)        as avg_stars
  from gbp_reviews
  where deleted_at is null
  group by 1, 2;

-- ---- RLS ------------------------------------------------------------------------
alter table gbp_locations         enable row level security;
alter table gbp_metrics_daily     enable row level security;
alter table gbp_keywords_monthly  enable row level security;
alter table gbp_reviews           enable row level security;
alter table gbp_profile_snapshots enable row level security;
alter table gbp_audit             enable row level security;

drop policy if exists gbp_locations_read on gbp_locations;
create policy gbp_locations_read on gbp_locations for select to authenticated using (true);
drop policy if exists gbp_metrics_read on gbp_metrics_daily;
create policy gbp_metrics_read on gbp_metrics_daily for select to authenticated using (true);
drop policy if exists gbp_keywords_read on gbp_keywords_monthly;
create policy gbp_keywords_read on gbp_keywords_monthly for select to authenticated using (true);
drop policy if exists gbp_reviews_read on gbp_reviews;
create policy gbp_reviews_read on gbp_reviews for select to authenticated using (true);
drop policy if exists gbp_snapshots_read on gbp_profile_snapshots;
create policy gbp_snapshots_read on gbp_profile_snapshots for select to authenticated using (is_admin());
drop policy if exists gbp_audit_read on gbp_audit;
create policy gbp_audit_read on gbp_audit for select to authenticated using (is_admin());
-- (no authenticated write policies — the gbp-sync edge function writes via service role)

-- ============================================================================
-- CRON — run AFTER the gbp-sync function is deployed and its secrets are set.
-- Replace YOUR_GBP_SYNC_SECRET with the GBP_SYNC_SECRET function secret.
-- ============================================================================
-- select cron.schedule('gbp-sync-nightly', '5 11 * * *', $$
--   select net.http_post(
--     url  := 'https://xuvsehrevxackuhmbmry.supabase.co/functions/v1/gbp-sync?action=pull&days=10&secret=YOUR_GBP_SYNC_SECRET',
--     body := '{}'::jsonb);
-- $$);
-- select cron.schedule('gbp-keywords-monthly', '20 11 3 * *', $$
--   select net.http_post(
--     url  := 'https://xuvsehrevxackuhmbmry.supabase.co/functions/v1/gbp-sync?action=keywords&months=3&secret=YOUR_GBP_SYNC_SECRET',
--     body := '{}'::jsonb);
-- $$);
