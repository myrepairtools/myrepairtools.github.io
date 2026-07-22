-- Onboarding v2: NON-article steps in a module (HR paperwork, account setups).
-- A module's track = its kb_articles (module_id/sort_order) + these steps,
-- merged by sort_order. `who` says who completes it: the employee themselves
-- (profile setup, home-screen install) or their manager (I-9, QBO, RepairQ
-- credentials). Managers tick their steps per-person from KB Compliance.
create table if not exists public.onboarding_steps (
  id bigint generated always as identity primary key,
  module_id bigint not null references public.onboarding_modules(id) on delete cascade,
  sort_order int not null default 0,
  title text not null,
  note text,                                   -- one-line description under the title
  who text not null default 'manager' check (who in ('employee','manager')),
  link_url text,                               -- optional deep link (profile.html…)
  active boolean not null default true
);
alter table public.onboarding_steps enable row level security;
drop policy if exists "read steps" on public.onboarding_steps;
create policy "read steps" on public.onboarding_steps for select using (true);
drop policy if exists "admin write steps" on public.onboarding_steps;
create policy "admin write steps" on public.onboarding_steps for all using (is_admin()) with check (is_admin());

-- one row per (step, onboardee) when completed; done_by records who ticked it
create table if not exists public.onboarding_step_done (
  id bigint generated always as identity primary key,
  step_id bigint not null references public.onboarding_steps(id) on delete cascade,
  staff_id bigint not null references public.staff(id),
  done_by bigint,
  done_at timestamptz not null default now(),
  unique (step_id, staff_id)
);
alter table public.onboarding_step_done enable row level security;
drop policy if exists "own or admin read" on public.onboarding_step_done;
create policy "own or admin read" on public.onboarding_step_done for select
  using (staff_id = my_staff_id() or is_admin());
drop policy if exists "own or admin write" on public.onboarding_step_done;
create policy "own or admin write" on public.onboarding_step_done for insert
  with check (staff_id = my_staff_id() or is_admin());
drop policy if exists "own or admin delete" on public.onboarding_step_done;
create policy "own or admin delete" on public.onboarding_step_done for delete
  using (staff_id = my_staff_id() or is_admin());

-- seed the HR & Accounts module ahead of the reading weeks (owner edits freely)
do $$
declare mid bigint;
begin
  if not exists (select 1 from onboarding_modules where name like '%HR & Accounts%') then
    insert into onboarding_modules (name, subtitle, sort)
      values ('Getting Set Up — HR & Accounts', 'Paperwork & accounts — done with your manager on day one', 0)
      returning id into mid;
    insert into onboarding_steps (module_id, sort_order, title, note, who, link_url) values
      (mid, 10, 'I-9 employment eligibility verification', 'Bring ID documents on day one — completed together with your manager.', 'manager', null),
      (mid, 20, 'W-4 federal & OR-W-4 state tax forms', 'Federal and Oregon withholding forms.', 'manager', null),
      (mid, 30, 'Payroll & direct deposit — QuickBooks setup', 'Manager adds you to QuickBooks payroll with your direct deposit details.', 'manager', null),
      (mid, 40, 'QuickBooks Time invite (clock in/out)', 'Accept the QB Time invite on your phone — this is how you clock in and out.', 'manager', null),
      (mid, 50, 'RepairQ login credentials', 'Manager creates your RepairQ user for the ticket system.', 'manager', null),
      (mid, 60, 'Sign in to myRepairTools & set your PIN', 'Set your personal PIN and finish your profile.', 'employee', 'profile.html'),
      (mid, 70, 'Add myRepairTools to your phone home screen', 'Install the app — instructions on your profile page.', 'employee', 'profile.html'),
      (mid, 80, 'Emergency contact & profile details', 'Phone, address, emergency contact, shirt size.', 'employee', 'profile.html');
  end if;
end $$;
-- Harden onboarding_step_done (verify finding): employees may only tick their
-- OWN completions on EMPLOYEE-kind steps, and done_by must be themselves —
-- manager-kind steps (I-9, payroll, credentials) are admin-only writes, so the
-- attestation record can't be forged or erased from the console.
drop policy if exists "own or admin write" on public.onboarding_step_done;
create policy "own or admin write" on public.onboarding_step_done for insert
  with check (
    is_admin()
    or (staff_id = my_staff_id() and done_by = my_staff_id()
        and exists (select 1 from public.onboarding_steps s
                    where s.id = step_id and s.who = 'employee'))
  );
drop policy if exists "own or admin delete" on public.onboarding_step_done;
create policy "own or admin delete" on public.onboarding_step_done for delete
  using (
    is_admin()
    or (staff_id = my_staff_id()
        and exists (select 1 from public.onboarding_steps s
                    where s.id = step_id and s.who = 'employee'))
  );
-- scope the new read policies to signed-in users (house convention)
drop policy if exists "read steps" on public.onboarding_steps;
create policy "read steps" on public.onboarding_steps for select to authenticated using (true);
drop policy if exists "read modules" on public.onboarding_modules;
create policy "read modules" on public.onboarding_modules for select to authenticated using (true);
