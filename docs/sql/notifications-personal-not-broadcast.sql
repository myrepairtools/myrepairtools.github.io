-- Notifications: personal alerts, not all-staff broadcasts.
--
-- The Communications feed had filled up with machine-generated posts nobody had
-- asked for (owner report 2026-08-20: eight Google-review replies in one week).
-- Standing directive now in CLAUDE.md / AGENTS.md: an automated event fires a
-- personal, user-manageable alert; the Communications feed is for posts a human
-- wrote, or a broadcast the owner explicitly sanctioned. Never both for one event.
--
-- Feed posts in the 60 days to 2026-08-20, by source:
--     12  hand-written by a manager      <- what the feed is for
--      9  KB article publish             <- removed in code (knowledge.html)
--      7  interviews.booked/.canceled    <- unrouted earlier
--      5  schedule.manual_broadcast      <- KEEP: the sanctioned exception
--      4  GBP weekly digest              <- removed in code (gbp-sync)
--      3  contracts.paid                 <- unrouted here
--      3  anniversaries / birthdays      <- KEEP: the team is the audience
--
-- This file unroutes contracts.paid from the in-app channel. The RULE row stays
-- enabled, so the owner can still wire contract-paid to SMS, email or a webhook
-- in Settings > Notifications; only the link to the Communications Feed goes.
-- In its place the contracts edge function sends a muteable 'payment' alert to
-- the tech who wrote the contract and to the owners.
--
-- Idempotent: re-running deletes nothing once the link is gone.

delete from notification_rule_channels rc
using notification_rules r, notification_channels c
where rc.rule_id = r.id
  and rc.channel_id = c.id
  and r.event_key = 'contracts.paid'
  and c.type = 'inapp';

-- Verify -- expect only schedule.manual_broadcast and records.anniversary:
--   select c.name, string_agg(r.event_key, ', ' order by r.event_key)
--     from notification_channels c
--     left join notification_rule_channels rc on rc.channel_id = c.id
--     left join notification_rules r on r.id = rc.rule_id and r.enabled
--    where c.type = 'inapp'
--    group by c.name;
