-- Generalize to one interval+anchor pair that covers BOTH weekly and monthly:
-- recur_interval = "every X" of the recurrence unit (1 = every week/month,
-- 2 = every other, ...); recur_anchor = any date in an "on" week/month, parity
-- counted from there (falls back to created_at when null).
alter table public.task_templates drop column if exists week_interval;
alter table public.task_templates drop column if exists week_anchor;
alter table public.task_templates
  add column if not exists recur_interval smallint not null default 1,
  add column if not exists recur_anchor date;
