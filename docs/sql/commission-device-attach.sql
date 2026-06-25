-- Device-attach (paid accessories on device tickets) on commission_sales.
-- The commission_device dashboard export now carries a per-ticket "Accessory Count"
-- column — the number of PAID accessories ( Net Sale > 0 ) sold on the same ticket as
-- the device, with $0 warranty/giveaway lines already filtered out in Looker.
--
-- The ingest commission_device feed sums this per (biz_date, store, employee), counting
-- each ticket ONCE (a 2-device ticket repeats the same count on both rows). It feeds the
-- engine's device-attach bonus: attach rate = device_attach / net devices, compared to
-- the store/role/person devAttachReq. Replaces the old manual "Acc on device" input.
--
-- Deployed alongside ingest device-parser rename (Ticket Number / Device Sale Count /
-- Device Net Sale Price / Accessory Count column headers from the dashboard CSV export).

alter table commission_sales add column if not exists device_attach numeric not null default 0;
