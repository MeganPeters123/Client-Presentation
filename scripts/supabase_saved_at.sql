-- Make saved_at mean "when these figures last changed", not "when this fund-month first
-- appeared".
--
-- Run this once in the Supabase SQL editor. Nothing else has to change: the ETL, the push
-- and the dashboard are all untouched.
--
-- What is wrong today. snapshots.saved_at is `timestamptz not null default now()`, and a
-- default only fires on INSERT. The push upserts with PostgREST's merge-duplicates, which
-- updates exactly the columns present in the payload -- and supabase_push.py does not send
-- saved_at, so an updated row keeps whatever timestamp it was first written with. On
-- 2026-11-10 the whole history was rebuilt to carry the futures contract counts; every one
-- of the 123 futures lines changed, three funds' active share moved, and afterwards the
-- table still held exactly two timestamps: 359 rows at 2026-10-15 and 34 at 2026-11-05.
-- Not one row said 2026-11-10.
--
-- Why that matters more than it looks. The dashboard asks for max(saved_at) on every load
-- (cloudHistoryUpdatedAt) and compares it with the copy in the browser, which is how it
-- offers "the saved history was rebuilt -- what is on screen is this browser's older copy".
-- That check can only fire when a brand-new fund-month lands. A rebuild that corrects
-- figures for months that already existed is invisible to it, so every browser keeps
-- showing the old numbers and nobody is told. That is the exact failure the comment in
-- js/cloud.js was written about: "a day went by with the right figures in the table and the
-- old ones on screen".
--
-- Why a trigger rather than sending saved_at from the push. build_history.py re-sends the
-- whole history every run -- all 393 rows, changed or not -- so stamping now() in the
-- payload would move the timestamp on every run and ask everyone to reload after a rebuild
-- that changed nothing. A false alarm each month is how a banner gets ignored. Deciding it
-- here is also the only place both versions of the row are already in hand; doing it in
-- Python would mean downloading all 393 rows to compare before every push.
--
-- The comparison deliberately leaves out saved_at itself, so a writer that does send one
-- cannot defeat the check, and leaves out fund and period because they are the key.
-- jsonb compares by value, not by text, so a re-serialised holdings array with its keys in
-- a different order is correctly seen as unchanged.

create or replace function public.snapshots_touch_saved_at()
returns trigger
language plpgsql
as $$
begin
  if (new.fund_code, new.as_of, new.total, new.segments, new.holdings,
      new.source, new.format, new.base_ccy, new.zar_rate)
     is distinct from
     (old.fund_code, old.as_of, old.total, old.segments, old.holdings,
      old.source, old.format, old.base_ccy, old.zar_rate)
  then
    new.saved_at = now();
  else
    new.saved_at = old.saved_at;
  end if;
  return new;
end;
$$;

comment on function public.snapshots_touch_saved_at() is
  'Moves snapshots.saved_at only when the figures in the row actually change, so the dashboard''s "this browser''s copy is older" check sees a corrective rebuild.';

drop trigger if exists snapshots_touch_saved_at on public.snapshots;

create trigger snapshots_touch_saved_at
  before update on public.snapshots
  for each row
  execute function public.snapshots_touch_saved_at();

comment on column public.snapshots.saved_at is
  'When these figures last changed. Set by default on insert, and moved by the snapshots_touch_saved_at trigger on an update that alters the row.';

-- ---------------------------------------------------------------- the one gap it leaves

-- This fixes every rebuild from here on, but it cannot reach backwards. The 2026-11-10
-- contract-count rebuild has already landed, so those rows hold their new figures under
-- their old timestamps; the next build will compare equal and move nothing, and no browser
-- will be prompted about a change that has in fact already happened.
--
-- Nobody is looking at wrong figures because of it -- a browser either loaded after
-- 2026-11-10 and has them, or has not loaded since 2026-11-05 and is behind by more than
-- this anyway. So the honest options are to leave it (anyone who presses Load latest gets
-- the right numbers) or to stamp those rows once, by hand, to make the banner offer it:
--
--   update public.snapshots set saved_at = now() where period >= '2026-09';
--
-- That is a deliberate nudge, not a correction, so it is left commented out. Run it only
-- if you would rather everyone was asked to reload than wait until they next do.

-- ---------------------------------------------------------------- check it took

-- Expect one row: snapshots_touch_saved_at, UPDATE, BEFORE.
select trigger_name, event_manipulation, action_timing
  from information_schema.triggers
 where event_object_schema = 'public' and event_object_table = 'snapshots'
 order by trigger_name;

-- The timestamps as they stand, before the next build. Expect the two historic dates.
select saved_at::date as saved_on, count(*)
  from public.snapshots
 group by 1
 order by 1;

-- And the policies unchanged: snapshots with a single SELECT policy for authenticated.
-- A trigger runs as the table owner and does not touch row-level security either way.
select tablename, policyname, cmd, roles
  from pg_policies
 where schemaname = 'public' and tablename = 'snapshots';
