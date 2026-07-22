-- ============================================================
-- KB redesign + onboarding layer (design handoff Jul 2026)
-- Extends the existing KB (kb_articles / kb_reads / kb_categories):
--   quizzes (answers NEVER client-readable; grading via SECURITY DEFINER),
--   onboarding modules (sequenced tracks), per-article emoji + module slot.
-- ============================================================

-- per-article icon + onboarding placement
alter table public.kb_articles
  add column if not exists emoji text,
  add column if not exists module_id bigint,
  add column if not exists sort_order int not null default 0;

-- last_viewed_at: the Viewed column (first_read_at = first open, kept)
alter table public.kb_reads
  add column if not exists last_viewed_at timestamptz;

-- ---------- onboarding tracks ----------
create table if not exists public.onboarding_modules (
  id bigint generated always as identity primary key,
  name text not null,             -- "Week 1 — Bench basics"
  subtitle text,                  -- "Read in order · quizzes unlock as you go"
  sort int not null default 0,
  active boolean not null default true
);
alter table public.onboarding_modules enable row level security;
drop policy if exists "read modules" on public.onboarding_modules;
create policy "read modules" on public.onboarding_modules for select using (true);
drop policy if exists "admin write modules" on public.onboarding_modules;
create policy "admin write modules" on public.onboarding_modules for all using (is_admin()) with check (is_admin());

