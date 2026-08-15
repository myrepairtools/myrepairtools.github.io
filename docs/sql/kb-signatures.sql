-- Signature-required KB articles.
--
-- kb_articles.require_ack is a click: "I read it." Some documents need more
-- than that — a policy the employee actually signs, filed against their person
-- like the offer letter and handbook acknowledgment already are.
--
-- require_signature is the stronger tier and IMPLIES require_ack, so every
-- existing compliance surface (Training's assigned list, kb-compliance's
-- roster and receipts, the overdue flag, the publish alert fanout) keeps
-- working untouched — signing just adds an artifact on top of the receipt.
--
-- The artifact is a FROZEN PDF in staff_documents, built at the moment of
-- signing from the article body as it read then. Same reasoning as the
-- handbook acknowledgment: these articles get edited, and what someone signed
-- must never change underneath them. kb_signatures.article_version binds the
-- signature to the exact wording (kb_article_versions), which is also what
-- makes "this policy changed, everyone re-signs" a decidable question instead
-- of a judgment call.

alter table kb_articles
  add column if not exists require_signature boolean not null default false;

comment on column kb_articles.require_signature is
  'Employee must sign this article, not just acknowledge it. Implies require_ack.';

create table if not exists kb_signatures (
  id              bigserial primary key,
  article_id      bigint not null references kb_articles(id) on delete cascade,
  article_version integer not null,
  staff_id        bigint not null references staff(id) on delete cascade,
  signed_name     text   not null,
  signature_png   text,                       -- data URL, the drawn signature
  signed_at       timestamptz not null default now(),
  ip              text,
  ua              text,
  document_id     bigint references staff_documents(id) on delete set null,
  created_at      timestamptz not null default now(),
  -- one signature per person per version; re-signing a NEW version adds a row
  -- and keeps the old one, so the history of what they agreed to stays intact
  unique (staff_id, article_id, article_version)
);

create index if not exists kb_signatures_article_idx on kb_signatures(article_id);
create index if not exists kb_signatures_staff_idx   on kb_signatures(staff_id);

alter table kb_signatures enable row level security;

-- Employees read their own signatures; managers read everyone's (that's the
-- compliance roster). Nobody writes from the browser — signing goes through
-- the kb-sign edge function, which is what builds and files the PDF. A
-- client-inserted row would be a signature record with no document behind it.
drop policy if exists kb_signatures_read_own on kb_signatures;
create policy kb_signatures_read_own on kb_signatures
  for select to authenticated
  using (
    is_admin()
    or staff_id in (select id from staff where auth_uid = auth.uid())
  );

-- staff_documents already carries the signed artifact. kind 'policy' is the
-- new one; source is 'kb:<slug>:v<version>', which composes with the existing
-- (staff_id, kind, source) idempotency so re-signing a revised policy files a
-- second document rather than colliding with the first.
-- kb_articles.version bumps on EVERY save, so binding signature staleness to
-- it would make a typo fix force the whole team to re-sign. Signatures get
-- their own epoch instead, advanced only when the author explicitly says the
-- revision is material ("Require new signatures" at publish) — the same shape
-- as the existing "Require re-read" reset.
alter table kb_articles
  add column if not exists signature_version integer not null default 1;
comment on column kb_articles.signature_version is
  'Signature epoch. Bumping it makes every existing signature stale and asks everyone to sign again. Independent of version, which bumps on every edit.';

alter table kb_signatures
  add column if not exists signature_epoch integer;
update kb_signatures set signature_epoch = article_version where signature_epoch is null;
alter table kb_signatures alter column signature_epoch set not null;

-- article_version stays as the audit record of the exact wording signed (it is
-- what the frozen PDF prints); the epoch is what decides "do they owe us one".
alter table kb_signatures drop constraint if exists kb_signatures_staff_id_article_id_article_version_key;
alter table kb_signatures add constraint kb_signatures_staff_article_epoch_key
  unique (staff_id, article_id, signature_epoch);
