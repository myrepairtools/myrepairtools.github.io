-- Per-weekday assignment overrides for task templates. The daily resolver
-- (tasks edge function) checks day_assignments[<dow>] first (0=Sun..6=Sat);
-- if present it resolves WHO from that override for that day, else the
-- template's own target. Shape (only days the recurrence runs are kept):
--   { "6": {"target":"shift","shift_id":11}, "0": {"target":"shift","shift_id":11} }
-- Powers e.g. "weekdays → Mid shift, weekends → Open shift".
alter table public.task_templates add column if not exists day_assignments jsonb;
