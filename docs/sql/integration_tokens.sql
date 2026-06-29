-- Server-only store for third-party OAuth tokens (QuickBooks Time, etc).
-- RLS on with NO policies => only the service role (edge functions) can touch it;
-- the browser can never read these tokens.
create table if not exists public.integration_tokens (
  provider      text primary key,            -- e.g. 'qbtime'
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  realm_id      text,
  meta          jsonb not null default '{}'::jsonb,
  connected_by  bigint references public.staff(id),
  updated_at    timestamptz not null default now()
);
alter table public.integration_tokens enable row level security;
-- (intentionally no policies: clients get nothing; edge functions use service role)
