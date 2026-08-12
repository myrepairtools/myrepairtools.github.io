-- Team Members consolidation — 2026-08-12
--
-- Schema for the consolidated Team Members page (employee-records.html):
-- termination record fields on staff. Phone/Email deliberately live in
-- staff_profiles (phone / personal_email — already exist, and the SMS pipeline
-- reads staff_profiles.phone) rather than duplicated onto staff; the page edits
-- them through cpr-auth's update_staff so admin writes bypass the self-only RLS.
--
-- commission_snapshots already lets employees read their own rows (snap_sel:
-- staff_id = my_staff_id() OR is_admin()); no RLS change for Commission → History.

alter table public.staff add column if not exists terminated_at date;
alter table public.staff add column if not exists termination_reason text;
alter table public.staff add column if not exists termination_note text;
alter table public.staff add column if not exists rehire_eligible boolean;
alter table public.staff add column if not exists terminated_by bigint;
