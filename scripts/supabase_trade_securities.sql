-- Every share traded each month, so the dashboard can show the largest and smallest buys
-- and sells rather than only monthly totals by asset class.
--
-- Run this once in the Supabase SQL editor. It only adds a column: the existing rows keep
-- their totals and gain an empty list, filled in the next time build_trades.py runs.
--
-- Nothing about access changes. trade_activity stays readable when signed in and writable
-- by nobody but the ETL's service key, so the new column inherits exactly that.

alter table public.trade_activity
  add column if not exists by_security jsonb not null default '[]'::jsonb;

comment on column public.trade_activity.by_security is
  'One entry per fund, share and action in the month: value, count, quantity, asset class.';

-- ---------------------------------------------------------------- check it took

-- Expect one row: by_security, jsonb. And the policies unchanged: trade_activity with a
-- single SELECT policy for authenticated.
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'trade_activity' and column_name = 'by_security';

select tablename, policyname, cmd, roles
  from pg_policies
 where schemaname = 'public' and tablename = 'trade_activity';
