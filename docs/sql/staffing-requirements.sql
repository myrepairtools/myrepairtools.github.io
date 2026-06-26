-- Per-store staffing minimums that drive Schedule Admin's Monthly coverage pills
-- and the time-off approval conflict flag. Weekday vs weekend, since weekends
-- usually run lighter. Set in Settings → Locations (the store editor).
alter table stores add column if not exists min_staff int default 2;     -- weekday min people
alter table stores add column if not exists min_mgr int default 1;        -- weekday min managers
alter table stores add column if not exists we_min_staff int default 2;   -- weekend min people
alter table stores add column if not exists we_min_mgr int default 1;     -- weekend min managers
