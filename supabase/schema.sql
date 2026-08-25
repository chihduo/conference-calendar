-- Submission tracking, one row per paper, owned by the user who created it.
--
-- Design note: this is the B1 shape - writes always go to the database and
-- never to a local writable copy. Two devices therefore cannot hold diverging
-- versions, so there is nothing to merge. The only remaining hazard is a stale
-- tab overwriting a change it never saw, which updated_at handles as a
-- compare-and-set token rather than as merge metadata.

create table if not exists public.submissions (
  id          text primary key,                 -- client-generated, stable across devices
  user_id     uuid not null references auth.users (id) on delete cascade,
  paper       text not null check (length(btrim(paper)) > 0),
  venue       text not null,
  status      text not null,
  history     jsonb not null default '[]'::jsonb,
  notes       text  not null default '',
  updated_at  timestamptz not null default now()
);

create index if not exists submissions_user_idx on public.submissions (user_id);

alter table public.submissions enable row level security;

-- Every policy is scoped to auth.uid(). Without RLS the anon key - which ships
-- in the page and is meant to be public - would expose every user's rows.
create policy "read own"   on public.submissions for select using  (user_id = auth.uid());
create policy "insert own" on public.submissions for insert with check (user_id = auth.uid());
create policy "update own" on public.submissions for update using  (user_id = auth.uid())
                                                        with check (user_id = auth.uid());
create policy "delete own" on public.submissions for delete using  (user_id = auth.uid());

-- Refuse a write whose view of the row is out of date. The client sends the
-- updated_at it last read; a mismatch means someone changed the row in between,
-- and silently winning would lose that change.
create or replace function public.save_submission(
  p_id text, p_paper text, p_venue text, p_status text,
  p_history jsonb, p_notes text, p_expected timestamptz
) returns public.submissions
language plpgsql security invoker as $$
declare
  row public.submissions;
  current timestamptz;
begin
  select updated_at into current from public.submissions where id = p_id and user_id = auth.uid();

  if current is not null and p_expected is distinct from current then
    raise exception 'stale_write' using errcode = '40001';
  end if;

  insert into public.submissions (id, user_id, paper, venue, status, history, notes, updated_at)
  values (p_id, auth.uid(), p_paper, p_venue, p_status, coalesce(p_history, '[]'::jsonb),
          coalesce(p_notes, ''), now())
  on conflict (id) do update
    set paper = excluded.paper, venue = excluded.venue, status = excluded.status,
        history = excluded.history, notes = excluded.notes, updated_at = now()
  returning * into row;

  return row;
end $$;
