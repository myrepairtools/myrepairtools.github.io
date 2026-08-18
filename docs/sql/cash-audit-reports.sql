-- Cash audit reports — reconciliation write-ups attached to a closed audit.
-- Written by a Claude session running the "Claude Audit" bundle (service role /
-- management API, bypasses RLS); the browser only READS them (Cash Admin's
-- audit detail lists them and opens the stored HTML). Same visibility as the
-- audit itself: is_admin(store) via the parent row. Delete is owner-only.

create table if not exists cash_audit_reports (
  id          uuid primary key default gen_random_uuid(),
  audit_id    bigint not null references cash_audits(id) on delete cascade,
  title       text not null,
  summary     text,
  html        text not null,
  created_by  text,
  created_at  timestamptz not null default now()
);

create index if not exists cash_audit_reports_audit_idx on cash_audit_reports(audit_id, created_at desc);

alter table cash_audit_reports enable row level security;

drop policy if exists cash_audit_reports_read on cash_audit_reports;
create policy cash_audit_reports_read on cash_audit_reports
  for select to authenticated
  using (exists (select 1 from cash_audits a where a.id = audit_id and is_admin(a.store)));

drop policy if exists cash_audit_reports_delete on cash_audit_reports;
create policy cash_audit_reports_delete on cash_audit_reports
  for delete to authenticated
  using (is_owner());
