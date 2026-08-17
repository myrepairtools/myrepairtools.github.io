-- Where a hire's CPR credentials live between corporate answering the ticket
-- and the employee signing in for the first time.
--
-- Corporate sends RepairQ / Outlook / GSX logins back as a support-ticket
-- reply. Before this they had nowhere to go: a text or an email leaves them
-- sitting in a phone and a sent folder forever, and staff_documents is
-- paperwork (admin-only in storage, so it isn't a delivery path either).
--
-- One row per person, readable by exactly two parties — that person, and the
-- managers who can already see them. It is deliberately NOT encrypted: the
-- point is that the employee can read it, and a key the browser can use is
-- not a key. What makes it safe enough is scope and lifetime — these are
-- first-login credentials the employee changes on arrival, and the note is
-- meant to be cleared once they have.

create table if not exists public.staff_credentials (
  staff_id    bigint primary key references public.staff(id) on delete cascade,
  body        text not null default '',
  updated_by  bigint references public.staff(id),
  updated_at  timestamptz not null default now()
);
comment on table public.staff_credentials is
  'First-login credentials handed to a hire (RepairQ/Outlook/GSX). Theirs to read, managers to write, cleared once changed.';

alter table public.staff_credentials enable row level security;

-- the person themselves, or a manager who can already see them
drop policy if exists "creds read" on public.staff_credentials;
create policy "creds read" on public.staff_credentials
  for select to authenticated
  using (
    staff_id = (select id from staff where auth_uid = auth.uid())
    or public.can_see_staff(staff_id)
  );

-- only managers write — an employee reads their own, never edits it
drop policy if exists "creds write" on public.staff_credentials;
create policy "creds write" on public.staff_credentials
  for insert to authenticated with check (public.can_see_staff(staff_id));
drop policy if exists "creds update" on public.staff_credentials;
create policy "creds update" on public.staff_credentials
  for update to authenticated using (public.can_see_staff(staff_id));
drop policy if exists "creds clear" on public.staff_credentials;
create policy "creds clear" on public.staff_credentials
  for delete to authenticated using (public.can_see_staff(staff_id));
