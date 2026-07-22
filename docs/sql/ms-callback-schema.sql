-- Capture log for the MobileSentrix (Magento) api-consumer OAuth callback.
-- Magento POSTs integration credentials here on activation; the ms-callback
-- edge function stores whatever arrives (service-role insert, owner-only read).
create table if not exists public.ms_callback_log (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  method text,
  path text,
  headers jsonb,
  body text
);
alter table public.ms_callback_log enable row level security;
drop policy if exists "owner read" on public.ms_callback_log;
create policy "owner read" on public.ms_callback_log for select using (is_owner());
