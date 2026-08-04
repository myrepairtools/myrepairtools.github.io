-- Sales Competitions — owner-defined contests that actually pay out.
--
-- Replaces the hardcoded "$50 Top performer bonus" card that lived only in
-- commission-dashboard.html. That card was display-only: the $50 never entered
-- any calculation, so it was absent from the payroll calculator and from the
-- commission_snapshots archive, and had to be paid by hand every month.
--
-- Two tables:
--   competitions        the definition (metric, bonus, fixed date range)
--   competition_results the FREEZE — who won and what they were paid.
--
-- The freeze matters for the same reason commission_snapshots exists: live
-- recompute means a later edit to commission_sales would silently rewrite who
-- won a contest that has already been paid. Once a result is finalized it is
-- the record, and payroll reads it instead of re-ranking.
--
-- Standings come from the competition_standings() RPC, NOT from client-side
-- ranking. commission_sales RLS is `can_see_store(store) OR own staff_id`, so
-- a tech ranking in the browser sees only their own store and can conclude they
-- are the company-wide leader. The RPC is security definer so every viewer gets
-- the same board.
--
-- Apply: run in the Supabase SQL editor (or management API database/query).

-- ---------------------------------------------------------------- definitions
create table if not exists public.competitions (
  id            bigint generated always as identity primary key,
  name          text    not null,
  metric        text    not null,          -- see competition_standings() for the supported set
  metric_key    text,                      -- category name or service sku; null = all (metric-dependent)
  start_date    date    not null,
  end_date      date    not null,          -- inclusive; the run whose range contains this date pays it
  bonus_amount  numeric not null default 0,
  min_tickets   integer not null default 20,  -- eligibility floor (was hardcoded 20 in the old card)
  note          text,
  active        boolean not null default true,
  created_by    bigint,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint competitions_dates_ck check (end_date >= start_date),
  constraint competitions_metric_ck check (metric in (
    'attach_rate','category_units','service_units','device_units',
    'accy_net','device_net','service_net','retail_net'))
);

create index if not exists competitions_end_idx on public.competitions (end_date);

-- ------------------------------------------------------------------- the freeze
create table if not exists public.competition_results (
  competition_id bigint not null references public.competitions(id) on delete cascade,
  staff_id       bigint not null,
  place          integer not null,          -- 1 = winner; ties share place 1
  metric_value   numeric,
  bonus_amount   numeric not null default 0,
  -- Stamped 'YYYY-MM' when a payroll run archives this award. The end_date rule
  -- decides WHICH run pays; this is the ledger that stops a second one from
  -- paying it again after a range change or a re-run.
  paid_month     text,
  finalized_by   bigint,
  finalized_at   timestamptz not null default now(),
  primary key (competition_id, staff_id)
);

create index if not exists competition_results_staff_idx on public.competition_results (staff_id);

-- ------------------------------------------------------------------------ RLS
-- Read is open to any signed-in employee: you must be able to see the contest
-- you are competing in, and the standings board is meant to be public to staff.
-- Write is is_owner() — this spends money (same reasoning as cash_journal).
-- Change to is_admin() if store managers should be able to run their own.
alter table public.competitions        enable row level security;
alter table public.competition_results enable row level security;

drop policy if exists competitions_read  on public.competitions;
create policy competitions_read  on public.competitions for select to authenticated using (true);
drop policy if exists competitions_write on public.competitions;
create policy competitions_write on public.competitions for all to authenticated
  using (is_owner()) with check (is_owner());

drop policy if exists competition_results_read  on public.competition_results;
create policy competition_results_read  on public.competition_results for select to authenticated using (true);
drop policy if exists competition_results_write on public.competition_results;
create policy competition_results_write on public.competition_results for all to authenticated
  using (is_owner()) with check (is_owner());

-- ------------------------------------------------------ the bonus on the archive
-- Mirrors the existing `tips numeric not null default 0` — the bonus rides
-- ALONGSIDE the commission, never inside commission-engine.js (that engine is a
-- pure function of one person's own totals; a competition result is a ranking
-- across people). Default 0 keeps every already-archived row valid.
alter table public.commission_snapshots
  add column if not exists bonus        numeric not null default 0,
  add column if not exists bonus_detail jsonb;

