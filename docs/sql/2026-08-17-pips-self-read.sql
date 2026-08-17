-- My Profile shows a person their own PIPs and reviews. Every other table the
-- profile reads already allows a self-read; staff_pips was manager-only, so it
-- is the one policy the merged page needs.
--
-- Read splits from write: can_see_staff() still governs who may create or edit
-- a plan, so an employee sees their own and can change nothing.
drop policy if exists staff_pips_rw on staff_pips;

create policy staff_pips_read on staff_pips
  for select to authenticated
  using (
    can_see_staff(staff_id)
    or staff_id in (select id from staff where auth_uid = auth.uid())
  );

create policy staff_pips_write on staff_pips
  for insert to authenticated with check (can_see_staff(staff_id));
create policy staff_pips_update on staff_pips
  for update to authenticated using (can_see_staff(staff_id)) with check (can_see_staff(staff_id));
create policy staff_pips_delete on staff_pips
  for delete to authenticated using (can_see_staff(staff_id));
