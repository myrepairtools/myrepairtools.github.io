-- ============================================================
-- HARD CUTOVER: staff.role -> new vocabulary (owner / admin / team_member)
-- Branch: claude/auth-roles-permissions-design-5yz462
-- Supabase project: xuvsehrevxackuhmbmry
--
-- RUN THIS ONLY AS PART OF THE COORDINATED RELEASE:
--   1. Deploy the updated cpr-auth Edge Function (caller() accepts owner|admin;
--      canManageRole() targets team_member).
--   2. Run this script (is_admin gate + data rename).
--   3. Merge the front-end changes to main so the live site uses the new names.
-- Doing any one of these alone will break admin login / cash-admin / staff mgmt.
--
-- Reversible: re-run with the values swapped back if needed.
-- ============================================================

-- 1) RLS gate for Cash Admin writes: manager -> admin --------------------
create or replace function public.is_admin(target text default null::text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists (
    select 1 from staff s
    where s.auth_uid = auth.uid() and s.active
      and s.role in ('admin','owner')
      and ( s.role = 'owner' or target is null
            or target = any(s.authorized_stores) or target = s.home_store )
  );
$function$;

-- 2) Migrate the stored role values (owner is unchanged) -----------------
update public.staff set role = 'admin'        where role = 'manager';
update public.staff set role = 'team_member'  where role = 'employee';

-- 3) Verify --------------------------------------------------------------
-- select role, count(*) from public.staff group by role order by role;
-- Expect only: owner / admin / team_member
