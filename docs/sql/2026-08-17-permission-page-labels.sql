-- Permission page labels: the audit batch went in with raw filenames as their
-- "page", which read as daily-digest.html next to Cash Tracker in the role
-- editor. Alphabetical order made it obvious. Applied 2026-08-17.
update public.permissions set page = case key
  when 'reports.digest'     then 'Daily Digest'
  when 'reports.reviews'    then 'Google Reviews'
  when 'reports.traffic'    then 'Google Traffic'
  when 'interviews.manage'  then 'Bookings'
  when 'inventory.editor'   then 'Inventory Editor'
  when 'kb.compliance'      then 'KB Compliance'
  when 'onboarding.manage'  then 'Onboarding'
  when 'reports.overtime'   then 'Overtime Report'
  else page end
where page like '%.html';
