-- Candidates go live at intake; a manager decides when they become staff.
--
-- Two changes that belong together:
--
-- 1. Finishing the new-hire form now promotes them into MRT immediately (the
--    intake fn's `submit` runs the same promote path a manager used to click),
--    landing on the `candidate` role. That's what lets you build their first
--    week's schedule the day they accept instead of the day they arrive.
--
-- 2. Because everyone now arrives early, `candidate` has to be genuinely
--    narrow: their own schedule and their own profile, nothing else. The
--    Knowledge Base, Training and Communications were reachable by any
--    signed-in person, so they get access keys and the role system decides —
--    never a hard-coded list of pages a candidate may see.
--
-- The door out of `candidate` is an onboarding step a manager ticks:
-- "Activate employee". Ticking it promotes them to the role the hiring wizard
-- picked (staff.role_on_start). The day-one cron still promotes anyone whose
-- start date arrives un-ticked — nobody is ever locked out on their first
-- shift because a box wasn't checked.

-- 1. a step can DO something, not just record that someone did it
alter table public.onboarding_steps add column if not exists action text;
comment on column public.onboarding_steps.action is
  'Machine hook fired when this step is ticked. Today: ''activate'' (candidate -> their real role).';

-- 2. the step itself, in the standard HR module
insert into public.onboarding_steps (module_id, sort_order, title, note, who, action, active)
select 3, 30, 'Activate employee',
  'Gives them the full Team Member role — the store''s tools, the Knowledge Base and their training.',
  'manager', 'activate', true
where not exists (select 1 from public.onboarding_steps where action = 'activate');

-- 3. ticking it is what promotes them. A trigger, not page code, so it works
--    from every surface that can tick a step (Training, KB Compliance, the
--    onboarding profile) and can't be forgotten in one of them.
--    Un-ticking deliberately does NOT demote: taking someone's access away is
--    a decision, not an undo.
create or replace function public.onboarding_activate_staff()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare act text;
begin
  select action into act from onboarding_steps where id = new.step_id;
  if act is distinct from 'activate' then return new; end if;
  update staff
     set role = coalesce(nullif(role_on_start, ''), 'team_member'),
         role_on_start = null
   where id = new.staff_id and role = 'candidate';
  return new;
end;
$function$;

drop trigger if exists trg_onboarding_activate on public.onboarding_step_done;
create trigger trg_onboarding_activate
  after insert on public.onboarding_step_done
  for each row execute function public.onboarding_activate_staff();

-- 4. the three surfaces that were open to anyone signed in. Granted to every
--    role that could already reach them; withheld from `candidate`.
insert into public.permissions (key, label, category, sort, is_access) values
  ('kb.view',       'Access the Knowledge Base', 'My Hub', 120, true),
  ('training.view', 'Access Training',           'My Hub', 121, true),
  ('comms.view',    'Access Communications',     'My Hub', 122, true)
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.key in ('owner','admin','team_member')
  and p.key in ('kb.view','training.view','comms.view')
on conflict do nothing;
