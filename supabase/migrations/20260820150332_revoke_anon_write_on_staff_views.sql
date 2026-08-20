-- Security fix 2026-08-20 (applied to production as migration 20260820150332).
--
-- staff_roster and staff_directory are auto-updatable views over `staff` with
-- security_invoker NOT set, so they execute as the view owner and RLS on `staff`
-- never applies. Both `anon` and `authenticated` held full write privileges on
-- them, and `role` + `active` are writable columns through the views — so an
-- unauthenticated request carrying the public anon key could PATCH a staff row's
-- role to 'owner', or deactivate the whole roster. No login required.
--
-- SELECT is deliberately left in place: cash-tracker.html, cash-admin.html,
-- settings.html, my-schedule.html, assets/comms.js and
-- assets/celebrations-summary.js all read these views, and nothing writes
-- through them. Revoking anon's SELECT (staff PII: names, roles, stores,
-- start dates, birthdays, terminated staff) is a separate decision.
--
-- Verified after applying:
--   anon/authenticated grants  -> SELECT only
--   anon read                  -> 200, 12 and 14 rows (unchanged, nothing broke)
--   anon PATCH {"role":"owner"} -> permission denied on both views
revoke insert, update, delete, truncate, references, trigger
  on public.staff_roster, public.staff_directory
  from anon, authenticated;
