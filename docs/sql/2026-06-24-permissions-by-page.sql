alter table public.permissions add column if not exists page text;
alter table public.permissions add column if not exists is_access boolean not null default false;

-- existing perms -> assign a page; the page's "access" toggle gets is_access=true (relabelled)
update public.permissions set page='Cash Tracker',           is_access=true,  label='Access Cash Tracker'        where key='cash.view';
update public.permissions set page='Cash Admin',             is_access=true,  label='Access Cash Admin'          where key='cash.admin';
update public.permissions set page='Claim Ledger',           is_access=true,  label='Access Claim Ledger'        where key='claims.view';
update public.permissions set page='Commission',             is_access=true,  label='Access Commission'          where key='commission.view';
update public.permissions set page='Profit First',           is_access=true,  label='Access Profit First'        where key='profit.view';
update public.permissions set page='Employee Records',       is_access=true,  label='Access Employee Records'     where key='staff.view';
update public.permissions set page='Settings',               is_access=true,  label='Access Settings'            where key='staff.manage';
update public.permissions set page='Hyla Orders',            is_access=true,  label='Access Hyla Orders'         where key='orders.hyla';
update public.permissions set page='Jerry Ding Order',       is_access=true,  label='Access Jerry Ding Order'    where key='orders.jerryding';
-- existing sub-permission
update public.permissions set page='Consumption & Ordering', is_access=false                                     where key='consumption.overrides';

-- new access toggles for pages that had none
insert into public.permissions (key,label,category,page,is_access,sort)
select v.key,v.label,v.category,v.page,v.is_access,v.sort from (values
  ('consumption.access','Access Consumption & Ordering','Orders & Inventory','Consumption & Ordering',true,100),
  ('damage.access','Access Tech Damage Tracker','Damage','Tech Damage Tracker',true,110),
  ('po.access','Access PO Converter','Orders & Inventory','PO Converter',true,120),
  ('pricecalc.access','Access Price Calculator','Pricing','Price Calculator',true,130),
  ('priceguide.access','Access Price Guide','Pricing','Price Guide',true,140)
) as v(key,label,category,page,is_access,sort)
where not exists (select 1 from public.permissions p where p.key=v.key);

-- ===== default grants (mirror today's nav so nobody is locked out) =====
-- Team Member: operations pages only
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.key='team_member'
  and p.key in ('cash.view','consumption.access','damage.access','orders.hyla','orders.jerryding','po.access','pricecalc.access','priceguide.access')
  and not exists (select 1 from public.role_permissions x where x.role_id=r.id and x.permission_id=p.id);
-- Admin: operations + Cash Admin + Employee Records + Settings
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.key='admin'
  and p.key in ('cash.view','consumption.access','damage.access','orders.hyla','orders.jerryding','po.access','pricecalc.access','priceguide.access','cash.admin','staff.view','staff.manage')
  and not exists (select 1 from public.role_permissions x where x.role_id=r.id and x.permission_id=p.id);
-- Owner: everything
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.key='owner'
  and not exists (select 1 from public.role_permissions x where x.role_id=r.id and x.permission_id=p.id);
-- drop the duplicate access perms I added (originals already exist)
delete from public.role_permissions where permission_id in (select id from public.permissions where key in ('consumption.access','damage.access','po.access','pricecalc.access','priceguide.access'));
delete from public.permissions where key in ('consumption.access','damage.access','po.access','pricecalc.access','priceguide.access');

-- repurpose the original perms as the per-page access toggles
update public.permissions set page='PO Converter',           is_access=true,  label='Access PO Converter'           where key='orders.po';
update public.permissions set page='Consumption & Ordering', is_access=true,  label='Access Consumption & Ordering' where key='consumption.view';
update public.permissions set page='Pricing Tools',          is_access=true,  label='Access Pricing Tools'          where key='pricing.view';
update public.permissions set page='Tech Damage Tracker',    is_access=true,  label='Access Tech Damage Tracker'    where key='damage.view';
-- settings sub-permissions (page-access stays staff.manage)
update public.permissions set page='Settings', is_access=false where key in ('settings.locations','settings.access','settings.roles');

-- re-grant operations access with the correct keys
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.key='team_member'
  and p.key in ('cash.view','consumption.view','damage.view','orders.hyla','orders.jerryding','orders.po','pricing.view')
  and not exists (select 1 from public.role_permissions x where x.role_id=r.id and x.permission_id=p.id);
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.key='admin'
  and p.key in ('cash.view','consumption.view','damage.view','orders.hyla','orders.jerryding','orders.po','pricing.view','cash.admin','staff.view','staff.manage')
  and not exists (select 1 from public.role_permissions x where x.role_id=r.id and x.permission_id=p.id);
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.key='owner' and not exists (select 1 from public.role_permissions x where x.role_id=r.id and x.permission_id=p.id);