-- one track per person; created lazily on first visit (started date = created)
create table if not exists public.onboarding_assignments (
  id bigint generated always as identity primary key,
  staff_id bigint not null unique references public.staff(id),
  started_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table public.onboarding_assignments enable row level security;
drop policy if exists "own or admin read" on public.onboarding_assignments;
create policy "own or admin read" on public.onboarding_assignments for select
  using (staff_id = my_staff_id() or is_admin());
drop policy if exists "own insert" on public.onboarding_assignments;
create policy "own insert" on public.onboarding_assignments for insert
  with check (staff_id = my_staff_id() or is_admin());
drop policy if exists "own or admin update" on public.onboarding_assignments;
create policy "own or admin update" on public.onboarding_assignments for update
  using (staff_id = my_staff_id() or is_admin());

-- ---------- quizzes ----------
create table if not exists public.kb_quizzes (
  id bigint generated always as identity primary key,
  article_id bigint not null unique references public.kb_articles(id) on delete cascade,
  pass_pct int not null default 80,
  active boolean not null default true
);
alter table public.kb_quizzes enable row level security;
drop policy if exists "read quizzes" on public.kb_quizzes;
create policy "read quizzes" on public.kb_quizzes for select using (true);
drop policy if exists "admin write quizzes" on public.kb_quizzes;
create policy "admin write quizzes" on public.kb_quizzes for all using (is_admin()) with check (is_admin());

-- question text + options are client-readable; the CORRECT INDEX IS NOT —
-- it lives in kb_quiz_answers (no select policy at all). Grading happens in
-- kb_quiz_grade() below, so the right answer never reaches the browser.
create table if not exists public.kb_quiz_questions (
  id bigint generated always as identity primary key,
  quiz_id bigint not null references public.kb_quizzes(id) on delete cascade,
  sort int not null default 0,
  question text not null,
  options jsonb not null default '[]'::jsonb,   -- ["opt A","opt B",...]
  section_hint text                              -- "Covered in: <hint>" on a miss
);
alter table public.kb_quiz_questions enable row level security;
drop policy if exists "read questions" on public.kb_quiz_questions;
create policy "read questions" on public.kb_quiz_questions for select using (true);
drop policy if exists "admin write questions" on public.kb_quiz_questions;
create policy "admin write questions" on public.kb_quiz_questions for all using (is_admin()) with check (is_admin());

create table if not exists public.kb_quiz_answers (
  question_id bigint primary key references public.kb_quiz_questions(id) on delete cascade,
  correct_idx int not null
);
alter table public.kb_quiz_answers enable row level security;
-- deliberately NO select policy for browser roles: deny-by-default hides answers.
-- managers write via the SECURITY DEFINER setter below (editor UI).
drop policy if exists "admin write answers" on public.kb_quiz_answers;
create policy "admin write answers" on public.kb_quiz_answers for all using (is_admin()) with check (is_admin());

create table if not exists public.kb_quiz_attempts (
  id bigint generated always as identity primary key,
  quiz_id bigint not null references public.kb_quizzes(id) on delete cascade,
  staff_id bigint not null references public.staff(id),
  attempt_no int not null,
  score_pct int not null,
  passed boolean not null,
  results jsonb not null default '[]'::jsonb,   -- [{ok:bool}] per question (no answers)
  created_at timestamptz not null default now()
);
alter table public.kb_quiz_attempts enable row level security;
drop policy if exists "own or admin read attempts" on public.kb_quiz_attempts;
create policy "own or admin read attempts" on public.kb_quiz_attempts for select
  using (staff_id = my_staff_id() or is_admin());
-- inserts happen ONLY inside kb_quiz_grade (security definer) — no insert policy.

-- ---------- grading (server-side; never returns correct answers) ----------
create or replace function public.kb_quiz_grade(p_quiz_id bigint, p_answers int[])
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_staff bigint := my_staff_id();
  v_pass int; v_total int := 0; v_right int := 0;
  v_score int; v_passed boolean; v_attempt int;
  v_results jsonb := '[]'::jsonb;
  r record; i int := 0; v_ok boolean;
begin
  if v_staff is null then raise exception 'not signed in'; end if;
  select pass_pct into v_pass from kb_quizzes where id = p_quiz_id and active;
  if v_pass is null then raise exception 'quiz not found'; end if;
  for r in
    select q.id, q.section_hint, a.correct_idx
    from kb_quiz_questions q join kb_quiz_answers a on a.question_id = q.id
    where q.quiz_id = p_quiz_id order by q.sort, q.id
  loop
    i := i + 1; v_total := v_total + 1;
    v_ok := (i <= coalesce(array_length(p_answers,1),0) and p_answers[i] = r.correct_idx);
    if v_ok then v_right := v_right + 1; end if;
    -- section hint only on a miss; correct answer never leaves the server
    v_results := v_results || jsonb_build_object('ok', v_ok,
      'hint', case when v_ok then null else r.section_hint end);
  end loop;
  if v_total = 0 then raise exception 'quiz has no questions'; end if;
  v_score := round(100.0 * v_right / v_total);
  v_passed := v_score >= v_pass;
  select coalesce(max(attempt_no),0) + 1 into v_attempt
    from kb_quiz_attempts where quiz_id = p_quiz_id and staff_id = v_staff;
  insert into kb_quiz_attempts (quiz_id, staff_id, attempt_no, score_pct, passed, results)
    values (p_quiz_id, v_staff, v_attempt, v_score, v_passed, v_results);
  return jsonb_build_object('score', v_score, 'passed', v_passed, 'pass_pct', v_pass,
    'attempt', v_attempt, 'total', v_total, 'right', v_right, 'results', v_results);
end $$;
revoke all on function public.kb_quiz_grade(bigint, int[]) from public, anon;
grant execute on function public.kb_quiz_grade(bigint, int[]) to authenticated;

-- editor-side setter so managers can save answers without a select policy
create or replace function public.kb_quiz_set_answer(p_question_id bigint, p_correct int)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'managers only'; end if;
  insert into kb_quiz_answers (question_id, correct_idx) values (p_question_id, p_correct)
    on conflict (question_id) do update set correct_idx = excluded.correct_idx;
end $$;
revoke all on function public.kb_quiz_set_answer(bigint, int) from public, anon;
grant execute on function public.kb_quiz_set_answer(bigint, int) to authenticated;

-- editor needs to SHOW the saved correct answer to managers only
create or replace function public.kb_quiz_get_answers(p_quiz_id bigint)
returns table (question_id bigint, correct_idx int)
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'managers only'; end if;
  return query select a.question_id, a.correct_idx
    from kb_quiz_answers a join kb_quiz_questions q on q.id = a.question_id
    where q.quiz_id = p_quiz_id;
end $$;
revoke all on function public.kb_quiz_get_answers(bigint) from public, anon;
grant execute on function public.kb_quiz_get_answers(bigint) to authenticated;

-- seed the two modules from the mocks (rename freely in the editor later)
insert into public.onboarding_modules (name, subtitle, sort)
select 'Week 1 — Bench basics', 'Read in order · quizzes unlock as you go', 1
where not exists (select 1 from public.onboarding_modules);
insert into public.onboarding_modules (name, subtitle, sort)
select 'Week 2 — Customer & POS', '', 2
where (select count(*) from public.onboarding_modules) < 2;
