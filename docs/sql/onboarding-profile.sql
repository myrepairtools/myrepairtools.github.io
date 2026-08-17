-- Onboarding roster -> per-person profile (design handoff, 2026-08-17).
--
-- The board is Hiring -> New-hire setup -> one column per assigned module.
-- Almost everything it draws already exists (CPRTrack inputs, the setup
-- checklist, staff_intake). Four things don't:
--
--   1. the Hiring column's manual steps need stamps of their own
--   2. a hire has a MENTOR, and the mentor works their panel
--   3. "done with onboarding" needs to be a fact, so the roster can end
--   4. a mentor is a team_member, so RLS has to let them tick their mentee's
--      steps without making them an admin

-- 1. Hiring column stamps. Steps 1-3 are derived from the signature/submit
--    timestamps already on the row; 4-6 are manager actions with no home.
--    Convert is already stamped by promote (promoted_at/promoted_staff_id).
alter table public.staff_intake
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by bigint references public.staff(id),
  add column if not exists qbo_created_at timestamptz,
  add column if not exists qbo_created_by bigint references public.staff(id),
  add column if not exists onboarding_completed_at timestamptz,
  add column if not exists onboarding_completed_by bigint references public.staff(id),
  add column if not exists onboarding_canceled_at timestamptz,
  add column if not exists onboarding_canceled_by bigint references public.staff(id);

-- 3. A converted hire's intake row is their onboarding record, so completion
--    stamps live there. Someone hired before intake existed has no row — for
--    them the same two stamps ride the staff row.
alter table public.staff
  add column if not exists mentor_staff_id bigint references public.staff(id),
  add column if not exists onboarding_completed_at timestamptz,
  add column if not exists onboarding_canceled_at timestamptz;
comment on column public.staff.mentor_staff_id is
  'Who is walking this hire through onboarding. Picked from their home store.';

create index if not exists staff_mentor_idx on public.staff (mentor_staff_id)
  where mentor_staff_id is not null;

-- 4. Mentor access. A mentor is an ordinary team_member, so every read the
--    profile makes and every tick it writes has to be allowed for exactly one
--    other person: their mentee. Wrapped in a helper so no policy hard-codes
--    the join.
create or replace function public.is_my_mentee(target bigint)
 returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select exists (
    select 1 from staff tgt join staff me on me.id = tgt.mentor_staff_id
    where tgt.id = target and me.auth_uid = auth.uid() and me.active
  );
$function$;

-- ...which widens the existing staff visibility helper. A mentor who cannot
-- see their mentee's row cannot render their profile at all.
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
  ) or public.is_my_mentee(target);
$function$;

-- ticking a mentee's manager step
drop policy if exists "mentor ticks mentee steps" on public.onboarding_step_done;
create policy "mentor ticks mentee steps" on public.onboarding_step_done
  for insert to authenticated with check (public.is_my_mentee(staff_id));
drop policy if exists "mentor unticks mentee steps" on public.onboarding_step_done;
create policy "mentor unticks mentee steps" on public.onboarding_step_done
  for delete to authenticated using (public.is_my_mentee(staff_id));
drop policy if exists "mentor reads mentee steps" on public.onboarding_step_done;
create policy "mentor reads mentee steps" on public.onboarding_step_done
  for select to authenticated using (public.is_my_mentee(staff_id));

-- the mentee's assignments and setup checklist, read-only
drop policy if exists "mentor reads mentee assignments" on public.onboarding_assignments;
create policy "mentor reads mentee assignments" on public.onboarding_assignments
  for select to authenticated using (public.is_my_mentee(staff_id));
drop policy if exists "mentor reads mentee setup" on public.staff_setup_checklist;
create policy "mentor reads mentee setup" on public.staff_setup_checklist
  for select to authenticated using (public.is_my_mentee(staff_id));
drop policy if exists "mentor ticks mentee setup" on public.staff_setup_checklist;
create policy "mentor ticks mentee setup" on public.staff_setup_checklist
  for insert to authenticated with check (public.is_my_mentee(staff_id));
drop policy if exists "mentor updates mentee setup" on public.staff_setup_checklist;
create policy "mentor updates mentee setup" on public.staff_setup_checklist
  for update to authenticated using (public.is_my_mentee(staff_id));

-- their reads (progress) — the article side of the track
drop policy if exists "mentor reads mentee reads" on public.kb_reads;
create policy "mentor reads mentee reads" on public.kb_reads
  for select to authenticated using (public.is_my_mentee(staff_id));

-- 2026-08-17 follow-ups (adversarial review + owner asks):
--
-- The mentor could read the mentee's step ticks and article receipts but not
-- their quiz attempts or signatures — so a quiz-passed article rendered
-- un-done on the mentor's board and locked everything after it.
drop policy if exists "mentor reads mentee attempts" on public.kb_quiz_attempts;
create policy "mentor reads mentee attempts" on public.kb_quiz_attempts
  for select to authenticated using (public.is_my_mentee(staff_id));
drop policy if exists "mentor reads mentee signatures" on public.kb_signatures;
create policy "mentor reads mentee signatures" on public.kb_signatures
  for select to authenticated using (public.is_my_mentee(staff_id));

-- A mentor ticking steps must not be able to tick an ACTION step — the
-- Activate step's trigger would promote their mentee (to admin, if that is
-- what the wizard picked). Granting access stays a manager's move.
drop policy if exists "mentor ticks mentee steps" on public.onboarding_step_done;
create policy "mentor ticks mentee steps" on public.onboarding_step_done
  for insert to authenticated with check (
    public.is_my_mentee(staff_id)
    and not exists (select 1 from onboarding_steps s
                    where s.id = step_id and s.action is not null)
  );

-- Hiring-column stamps for the two QB Time configs that used to be module
-- steps (owner call: they belong to hiring, gated on the payroll add).
-- Columns: staff_intake.qbt_class_at/_by, payroll_map_at/_by.
