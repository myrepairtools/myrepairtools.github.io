-- New-hire intake — step 1 of the hiring flow.
--
--   1. new hire fills the intake form   <- this
--   2. owner sets them up in QuickBooks (employee self-setup) and requests
--      RepairQ credentials from corporate
--   3. owner creates them in MRT and assigns onboarding
--
-- The form exists because self-serve profile completion doesn't happen: 3 of 9
-- current staff have no emergency contact on file and 0 have a birthday, so the
-- milestones cron's birthday posts have never fired for anyone. This is the one
-- moment where that data reliably gets captured.
--
-- DELIBERATELY NOT COLLECTED: SSN, bank / routing numbers, W-4 elections. Those
-- go straight into QuickBooks via its Workforce self-setup invite, so they never
-- touch this database. MRT ships a committed anon key with deterrent-level gates
-- — a correct posture for an internal tool and the wrong home for that data.
-- I-9 documents stay physical; the form only records what the hire plans to bring.
--
-- The candidate never touches the staff tables. They write a PENDING row here,
-- and a manager promotes it into staff + staff_profiles afterwards.
--
-- Access is the same capability-URL shape as contracts and interview bookings:
-- the token IS the credential. But rather than an edge function (those exist for
-- things needing server-held API keys — this needs none), the public surface is
-- two SECURITY DEFINER RPCs. The table itself stays closed to anon entirely.
--
-- Apply: run in the Supabase SQL editor (or management API database/query).

create table if not exists public.staff_intake (
  id            bigint generated always as identity primary key,
  token         text not null unique default encode(gen_random_bytes(24), 'hex'),
  status        text not null default 'pending',   -- pending | submitted | promoted | void

  -- seeded by the manager when the invite is created
  invited_name  text,                              -- so the page can greet them by name
  invited_store text,
  invited_by    bigint,

  -- filled by the new hire
  legal_first   text,
  legal_middle  text,
  legal_last    text,
  preferred_name text,
  pronouns      text,
  dob           date,
  phone         text,
  personal_email text,
  address       jsonb,                             -- {street, unit, city, state, zip}
  emergency     jsonb,                             -- {name, relation, phone}
  emergency2    jsonb,
  shirt_size    text,
  transportation text,
  availability  text,
  contact_pref  text,
  i9_docs       text,

  submitted_at  timestamptz,
  promoted_staff_id bigint,
  promoted_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists staff_intake_status_idx on public.staff_intake (status, created_at desc);

alter table public.staff_intake enable row level security;
-- No anon policy at all: the public page reaches this table ONLY through the
-- definer RPCs below, which scope every read and write to a single token.
drop policy if exists staff_intake_read  on public.staff_intake;
create policy staff_intake_read  on public.staff_intake for select to authenticated using (is_admin());
drop policy if exists staff_intake_write on public.staff_intake;
create policy staff_intake_write on public.staff_intake for all to authenticated
  using (is_admin()) with check (is_admin());

-- ------------------------------------------------------------- public surface
-- What the candidate's page may READ: their own row, by token, and only the
-- fields the form needs back. Never the whole table, never another row.
create or replace function public.intake_get(p_token text)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  select to_jsonb(x) from (
    select i.status, i.invited_name, i.invited_store,
           i.legal_first, i.legal_middle, i.legal_last, i.preferred_name, i.pronouns,
           i.dob, i.phone, i.personal_email, i.address, i.emergency, i.emergency2,
           i.shirt_size, i.transportation, i.availability, i.contact_pref, i.i9_docs,
           i.submitted_at
      from staff_intake i
     where i.token = p_token
     limit 1
  ) x;
$function$;

-- Save/submit. Refuses once the row has been promoted, so a stale link can't
-- overwrite a hire who is already set up. Re-submitting before promotion is
-- allowed on purpose — people fix typos.
create or replace function public.intake_submit(p_token text, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare cur staff_intake%rowtype;
begin
  select * into cur from staff_intake where token = p_token;
  if cur.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if cur.status in ('promoted','void') then
    return jsonb_build_object('ok', false, 'error', 'closed');
  end if;

  update staff_intake set
    legal_first    = nullif(trim(p_data->>'legal_first'), ''),
    legal_middle   = nullif(trim(p_data->>'legal_middle'), ''),
    legal_last     = nullif(trim(p_data->>'legal_last'), ''),
    preferred_name = nullif(trim(p_data->>'preferred_name'), ''),
    pronouns       = nullif(trim(p_data->>'pronouns'), ''),
    dob            = nullif(p_data->>'dob', '')::date,
    phone          = nullif(trim(p_data->>'phone'), ''),
    personal_email = nullif(trim(p_data->>'personal_email'), ''),
    address        = case when p_data ? 'address'    then p_data->'address'    else address    end,
    emergency      = case when p_data ? 'emergency'  then p_data->'emergency'  else emergency  end,
    emergency2     = case when p_data ? 'emergency2' then p_data->'emergency2' else emergency2 end,
    shirt_size     = nullif(trim(p_data->>'shirt_size'), ''),
    transportation = nullif(trim(p_data->>'transportation'), ''),
    availability   = nullif(trim(p_data->>'availability'), ''),
    contact_pref   = nullif(trim(p_data->>'contact_pref'), ''),
    i9_docs        = nullif(trim(p_data->>'i9_docs'), ''),
    status         = 'submitted',
    submitted_at   = now(),
    updated_at     = now()
  where id = cur.id;

  return jsonb_build_object('ok', true);
end
$function$;

-- Promote: copy the intake into an ALREADY-CREATED staff row. The manager still
-- creates the person normally (role, store, PIN are their decisions, not the
-- candidate's) — this just fills in everything the hire already told us so it
-- isn't retyped, and stamps the intake closed.
create or replace function public.intake_promote(p_intake_id bigint, p_staff_id bigint)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare cur staff_intake%rowtype;
begin
  if not is_admin() then raise exception 'not authorized'; end if;
  select * into cur from staff_intake where id = p_intake_id;
  if cur.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  update staff set
    first_name     = coalesce(cur.legal_first, first_name),
    last_name      = coalesce(cur.legal_last, last_name),
    preferred_name = coalesce(cur.preferred_name, preferred_name),
    birthday       = coalesce(cur.dob, birthday)
  where id = p_staff_id;

  insert into staff_profiles (staff_id, phone, personal_email, address, emergency, shirt_size)
  values (p_staff_id, cur.phone, cur.personal_email, cur.address, cur.emergency, cur.shirt_size)
  on conflict (staff_id) do update set
    phone          = coalesce(excluded.phone,          staff_profiles.phone),
    personal_email = coalesce(excluded.personal_email, staff_profiles.personal_email),
    address        = coalesce(excluded.address,        staff_profiles.address),
    emergency      = coalesce(excluded.emergency,      staff_profiles.emergency),
    shirt_size     = coalesce(excluded.shirt_size,     staff_profiles.shirt_size),
    updated_at     = now();

  update staff_intake set status='promoted', promoted_staff_id=p_staff_id,
         promoted_at=now(), updated_at=now()
   where id = cur.id;

  return jsonb_build_object('ok', true);
end
$function$;

revoke all on function public.intake_get(text)             from public;
revoke all on function public.intake_submit(text, jsonb)   from public;
revoke all on function public.intake_promote(bigint,bigint) from public, anon;
grant execute on function public.intake_get(text)           to anon, authenticated;
grant execute on function public.intake_submit(text, jsonb) to anon, authenticated;
grant execute on function public.intake_promote(bigint,bigint) to authenticated;
