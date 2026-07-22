-- Employee records: who logged the entry + when the conversation happened.
-- created_by = staff id of the manager who created the record (display only);
-- discussed_at = date of the conversation with the employee (pairs with the
-- existing `discussed` boolean; null when discussed is false or legacy).
alter table public.staff_entries
  add column if not exists created_by bigint,
  add column if not exists discussed_at date;
alter table public.staff_pips
  add column if not exists created_by bigint;
