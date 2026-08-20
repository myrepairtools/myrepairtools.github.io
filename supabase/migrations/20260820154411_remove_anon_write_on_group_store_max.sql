-- group_store_max: remove anonymous write access.
--
-- WHY. This is the only table in the schema carrying explicit {anon} policies,
-- and it had all four -- SELECT, INSERT, UPDATE and DELETE, every expression
-- literally `true`. Combined with the INSERT/UPDATE/DELETE grants held by anon,
-- any unauthenticated request carrying the published anon key could write to it.
--
-- SEVERITY: LOW, stated honestly. The table holds 0 rows and is referenced
-- NOWHERE in the repo -- zero matches across *.html, *.js, *.ts, *.sql and
-- *.md. It feeds nothing and holds nothing, so the realistic worst case today
-- is an attacker inserting junk into dead schema. It is fixed because the door
-- is open, the fix is free, and an anonymous write path should not exist.
--
-- EVIDENCE THESE POLICIES ARE LEGACY DEBRIS, not a workflow: the table is
-- closed to `authenticated` entirely (grants but ZERO policies, so RLS denies
-- it), while its two sibling tables use the correct modern pattern --
--   max_overrides.cfg_write        }  {authenticated},
--   group_max_overrides.gmo_write  }  can_see_store(store)
--                                  }    AND has_perm('consumption.overrides')
-- A table whose only reachable caller is anonymous, while its siblings require
-- a permission, is a mistake rather than a design.
--
-- The SELECT policy is deliberately LEFT IN PLACE. This change is about the
-- write hole; whether an unused table should keep an anonymous read policy --
-- or be dropped outright -- is the owner's call and belongs in its own change.
--
-- VERIFIED after applying, anonymously over the REST API with no Authorization
-- header: INSERT returns 42501 "permission denied for table group_store_max";
-- SELECT still returns HTTP 200; row count still 0. One SELECT policy remains.
drop policy if exists "anon insert group_store_max" on public.group_store_max;
drop policy if exists "anon update group_store_max" on public.group_store_max;
drop policy if exists "anon delete group_store_max" on public.group_store_max;

-- Belt and braces: the grants are what make a future permissive policy
-- dangerous. `authenticated` is included because it holds write grants while
-- having no policy at all -- pointless privilege either way.
revoke insert, update, delete, truncate, references, trigger
  on public.group_store_max from anon, authenticated;
