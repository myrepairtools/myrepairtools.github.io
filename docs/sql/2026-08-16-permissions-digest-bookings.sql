-- Daily Digest becomes a granted permission instead of a role rank, and the
-- owner's call is that employees may see it: store revenue, GP and the per-rep
-- leaderboard are not secrets from the team.
insert into permissions (key, label, category, sort, page, is_access) values
  ('reports.digest', 'Access Daily Digest', 'Reports', 10, 'daily-digest.html', true)
on conflict (key) do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where p.key = 'reports.digest' and r.key in ('team_member','admin','owner')
on conflict do nothing;

-- Bookings had no gate at all: no in-page role check, and interview_bookings
-- reads as `true`, so any signed-in person could read every candidate's name,
-- phone and email. It is a hiring tool — managers and owners only.
insert into permissions (key, label, category, sort, page, is_access) values
  ('interviews.manage', 'Access Bookings', 'Employees', 40, 'interviews.html', true)
on conflict (key) do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where p.key = 'interviews.manage' and r.key in ('admin','owner')
on conflict do nothing;

-- These two were granted to NO role, and canSee() hides a row whose permission
-- nobody holds — so the Cash Journal nav entry rendered for nobody, the owner
-- included. Both are owner-scoped surfaces.
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where p.key in ('cash.journal','commission.competitions') and r.key = 'owner'
on conflict do nothing;

-- digest_raw was is_admin(), so a permissioned employee would have landed on a
-- page with zero rows. Read opens to any signed-in staff; writes stay
-- service-role only (the sync cron is the only writer).
drop policy if exists digest_raw_read on digest_raw;
create policy digest_raw_read on digest_raw
  for select to authenticated using (true);
