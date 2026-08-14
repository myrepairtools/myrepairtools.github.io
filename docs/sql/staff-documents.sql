-- Staff documents — the HR file that outlives the hire (idempotent).
--
-- Until now a signed offer letter existed in exactly one place: the
-- `staff_intake` row, rebuilt into a PDF on demand from the candidate's token.
-- That row is a HIRING record — the Onboarding dashboard hides it once the
-- person is promoted — so the moment someone became an employee their signed
-- paperwork became unreachable. Signed documents belong to the PERSON, not to
-- the funnel that produced them.
--
-- So: promote now FREEZES each document to a PDF in the private `hr-private`
-- bucket and files it here, and Team Members grows a Documents tab. Frozen
-- matters — the handbook acknowledgment renders from live KB articles, so a
-- regenerated copy would silently show today's wording instead of what they
-- actually signed.
--
-- The same table takes hand-uploaded files (I-9 copies, write-ups, anything
-- that arrives on paper), which is why `kind` is open text rather than an enum.

create table if not exists public.staff_documents (
  id               bigint generated always as identity primary key,
  staff_id         bigint not null references public.staff(id) on delete cascade,
  kind             text   not null,          -- offer | handbook | intake_form | upload
  title            text   not null,
  file_path        text   not null,          -- hr-private: staff/<staff_id>/<uuid>.<ext>
  file_name        text,
  mime             text default 'application/pdf',
  file_size        integer,
  signed_at        timestamptz,              -- when the PERSON signed it (null for uploads)
  source           text,                     -- e.g. 'intake:42' — what produced it
  note             text,
  uploaded_by      bigint references public.staff(id) on delete set null,
  uploaded_by_name text,
  created_at       timestamptz not null default now(),
  deleted          boolean not null default false
);

create index if not exists staff_documents_staff_idx on public.staff_documents(staff_id, created_at desc);

-- Archiving is re-runnable: the same source + kind lands on the same row
-- instead of stacking duplicates every time promote is retried. Deliberately
-- NOT a partial index — ON CONFLICT (and so PostgREST's upsert) can't target
-- one. Plain uniqueness is right anyway: `source` is null on hand-filed
-- uploads, and Postgres treats nulls as distinct, so you can file as many of
-- those as you like.
alter table public.staff_documents drop constraint if exists staff_documents_source_uq;
drop index if exists public.staff_documents_source_uq;
alter table public.staff_documents
  add constraint staff_documents_source_uq unique (staff_id, kind, source);

alter table public.staff_documents enable row level security;

-- Managers read and file documents; the person can read their own; only the
-- owner may hard-delete (the UI soft-deletes instead).
drop policy if exists staff_documents_read on public.staff_documents;
create policy staff_documents_read on public.staff_documents for select to authenticated
  using (
    is_admin()
    or staff_id in (select id from public.staff where auth_uid = auth.uid())
  );
drop policy if exists staff_documents_write on public.staff_documents;
create policy staff_documents_write on public.staff_documents for insert to authenticated
  with check (is_admin());
drop policy if exists staff_documents_update on public.staff_documents;
create policy staff_documents_update on public.staff_documents for update to authenticated
  using (is_admin()) with check (is_admin());
drop policy if exists staff_documents_delete on public.staff_documents;
create policy staff_documents_delete on public.staff_documents for delete to authenticated
  using (is_owner());

-- Storage. `hr-private` already exists (it holds the owner's countersignature
-- at the bucket root, service-role only). These policies open ONLY the
-- staff/<id>/ prefix, and only to managers — the root stays untouched.
drop policy if exists hr_staff_docs_read   on storage.objects;
create policy hr_staff_docs_read on storage.objects for select to authenticated
  using (bucket_id = 'hr-private' and (storage.foldername(name))[1] = 'staff' and is_admin());
drop policy if exists hr_staff_docs_insert on storage.objects;
create policy hr_staff_docs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'hr-private' and (storage.foldername(name))[1] = 'staff' and is_admin());
drop policy if exists hr_staff_docs_update on storage.objects;
create policy hr_staff_docs_update on storage.objects for update to authenticated
  using (bucket_id = 'hr-private' and (storage.foldername(name))[1] = 'staff' and is_admin());
drop policy if exists hr_staff_docs_delete on storage.objects;
create policy hr_staff_docs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'hr-private' and (storage.foldername(name))[1] = 'staff' and is_owner());
