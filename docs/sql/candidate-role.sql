-- Candidate role — a hire who exists before their first day (idempotent).
--
-- Convert has to happen BEFORE the start date or the schedule can't be built:
-- Schedule Admin only lists real staff rows, so "wait until day one" means a
-- new hire's first week can't be written in advance. But a full Team Member
-- from the moment they sign an offer is too much — they'd have the store's
-- pricing, cash and ordering tools weeks before they walk in.
--
-- So converting lands them on `candidate`: they can sign in, see THEIR
-- schedule, and do their training. On their start date the day-one cron
-- promotes them to the role the wizard actually picked (staff.role_on_start)
-- and tells the owner + store manager it happened.
--
-- Five tools were reachable by any signed-in person because they carried no
-- permission key at all. They do now, granted to every existing role, so the
-- role system is what decides — not a hard-coded list of pages a candidate
-- may see.

-- 1. the permissions those five tools were missing
insert into public.permissions (key, label, category, sort, is_access) values
  ('contracts.view',       'Access Contracts',      'Operations', 100, true),
  ('lcd.view',             'Access LCD Buyback',    'Operations', 101, true),
  ('brand.view',           'Access Brand Assets',   'Operations', 102, true),
  ('tools.label_resizer',  'Access Label Resizer',  'Tools',      110, true),
  ('tools.extension',      'Access the Extension',  'Tools',      111, true)
on conflict (key) do nothing;

-- every role that could reach them before still can (they were open to all)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.key in ('owner','admin','team_member')
  and p.key in ('contracts.view','lcd.view','brand.view','tools.label_resizer','tools.extension')
on conflict do nothing;

-- 2. the role itself
insert into public.roles (key, name, description, is_system, sort)
values ('candidate', 'Candidate',
        'Hired, not started. Their own schedule and training only.', true, 4)
on conflict (key) do nothing;

-- 3. what a candidate may do: see their schedule. Training, the Knowledge
--    Base, Communications, Alerts and their profile are open to any signed-in
--    person and stay that way — reading the handbook before day one is the
--    point of the account.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.key = 'candidate' and p.key in ('schedule.view')
on conflict do nothing;

-- 4. the role they become on their start date. Null on everyone who is
--    already staff — this only rides along a candidate row.
alter table public.staff add column if not exists role_on_start text;
comment on column public.staff.role_on_start is
  'Role the day-one cron promotes a candidate into (chosen in the hiring wizard).';

-- 5. A candidate is a REAL employee, just limited — so every surface that
--    works on "my people" has to include them. can_see_staff() gated a
--    manager's visibility to team_member/employee, which made a candidate
--    invisible to the manager who has to set them up (and to Team Members,
--    schedule overrides, and the compliance roster).
create or replace function public.can_see_staff(target bigint)
 returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select exists (
    select 1 from staff me
    where me.auth_uid = auth.uid() and me.active and (
      me.role = 'owner'
      or ( me.role in ('admin','manager')
           and exists (
             select 1 from staff tgt
             where tgt.id = target
               and tgt.role in ('team_member','employee','candidate')
               and ( tgt.home_store = any(me.authorized_stores)
                     or tgt.authorized_stores && me.authorized_stores )
           ) )
    )
  );
$function$;

-- 6. Availability follows the PERSON. It was captured on the new-hire form and
--    left on the intake row, which leaves the Onboarding board at promote —
--    so the one place it's needed (building their first schedule) couldn't
--    see it. Schedule Admin reads it from here.
alter table public.staff_profiles add column if not exists availability jsonb;
comment on column public.staff_profiles.availability is
  'What they told us on the new-hire form: [{day,mode,from,to}] per weekday.';
update public.staff_profiles p set availability = i.availability
from public.staff_intake i
where i.promoted_staff_id = p.staff_id and i.availability is not null and p.availability is null;
