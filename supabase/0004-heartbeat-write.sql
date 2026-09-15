-- Make the keep-alive observable, and make it unambiguously database activity.
--
-- Two earlier attempts failed for reasons that were only visible a week later,
-- when the project paused: first the ping read a table anon had no grant on and
-- got 401 every night, then it read successfully but only once a day, which is
-- exactly the "low activity" the pause rule is aimed at.
--
-- Recording a timestamp fixes the thing that made both of those slow to catch:
-- until now there was no way to ask the database whether the keep-alive had
-- reached it. Now `select last_seen from heartbeat` answers that directly.

alter table public.heartbeat
  add column if not exists last_seen timestamptz not null default now(),
  add column if not exists hits bigint not null default 0;

-- anon may bump the row and nothing else. The table holds no information, the
-- check constraint pins it to a single row, and there is no insert or delete
-- policy - so the worst a leaked publishable key buys is a moved timestamp.
drop policy if exists "heartbeat touch" on public.heartbeat;
create policy "heartbeat touch" on public.heartbeat
  for update using (id = 1) with check (id = 1);

grant update (last_seen, hits) on public.heartbeat to anon;

-- Called instead of a bare UPDATE so the counter increments server-side and the
-- caller needs to know nothing about the current value.
create or replace function public.touch_heartbeat()
returns timestamptz
language sql security invoker as $$
  update public.heartbeat
     set last_seen = now(), hits = hits + 1
   where id = 1
  returning last_seen;
$$;

grant execute on function public.touch_heartbeat() to anon;
