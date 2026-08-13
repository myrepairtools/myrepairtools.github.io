-- KB browse redesign (2026-08-12, design handoff 13c/14a/17a/19a/20a) —
-- two-axis facets + the search-first portal home.
--
-- Sub-categories are ONE axis (e.g. Repair Knowledge's "Device": iPhone,
-- Samsung…) rendered as pills in the topic band; tags are the SECOND axis
-- (e.g. "Component": Screens, Batteries…) rendered as chips on the surface.
-- Both are optional per category and freely combinable; the labels over each
-- row come from the category config — nothing about "Device"/"Component" is
-- baked into code. Managed in knowledge.html's Categories view (KB nav pane →
-- Manage → Categories).

alter table public.kb_categories add column if not exists subcat_label text;  -- label over the pills, e.g. 'Device'
alter table public.kb_categories add column if not exists tag_label   text;   -- label over the chips, e.g. 'Component'

create table if not exists public.kb_subcategories (
  id          bigint generated always as identity primary key,
  category_id bigint not null references public.kb_categories(id) on delete cascade,
  name        text not null,
  sort        int  not null default 0
);
alter table public.kb_articles add column if not exists subcategory_id bigint references public.kb_subcategories(id) on delete set null;

-- Tags are CATEGORY-SCOPED (a "Screens" tag in Repair Knowledge is not the
-- same tag as one in Tools & Systems) — picked per-article in the editor.
create table if not exists public.kb_tags (
  id          bigint generated always as identity primary key,
  category_id bigint not null references public.kb_categories(id) on delete cascade,
  name        text not null,
  sort        int  not null default 0
);
create table if not exists public.kb_article_tags (
  article_id bigint not null references public.kb_articles(id) on delete cascade,
  tag_id     bigint not null references public.kb_tags(id) on delete cascade,
  primary key (article_id, tag_id)
);

alter table public.kb_subcategories enable row level security;
alter table public.kb_tags          enable row level security;
alter table public.kb_article_tags  enable row level security;
drop policy if exists kb_subcat_read  on public.kb_subcategories;
drop policy if exists kb_subcat_write on public.kb_subcategories;
create policy kb_subcat_read  on public.kb_subcategories for select to authenticated using (true);
create policy kb_subcat_write on public.kb_subcategories for all    to authenticated using (is_admin()) with check (is_admin());
drop policy if exists kb_tags_read  on public.kb_tags;
drop policy if exists kb_tags_write on public.kb_tags;
create policy kb_tags_read  on public.kb_tags for select to authenticated using (true);
create policy kb_tags_write on public.kb_tags for all    to authenticated using (is_admin()) with check (is_admin());
drop policy if exists kb_arttags_read  on public.kb_article_tags;
drop policy if exists kb_arttags_write on public.kb_article_tags;
create policy kb_arttags_read  on public.kb_article_tags for select to authenticated using (true);
create policy kb_arttags_write on public.kb_article_tags for all    to authenticated using (is_admin()) with check (is_admin());

-- "Most read this month" on the portal home. kb_reads is per-person RLS, so
-- the aggregate is a SECURITY DEFINER count — it returns ONLY (article_id, n);
-- the page joins against the articles the caller can already see, so
-- manager-only titles never leak to employees.
create or replace function public.kb_most_read(days int default 30)
returns table(article_id bigint, n bigint)
language sql security definer set search_path = public as $$
  select r.article_id, count(distinct r.staff_id)::bigint as n
  from kb_reads r
  where coalesce(r.last_viewed_at, r.first_read_at) > now() - make_interval(days => days)
  group by r.article_id
  order by n desc, r.article_id
  limit 12
$$;
revoke all on function public.kb_most_read(int) from public;
grant execute on function public.kb_most_read(int) to authenticated;

-- Card order inside a topic view (drag-to-organize on the category grid).
-- Deliberately NOT kb_articles.sort_order — that orders module tracks
-- (Training), and rearranging a category's browse grid must never reorder
-- anyone's onboarding sequence. null = falls after ordered cards (newest
-- first among themselves).
alter table public.kb_articles add column if not exists browse_order int;

-- Manager/owner-only categories (owner ask 2026-08-12): kb_categories.min_role
-- ('employee' default | 'manager') hides the tile + topic view from
-- employees. UI gating only — the real enforcement stays kb_articles RLS, and
-- the editor forces min_role='manager' on any article saved into a gated
-- category so content can never leak through a mislabeled article.
alter table public.kb_categories add column if not exists min_role text not null default 'employee';
