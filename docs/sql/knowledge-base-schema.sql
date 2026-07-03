-- Knowledge Base — "the brain": SOPs & policies, repair knowledge, training,
-- tools how-tos. Manager-authored, everyone reads, and the cpr-assistant edge
-- function retrieves from it so the AI answers from OUR docs with citations.
--
-- Body is the site's light markup (same family as Communications):
--   # / ## headings, **bold**, *italic*, __underline__, "- " bullets,
--   "1. " numbered, [text](url) links, bare URLs, ![alt](url) images, --- rule.
-- Rendered client-side after HTML-escaping; images live in the public
-- kb-media storage bucket.
--
-- Surfaces: knowledge.html (My Hub) + dashboard widget + cpr-assistant RAG.

-- ---------- categories ----------
create table if not exists kb_categories (
  id bigint generated always as identity primary key,
  name text not null unique,
  icon text not null default '📄',
  sort int not null default 100,
  description text
);

-- ---------- articles ----------
create table if not exists kb_articles (
  id bigint generated always as identity primary key,
  slug text unique,                          -- stable link target (from title)
  title text not null,
  category_id bigint references kb_categories(id),
  tags text[] not null default '{}',
  summary text,                              -- one-liner for cards + AI context
  body text not null default '',
  status text not null default 'draft' check (status in ('draft','published','archived')),
  min_role text not null default 'employee' check (min_role in ('employee','manager')),
  require_ack boolean not null default false, -- training: must read & acknowledge
  version int not null default 1,
  created_by bigint references staff(id),
  updated_by bigint references staff(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  search tsvector
);
create index if not exists kb_articles_search_idx on kb_articles using gin(search);
create index if not exists kb_articles_cat_idx on kb_articles(category_id);

-- weighted tsvector maintained by trigger (array_to_string isn't immutable,
-- so a generated column can't do this)
create or replace function kb_articles_tsv() returns trigger
language plpgsql as $$
begin
  new.search :=
      setweight(to_tsvector('english', coalesce(new.title,'')), 'A')
   || setweight(to_tsvector('english', coalesce(array_to_string(new.tags,' '),'')), 'A')
   || setweight(to_tsvector('english', coalesce(new.summary,'')), 'B')
   || setweight(to_tsvector('english', coalesce(new.body,'')), 'C');
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists kb_articles_tsv_trg on kb_articles;
create trigger kb_articles_tsv_trg before insert or update of title, tags, summary, body
  on kb_articles for each row execute function kb_articles_tsv();

-- ---------- version history (snapshot on every save) ----------
create table if not exists kb_article_versions (
  id bigint generated always as identity primary key,
  article_id bigint not null references kb_articles(id) on delete cascade,
  version int not null,
  title text, summary text, body text, tags text[],
  edited_by bigint references staff(id),
  edited_at timestamptz not null default now()
);
create index if not exists kb_versions_article_idx on kb_article_versions(article_id, version desc);

-- ---------- reads & acknowledgments (training) ----------
create table if not exists kb_reads (
  id bigint generated always as identity primary key,
  article_id bigint not null references kb_articles(id) on delete cascade,
  staff_id bigint not null references staff(id) on delete cascade,
  first_read_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  unique (article_id, staff_id)
);

-- ---------- RLS ----------
alter table kb_categories enable row level security;
alter table kb_articles enable row level security;
alter table kb_article_versions enable row level security;
alter table kb_reads enable row level security;

drop policy if exists kb_cat_read  on kb_categories;
drop policy if exists kb_cat_write on kb_categories;
create policy kb_cat_read  on kb_categories for select to authenticated using (true);
create policy kb_cat_write on kb_categories for all to authenticated using (is_admin()) with check (is_admin());

-- everyone reads published articles at their role; managers see everything
drop policy if exists kb_art_read  on kb_articles;
drop policy if exists kb_art_write on kb_articles;
create policy kb_art_read on kb_articles for select to authenticated
  using (is_admin() or (status = 'published' and min_role = 'employee'));
create policy kb_art_write on kb_articles for all to authenticated
  using (is_admin()) with check (is_admin());

drop policy if exists kb_ver_rw on kb_article_versions;
create policy kb_ver_rw on kb_article_versions for all to authenticated
  using (is_admin()) with check (is_admin());

-- reads: own rows; managers see all (training receipts)
drop policy if exists kb_reads_sel on kb_reads;
drop policy if exists kb_reads_ins on kb_reads;
drop policy if exists kb_reads_upd on kb_reads;
create policy kb_reads_sel on kb_reads for select to authenticated
  using (staff_id = my_staff_id() or is_admin());
create policy kb_reads_ins on kb_reads for insert to authenticated
  with check (staff_id = my_staff_id());
create policy kb_reads_upd on kb_reads for update to authenticated
  using (staff_id = my_staff_id()) with check (staff_id = my_staff_id());

-- ---------- search (RLS applies via security invoker) ----------
create or replace function kb_search(q text, max_results int default 8)
returns table (
  id bigint, slug text, title text, summary text, category_id bigint,
  tags text[], status text, updated_at timestamptz,
  rank real, snippet text
)
language sql stable security invoker as $$
  select a.id, a.slug, a.title, a.summary, a.category_id, a.tags, a.status, a.updated_at,
         ts_rank(a.search, websearch_to_tsquery('english', q)) as rank,
         ts_headline('english', left(a.body, 4000), websearch_to_tsquery('english', q),
                     'MaxWords=30, MinWords=12, StartSel=**, StopSel=**') as snippet
  from kb_articles a
  where a.status = 'published'
    and a.search @@ websearch_to_tsquery('english', q)
  order by rank desc, a.updated_at desc
  limit greatest(1, least(max_results, 20));
$$;

-- seed starter categories (idempotent)
insert into kb_categories (name, icon, sort, description) values
  ('SOPs & Policies',   '📘', 10, 'How we operate: returns, warranties, cash, opening/closing, HR basics'),
  ('Repair Knowledge',  '🔧', 20, 'Device-specific guides, known issues, board-level notes, parts gotchas'),
  ('Training',          '🎓', 30, 'Onboarding & skills — read-and-acknowledge material'),
  ('Tools & Systems',   '🧰', 40, 'How to use myRepairTools, RepairQ, the extension, QB Time, Square'),
  ('Vendors & Contacts','🤝', 50, 'Who we buy from / send to, terms, contacts, turnaround times')
on conflict (name) do nothing;

-- ---------- engagement: was this helpful? ----------
create table if not exists kb_feedback (
  id bigint generated always as identity primary key,
  article_id bigint not null references kb_articles(id) on delete cascade,
  staff_id bigint not null references staff(id) on delete cascade,
  helpful boolean not null,
  note text,
  created_at timestamptz not null default now(),
  unique (article_id, staff_id)
);
alter table kb_feedback enable row level security;
drop policy if exists kb_fb_sel on kb_feedback;
drop policy if exists kb_fb_ins on kb_feedback;
drop policy if exists kb_fb_upd on kb_feedback;
create policy kb_fb_sel on kb_feedback for select to authenticated
  using (staff_id = my_staff_id() or is_admin());
create policy kb_fb_ins on kb_feedback for insert to authenticated
  with check (staff_id = my_staff_id());
create policy kb_fb_upd on kb_feedback for update to authenticated
  using (staff_id = my_staff_id()) with check (staff_id = my_staff_id());

-- ---------- retrieval for the assistant (strict AND, then loose OR fallback) ----------
-- SECURITY DEFINER + execute revoked from browser roles: only the edge function
-- (service role) calls this — the mgr flag would otherwise let an employee pull
-- manager-only article text through PostgREST.
create or replace function kb_retrieve(q text, mgr boolean default false, max_results int default 4)
returns table (slug text, title text, summary text, body text, rank real)
language plpgsql stable security definer set search_path = public as $$
declare tsq_and tsquery; tsq_or tsquery;
begin
  tsq_and := websearch_to_tsquery('english', q);
  begin
    tsq_or := replace(plainto_tsquery('english', q)::text, ' & ', ' | ')::tsquery;
  exception when others then tsq_or := tsq_and;
  end;
  return query
  select a.slug, a.title, a.summary, left(a.body, 2600) as body,
         (ts_rank(a.search, tsq_and) * 2 + ts_rank(a.search, tsq_or))::real as rank
  from kb_articles a
  where a.status = 'published' and (mgr or a.min_role = 'employee')
    and (a.search @@ tsq_and or a.search @@ tsq_or)
  order by rank desc, a.updated_at desc
  limit greatest(1, least(max_results, 8));
end $$;
revoke execute on function kb_retrieve(text, boolean, int) from public, anon, authenticated;

-- page search gets the same loose fallback (still RLS-scoped, published-only)
create or replace function kb_search(q text, max_results int default 8)
returns table (
  id bigint, slug text, title text, summary text, category_id bigint,
  tags text[], status text, updated_at timestamptz,
  rank real, snippet text
)
language plpgsql stable security invoker as $$
declare tsq_and tsquery; tsq_or tsquery;
begin
  tsq_and := websearch_to_tsquery('english', q);
  begin
    tsq_or := replace(plainto_tsquery('english', q)::text, ' & ', ' | ')::tsquery;
  exception when others then tsq_or := tsq_and;
  end;
  return query
  select a.id, a.slug, a.title, a.summary, a.category_id, a.tags, a.status, a.updated_at,
         (ts_rank(a.search, tsq_and) * 2 + ts_rank(a.search, tsq_or))::real as rank,
         ts_headline('english', left(a.body, 4000), coalesce(nullif(tsq_and, ''::tsquery), tsq_or),
                     'MaxWords=30, MinWords=12, StartSel=**, StopSel=**') as snippet
  from kb_articles a
  where a.status = 'published'
    and (a.search @@ tsq_and or a.search @@ tsq_or)
  order by rank desc, a.updated_at desc
  limit greatest(1, least(max_results, 20));
end $$;

-- managers can reset acknowledgments (re-certification after a policy change)
drop policy if exists kb_reads_admin_upd on kb_reads;
create policy kb_reads_admin_upd on kb_reads for update to authenticated
  using (is_admin()) with check (is_admin());
