-- Tend 24/7 — agile boards and custom templates.
--   Agile (per project, opt in): sprints with a backlog ranked by drag and drop, story points,
--   epics, and a daily snapshot per sprint for the burndown chart.
--   Templates: a workspace's own saved templates (made with "Save as template", the setup
--   wizard or an uploaded file), installed like the built-in ones.

-- ---------------------------------------------------------------- agile projects
alter table projects add column agile boolean not null default false;
-- Records of an epic type group other records of the project (they are never planned into sprints).
alter table record_types add column is_epic boolean not null default false;

create table sprints (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  project_id        uuid not null,
  name              text not null check (length(name) between 1 and 120),
  goal              text not null default '' check (length(goal) <= 2000),
  state             text not null default 'planned' check (state in ('planned', 'active', 'completed')),
  -- Planned dates (set or adjusted when the sprint starts); timestamps so copies shift cleanly.
  start_at          timestamptz,
  end_at            timestamptz,
  started_at        timestamptz,
  completed_at      timestamptz,
  committed_points  numeric(8, 1),
  committed_count   integer,
  completed_points  numeric(8, 1),
  completed_count   integer,
  created_by        uuid,
  created_at        timestamptz not null default clock_timestamp(),
  check (end_at is null or start_at is null or end_at > start_at),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, created_by) references users (tenant_id, id) on delete set null (created_by)
);
create unique index sprints_one_active on sprints (tenant_id, project_id) where state = 'active';
create index sprints_project_idx on sprints (tenant_id, project_id, created_at);

-- One row per sprint day: what the burndown chart draws. day_index counts from the sprint's
-- start, so the rows stay right when a workspace copy shifts its dates.
create table sprint_snapshots (
  tenant_id         uuid not null references tenants(id) on delete cascade,
  sprint_id         uuid not null,
  day_index         integer not null check (day_index >= 0),
  scope_points      numeric(8, 1) not null default 0,
  remaining_points  numeric(8, 1) not null default 0,
  scope_count       integer not null default 0,
  remaining_count   integer not null default 0,
  captured_at       timestamptz not null default clock_timestamp(),
  primary key (sprint_id, day_index),
  foreign key (tenant_id, sprint_id) references sprints (tenant_id, id) on delete cascade
);

alter table records
  add column story_points  numeric(6, 1) check (story_points >= 0 and story_points <= 1000),
  add column sprint_id     uuid,
  add column epic_id       uuid,
  -- Backlog order within a project: smaller first. Doubles leave room to insert between two
  -- neighbours many times; the service renumbers a project when the gap gets too small.
  add column rank          double precision,
  add constraint records_epic_not_self check (epic_id is null or epic_id <> id),
  add foreign key (tenant_id, sprint_id) references sprints (tenant_id, id) on delete set null (sprint_id),
  add foreign key (tenant_id, epic_id) references records (tenant_id, id) on delete set null (epic_id);
create index records_sprint_idx on records (tenant_id, sprint_id) where deleted_at is null;
create index records_epic_idx on records (tenant_id, epic_id) where deleted_at is null;
create index records_rank_idx on records (tenant_id, project_id, rank) where deleted_at is null;

-- ---------------------------------------------------------------- saved templates
create table workspace_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null check (length(name) between 1 and 120),
  summary     text not null default '' check (length(summary) <= 500),
  definition  jsonb not null check (jsonb_typeof(definition) = 'object'),
  source      text not null default 'saved' check (source in ('saved', 'wizard', 'file')),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, name),
  foreign key (tenant_id, created_by) references users (tenant_id, id) on delete set null (created_by)
);

-- ---------------------------------------------------------------- row-level security
do $$
declare t text;
begin
  foreach t in array array['sprints', 'sprint_snapshots', 'workspace_templates'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = tend247_current_tenant()) '
      'with check (tenant_id = tend247_current_tenant())', t);
  end loop;
end
$$;
