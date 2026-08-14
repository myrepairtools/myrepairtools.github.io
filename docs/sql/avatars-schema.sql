-- Employee profile photos (owner ask 2026-08-14). staff_profiles.photo_path was
-- reserved for this from the start ("avatars bucket (later)") — this is the
-- bucket and the FK that finally use it.
--
-- Public bucket: an avatar is shown in the nav on every page, so a signed URL
-- per render would be pure overhead for a photo of a staff member wearing a
-- company shirt. Writes are authenticated-only; the person's OWN row is what
-- staff_profiles RLS protects, so nobody can point a teammate's row at a file.

insert into storage.buckets (id, name, public) values ('avatars','avatars',true)
  on conflict (id) do update set public = true;

drop policy if exists avatars_read   on storage.objects;
drop policy if exists avatars_write  on storage.objects;
drop policy if exists avatars_update on storage.objects;
drop policy if exists avatars_delete on storage.objects;
create policy avatars_read   on storage.objects for select using (bucket_id = 'avatars');
create policy avatars_write  on storage.objects for insert to authenticated with check (bucket_id = 'avatars');
create policy avatars_update on storage.objects for update to authenticated using (bucket_id = 'avatars');
create policy avatars_delete on storage.objects for delete to authenticated using (bucket_id = 'avatars');

-- The FK lets nav.js pull the photo inside its existing staff query
-- (staff_profiles(photo_path)) instead of a second round-trip on every page.
alter table public.staff_profiles
  add constraint staff_profiles_staff_id_fkey
  foreign key (staff_id) references public.staff(id) on delete cascade;
