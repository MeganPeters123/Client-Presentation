-- The currency each fund is reported in, and the rand rate that converts it.
--
-- Run this once in the Supabase SQL editor, then run build_history.py again to fill it.
--
-- Why it is needed: the custodian reports each fund in the fund's own base currency and
-- nowhere says which. build_history.py works it out from the valuation files -- an FX cash
-- line carries both the amount held and what it is worth, so the line whose value equals
-- its nominal names the base, and a rand fund's dollar line is that month's USD/ZAR -- but
-- it had nowhere to put the answer here. Without these two columns the dashboard reads
-- every fund as rand, so the global fund's $110m joins a rand total as R110m and the funds'
-- holdings of one another are not taken out either, both of which the dashboard can only do
-- once it knows the currency.
--
-- Existing rows keep everything they have. base_ccy defaults to rand, which is what all but
-- one of the funds report in, and the next build writes the real value for every row.
--
-- Nothing about access changes: snapshots stays readable only when signed in and writable
-- by nobody but the ETL's service key, so the new columns inherit exactly that.

alter table public.snapshots
  add column if not exists base_ccy text not null default 'ZAR',
  add column if not exists zar_rate numeric;

comment on column public.snapshots.base_ccy is
  'The currency this fund''s figures are in, read from the valuation file. ZAR for all but the global fund.';

comment on column public.snapshots.zar_rate is
  'Rand per unit of base_ccy at that month end, from the custodian''s own FX cash lines. 1 for a rand fund.';

-- ---------------------------------------------------------------- check it took

-- Expect two rows: base_ccy text, zar_rate numeric.
select column_name, data_type, column_default
  from information_schema.columns
 where table_schema = 'public' and table_name = 'snapshots'
   and column_name in ('base_ccy', 'zar_rate')
 order by column_name;

-- And the policies unchanged: snapshots with a single SELECT policy for authenticated.
select tablename, policyname, cmd, roles
  from pg_policies
 where schemaname = 'public' and tablename = 'snapshots';
