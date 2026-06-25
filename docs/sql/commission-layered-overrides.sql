-- Layered commission overrides (Store -> Role -> Person), companion migration.
-- Effective rules = mergeRules(store, role, person) onto engine ruleDefaults.
-- Effective rates = mergeRates(globalRates, role, person).
create table if not exists commission_role_overrides (
  role_id    bigint primary key references roles(id) on delete cascade,
  rules      jsonb not null default '{}'::jsonb,   -- partial tier-rule overrides for this role
  rates      jsonb not null default '{}'::jsonb,   -- partial service $/SKU overrides for this role
  updated_at timestamptz not null default now()
);
alter table commission_roster add column if not exists rules_override jsonb;  -- per-person tier rules
alter table commission_roster add column if not exists rates_override jsonb;  -- per-person service $

alter table commission_role_overrides enable row level security;
drop policy if exists commission_role_overrides_read on commission_role_overrides;
create policy commission_role_overrides_read on commission_role_overrides for select using (auth.uid() is not null);
drop policy if exists commission_role_overrides_write on commission_role_overrides;
create policy commission_role_overrides_write on commission_role_overrides for all using (is_admin()) with check (is_admin());
