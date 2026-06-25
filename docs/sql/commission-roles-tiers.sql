-- ============================================================================
-- Commission: role-driven earning permissions + per-person override + tier redesign
-- (companion to commission-schema.sql)
-- ============================================================================

-- Granular commission-EARNING permissions (behavioral, not page-access). Toggled
-- per role in Roles & Permissions; a person's eligibility derives from their role
-- (via ROLE_ALIAS: manager->admin, employee->team_member), with an optional
-- per-person override.
insert into permissions (key,label,category,description,sort,is_access)
select v.key, v.label, 'Commission', v.descr, v.sort, false
from (values
  ('commission.earn.accessory','Earns accessory %','Eligible for accessory tier commission',161),
  ('commission.earn.device','Earns device %','Eligible for device tier commission',162),
  ('commission.earn.services','Earns service payouts','Eligible for flat service payouts',163)
) as v(key,label,descr,sort)
where not exists (select 1 from permissions p where p.key=v.key);

-- Seed: every existing role earns all three (preserves prior "everyone earns"
-- behavior; trim per role in the UI as needed).
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r
join permissions p on p.key in ('commission.earn.accessory','commission.earn.device','commission.earn.services')
where not exists (select 1 from role_permissions rp where rp.role_id=r.id and rp.permission_id=p.id);

-- Per-person override of role defaults: {accessory?:bool, device?:bool, services?:bool}
alter table commission_roster add column if not exists earns_override jsonb;

-- Tier redesign: the accessory min-attach gate (accyGate) is removed from the
-- engine; the $ goal bonus now pays at any attach rate. Strip the dead key.
update commission_rules set rules = rules - 'accyGate' where rules ? 'accyGate';
