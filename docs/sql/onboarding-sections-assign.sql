-- Training modules: sections (a third level) + assignable bundles.
--
-- Two gaps this closes:
--
-- 1. NESTING. The track was exactly two levels — module -> item — with articles
--    attaching via kb_articles.module_id and steps via onboarding_steps.module_id,
--    both merged into one flat ordered list. "Week 2 > iPhone Repairs > Screen
--    removal" had nowhere to live. onboarding_sections adds that middle level;
--    a NULL section_id keeps an item at module level, so bare items like
--    "Week 1 > How to answer the phone" still work and mix with sections.
--
-- 2. ASSIGNMENT. onboarding_assignments was one row per PERSON (a start stamp,
--    self-created when the employee first opened My Onboarding) with no
--    module_id, so every active module showed to everyone. It becomes one row
--    per (person, module) with assigned_by / assigned_at / due_at, and modules
--    gain auto-assign rules.
--
--    auto_assign_from is what makes "new hires only" true: without it, switching
--    a module on would retroactively assign it to every current employee whose
--    role matches. Default it to the day the rule is enabled.
--
--    due_at is deliberately the cheap version of per-person goals — "Week 1 done
--    by Friday" as real data the compliance roster can flag.
--
-- Assignment INSERT tightens to is_admin(): it used to be self-serve because the
-- row meant nothing. Now that it does, employees get their rows from the
-- security-definer sync RPC instead, so nobody can hand themselves a module that
-- wasn't aimed at them. A DELETE policy is added — there was none, so unassigning
-- was impossible.
--
-- Apply: run in the Supabase SQL editor (or management API database/query).

-- ------------------------------------------------------------------- sections
create table if not exists public.onboarding_sections (
  id        bigint generated always as identity primary key,
  module_id bigint not null references public.onboarding_modules(id) on delete cascade,
  name      text   not null,                -- "iPhone Repairs", "Important Policy"
  sort      integer not null default 0,     -- shares a number space with ungrouped items
  active    boolean not null default true
);
create index if not exists onboarding_sections_mod_idx on public.onboarding_sections (module_id, sort);

-- NULL section_id = the item sits directly under the module.
alter table public.kb_articles      add column if not exists section_id bigint references public.onboarding_sections(id) on delete set null;
alter table public.onboarding_steps add column if not exists section_id bigint references public.onboarding_sections(id) on delete set null;

-- --------------------------------------------------------------- assignments
alter table public.onboarding_assignments add column if not exists module_id   bigint references public.onboarding_modules(id) on delete cascade;
alter table public.onboarding_assignments add column if not exists assigned_by bigint;
alter table public.onboarding_assignments add column if not exists assigned_at timestamptz not null default now();
alter table public.onboarding_assignments add column if not exists due_at      date;

-- The pre-existing rows are per-PERSON start stamps with no module. Only two
-- existed and no onboarding_step_done rows referenced them, so they carry no
-- progress — drop them rather than invent a module for them. (Read receipts live
-- in kb_reads and are untouched.)
delete from public.onboarding_assignments where module_id is null;

do $$ begin
  alter table public.onboarding_assignments add constraint onboarding_assignments_staff_module_key unique (staff_id, module_id);
exception when duplicate_table or duplicate_object then null; end $$;

-- ------------------------------------------------------------- auto-assign
alter table public.onboarding_modules add column if not exists auto_assign_role text;  -- null = never auto-assign
alter table public.onboarding_modules add column if not exists auto_assign_from date;  -- only staff starting on/after this date

-- ------------------------------------------------------------------------ RLS
alter table public.onboarding_sections enable row level security;
drop policy if exists onboarding_sections_read  on public.onboarding_sections;
create policy onboarding_sections_read  on public.onboarding_sections for select using (true);
drop policy if exists onboarding_sections_write on public.onboarding_sections;
create policy onboarding_sections_write on public.onboarding_sections for all
  using (is_admin()) with check (is_admin());

-- assignment is no longer self-serve: the definer RPC below does employee inserts
drop policy if exists "own insert" on public.onboarding_assignments;
drop policy if exists onboarding_assignments_insert on public.onboarding_assignments;
create policy onboarding_assignments_insert on public.onboarding_assignments for insert
  with check (is_admin());
-- ...and unassigning needs a DELETE policy; there was none at all before
drop policy if exists onboarding_assignments_delete on public.onboarding_assignments;
create policy onboarding_assignments_delete on public.onboarding_assignments for delete
  using (is_admin());

-- ------------------------------------------------------------ auto-assign sync
-- Resolves a person's auto-assigned modules and inserts any that are missing.
-- SECURITY DEFINER so the employee-facing wrapper can create rows the employee
-- is not allowed to insert directly.
create or replace function public.onboarding_sync_for(p_staff_id bigint)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare n integer;
begin
  with me as (
    select s.id,
           -- the app aliases manager->admin and employee->team_member; normalize
           -- both sides so a rule written either way still matches
           case coalesce(s.role,'') when 'manager' then 'admin'
                                    when 'employee' then 'team_member'
                                    else coalesce(s.role,'') end as role,
           s.start_date
      from staff s where s.id = p_staff_id and s.active
  )
  insert into onboarding_assignments (staff_id, module_id, assigned_at)
  select me.id, m.id, now()
    from onboarding_modules m cross join me
   where m.active
     and m.auto_assign_role is not null
     and (case m.auto_assign_role when 'manager' then 'admin'
                                  when 'employee' then 'team_member'
                                  else m.auto_assign_role end) = me.role
     and (m.auto_assign_from is null
          or (me.start_date is not null and me.start_date >= m.auto_assign_from))
  on conflict (staff_id, module_id) do nothing;
  get diagnostics n = row_count;
  return n;
end
$function$;

-- Called by My Onboarding on load, for the signed-in user only.
create or replace function public.onboarding_sync_me()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare me bigint;
begin
  select id into me from staff where auth_uid = auth.uid() and active;
  if me is null then return 0; end if;
  return onboarding_sync_for(me);
end
$function$;

-- Manager-triggered, so a brand-new hire gets their bundles the moment the staff
-- record is created rather than waiting for their first sign-in.
create or replace function public.onboarding_sync_staff(p_staff_id bigint)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not is_admin() then raise exception 'not authorized'; end if;
  return onboarding_sync_for(p_staff_id);
end
$function$;

revoke all on function public.onboarding_sync_for(bigint)   from public, anon, authenticated;
revoke all on function public.onboarding_sync_me()          from public, anon;
revoke all on function public.onboarding_sync_staff(bigint) from public, anon;
grant execute on function public.onboarding_sync_me()          to authenticated;
grant execute on function public.onboarding_sync_staff(bigint) to authenticated;
