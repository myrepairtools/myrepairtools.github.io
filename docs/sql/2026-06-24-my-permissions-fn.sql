create or replace function public.my_permissions()
returns setof text language sql stable security definer set search_path to 'public' as $$
  with me as (
    select case s.role when 'manager' then 'admin' when 'employee' then 'team_member' else s.role end as rkey,
           s.role as raw
    from staff s where s.auth_uid = auth.uid() and s.active limit 1
  )
  select p.key from permissions p
  where exists (select 1 from me where me.raw = 'owner')               -- owner: everything
     or exists (
       select 1 from me
       join roles r on r.key = me.rkey
       join role_permissions rp on rp.role_id = r.id
       where rp.permission_id = p.id
     );
$$;
grant execute on function public.my_permissions() to authenticated;
