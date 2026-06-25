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
-- The returns feed only counts rows where money was actually refunded (Device Net Sale
-- Price < 0). This skips EXCHANGES (device returned AND re-sold on the same ticket, net
-- ~$0 — the sold side is already in the sales report) and $0-refund warranty/RMA
-- "returns" that move no money but carry a GP entry (e.g. RQ refund-bug manual
-- corrections). Neither should touch commission.
--
-- Deployed in ingest v33 (returns feed) / v34 (exchange guard) / v35 (Net Sale < 0).

alter table commission_sales add column if not exists device_return_gp     numeric not null default 0;
alter table commission_sales add column if not exists device_return_net    numeric not null default 0;
alter table commission_sales add column if not exists device_attach_return numeric not null default 0;
