-- ============================================================================
-- GBP: retire the pre-engine unanswered backlog (owner decision 2026-07-22).
-- ~1,200 reviews were never answered before the review engine existed; the
-- owner chose not to reply to them ("the damage is already done"), so they
-- must not count as actionable anywhere — nav pill, dashboard widget, the
-- Google Reviews Unanswered filter/stepper, or the Google Traffic
-- "Unanswered now" matrix row. They stay visible in the feed (muted "no
-- reply" pill) and can still be answered by hand from the drawer — a manual
-- reply simply fills reply_text and the flag stops mattering for that row.
-- New reviews are never flagged; the engine's SLA/alert queries also exclude
-- legacy rows (belt and braces — they're all far older than its windows).
-- ============================================================================

alter table gbp_reviews add column if not exists legacy_unanswered boolean not null default false;

-- one-time marking, run 2026-07-22 (newest unanswered at the time: 2026-03-21)
update gbp_reviews
   set legacy_unanswered = true
 where reply_text is null
   and deleted_at is null
   and created_at < timestamptz '2026-07-22'
   and legacy_unanswered = false;
