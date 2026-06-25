-- Service sales revenue on commission_sales.
-- The commission_service feed can now carry a service revenue (sales $) column;
-- it lands here (NOT counted as a service unit). Used by the Commission Dashboard
-- leaderboard "Services" mode to rank/show real sales dollars instead of payout.

alter table commission_sales add column if not exists service_net numeric not null default 0;

-- The ingest commission_service feed routes any column named (case-insensitive)
-- one of: Net · Net Sales · Service Net · Services Net · Service Sales ·
-- Service Revenue · Service Total · Service $ · Sales · Revenue · Amount
-- into service_net via the money() parser. All other numeric columns stay as
-- per-service unit counts in the services jsonb. Deployed in ingest v28.
