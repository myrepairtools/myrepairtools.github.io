-- ============================================================
-- RBAC: roles & permissions catalog  (applied 2026-06-23)
-- Branch: claude/auth-roles-permissions-design-5yz462
-- Supabase project: xuvsehrevxackuhmbmry
--
-- Built-in roles: Owner / Admin / Team Member (is_system = true).
-- Owners can add custom roles and tick each role's permissions via the
-- Settings → Roles & Permissions tab (owner-only). Idempotent — safe to re-run.
-- ============================================================

create table if not exists public.permissions (
  id          bigint generated always as identity primary key,
  key         text unique not null,
  label       text not null,
  category    text not null,
  description text,
  sort        int  not null default 0
);

create table if not exists public.roles (
  id          bigint generated always as identity primary key,
  key         text unique,                 -- stable slug for built-ins; null for custom
  name        text not null,
  description text,
  is_system   boolean not null default false,
  sort        int  not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.role_permissions (
  role_id       bigint not null references public.roles(id)       on delete cascade,
  permission_id bigint not null references public.permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

-- RLS: world-readable catalog, owner-only writes (mirrors stores_write) ----
alter table public.permissions      enable row level security;
alter table public.roles            enable row level security;
alter table public.role_permissions enable row level security;

drop policy if exists permissions_read on public.permissions;
drop policy if exists roles_read on public.roles;
drop policy if exists role_permissions_read on public.role_permissions;
create policy permissions_read      on public.permissions      for select using (true);
create policy roles_read            on public.roles            for select using (true);
create policy role_permissions_read on public.role_permissions for select using (true);

drop policy if exists permissions_write on public.permissions;
drop policy if exists roles_write on public.roles;
drop policy if exists role_permissions_write on public.role_permissions;
create policy permissions_write on public.permissions for all
  using      (exists (select 1 from public.staff s where s.auth_uid = auth.uid() and s.active and s.role = 'owner'))
  with check (exists (select 1 from public.staff s where s.auth_uid = auth.uid() and s.active and s.role = 'owner'));
create policy roles_write on public.roles for all
  using      (exists (select 1 from public.staff s where s.auth_uid = auth.uid() and s.active and s.role = 'owner'))
  with check (exists (select 1 from public.staff s where s.auth_uid = auth.uid() and s.active and s.role = 'owner'));
create policy role_permissions_write on public.role_permissions for all
  using      (exists (select 1 from public.staff s where s.auth_uid = auth.uid() and s.active and s.role = 'owner'))
  with check (exists (select 1 from public.staff s where s.auth_uid = auth.uid() and s.active and s.role = 'owner'));

grant select on public.permissions, public.roles, public.role_permissions to anon, authenticated;
grant insert, update, delete on public.permissions, public.roles, public.role_permissions to authenticated;

-- Seed: permission catalog ------------------------------------------------
insert into public.permissions (key,label,category,description,sort) values
 ('cash.view',          'View cash counts',        'Cash',               'See Cash Tracker counts',                 10),
 ('cash.admin',         'Cash administration',     'Cash',               'Cash Admin tools & adjustments',          20),
 ('claims.view',        'View claim ledger',       'Claims',             'Claim Ledger',                            30),
 ('commission.view',    'View commission',         'Commission',         'Commission Calculator',                   40),
 ('profit.view',        'View Profit First',       'Profit',             'Profit First',                            50),
 ('staff.view',         'View staff records',      'Staff',              'Employee Records (read)',                 60),
 ('staff.manage',       'Manage staff',            'Staff',              'Add/edit people & PINs',                  70),
 ('orders.hyla',        'Hyla orders',             'Orders & Inventory', 'Hyla Orders',                             80),
 ('orders.jerryding',   'Jerry Ding orders',       'Orders & Inventory', 'Jerry Ding Order',                        90),
 ('orders.po',          'PO converter',            'Orders & Inventory', 'PO Converter',                           100),
 ('consumption.view',   'Consumption & ordering',  'Orders & Inventory', 'Consumption Report',                     110),
 ('pricing.view',       'Pricing tools',           'Pricing',            'Price Calc & Price Guide',               120),
 ('damage.view',        'Tech damage tracker',     'Damage',             'Tech Damage Tracker',                    130),
 ('settings.locations', 'Manage locations',        'Admin',              'Stores & registers',                     140),
 ('settings.access',    'Assign people access',    'Admin',              'Grant roles to people',                  150),
 ('settings.roles',     'Edit roles & permissions','Admin',              'The most powerful — edits this area',    160)
on conflict (key) do nothing;

-- Seed: built-in roles ----------------------------------------------------
insert into public.roles (key,name,description,is_system,sort) values
 ('owner',       'Owner',       'Full access to everything, at all stores.',                                     true, 1),
 ('admin',       'Admin',       'Runs a store day-to-day — most tools except owner financials & editing roles.', true, 2),
 ('team_member', 'Team Member', 'Front-line tools: cash counts, pricing, orders, damage.',                       true, 3)
on conflict (key) do nothing;

-- Seed: role -> permission grants -----------------------------------------
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.key = 'owner'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p
  on p.key in ('cash.view','cash.admin','claims.view','staff.view','staff.manage',
               'orders.hyla','orders.jerryding','orders.po','consumption.view',
               'pricing.view','damage.view','settings.locations','settings.access')
where r.key = 'admin'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p
  on p.key in ('cash.view','pricing.view','damage.view',
               'orders.hyla','orders.jerryding','orders.po','consumption.view')
where r.key = 'team_member'
on conflict do nothing;
