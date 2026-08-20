-- device_inventory / device_sales / consumption_export_skips: stop letting any
-- signed-in person write the ordering tables.
--
-- WAS: di_write / ds_write / ces_write were all `ALL USING (true) WITH CHECK (true)`,
-- so ANY authenticated session -- including `candidate`, a role that by design
-- has not started work yet -- could insert, update or DELETE these rows.
--
-- Not theoretical. device-orders.html:235 does
--     var del = await sb.from('device_inventory').delete().gte('rq_id', 0);
-- a full wipe followed by a re-insert. That is the legitimate manual zip/csv
-- upload fallback, so write access cannot be removed -- only scoped to the
-- people the page is already meant for.
--
-- consumption.view is that gate: nav.js's own acc: key for both
-- device-orders.html and consumption-report.html, and the PAGEACC entry for
-- both. Granted to owner/admin/team_member, so everyone who legitimately uses
-- these pages keeps working; what changes is that a session which is not
-- supposed to be in these tools can no longer write via PostgREST directly.
--
-- has_perm() not is_admin(): the question is "may this person use the ordering
-- tools", which is a permission. is_admin() would lock out the team_members who
-- actually do the ordering.
--
-- READS DELIBERATELY LEFT OPEN (di_read / ds_read / ces_read stay true). This is
-- inventory data, not customer or staff data, and the concern here was
-- integrity -- a tech dropping the device inventory -- not confidentiality.
--
-- Service-role writers unaffected: repairq-devices-sync writes both device
-- tables through repairq-query, bypassing RLS.
--
-- VERIFIED as codextest (team_member, holds consumption.view): reads still
-- 66 / 189 / 563 rows, and an insert into consumption_export_skips still
-- succeeds -- no regression for the manual upload path.
alter policy di_write on public.device_inventory
  using ( has_perm('consumption.view') ) with check ( has_perm('consumption.view') );

alter policy ds_write on public.device_sales
  using ( has_perm('consumption.view') ) with check ( has_perm('consumption.view') );

alter policy ces_write on public.consumption_export_skips
  using ( has_perm('consumption.view') ) with check ( has_perm('consumption.view') );
