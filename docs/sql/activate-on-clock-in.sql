-- Activation follows the punch clock.
--
-- A candidate is someone we hired who hasn't started. Promoting them on a
-- DATE assumes they turned up; promoting them on their first CLOCK-IN knows
-- they did. Someone who ghosts the job never gets the store's tools, and
-- nobody has to remember to tick anything for someone who shows up.
--
-- One function, three callers: the MRT top-bar clock (qbtime-sync clock_in),
-- the hourly QB Time timesheet sync (they punched in on Workforce or the
-- store machine), and the day-one cron. The manual "Activate employee"
-- onboarding step still works exactly as before via its own trigger.

create or replace function public.activate_staff(p_staff_id bigint, p_reason text default 'clock_in')
 returns text language plpgsql security definer set search_path to 'public'
as $function$
declare new_role text; v_step bigint;
begin
  update staff
     set role = coalesce(nullif(role_on_start, ''), 'team_member'),
         role_on_start = null
   where id = p_staff_id and role = 'candidate'
   returning role into new_role;
  if new_role is null then return null; end if;
  -- tick the onboarding step so the track doesn't sit on something that has
  -- already happened. done_by null = the system did it, not a person.
  select id into v_step from onboarding_steps where action = 'activate' and active limit 1;
  if v_step is not null then
    insert into onboarding_step_done (step_id, staff_id, done_by)
    values (v_step, p_staff_id, null)
    on conflict (step_id, staff_id) do nothing;
  end if;
  return new_role;
end;
$function$;

revoke all on function public.activate_staff(bigint, text) from public, anon, authenticated;
comment on function public.activate_staff is
  'Candidate -> their real role (staff.role_on_start), ticking the Activate step. Service-role only.';

-- A punch also proves the Workforce app is installed and signed in — the one
-- employee step nobody should have to self-report. staff_clocked_in() is what
-- the clock calls now: it ticks every step marked action='clock_in' AND runs
-- the candidate promotion above. Separate from activate_staff() because a
-- punch from an already-activated employee must still tick their app step.
create or replace function public.staff_clocked_in(p_staff_id bigint)
 returns text language plpgsql security definer set search_path to 'public'
as $function$
declare new_role text;
begin
  insert into onboarding_step_done (step_id, staff_id, done_by)
  select s.id, p_staff_id, null from onboarding_steps s
  where s.action = 'clock_in' and s.active
  on conflict (step_id, staff_id) do nothing;
  new_role := public.activate_staff(p_staff_id, 'clock_in');
  return new_role;
end;
$function$;
revoke all on function public.staff_clocked_in(bigint) from public, anon, authenticated;

-- Only 'activate' is the dangerous one to hand a mentor (its trigger grants
-- the store's tools). A clock_in step is an ordinary tick.
drop policy if exists "mentor ticks mentee steps" on public.onboarding_step_done;
create policy "mentor ticks mentee steps" on public.onboarding_step_done
  for insert to authenticated with check (
    public.is_my_mentee(staff_id)
    and not exists (select 1 from onboarding_steps s
                    where s.id = step_id and s.action = 'activate')
  );
