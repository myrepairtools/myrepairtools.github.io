-- Candidate pay + commission — the wizard's new Pay step (idempotent).
--
-- The offer letter has always carried pay as one free-text line ("$16.00 per
-- hour"), which reads fine on the PDF but tells the system nothing: we could
-- not answer "is this hire on commission?" without reading the letter. Pay is
-- now structured, and `pay` stays as the RENDERED string so every offer
-- already signed keeps its exact wording (offer_body is a frozen snapshot and
-- must never be recomputed).
--
-- commission_earns mirrors commission_roster.earns_override
-- ({accessory, device, services}) so promote can hand it straight over —
-- see supabase/functions/intake/index.ts.

alter table public.staff_intake
  add column if not exists pay_type         text,           -- 'hourly' | 'salary'
  add column if not exists pay_amount       numeric(10,2),  -- per hour, or per MONTH for salary
  add column if not exists commission       boolean not null default false,
  add column if not exists commission_earns jsonb;          -- {accessory:bool, device:bool, services:bool}

alter table public.staff_intake drop constraint if exists staff_intake_pay_type_ck;
alter table public.staff_intake add constraint staff_intake_pay_type_ck
  check (pay_type is null or pay_type in ('hourly','salary'));

comment on column public.staff_intake.pay_amount is
  'Hourly rate, or MONTHLY salary — salary is always stored per month (the wizard says so on the field).';
comment on column public.staff_intake.pay is
  'Rendered pay line as it appears in the signed offer letter. Display only — never recompute it for a sent offer.';

-- RLS is unchanged: staff_intake stays admin-only (docs/sql/staff-intake-schema.sql),
-- and the candidate-facing page reads through the intake edge function, whose
-- PUBLIC_FIELDS list deliberately excludes pay.

-- Proposed start became a day picker (same split as pay): start_date is the
-- real date, start_hint stays the rendered line the offer letter shows.
alter table public.staff_intake add column if not exists start_date date;

-- Two-stage hiring flow: the offer link ends at the signature, and signing
-- fires a separate new-hire email (handbook + intake form + their signed PDF).
alter table public.staff_intake add column if not exists newhire_sent_at timestamptz;

-- Day-one SMS: 7:30am store-local on their start date, from the STORE's own
-- RingCentral line (not the company alerts number), reminding them which I-9
-- documents they told us they'd bring. Stamped so it can only fire once.
alter table public.staff_intake add column if not exists dayone_sms_at timestamptz;

-- QBO employee creation on submit. Verified against the live company: the
-- Accounting API's Employee list IS the payroll employee list (64 = 64; Britt
-- Bay is Id 575 in both). No payroll OAuth scope needed. Duplicate guard
-- matches GivenName + FamilyName because QBO stores DisplayName as
-- "First M. Last". Enabled via app_settings 'hiring.qbo_autocreate' = true.
alter table public.staff_intake add column if not exists qbo_employee_id text;
alter table public.staff_intake add column if not exists qbo_synced_at timestamptz;
alter table public.staff_intake add column if not exists qbo_error text;
