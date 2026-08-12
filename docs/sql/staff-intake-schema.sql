-- New-hire intake — catch-up record + round-2 deltas (idempotent).
--
-- Public token page (intake.html, token = the credential, same pattern as
-- contract-sign/interview) writes through the `intake` edge function with the
-- service role — the browser NEVER reads staff_intake directly. Managers read
-- and promote from the Onboarding dashboard / Team Members.

create table if not exists public.staff_intake (
  id               bigint generated always as identity primary key,
  token            text not null unique,
  status           text not null default 'sent',       -- sent -> submitted -> promoted
  invited_name     text,
  invited_store    text,
  invited_by       bigint,
  legal_first      text, legal_middle text, legal_last text,
  preferred_name   text,
  pronouns         text,                                -- legacy column; round 2 stops collecting it
  dob              date,
  phone            text,
  personal_email   text,
  address          jsonb,
  emergency        jsonb,
  emergency2       jsonb,
  shirt_size       text,
  transportation   text,                                -- legacy column; round 2 stops collecting it
  availability     jsonb,                               -- [{day,mode:'all'|'hours'|'off',from,to}] — structured, never free text
  contact_pref     text,
  i9_docs          text,
  submitted_at     timestamptz,
  promoted_staff_id bigint,
  promoted_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
-- round-2 delta: availability was text; structured now (safe — applied when empty)
-- alter table public.staff_intake alter column availability type jsonb using nullif(availability,'')::jsonb;
-- candidate-stage delta (2026-08-12): offer-letter + handbook-signature columns,
-- status 'declined', and the app_settings 'hiring.offer_template' seed live in
-- docs/sql/candidate-stage.sql.

alter table public.staff_intake enable row level security;
drop policy if exists staff_intake_admin on public.staff_intake;
create policy staff_intake_admin on public.staff_intake for all to authenticated using (is_admin()) with check (is_admin());
-- no anon policy on purpose: the public page goes through the intake edge function.

-- Manual new-hire setup checklist ticks (the trust-me items; auto-verified
-- rows are computed live from staff/staff_profiles/staff_schedule/etc and
-- never stored). item keys: i9 | qbw_invite | rq_creds | shirt | team_chat
create table if not exists public.staff_setup_checklist (
  id         bigint generated always as identity primary key,
  staff_id   bigint not null references public.staff(id) on delete cascade,
  item       text not null,
  checked_by bigint,
  checked_at timestamptz not null default now(),
  unique (staff_id, item)
);
alter table public.staff_setup_checklist enable row level security;
drop policy if exists ssc_admin on public.staff_setup_checklist;
create policy ssc_admin on public.staff_setup_checklist for all to authenticated using (is_admin()) with check (is_admin());
