-- timeoff.approve: deciding time-off requests is its own permission,
-- granted ONLY to Owner (managers still view/add; adds go in pending).
insert into public.permissions (key,label,category,description,sort)
select 'timeoff.approve','Approve Time Off','Employees','Approve or deny time-off requests. Without it, managers can log requests but not decide them.',60
where not exists (select 1 from public.permissions where key='timeoff.approve');
insert into public.role_permissions (role_id, permission_id)
select 1, p.id from public.permissions p where p.key='timeoff.approve'
and not exists (select 1 from public.role_permissions rp where rp.permission_id=p.id and rp.role_id=1);
