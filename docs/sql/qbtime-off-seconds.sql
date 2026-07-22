-- Time-off seconds counted as worked hours (the Dylan bug): QB Time writes
-- time off as timesheets against PTO/Unpaid-Time-Off jobcodes, and most
-- consumers summed `seconds` blindly ("Unpaid Time Off" is type
-- unpaid_time_off, so even the pto-only filters missed it).
-- Fix at the source: off_seconds = seconds logged against ANY time-off
-- jobcode (type pto or unpaid_time_off). Worked time = seconds - off_seconds.
-- qbtime-sync computes it on every write; this backfills history.
alter table public.qbtime_timesheets add column if not exists off_seconds int not null default 0;
update public.qbtime_timesheets t
set off_seconds = sub.off
from (
  select t2.qbt_user_id, t2.biz_date,
         coalesce(sum(case when j.type in ('pto','unpaid_time_off') then (kv.value)::numeric else 0 end),0)::int as off
  from public.qbtime_timesheets t2
  cross join lateral jsonb_each_text(coalesce(t2.jobcodes,'{}'::jsonb)) kv
  left join public.qbtime_jobcodes j on j.qbt_id = kv.key
  group by t2.qbt_user_id, t2.biz_date
) sub
where sub.qbt_user_id = t.qbt_user_id and sub.biz_date = t.biz_date;
