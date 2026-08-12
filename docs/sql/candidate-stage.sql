-- Candidate stage (2026-08-12) — treat new hires as "New Candidates" first.
--
-- The hiring pipeline gains a pre-acceptance phase: a candidate's link now
-- opens with a signable OFFER LETTER (accept or decline), then the EMPLOYEE
-- HANDBOOK (rendered live from the KB's Employee Handbook category, signed as
-- an acknowledgment), and only then the new-hire form. Everything is written
-- through the `intake` edge function — the browser never reads staff_intake.
-- Once the docs + form are back, the manager converts the candidate to a New
-- Employee (the existing promote), which kicks off QBO back-office steps and
-- module auto-assign. A declined offer parks the row as status 'declined'.
--
-- status flow: sent -> (declined) -> submitted -> promoted
--   offer/handbook signing happens while status is still 'sent'; 'declined'
--   is terminal (row stays for the record; deletable via cancel).

alter table public.staff_intake add column if not exists position        text;
alter table public.staff_intake add column if not exists pay             text;         -- free text, e.g. "$18/hr + commission"
alter table public.staff_intake add column if not exists start_hint      text;         -- proposed start, free text
alter table public.staff_intake add column if not exists offer_body      text;         -- SNAPSHOT of the offer letter as sent (null = docs phase skipped)
alter table public.staff_intake add column if not exists offer_signature text;         -- data:image/png;base64
alter table public.staff_intake add column if not exists offer_signed_name text;
alter table public.staff_intake add column if not exists offer_signed_at timestamptz;
alter table public.staff_intake add column if not exists offer_declined_at timestamptz;
alter table public.staff_intake add column if not exists decline_note    text;
alter table public.staff_intake add column if not exists handbook_signature text;
alter table public.staff_intake add column if not exists handbook_signed_name text;
alter table public.staff_intake add column if not exists handbook_signed_at timestamptz;
alter table public.staff_intake add column if not exists signed_meta     jsonb;        -- {offer:{ip,ua},handbook:{ip,ua}}

-- Default offer-letter template (owner-editable in app_settings; the New
-- Candidate modal prefills from it, resolves the {placeholders}, and lets the
-- manager edit before the snapshot lands in staff_intake.offer_body).
insert into public.app_settings (key, value)
values ('hiring.offer_template', jsonb_build_object('body',
'Dear {name},

We''re excited to offer you the position of {position} at CPR Cell Phone Repair — {store} (iRepair Phone Shop, LLC).

Compensation: {pay}
Proposed start date: {start}

This offer is contingent on completing your new-hire paperwork, including I-9 employment eligibility verification on or before your first day. Employment is at-will: either you or the company may end the employment relationship at any time, with or without cause or notice.

To accept, sign below. After signing you''ll review the Employee Handbook and fill out your new-hire form — the whole thing takes about 10 minutes.

We''re looking forward to having you on the team!

— CPR Cell Phone Repair, Oregon'))
on conflict (key) do nothing;
