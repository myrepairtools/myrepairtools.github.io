-- Consumption Report page settings: custom flags (Special Order + future) and
-- the part-types list managed from Settings → Page Settings → Consumption Report.
--
-- part_types already existed (id, part_type, active); this migration adds the
-- custom-flag system. Flags are global definitions with a badge color; each is
-- assigned per (store, sku) like the existing consignment_only table.

-- custom flag definitions (global), e.g. Special Order
create table if not exists flag_types (
  id      bigint generated always as identity primary key,
  key     text unique not null,
  label   text not null,
  color   text not null default '#4FB0E3',
  active  boolean not null default true,
  sort    int not null default 0,
  created_at timestamptz not null default now()
);
alter table flag_types enable row level security;
drop policy if exists ft_read on flag_types;
create policy ft_read on flag_types for select to authenticated using (true);
drop policy if exists ft_write on flag_types;
create policy ft_write on flag_types for all to authenticated using (is_admin()) with check (is_admin());

-- per-(store,sku) assignment of a custom flag (mirrors consignment_only's RLS)
create table if not exists sku_flags (
  store     text not null,
  sku       text not null,
  flag_key  text not null references flag_types(key) on update cascade on delete cascade,
  primary key (store, sku, flag_key)
);
alter table sku_flags enable row level security;
drop policy if exists sf_read on sku_flags;
create policy sf_read on sku_flags for select to authenticated using (can_see_store(store));
drop policy if exists sf_write on sku_flags;
create policy sf_write on sku_flags for all to authenticated using (is_admin(store)) with check (is_admin(store));

-- seed the Special Order flag (amber badge)
insert into flag_types (key, label, color, sort)
values ('special_order', 'Special Order', '#C9820B', 0)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Per-(store, group) max stock override. Part groups are global, but each store
-- can set its own max; absent a row, the group's global default (groups.max) wins.
create table if not exists group_max_overrides (
  store     text not null,
  group_id  text not null references groups(id) on delete cascade,
  value     integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (store, group_id)
);
alter table group_max_overrides enable row level security;
drop policy if exists gmo_read on group_max_overrides;
create policy gmo_read on group_max_overrides for select to authenticated using (can_see_store(store));
drop policy if exists gmo_write on group_max_overrides;
create policy gmo_write on group_max_overrides for all to authenticated
  using (can_see_store(store) and has_perm('consumption.overrides'))
  with check (can_see_store(store) and has_perm('consumption.overrides'));
