-- A table whose only purpose is to be read successfully.
--
-- The nightly keep-alive used to query `submissions` with the publishable key.
-- anon has no grant on that table, so every ping came back 401 - and Supabase
-- does not count a rejected request as database activity. The pings looked fine
-- in the log while the seven-day pause timer ran down underneath them.
--
-- This table holds nothing, so granting anon SELECT gives away nothing, and the
-- read is a real query that Postgres actually answers.

create table if not exists public.heartbeat (
  id  smallint primary key default 1,
  ok  boolean  not null default true,
  constraint heartbeat_single_row check (id = 1)
);

insert into public.heartbeat (id) values (1) on conflict (id) do nothing;

alter table public.heartbeat enable row level security;

-- Readable by anyone, writable by no one. RLS with a select-only policy, and no
-- insert/update/delete policy at all, means the keep-alive cannot become a way
-- to write to the database with a key that ships in the page.
create policy "heartbeat readable" on public.heartbeat for select using (true);

grant usage on schema public to anon;
grant select on public.heartbeat to anon;
