-- Earlier versions of the shared uploads, so a bad save is a click rather than a morning.
--
-- Run this once, after supabase_app_state.sql, in the Supabase SQL editor.
--
-- app_state holds the revenue split, the GICS sectors, the index weights and the attribution:
-- small files and judgement calls that are entered in the dashboard and nowhere else, and so
-- exist in no build that could be re-run. A row there was replaced in place, which meant the
-- previous value was simply gone. There was no way back from a mis-click, and the mis-click
-- that prompted this took six funds with it.
--
-- Every replaced value is now kept here first. The table is written only by the trigger below
-- and never by the browser, and it keeps the most recent KEEP versions per key so it cannot
-- grow without end — the index weights alone are a third of a megabyte apiece.

create table if not exists public.app_state_history (
  id          bigint      generated always as identity primary key,
  key         text        not null,
  value       jsonb       not null,
  -- the window this value was the live one for
  live_from   timestamptz not null,
  replaced_at timestamptz not null default now(),
  -- length of the JSON, so a version that was wiped is visible in a list without having to
  -- download every version to find out
  bytes       integer     not null,
  -- Who replaced it. Null means it was not a signed-in browser, which today means a script
  -- holding the service key. With one shared account this says nothing; it starts saying
  -- something the day each person has their own login.
  replaced_by       uuid,
  replaced_by_email text
);

comment on table public.app_state_history is
  'Previous values of app_state rows. Written by a trigger on app_state, never by the browser.';

create index if not exists app_state_history_key_idx
  on public.app_state_history (key, replaced_at desc);

-- ---------------------------------------------------------------- the trigger

create or replace function public.app_state_keep_history()
returns trigger
language plpgsql
security definer                 -- so the insert below is not refused by this table's own RLS
set search_path = public
as $$
declare
  claims json;
  keep   constant integer := 20;
begin
  -- A save that changes nothing keeps nothing. The dashboard re-sends the whole store every
  -- time, so without this a run of no-op saves would push every real version out of the
  -- window and leave twenty identical copies of the current one.
  if tg_op = 'UPDATE' and new.value is not distinct from old.value then
    return new;
  end if;

  -- there is no JWT behind a service-key write, and asking for one must not fail the write
  begin
    claims := nullif(current_setting('request.jwt.claims', true), '')::json;
  exception when others then
    claims := null;
  end;

  insert into public.app_state_history
    (key, value, live_from, bytes, replaced_by, replaced_by_email)
  values
    (old.key, old.value, old.updated_at, length(old.value::text),
     nullif(claims ->> 'sub', '')::uuid,
     nullif(claims ->> 'email', ''));

  delete from public.app_state_history h
   where h.key = old.key
     and h.id not in (
       select id
         from public.app_state_history
        where key = old.key
        order by replaced_at desc, id desc
        limit keep
     );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- BEFORE, so the value being replaced is still the one in OLD. It returns NEW unchanged:
-- updated_at is set by the dashboard and the save depends on it, so nothing here may touch it.
drop trigger if exists app_state_history_trg on public.app_state;
create trigger app_state_history_trg
  before update or delete on public.app_state
  for each row execute function public.app_state_keep_history();

-- ---------------------------------------------------------------- access

alter table public.app_state_history enable row level security;

drop policy if exists "signed in can read app state history" on public.app_state_history;
create policy "signed in can read app state history"
  on public.app_state_history for select
  to authenticated
  using (true);

-- No insert, update or delete policy, for anon or for authenticated. The trigger is the only
-- thing that writes this table, and it can because it is security definer — not because the
-- browser has been given a way in. Restoring is an ordinary write to app_state of a value
-- read from here, so it needs no more than the select above.

-- ---------------------------------------------------------------- check it took

-- Expect: rls_on = true, policies = 1, and one trigger on app_state.
select
  (select rowsecurity from pg_tables
    where schemaname = 'public' and tablename = 'app_state_history')            as rls_on,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'app_state_history')            as policies,
  (select string_agg(p.cmd, ', ') from pg_policies p
    where p.schemaname = 'public' and p.tablename = 'app_state_history')        as commands,
  (select count(*) from pg_trigger
    where tgrelid = 'public.app_state'::regclass and not tgisinternal)          as triggers_on_app_state;

-- And a live check that costs nothing: touching a row without changing its value must not
-- record a version. Expect the same count before and after, and 0 on a first run.
-- select count(*) from public.app_state_history where key = 'sa_income';
-- update public.app_state set updated_at = now() where key = 'sa_income';
-- select count(*) from public.app_state_history where key = 'sa_income';
