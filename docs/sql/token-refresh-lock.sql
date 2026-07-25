-- Single-flight OAuth token refresh (qbtime + qbo) — 2026-07-25
--
-- Why: Intuit/TSheets refresh tokens are single-use (TSheets) or rotating (QBO).
-- Two concurrent edge-function requests that both hit the "near expiry" window
-- would both trade in the SAME stored refresh token; whichever grant loses (or
-- whichever DB write lands last) leaves a consumed token in integration_tokens
-- and the connection dies with "That refresh_token is invalid, stop trying."
-- That is exactly what killed QB Time on 2026-07-23 00:00, when the
-- timeoff-sync-15min and qbtime-timesheets-hourly crons fired in the same second.
--
-- Fix: before refreshing, an instance must win this atomic claim. The claim only
-- succeeds if the refresh token it read is still the stored one (nobody rotated
-- in between) and no other claim is in flight (90s stale-claim takeover covers a
-- crashed winner). Losers just keep using the current access token — the
-- proactive refresh window means it is still valid.

alter table public.integration_tokens
  add column if not exists refresh_lock_at timestamptz;

create or replace function public.claim_token_refresh(p_provider text, p_seen_rt text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  update integration_tokens
     set refresh_lock_at = now()
   where provider = p_provider
     and refresh_token = p_seen_rt
     and (refresh_lock_at is null or refresh_lock_at < now() - interval '90 seconds');
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- server-side only (edge functions use the service role); never callable from the browser
revoke execute on function public.claim_token_refresh(text, text) from public, anon, authenticated;
