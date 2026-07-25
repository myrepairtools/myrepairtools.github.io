-- Interview booking — our own scheduler. The host declares weekly windows;
-- nothing else (no calendar sync) ever blocks a slot. Slots are computed live
-- from availability − bookings − blackouts, so there's no generation cron.

create table if not exists public.interview_settings (
  staff_id bigint primary key references public.staff(id) on delete cascade,
  active boolean not null default true,          -- accepting bookings at all
  slot_minutes int not null default 30,
  buffer_minutes int not null default 15,        -- gap left after each interview
  lead_hours int not null default 12,            -- min notice before a slot is bookable
  horizon_days int not null default 21,          -- how far out the page shows
  max_per_day int not null default 4,
  blurb text,                                    -- shown to the candidate
  updated_at timestamptz not null default now()
);

-- Recurring weekly windows, in store-local minutes from midnight.
create table if not exists public.interview_availability (
  id bigserial primary key,
  staff_id bigint not null references public.staff(id) on delete cascade,
  store text,                                    -- where the interview happens
  weekday int not null check (weekday between 0 and 6),   -- 0=Sun
  start_min int not null check (start_min >= 0 and start_min < 1440),
  end_min int not null check (end_min > 0 and end_min <= 1440),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (end_min > start_min)
);
create index if not exists interview_avail_staff on public.interview_availability(staff_id, weekday);

-- One-off "I'm out" blocks. staff_id null = blocks everyone (holiday etc).
create table if not exists public.interview_blackouts (
  id bigserial primary key,
  staff_id bigint references public.staff(id) on delete cascade,
  block_date date not null,
  start_min int, end_min int,                    -- null/null = the whole day
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists interview_blackout_date on public.interview_blackouts(block_date);

create table if not exists public.interview_bookings (
  id bigserial primary key,
  token text unique not null,                    -- candidate's capability link
  staff_id bigint not null references public.staff(id),
  store text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  candidate_name text not null,
  candidate_phone text,
  candidate_email text,
  position text,
  notes text,
  status text not null default 'booked'
    check (status in ('booked','canceled','completed','no_show')),
  canceled_at timestamptz,
  canceled_by text,
  reminded_24h boolean not null default false,
  confirm_sms boolean not null default false,
  confirm_email boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists interview_book_slot on public.interview_bookings(staff_id, starts_at) where status = 'booked';
create index if not exists interview_book_when on public.interview_bookings(starts_at);

alter table public.interview_settings     enable row level security;
alter table public.interview_availability enable row level security;
alter table public.interview_blackouts    enable row level security;
alter table public.interview_bookings     enable row level security;

-- Staff read everything; you manage your own rows, admins manage anyone's.
drop policy if exists ivs_read on public.interview_settings;
create policy ivs_read on public.interview_settings for select to authenticated using (true);
drop policy if exists ivs_write on public.interview_settings;
create policy ivs_write on public.interview_settings for all to authenticated
  using (is_admin() or staff_id = (select id from public.staff where auth_uid = auth.uid()))
  with check (is_admin() or staff_id = (select id from public.staff where auth_uid = auth.uid()));

drop policy if exists iva_read on public.interview_availability;
create policy iva_read on public.interview_availability for select to authenticated using (true);
drop policy if exists iva_write on public.interview_availability;
create policy iva_write on public.interview_availability for all to authenticated
  using (is_admin() or staff_id = (select id from public.staff where auth_uid = auth.uid()))
  with check (is_admin() or staff_id = (select id from public.staff where auth_uid = auth.uid()));

drop policy if exists ivb_read on public.interview_blackouts;
create policy ivb_read on public.interview_blackouts for select to authenticated using (true);
drop policy if exists ivb_write on public.interview_blackouts;
create policy ivb_write on public.interview_blackouts for all to authenticated
  using (is_admin() or staff_id = (select id from public.staff where auth_uid = auth.uid()))
  with check (is_admin() or staff_id = (select id from public.staff where auth_uid = auth.uid()));

-- Bookings: staff read + update (mark completed / no-show / cancel). Candidate
-- writes happen ONLY through the edge function (service role), never the browser.
drop policy if exists ivb_r on public.interview_bookings;
create policy ivb_r on public.interview_bookings for select to authenticated using (true);
drop policy if exists ivb_u on public.interview_bookings;
create policy ivb_u on public.interview_bookings for update to authenticated
  using (is_admin() or staff_id = (select id from public.staff where auth_uid = auth.uid()))
  with check (is_admin() or staff_id = (select id from public.staff where auth_uid = auth.uid()));
