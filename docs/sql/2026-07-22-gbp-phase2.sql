-- ============================================================================
-- Google Business Profile — Phase 2 ("Reply"): review engine data layer.
-- Per docs/GBP_DESIGN_HANDOFF.md §16 answers in GBP_Design_Response (July 2026):
--   gbp_reply_queue   auto-reply hold queue (3h hold before an LLM reply posts)
--   gbp_notify_prefs  per-user review-notification settings (gear on the page)
--   gbp_notify_log    dedupe for sent notifications / weekly digests
--   gbp_config        key/value: auto-reply toggles, thank-you rotation state
--   gbp_locations     + phone (used in 1–2★ drafts) + last_photo_at (freshness row)
-- Writes: the gbp-sync edge function (service role). Browser: prefs are self-RLS,
-- config is manager-editable, queue is manager-readable (ops go through the
-- function so every decision lands in gbp_audit).
-- ============================================================================

alter table gbp_locations add column if not exists phone text;
alter table gbp_locations add column if not exists last_photo_at timestamptz;

create table if not exists gbp_config (
  key        text primary key,
  value      jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now()
);
-- keys: auto_reply = {"master":bool,"stores":{"CPR Eugene":bool,…}}  (missing store = ON)
--       thanks_rot = {"CPR Eugene":2,…}  last rating-only template index per store

create table if not exists gbp_reply_queue (
  id         bigint generated always as identity primary key,
  review_id  text not null,                    -- gbp_reviews.id (Google resource name)
  store      text not null,
  source     text not null default 'auto',     -- auto | manual
  draft      text not null,
  status     text not null default 'hold',     -- hold | posted | cancelled | error
  post_after timestamptz,                      -- 3h-hold expiry; posts only 9a–7p store time
  created_at timestamptz not null default now(),
  decided_by text,                             -- who edited / cancelled / posted-now
  posted_at  timestamptz,
  error      text
);
create unique index if not exists gbp_reply_queue_open on gbp_reply_queue (review_id) where status = 'hold';
create index if not exists gbp_reply_queue_due on gbp_reply_queue (status, post_after);

create table if not exists gbp_notify_prefs (
  staff_id   bigint primary key,
  methods    jsonb not null default '{"push":true,"sms":false,"inapp":true}'::jsonb,
  stores     jsonb not null default '[]'::jsonb,   -- [] = all stores
  triggers   jsonb not null default '{"low_star":true,"sla":true,"auto_digest":false}'::jsonb,
  quiet      jsonb,                                -- {"start":"21:00","end":"08:00"} | null
  updated_at timestamptz not null default now()
);

create table if not exists gbp_notify_log (
  key text primary key,                        -- lowstar:<review> | sla12:<review> | sla24:<review> | digest:<iso-week>
  at  timestamptz not null default now()
);

-- ---- RLS -------------------------------------------------------------------
alter table gbp_config       enable row level security;
alter table gbp_reply_queue  enable row level security;
alter table gbp_notify_prefs enable row level security;
alter table gbp_notify_log   enable row level security;

drop policy if exists gbp_config_read on gbp_config;
create policy gbp_config_read on gbp_config for select to authenticated using (true);
drop policy if exists gbp_config_write on gbp_config;
create policy gbp_config_write on gbp_config for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists gbp_reply_queue_read on gbp_reply_queue;
create policy gbp_reply_queue_read on gbp_reply_queue for select to authenticated using (is_admin());
-- queue writes: edge function only (service role) so every decision is audited

drop policy if exists gbp_notify_prefs_self on gbp_notify_prefs;
create policy gbp_notify_prefs_self on gbp_notify_prefs for all to authenticated
  using (staff_id = (select id from staff where auth_uid = auth.uid()))
  with check (staff_id = (select id from staff where auth_uid = auth.uid()));
-- notify_log: no authenticated policies — service role only

-- ============================================================================
-- CRON — run AFTER the updated gbp-sync function is deployed.
-- Replace YOUR_GBP_SYNC_SECRET with the GBP_SYNC_SECRET function secret.
-- The engine pulls new reviews, sends 1–3★ + SLA alerts, and runs the
-- auto-reply queue. 15-minute cadence ≈ "immediate" for review alerts.
-- ============================================================================
-- select cron.schedule('gbp-engine', '*/15 * * * *', $$
--   select net.http_post(
--     url  := 'https://xuvsehrevxackuhmbmry.supabase.co/functions/v1/gbp-sync?action=engine&secret=YOUR_GBP_SYNC_SECRET',
--     body := '{}'::jsonb);
-- $$);
