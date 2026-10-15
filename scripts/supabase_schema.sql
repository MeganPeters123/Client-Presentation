-- Central store for the dashboard's history.
--
-- Run this once, in the Supabase SQL editor, on a new project. It creates the two tables
-- the dashboard reads and locks them so that only a signed-in user can see anything.
--
-- The security model matters more here than usual: the dashboard is served from a PUBLIC
-- GitHub Pages repo, so the anon key in its JavaScript is readable by anyone who views
-- source. That is how Supabase expects the anon key to be treated — it is an identifier,
-- not a secret — but it only holds because of the policies below. Without them, that public
-- key reads every holding in every fund.
--
-- Two rules follow, and both are enforced here rather than remembered:
--   * nothing is readable except to an authenticated user;
--   * nothing is writable from the browser at all. Writes come from build_history.py with
--     the service key, which bypasses RLS and never leaves the machine it runs on.

-- ---------------------------------------------------------------- holdings history

create table if not exists public.snapshots (
  fund        text        not null,
  period      text        not null,          -- 'YYYY-MM', the month the figures are for
  fund_code   text,
  as_of       date        not null,          -- the valuation date the figures came from
  total       numeric     not null,
  -- The asset-class split and the position rows stay as JSON, which is the shape the
  -- dashboard already works in. Splitting holdings into their own table would make them
  -- queryable across funds — "who else holds Netcare" — and is a reasonable next step, but
  -- it is a change to every reader and is not needed to get the history off a file.
  segments    jsonb       not null default '[]'::jsonb,
  holdings    jsonb       not null default '[]'::jsonb,
  source      text,                          -- the export each month was built from
  format      text,
  saved_at    timestamptz not null default now(),
  primary key (fund, period)
);

comment on table public.snapshots is
  'One row per fund per month. Written by scripts/build_history.py with the service key.';

create index if not exists snapshots_period_idx on public.snapshots (period);

-- ---------------------------------------------------------------- trade activity

create table if not exists public.trade_activity (
  period     text        primary key,        -- 'YYYY-MM'
  by_class   jsonb       not null default '{}'::jsonb,
  by_source  jsonb       not null default '{}'::jsonb,
  saved_at   timestamptz not null default now()
);

comment on table public.trade_activity is
  'One row per month of trade activity. Written by scripts/build_trades.py.';

-- ---------------------------------------------------------------- access

alter table public.snapshots      enable row level security;
alter table public.trade_activity enable row level security;

-- Readable only once signed in. There is no "using (true)" for anon anywhere in this file,
-- and there should never be: anon is the whole public internet.
drop policy if exists "signed in can read snapshots" on public.snapshots;
create policy "signed in can read snapshots"
  on public.snapshots for select
  to authenticated
  using (true);

drop policy if exists "signed in can read trade activity" on public.trade_activity;
create policy "signed in can read trade activity"
  on public.trade_activity for select
  to authenticated
  using (true);

-- No insert, update or delete policy exists for anon or authenticated, so the browser
-- cannot write whatever it is asked to. Only the service key can, and only the ETL holds it.
--
-- "Only Megan" is enforced by there being only one account, not by a user id written into a
-- policy — so turn OFF public sign-ups in Authentication -> Providers -> Email, and create
-- the single user by hand. Adding a colleague later is then an invitation rather than a
-- schema change.

-- ---------------------------------------------------------------- check it took

-- Expect: rowsecurity = true for both, and exactly two policies, both SELECT, both
-- authenticated. If anon appears anywhere in the roles column, stop and fix it.
select tablename, rowsecurity
  from pg_tables
 where schemaname = 'public' and tablename in ('snapshots', 'trade_activity');

select tablename, policyname, cmd, roles
  from pg_policies
 where schemaname = 'public' and tablename in ('snapshots', 'trade_activity');
