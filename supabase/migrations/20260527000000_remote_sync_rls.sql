-- Row-level security for the Supabase remote-sync backend.
--
-- These policies enable the published/anon key to be used for remote storage
-- instead of requiring a service-role key, as described in the project README.
--
-- Storage
-- -------
-- The private `aisocratic-remote-sync` bucket needs explicit per-operation
-- policies on `storage.objects` so that requests authenticated with the
-- publishable/anon key are permitted.  Service-role keys bypass RLS entirely
-- and continue to work without any policy.

create policy "aisocratic_remote_sync_anon_select"
  on storage.objects for select
  to anon
  using (bucket_id = 'aisocratic-remote-sync');

create policy "aisocratic_remote_sync_anon_insert"
  on storage.objects for insert
  to anon
  with check (bucket_id = 'aisocratic-remote-sync');

create policy "aisocratic_remote_sync_anon_update"
  on storage.objects for update
  to anon
  using (bucket_id = 'aisocratic-remote-sync')
  with check (bucket_id = 'aisocratic-remote-sync');

create policy "aisocratic_remote_sync_anon_delete"
  on storage.objects for delete
  to anon
  using (bucket_id = 'aisocratic-remote-sync');

-- Tables
-- ------
-- RLS is OFF by default for new tables in Supabase, meaning any API key can
-- read and write freely.  Enabling it with explicit anon policies keeps the
-- same effective access level but makes the rules auditable and allows
-- tightening them per-user once Supabase Auth is adopted.

alter table public.aisocratic_remote_projects enable row level security;

create policy "aisocratic_remote_projects_anon_all"
  on public.aisocratic_remote_projects for all
  to anon
  using (true)
  with check (true);

alter table public.aisocratic_remote_events enable row level security;

create policy "aisocratic_remote_events_anon_all"
  on public.aisocratic_remote_events for all
  to anon
  using (true)
  with check (true);
