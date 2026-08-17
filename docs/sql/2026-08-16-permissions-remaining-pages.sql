-- The rest of the pages that had no permission key. Grants deliberately mirror
-- the access each page already enforced in its own gate, so nothing changes for
-- anyone today — the point is that these can now be granted or revoked from
-- Settings › Roles & Permissions instead of being welded to a role.
insert into permissions (key, label, category, sort, page, is_access) values
  ('reports.traffic',   'Access Google Traffic',   'Reports',   20, 'google-traffic.html',      true),
  ('reports.reviews',   'Access Google Reviews',   'Reports',   30, 'google-reviews.html',      true),
  ('reports.overtime',  'Access Overtime Report',  'Reports',   40, 'report-overtime.html',     true),
  ('onboarding.manage', 'Access Onboarding',       'Employees', 50, 'onboarding-dashboard.html',true),
  ('kb.compliance',     'Access KB Compliance',    'Employees', 60, 'kb-compliance.html',       true),
  ('inventory.editor',  'Access Inventory Editor', 'Tools',     30, 'inventory-editor.html',    true)
on conflict (key) do nothing;

-- checklist.manage already existed and was granted to admin+owner, but nothing
-- ever checked it; Task Admin now does.
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where p.key in ('reports.traffic','reports.reviews','reports.overtime',
                'onboarding.manage','kb.compliance','inventory.editor')
  and r.key in ('admin','owner')
on conflict do nothing;
