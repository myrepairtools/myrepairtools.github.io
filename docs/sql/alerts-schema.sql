-- Alerts: the personal notification feed (distinct from Communications = team
-- bulletin board). Every notification lands here regardless of delivery channel,
-- so someone who never installs the home-screen app still sees everything.
-- Writes come from edge functions / crons (service role) — no client INSERT.
create table if not exists public.alerts (
  id           uuid primary key default gen_random_uuid(),
  staff_id     bigint not null,
  kind         text not null default 'system',   -- task | schedule | kb | goal | system | ...
  title        text not null,
  body         text,
  link         text,                             -- deep link, e.g. checklist.html#daily
  icon         text,                             -- emoji override (else per-kind default)
  created_at   timestamptz not null default now(),
  read_at      timestamptz,
  dismissed_at timestamptz
);
create index if not exists alerts_staff_created on public.alerts (staff_id, created_at desc);

alter table public.alerts enable row level security;
drop policy if exists alerts_select on public.alerts;
create policy alerts_select on public.alerts for select to authenticated
  using (staff_id = (select id from staff where auth_uid = auth.uid()));
drop policy if exists alerts_update on public.alerts;
create policy alerts_update on public.alerts for update to authenticated
  using (staff_id = (select id from staff where auth_uid = auth.uid()));
