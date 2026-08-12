-- Price Guide entries — 2026-08-12
--
-- The price guide lived only as hand-authored HTML (price-guide.html + a
-- drifted copy in the extension). This table is the AI-readable source the
-- cpr-assistant retrieves from (standing directive: data in clean tables).
-- Imported from price-guide.html; the pages still render their own HTML for
-- now — re-import after editing the page (scratchpad pg_import.py).

create table if not exists public.price_guide_entries (
  id          bigint generated always as identity primary key,
  section     text not null,          -- Accessories / Phone Repair / Tablet Repair / ...
  subsection  text,                   -- table heading within the section
  item        text not null,          -- first column (item / device / service)
  details     text,                   -- remaining descriptive columns, ' · ' joined
  sku         text,
  price       text,                   -- verbatim ("$79.99", "Parts + $100") — rules aren't numbers
  sort        integer not null default 0,
  updated_at  timestamptz not null default now(),
  search      tsvector generated always as (
    to_tsvector('english', coalesce(section,'')||' '||coalesce(subsection,'')||' '
      ||coalesce(item,'')||' '||coalesce(details,'')||' '||coalesce(sku,'')||' '||coalesce(price,''))
  ) stored
);
create index if not exists price_guide_entries_search on public.price_guide_entries using gin (search);

alter table public.price_guide_entries enable row level security;
drop policy if exists pge_read on public.price_guide_entries;
create policy pge_read on public.price_guide_entries for select to authenticated using (true);
-- writes: service-role only (the import script)
