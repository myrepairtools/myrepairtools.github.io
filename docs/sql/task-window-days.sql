-- Completion window for weekly/monthly tasks: the instance generates on its
-- scheduled day but is DUE window_days later (0 = due same day, the default).
-- e.g. claim-eligible inventory count: loads Monday, due Wednesday = 2.
-- On-time scoring keys off due_at, so any day inside the window is on-time.
alter table public.task_templates
  add column if not exists window_days smallint not null default 0;
