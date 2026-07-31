-- Brand Assets — CPR-branded print collateral library (posters, flyers, sale
-- sheets, business cards, logos). "Grab & print in-store": any signed-in staff
-- can browse, upload, and manage; removal is a soft-delete (active=false) so an
-- accidental delete never destroys a file. Files live in the public
-- `brand-assets` Storage bucket (this table is the index + metadata).
--
-- Apply: run in the Supabase SQL editor (or management API database/query).

create table if not exists brand_assets (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,
  -- poster | flyer | sale_sheet | business_card | logo | other
  category         text not null default 'other',
  file_path        text not null,            -- path within the brand-assets bucket
  file_name        text,                     -- original filename (for download)
  file_ext         text,                     -- pdf, png, jpg, svg, …
  mime             text,
  file_size        bigint,
  thumb_path       text,                     -- optional generated preview (image) in the bucket
  width            int,
  height           int,
  tags             text[] not null default '{}',
  note             text,
  active           boolean not null default true,
  uploaded_by      bigint references staff(id),
  uploaded_by_name text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists brand_assets_active_idx   on brand_assets(active);
create index if not exists brand_assets_category_idx on brand_assets(category);
create index if not exists brand_assets_created_idx  on brand_assets(created_at desc);

-- keep updated_at fresh
create or replace function brand_assets_touch() returns trigger
  language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists brand_assets_touch on brand_assets;
create trigger brand_assets_touch before update on brand_assets
  for each row execute function brand_assets_touch();

alter table brand_assets enable row level security;

-- Read: any signed-in staff. Write/manage: any signed-in staff (owner's call —
-- brand-consistency is a social norm here, not an RLS gate). Removal goes
-- through UPDATE (active=false); hard DELETE stays owner-only as an escape hatch.
drop policy if exists brand_assets_read   on brand_assets;
drop policy if exists brand_assets_insert on brand_assets;
drop policy if exists brand_assets_update on brand_assets;
drop policy if exists brand_assets_delete on brand_assets;
create policy brand_assets_read   on brand_assets for select to authenticated using (true);
create policy brand_assets_insert on brand_assets for insert to authenticated with check (true);
create policy brand_assets_update on brand_assets for update to authenticated using (true) with check (true);
create policy brand_assets_delete on brand_assets for delete to authenticated using (is_owner());

-- ---------------------------------------------------------------------------
-- Storage bucket policies (bucket `brand-assets`, public read). The bucket
-- itself is created via the Storage API; these policies govern writes.
-- Public read is implicit for a public bucket; writes need authenticated staff.
drop policy if exists brand_assets_obj_insert on storage.objects;
drop policy if exists brand_assets_obj_update on storage.objects;
drop policy if exists brand_assets_obj_delete on storage.objects;
create policy brand_assets_obj_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'brand-assets');
create policy brand_assets_obj_update on storage.objects for update to authenticated
  using (bucket_id = 'brand-assets') with check (bucket_id = 'brand-assets');
create policy brand_assets_obj_delete on storage.objects for delete to authenticated
  using (bucket_id = 'brand-assets');
