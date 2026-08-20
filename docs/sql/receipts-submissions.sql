-- Receipts (manager receipt drop, 2026-08-20): managers snap a receipt + note on
-- receipts.html; rows land in expense_receipts as status 'review' for the owner
-- to categorize (expense account + class) and book to QBO from the same page —
-- the existing qbo create_expense pipeline, so idempotency, the DocNumber
-- recovery probe, and the photo attachment are all shared with Expenses.

-- a submission has no category yet — the owner fills it at review
alter table public.expense_receipts alter column expense_account_id drop not null;
alter table public.expense_receipts alter column payment_account_id drop not null;

-- who submitted (uuid for "own rows" RLS; created_by keeps the display name)
alter table public.expense_receipts add column if not exists submitted_by uuid;

-- the live table carried TWO status checks (the schema doc's inline one landed
-- as _chk) — both have to go before the widened one lands
alter table public.expense_receipts drop constraint if exists expense_receipts_status_chk;
alter table public.expense_receipts drop constraint if exists expense_receipts_status_check;
alter table public.expense_receipts add constraint expense_receipts_status_check
  check (status in ('review','pending','posting','posted','failed'));

-- managers: insert their own 'review' submissions + read their own rows back
drop policy if exists expense_receipts_mgr_insert on public.expense_receipts;
create policy expense_receipts_mgr_insert on public.expense_receipts for insert
  to authenticated with check (is_admin() and status = 'review' and submitted_by = auth.uid());
drop policy if exists expense_receipts_mgr_select on public.expense_receipts;
create policy expense_receipts_mgr_select on public.expense_receipts for select
  to authenticated using (is_admin() and submitted_by = auth.uid());

-- managers can put a photo in the private receipts bucket (reads stay owner-only)
drop policy if exists receipts_mgr_insert on storage.objects;
create policy receipts_mgr_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and is_admin());

-- which door the receipt came through: 'page' (receipts.html submit) or 'email'
-- (the receipts-inbound forward address). The owner's review log lists rows with
-- a source; the owner's own Expenses rows stay source-null and never appear there.
alter table public.expense_receipts add column if not exists source text;
-- inbound idempotency — Resend retries webhooks; 'email:<email_id>:<attachment_id>'
alter table public.expense_receipts add column if not exists source_ref text;
create unique index if not exists expense_receipts_source_ref_uidx on public.expense_receipts (source_ref) where source_ref is not null;

-- page access: owner + admin
insert into public.permissions (key, label, category, description, sort, page, is_access)
values ('receipts.submit', 'Access Receipts', 'Cash', 'Snap a receipt for the owner to review + book', 27, 'Receipts', true)
on conflict (key) do nothing;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.key in ('owner','admin') and p.key = 'receipts.submit'
  and not exists (select 1 from public.role_permissions x where x.role_id = r.id and x.permission_id = p.id);
