insert into storage.buckets (id, name, public)
values ('aisocratic-remote-sync', 'aisocratic-remote-sync', false)
on conflict (id) do nothing;

create table if not exists public.aisocratic_remote_projects (
  id text primary key,
  project_id text not null,
  user_id text not null,
  source_url text not null,
  source_seed text not null,
  title text not null,
  seed_object_path text not null,
  seed_revision text not null,
  latest_revision text not null,
  last_synced_at timestamptz not null default now()
);

create index if not exists aisocratic_remote_projects_project_scope_idx
  on public.aisocratic_remote_projects (project_id, user_id, source_seed);

create table if not exists public.aisocratic_remote_events (
  id bigint generated always as identity primary key,
  record_id text not null references public.aisocratic_remote_projects (id) on delete cascade,
  project_id text not null,
  user_id text not null,
  source_seed text not null,
  batch_revision text not null,
  previous_revision text null,
  sequence_index integer not null,
  operation jsonb not null,
  saved_at bigint not null,
  synced_at timestamptz not null default now()
);

create index if not exists aisocratic_remote_events_record_order_idx
  on public.aisocratic_remote_events (record_id, synced_at, sequence_index);
