-- Store contact info shown to interview candidates (booking page, confirmation
-- text/email, add-to-calendar event) and editable in Settings → Locations.
-- address existed already; phone + email added 2026-07-26. The three stores'
-- address + phone were filled from the stores' own public listings, verified
-- against gbp_locations.phone (our Google Business data). email left null
-- until the owner fills it in.
alter table stores add column if not exists phone text;
alter table stores add column if not exists email text;
