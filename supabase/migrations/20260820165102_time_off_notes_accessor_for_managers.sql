-- time_off_requests.note: give managers (and the author) a way to read the note
-- without every employee being able to.
--
-- THE FEATURE THAT MUST NOT BREAK, in the owner's words: an employee making a
-- time-off request needs to see on the calendar what days a colleague has
-- already requested, so they know whether there is a conflict before they book
-- a holiday. That is WHICH DAYS -- dates, type, status -- and tor_read stays
-- `USING (true)` so it keeps working exactly as designed.
--
-- What is NOT part of that feature is the free-text `note` on the same row. For
-- a Sick request that is where a medical reason lands, and Oregon sick time
-- means it eventually will. Owner's decision: note is owner/manager only.
--
-- WHY A FUNCTION AND NOT A VIEW. RLS is row-level; it cannot mask a column. A
-- view that nulls the note for non-managers would, without security_invoker,
-- run as its owner and bypass RLS entirely -- precisely the defect that made
-- staff_roster and staff_directory anonymously readable (fixed in
-- 20260820150332 / 20260820154603). Adding another one of those to fix a
-- privacy problem would be the wrong shape. SECURITY DEFINER functions are the
-- pattern this codebase already uses for this (kb_most_read,
-- competition_standings, ms_ordered_for_day) and EXECUTE can be revoked.
--
-- Takes an array so a manager page fetches every note in ONE call, not N+1.
--
-- VERIFIED: codextest (team_member, Eugene) asking for all 5 notes they do not
-- own -> 0 rows. Anonymous -> 42501 permission denied. The dates feature
-- unchanged: codextest still sees all 13 requests.
create or replace function public.time_off_notes(p_ids bigint[])
returns table (id bigint, note text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select t.id, t.note
    from time_off_requests t
   where t.id = any(p_ids)
     and ( is_admin(norm_store(t.store))        -- a manager over that store
        or t.staff_id = my_staff_id() );        -- or the person who wrote it
$function$;

revoke all on function public.time_off_notes(bigint[]) from public, anon;
grant execute on function public.time_off_notes(bigint[]) to authenticated;

comment on function public.time_off_notes(bigint[]) is
  'Reads time_off_requests.note for a set of request ids, but only for a manager over that request''s store or the person who wrote it. Exists because RLS cannot mask a column and tor_read is deliberately open so teammates can see each other''s DATES. Pair with revoking column-level select(note) on the table once every page reads notes through here.';
