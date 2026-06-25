-- Employee-facing commission dashboard access permission.
-- Granted to every standard role so each tech can see their own numbers
-- (the page itself scopes data to the signed-in staff; managers can "view as").

insert into permissions(key,label,category,description,sort,page,is_access)
values ('commission.dashboard','Access My Commission','Commission',
        'Employee-facing commission dashboard (own numbers)',41,'My Commission',true)
on conflict (key) do nothing;

insert into role_permissions(role_id,permission_id)
select r.id, p.id
from roles r, permissions p
where p.key='commission.dashboard'
  and r.key in ('owner','admin','team_member')
on conflict do nothing;
