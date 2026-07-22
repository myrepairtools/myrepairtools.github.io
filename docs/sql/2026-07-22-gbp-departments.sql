-- ============================================================================
-- GBP: department listings (corporate's "Electronics at CPR" / "Video Game
-- Console Repair at CPR" profiles, 2 per store, manager access granted
-- 2026-07-22). One row per department listing, tied to its parent store.
-- Reviews on department listings flow into gbp_reviews under the PARENT
-- store with `department` = the listing title, so the feed, unanswered
-- counts, alerts, SLA, and the auto-reply engine all cover them with zero
-- extra plumbing — the feed just shows a department tag. The store's
-- lifetime rating/review_count stay main-listing-only. Department metrics /
-- keywords are deliberately not synced (reviews are what we act on).
-- ============================================================================

create table if not exists gbp_departments (
  google_location_id text primary key,        -- "locations/123…"
  store              text not null,           -- parent store (gbp_locations.store)
  google_account     text not null,
  title              text not null,           -- "Electronics at CPR"
  place_id           text,
  new_review_uri     text,
  maps_uri           text,
  connected_at       timestamptz,
  last_sync_at       timestamptz,
  last_error         text
);
create index if not exists gbp_departments_store on gbp_departments (store);

alter table gbp_reviews add column if not exists department text;  -- null = main listing

alter table gbp_departments enable row level security;
drop policy if exists gbp_departments_read on gbp_departments;
create policy gbp_departments_read on gbp_departments for select to authenticated using (true);
-- writes: gbp-sync edge function only (service role)
