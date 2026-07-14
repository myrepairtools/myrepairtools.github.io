-- Multi-store task templates: link the per-store copies with a shared group_id
-- so editing one edits the set (task-admin's "Edit template" fans a shift/role
-- task across all its stores instead of forcing one edit per store).
--
-- A task created for N stores writes N task_templates rows (each store keeps its
-- own due time / instance generation); they now carry the same group_id.
-- Fan-out is only meaningful for shift/role targets — fixed-person and group
-- pools are store-specific people, so those stay singletons.

alter table public.task_templates add column if not exists group_id uuid;

-- Backfill: shift/role templates that share name+recurrence+target+role/shift+
-- completion across stores were the "one task, many stores" sets — link them.
with grp as (
  select name, recur, target, coalesce(role_key,'') rk, coalesce(shift_id,0) sh, completion,
         gen_random_uuid() gid
  from public.task_templates
  where active and not personal and target in ('shift','role')
  group by name, recur, target, coalesce(role_key,''), coalesce(shift_id,0), completion
)
update public.task_templates t set group_id = g.gid
from grp g
where t.active and not t.personal and t.target in ('shift','role')
  and t.name=g.name and t.recur=g.recur and t.target=g.target
  and coalesce(t.role_key,'')=g.rk and coalesce(t.shift_id,0)=g.sh and t.completion=g.completion
  and t.group_id is null;

-- everything else gets its own singleton group
update public.task_templates set group_id = gen_random_uuid() where group_id is null;
