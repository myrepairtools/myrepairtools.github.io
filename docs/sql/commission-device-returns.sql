-- Device returns (clawback) on commission_sales.
-- A separate Looker "device returns" report (a clone of the device sales merge,
-- filtered to returns, with the last column = Accessories Returned instead of
-- Accessory Count) posts to the ingest feed `commission_device_return`.
--
-- Returns land in their OWN columns so a sales post and a returns post for the same
-- (biz_date, store, employee) never clobber each other (partial-column upsert):
--   device_returns        -- count of returned devices  (owned by the returns feed now;
--                            the sales feed no longer writes it)
--   device_return_net     -- returned revenue   (arrives negative, e.g. -349.99)
--   device_return_gp      -- returned gross profit (arrives negative, e.g. -152.40)
--   device_attach_return  -- accessories returned on device tickets (positive count)
--
-- The calculator + dashboard addInto() net these into the existing totals, so every
-- downstream calc/display uses net values with no engine change:
--   netDev      = device_units  - device_returns
--   DeviceGP    = device_gp     + device_return_gp   (return gp is negative)
--   DeviceRev   = device_net    + device_return_net  (return net is negative)
--   DeviceAttach= device_attach - device_attach_return
--
-- Deployed in ingest v33.

alter table commission_sales add column if not exists device_return_gp     numeric not null default 0;
alter table commission_sales add column if not exists device_return_net    numeric not null default 0;
alter table commission_sales add column if not exists device_attach_return numeric not null default 0;
