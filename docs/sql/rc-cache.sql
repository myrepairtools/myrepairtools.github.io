-- Short-TTL cache for RingCentral read results, shared across edge isolates.
-- See the comment in the messaging function. Applied 2026-08-21 as migration
-- rc_cache_for_hot_reads.
create table if not exists public.rc_cache (
  cache_key text primary key,
  payload   jsonb       not null,
  exp       timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists rc_cache_exp_idx on public.rc_cache (exp);
alter table public.rc_cache enable row level security;
-- No policies: RLS on with zero policies denies every browser role. The
-- messaging function reaches it with the service role, which bypasses RLS.
revoke all on public.rc_cache from anon, authenticated;
