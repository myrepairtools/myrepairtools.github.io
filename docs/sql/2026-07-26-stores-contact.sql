-- Store contact info shown to interview candidates (booking page, confirmation
-- text/email, add-to-calendar event) and editable in Settings → Locations.
-- address existed already; phone + email added 2026-07-26. The three stores'
-- address + phone were filled from OUR OWN Google Business Profile listings
-- (gbp-sync ?action=location_contact — storefrontAddress + primaryPhone).
-- Google is the verification source; stores (Settings → Locations) is the
-- runtime authority. email left null until the owner fills it in.
alter table stores add column if not exists phone text;
alter table stores add column if not exists email text;
