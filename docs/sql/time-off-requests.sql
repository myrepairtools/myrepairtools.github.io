-- Employee time-off requests (employee My Schedule + future admin approvals).
-- Read is company-wide (so teammates plan around each other); insert is your own
-- row; update is the requester (cancel) or an admin of the requester's store
-- (approve/deny); delete only your own still-pending request.
create table if not exists time_off_requests (
  id bigserial primary key,
  staff_id bigint not null references staff(id) on delete cascade,
  store text,
  type text not null default 'Vacation',     -- Vacation | Personal | Sick
  start_date date not null,
  end_date date not null,
  status text not null default 'pending',     -- pending | approved | denied
  note text,
  submitted_at timestamptz default now(),
  decided_by bigint references staff(id),
  decided_at timestamptz
);
alter table time_off_requests enable row level security;
drop policy if exists tor_read on time_off_requests;
create policy tor_read on time_off_requests for select using (true);
drop policy if exists tor_ins on time_off_requests;
create policy tor_ins on time_off_requests for insert to authenticated with check (staff_id = (select id from staff where auth_uid = auth.uid()));
drop policy if exists tor_upd on time_off_requests;
create policy tor_upd on time_off_requests for update to authenticated using (is_admin(store) or staff_id = (select id from staff where auth_uid=auth.uid())) with check (is_admin(store) or staff_id = (select id from staff where auth_uid=auth.uid()));
drop policy if exists tor_del on time_off_requests;
create policy tor_del on time_off_requests for delete to authenticated using (staff_id = (select id from staff where auth_uid=auth.uid()) and status='pending');
