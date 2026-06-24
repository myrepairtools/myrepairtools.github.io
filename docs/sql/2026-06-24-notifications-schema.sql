create table if not exists public.notification_channels (
  id bigint generated always as identity primary key,
  name text not null default '',
  type text not null default 'email' check (type in ('email','webhook')),
  target text,
  webhook_format text not null default 'adaptive' check (webhook_format in ('adaptive','messagecard')),
  enabled boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists public.notification_rules (
  id bigint generated always as identity primary key,
  tool text not null,
  event_key text not null unique,
  name text not null,
  description text,
  enabled boolean not null default false,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists public.notification_rule_channels (
  rule_id bigint references public.notification_rules(id) on delete cascade,
  channel_id bigint references public.notification_channels(id) on delete cascade,
  primary key (rule_id, channel_id)
);

alter table public.notification_channels enable row level security;
alter table public.notification_rules enable row level security;
alter table public.notification_rule_channels enable row level security;

drop policy if exists notif_channels_admin on public.notification_channels;
create policy notif_channels_admin on public.notification_channels for all to authenticated using (is_admin()) with check (is_admin());
drop policy if exists notif_rules_admin on public.notification_rules;
create policy notif_rules_admin on public.notification_rules for all to authenticated using (is_admin()) with check (is_admin());
drop policy if exists notif_rc_admin on public.notification_rule_channels;
create policy notif_rc_admin on public.notification_rule_channels for all to authenticated using (is_admin()) with check (is_admin());

-- seed the event catalog (real tool triggers; routing starts empty)
insert into public.notification_rules (tool, event_key, name, description, sort) values
  ('Tech Damage','damage.new_report','New damage report','A tech logs a damaged part during a repair.',0),
  ('Tech Damage','damage.weekly_summary','Weekly damage summary','Monday recap of last week''s damage $ by store.',1),
  ('Cash Tracker','cash.drawer_variance','Drawer over / short','A register count is off by more than the threshold.',2),
  ('Cash Tracker','cash.daily_audit','Daily cash audit submitted','End-of-day audit posted for a store.',3),
  ('Consumption','consumption.out_of_stock','Out-of-stock to reorder','Parts hit zero and need a MobileSentrix order.',4),
  ('Employee Records','records.new_pip','New PIP opened','A performance improvement plan is started for an employee.',5)
on conflict (event_key) do nothing;
