-- Onboarding sections + per-person module assignment — catch-up record
-- (applied to the live DB in an earlier round; this file documents it and is
-- idempotent). Round-2 build (Training Center) consumes all of this.

-- Sections: a presentation-only third level inside a module. Items reference
-- one via kb_articles.section_id / onboarding_steps.section_id (null = module
-- level); ordering interleaves sections and module-level items by sort.
create table if not exists public.onboarding_sections (
  id        bigint generated always as identity primary key,
  module_id bigint not null references public.onboarding_modules(id) on delete cascade,
  name      text not null,
  sort      integer not null default 100,
  active    boolean not null default true
);
alter table public.onboarding_sections enable row level security;
drop policy if exists onboarding_sections_read on public.onboarding_sections;
create policy onboarding_sections_read on public.onboarding_sections for select to authenticated using (true);
drop policy if exists onboarding_sections_write on public.onboarding_sections;
create policy onboarding_sections_write on public.onboarding_sections for all to authenticated using (is_admin()) with check (is_admin());

alter table public.kb_articles      add column if not exists section_id bigint;
alter table public.onboarding_steps add column if not exists section_id bigint;

-- Per-person module assignment: onboarding_assignments went from one row per
-- person (track marker) to one row per (person, module) with audit + due date.
alter table public.onboarding_assignments add column if not exists module_id   bigint;
alter table public.onboarding_assignments add column if not exists assigned_by bigint;
alter table public.onboarding_assignments add column if not exists assigned_at timestamptz default now();
alter table public.onboarding_assignments add column if not exists due_at      date;
create unique index if not exists onboarding_assignments_person_module
  on public.onboarding_assignments (staff_id, module_id);

-- Auto-assign rule on the module: role + hired-on-or-after date. The rule is
-- applied when a hire is promoted from intake (and by the compliance surfaces).
alter table public.onboarding_modules add column if not exists auto_assign_role text;
alter table public.onboarding_modules add column if not exists auto_assign_from date;

-- the legacy one-row-per-person unique constraint blocks per-module rows:
alter table public.onboarding_assignments drop constraint if exists onboarding_assignments_staff_id_key;
