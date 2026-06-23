-- ============================================================
-- HARD CUTOVER: staff.role -> new vocabulary (owner / admin / team_member)
-- Branch: claude/auth-roles-permissions-design-5yz462
-- Supabase project: xuvsehrevxackuhmbmry
--
-- BACKEND PREP DONE (2026-06-23): the cpr-auth Edge Function (v15) and
-- is_admin() are already BILINGUAL — they accept both the legacy
-- (manager/employee) and new (admin/team_member) role names. So the only
-- remaining live step is the data rename below + merging the front-end to
-- main. Because the backend is bilingual, the data rename no longer breaks
-- the backend; it only desyncs the OLD front-end on main (which filters on
-- 'manager'), so still run it together with the main merge.
--
-- Reversible: re-run with the values swapped back if needed.
-- ============================================================

-- is_admin() is already bilingual in the DB (manager+admin+owner). Kept here
-- for reference; re-running is a no-op:
create or replace function public.is_admin(target text default null::text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists (
    select 1 from staff s
    where s.auth_uid = auth.uid() and s.active
      and s.role in ('manager','admin','owner')
      and ( s.role = 'owner' or target is null
            or target = any(s.authorized_stores) or target = s.home_store )
  );
$function$;

-- THE REMAINING LIVE STEP — migrate stored role values (owner unchanged) --
update public.staff set role = 'admin'        where role = 'manager';
update public.staff set role = 'team_member'  where role = 'employee';

-- 3) Verify --------------------------------------------------------------
-- select role, count(*) from public.staff group by role order by role;
-- Expect only: owner / admin / team_member
