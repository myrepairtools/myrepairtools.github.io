-- Editable customer-message templates (per store, with a shared default).
-- The first consumer is the extension's Ready-for-Pickup SMS; the body carries
-- short codes ({name}/{first}, {device}, {store}/{location}, {tech}, {hours})
-- that the extension fills in per send from the RepairQ ticket + logged-in user.
--
-- Read is open (the messaging edge function resolves store→default with the
-- service role; settings.html reads under the PIN session). Writes are
-- manager-only via is_admin(), mirroring compose_templates / kb_articles.

create table if not exists public.message_templates (
  id bigint generated always as identity primary key,
  store text,                         -- null = shared default; else canonical store name
  template_key text not null,
  body text not null,
  updated_by text,
  updated_at timestamptz not null default now()
);

-- one row per (store, key); null store is the shared default (coalesce so nulls collapse)
create unique index if not exists message_templates_store_key
  on public.message_templates (coalesce(store, ''), template_key);

alter table public.message_templates enable row level security;

drop policy if exists "message_templates read" on public.message_templates;
create policy "message_templates read" on public.message_templates for select using (true);
drop policy if exists "message_templates write" on public.message_templates;
create policy "message_templates write" on public.message_templates for all using (is_admin()) with check (is_admin());

-- seed the shared default ready-for-pickup message
insert into public.message_templates (store, template_key, body)
select null, 'ready_for_pickup',
  'Hi {name}, your {device} is ready for pickup at {store}! Come by during business hours — see you soon.'
where not exists (
  select 1 from public.message_templates where store is null and template_key = 'ready_for_pickup'
);
