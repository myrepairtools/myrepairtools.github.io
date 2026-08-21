-- Time-off NOTES are owner/manager material; the DATES are not.
--
-- Employees seeing each other's booked dates is deliberate (owner's call) --
-- people plan around each other. The free-text reason is a different matter:
-- "why" can be a medical detail, a family problem, a funeral.
--
-- The split is enforced with a COLUMN-level revoke rather than a second table,
-- and the note comes back through time_off_notes(p_ids) -- SECURITY DEFINER,
-- returning a note only to a manager over that store or to the person who
-- wrote it.
--
-- ORDER MATTERS. Do not run this until the frontend that stops selecting `note`
-- is LIVE. Until then time-off.html, schedule-admin.html and
-- employee-records.html still ask for the column and would break on deploy.
-- Also watch for `insert(...).select()` with no column list: that is
-- RETURNING *, which needs SELECT on every column and fails after this runs.
-- Both such call sites (my-schedule.html, time-off.html) were made explicit
-- first.

revoke select (note) on public.time_off_requests from authenticated;

-- Verify as a real low-privilege user over REST (never in the SQL editor,
-- which runs as superuser and bypasses all of this):
--   GET /rest/v1/time_off_requests?select=note   -> 401/42501
--   GET /rest/v1/time_off_requests?select=id,start_date,end_date -> 200
--   POST /rest/v1/rpc/time_off_notes {"p_ids":[...]} -> only own/managed rows
