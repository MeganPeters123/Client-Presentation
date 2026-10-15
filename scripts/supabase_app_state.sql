-- The two reference uploads, and the judgement calls made on top of them.
--
-- Run this once, after supabase_schema.sql, in the Supabase SQL editor.
--
-- Holds the SA revenue split workbook and the month-end index weights, so a second machine
-- signs in rather than re-uploading them. It also carries the overrides made by hand in the
-- dashboard — the revenue split set on a position, the listing call, the sector — which is
-- the part that was previously stuck in one browser and lost on clearing site data.
--
-- This table is the ONE place a signed-in user may write. snapshots and trade_activity stay
-- read-only from the browser and keep coming from the ETL with the service key. The
-- separation is deliberate: the figures are produced by a build that can be re-run and
-- checked, while these are small files and personal calls that are only ever entered here.

create table if not exists public.app_state (
  key        text        primary key,        -- 'sa_income' | 'index_weights'
  value      jsonb       not null,
  updated_at timestamptz not null default now()
);

comment on table public.app_state is
  'Reference uploads and hand-made overrides. Written by the dashboard, not the ETL.';

alter table public.app_state enable row level security;

drop policy if exists "signed in can read app state"   on public.app_state;
drop policy if exists "signed in can write app state"  on public.app_state;
drop policy if exists "signed in can update app state" on public.app_state;

create policy "signed in can read app state"
  on public.app_state for select
  to authenticated
  using (true);

create policy "signed in can write app state"
  on public.app_state for insert
  to authenticated
  with check (true);

create policy "signed in can update app state"
  on public.app_state for update
  to authenticated
  using (true)
  with check (true);

-- no delete policy: a row here is replaced, never removed, so a mis-click cannot empty it

-- ---------------------------------------------------------------- check it took

-- Expect app_state with rls_on = true and 3 policies, and the other two tables unchanged
-- at 1 policy each. If snapshots or trade_activity has gained a policy, something has gone
-- wrong — those must stay read-only from the browser.
select t.tablename,
       t.rowsecurity       as rls_on,
       count(p.policyname) as policies,
       string_agg(distinct p.cmd, ', ' order by p.cmd) as commands
  from pg_tables t
  left join pg_policies p
    on p.schemaname = t.schemaname and p.tablename = t.tablename
 where t.schemaname = 'public'
   and t.tablename in ('snapshots', 'trade_activity', 'app_state')
 group by t.tablename, t.rowsecurity
 order by t.tablename;
