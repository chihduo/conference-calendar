-- Run this if you created the table before the grants were added to schema.sql.
-- Symptom it fixes: 42501 "permission denied for table submissions", even when
-- signed in. GRANT and RLS are separate layers - RLS filters rows for a role
-- that already has table access, and a SQL-editor-created table starts with none.

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.submissions to authenticated;
grant execute on function public.save_submission(text, text, text, text, jsonb, text, timestamptz)
  to authenticated;
