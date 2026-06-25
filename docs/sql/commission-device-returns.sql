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
-- The returns feed SKIPS exchanges — rows where a device was returned AND re-sold on
-- the same ticket (Device Sale Count > 0, net ~$0). The sold side is already in the
-- sales report, so counting the return would wrongly cancel a legit sale. Only pure
-- returns (Device Sale Count = 0) are processed.
--
-- Deployed in ingest v33 (returns feed) / v34 (exchange guard).

alter table commission_sales add column if not exists device_return_gp     numeric not null default 0;
alter table commission_sales add column if not exists device_return_net    numeric not null default 0;
alter table commission_sales add column if not exists device_attach_return numeric not null default 0;
