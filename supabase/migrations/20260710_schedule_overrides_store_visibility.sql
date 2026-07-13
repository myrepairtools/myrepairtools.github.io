-- Fix: teammates couldn't see owner/manager shifts on the schedule.
--
-- schedule_overrides.so_read gated reads on can_see_staff(staff_id), which only
-- returns true when the TARGET is a team_member/employee. Staff with no recurring
-- schedule who are scheduled purely via overrides (e.g. the owner, Britt) were
-- therefore invisible on the team schedule to everyone but themselves/owners —
-- while recurring folks stayed visible (staff_schedule is world-readable).
--
-- Add store-based visibility so anyone who can see a store's schedule sees whoever
-- is working it that day, regardless of the worker's role. Additive (never removes
-- access) and store-scoped via can_see_store() (home_store / authorized_stores).
alter policy so_read on public.schedule_overrides using (
  can_see_staff(staff_id)
  or exists (select 1 from staff me where me.auth_uid = auth.uid() and me.id = schedule_overrides.staff_id)
  or can_see_store(store)
);