-- ------------------------------------------------------------------ standings
-- Company-wide standings for one competition, identical for every viewer.
-- Returns EVERY participant (not just the winner) so the board can show a tech
-- their own position. `place` is null for anyone under the ticket floor.
create or replace function public.competition_standings(p_competition_id bigint)
returns table (
  staff_id     bigint,
  display_name text,
  home_store   text,
  is_active    boolean,
  metric_value numeric,
  tickets      numeric,
  eligible     boolean,
  place        integer
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with c as (
    select * from competitions where id = p_competition_id
  ),
  -- Per-row metric contribution. Reading commission_sales in SQL deliberately
  -- sidesteps the calculator's client-side "live row" filter, which does not
  -- treat `categories` as a liveness signal and would drop category-only rows —
  -- exactly the rows a case / screen-protector contest is scored on.
  src as (
    select cs.staff_id,
           coalesce(cs.tickets, 0)::numeric as tickets,
           case c.metric
             when 'attach_rate'    then coalesce(cs.accy_units, 0)::numeric
             when 'category_units' then coalesce((cs.categories ->> c.metric_key)::numeric, 0)
             when 'service_units'  then case
                                          when c.metric_key is null then
                                            (select coalesce(sum(v::numeric), 0)
                                               from jsonb_each_text(coalesce(cs.services, '{}'::jsonb)) as e(k, v))
                                          else coalesce((cs.services ->> c.metric_key)::numeric, 0)
                                        end
             when 'device_units'   then coalesce(cs.device_units, 0)::numeric - coalesce(cs.device_returns, 0)::numeric
             when 'accy_net'       then coalesce(cs.accy_net, 0)
             when 'device_net'     then coalesce(cs.device_net, 0) + coalesce(cs.device_return_net, 0)
             when 'service_net'    then coalesce(cs.service_net, 0)
             when 'retail_net'     then coalesce(cs.accy_net, 0) + coalesce(cs.device_net, 0) + coalesce(cs.device_return_net, 0)
             else 0
           end as num
      from commission_sales cs
      cross join c
     where cs.biz_date between c.start_date and c.end_date
       and cs.staff_id is not null
  ),
  agg as (
    select src.staff_id as sid, sum(src.tickets) as tkts, sum(src.num) as num
      from src group by src.staff_id
  ),
  scored as (
    select a.sid,
           s.display_name,
           s.home_store,
           s.active,
           case when c.metric = 'attach_rate'
                then a.num / nullif(a.tkts, 0)
                else a.num
           end as val,
           a.tkts,
           (a.tkts >= c.min_tickets) as elig
      from agg a
      join staff s on s.id = a.sid
      cross join c
     -- The owner is excluded by ROLE, not by the brittle display-name regex the
     -- old dashboard card used. Their sales do not reach commission_sales anyway.
     where coalesce(s.role, '') <> 'owner'
  )
  select sc.sid,
         sc.display_name,
         sc.home_store,
         sc.active,
         round(sc.val, 4),
         sc.tkts,
         sc.elig,
         -- dense_rank so ties genuinely share first place; ineligible rows sort
         -- last (null val) and then have their place nulled out entirely.
         (case when sc.elig then
            dense_rank() over (order by (case when sc.elig then sc.val end) desc nulls last)
          end)::integer
    from scored sc
   order by sc.elig desc, sc.val desc nulls last, sc.display_name;
$function$;

revoke all on function public.competition_standings(bigint) from public, anon;
grant execute on function public.competition_standings(bigint) to authenticated;

-- ----------------------------------------------------------------- permission
insert into public.permissions (key, label, category, description, sort, page, is_access)
values ('commission.competitions', 'Manage Competitions', 'Commission',
        'Create sales competitions and the bonuses they pay', 30, 'Competitions', false)
on conflict (key) do nothing;
