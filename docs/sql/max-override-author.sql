-- Who last CHANGED a max stock level.
--
-- max_overrides / group_max_overrides / groups.max carried a value and an
-- updated_at but no author, so "who set this max?" was only answerable by
-- matching the row's updated_at against the edge logs' JWT subject. That works
-- until log retention rolls, and nobody can do it from the page.
--
-- The author is stamped by a TRIGGER, not by the page: auth.uid() is the
-- session's own identity, so it can't be spoofed by a hand-rolled request the
-- way a client-supplied name can, and any future surface that writes these
-- tables is covered without remembering to pass a name.
--
-- updated_by_name is denormalized on purpose (same pattern as
-- inventory_edit_log.run_by_name / brand_assets.uploaded_by_name): staff RLS
-- doesn't let a team member read other people's staff rows, so a join would
-- render blank for exactly the people using the report. The name also survives
-- the staff row being deleted, which the FK deliberately does not.

alter table public.max_overrides
  add column if not exists updated_by      bigint references public.staff(id) on delete set null,
  add column if not exists updated_by_name text;

alter table public.group_max_overrides
  add column if not exists updated_by      bigint references public.staff(id) on delete set null,
  add column if not exists updated_by_name text;

alter table public.groups
  add column if not exists updated_by      bigint references public.staff(id) on delete set null,
  add column if not exists updated_by_name text;

-- TG_ARGV[0] names the column that holds the max. The stamp only moves when
-- THAT column actually changes, so renaming or reordering a part group leaves
-- the max's author alone — the column reads "last changed by", and a rename is
-- not a change to the number.
--
-- A write with no matching staff row (service-role sync, cron) must not blank
-- an existing author, so it carries the previous one forward.
create or replace function public.stamp_max_author()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s   record;
  col text := tg_argv[0];
begin
  if tg_op = 'UPDATE'
     and to_jsonb(new) ->> col is not distinct from to_jsonb(old) ->> col then
    new.updated_by      := old.updated_by;
    new.updated_by_name := old.updated_by_name;
    return new;
  end if;

  select id, display_name into s from staff where auth_uid = auth.uid();

  if s.id is not null then
    new.updated_by      := s.id;
    new.updated_by_name := s.display_name;
  elsif tg_op = 'UPDATE' then
    new.updated_by      := old.updated_by;
    new.updated_by_name := old.updated_by_name;
  end if;

  new.updated_at := now();
  return new;
end $$;

revoke execute on function public.stamp_max_author() from anon, authenticated;

drop trigger if exists trg_max_overrides_author on public.max_overrides;
create trigger trg_max_overrides_author
  before insert or update on public.max_overrides
  for each row execute function public.stamp_max_author('value');

drop trigger if exists trg_group_max_overrides_author on public.group_max_overrides;
create trigger trg_group_max_overrides_author
  before insert or update on public.group_max_overrides
  for each row execute function public.stamp_max_author('value');

drop trigger if exists trg_groups_author on public.groups;
create trigger trg_groups_author
  before insert or update on public.groups
  for each row execute function public.stamp_max_author('max');
