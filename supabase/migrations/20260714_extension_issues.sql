-- Extension bug reports. Techs file glitches from a "Report Issue" link in
-- RepairQ (extension → report-issue edge function), which inserts here and texts
-- the owner. Managers review the reports.

create table if not exists public.extension_issues (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  store text, reporter text, ticket_no text, url text,
  ext_version text, user_agent text,
  message text not null,
  status text not null default 'new', notes text
);

alter table public.extension_issues enable row level security;

-- filing a report is open (deterrent-level internal tool; the edge function
-- actually writes with the service role, but keep anon insert as a fallback)
drop policy if exists "extension_issues insert" on public.extension_issues;
create policy "extension_issues insert" on public.extension_issues for insert with check (true);
-- only managers read / triage
drop policy if exists "extension_issues read" on public.extension_issues;
create policy "extension_issues read" on public.extension_issues for select using (is_admin());
drop policy if exists "extension_issues update" on public.extension_issues;
create policy "extension_issues update" on public.extension_issues for all using (is_admin()) with check (is_admin());
