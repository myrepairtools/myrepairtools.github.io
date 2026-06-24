-- 1. new assignable permission
insert into public.permissions (key,label,category,sort)
select 'consumption.overrides','Edit max stock overrides','Orders & Inventory',95
where not exists (select 1 from public.permissions where key='consumption.overrides');

-- 2. grant to built-in roles (owner/admin/team_member); owner also bypasses in has_perm
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r cross join public.permissions p
where p.key='consumption.overrides' and r.key in ('owner','admin','team_member')
  and not exists (select 1 from public.role_permissions x where x.role_id=r.id and x.permission_id=p.id);

-- 3. permission check for RLS (bilingual role normalization; owner has everything)
create or replace function public.has_perm(perm_key text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1 from staff s
    where s.auth_uid = auth.uid() and s.active
      and ( s.role = 'owner'
        or exists (
          select 1 from roles r
          join role_permissions rp on rp.role_id = r.id
          join permissions p on p.id = rp.permission_id
          where r.key = case s.role when 'manager' then 'admin' when 'employee' then 'team_member' else s.role end
            and p.key = perm_key
        ))
  );
$$;

-- 4. override writes now require the permission + store access (reads unchanged)
drop policy if exists cfg_write on public.max_overrides;
create policy cfg_write on public.max_overrides for all to authenticated
  using (can_see_store(store) and has_perm('consumption.overrides'))
  with check (can_see_store(store) and has_perm('consumption.overrides'));
