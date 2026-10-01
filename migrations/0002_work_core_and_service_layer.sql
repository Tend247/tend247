-- Tend 24/7 — Phases 1 and 2: workflows, layouts, teams, privacy, comments, attachments,
-- views, links (work core) and SLAs, approvals, automation, email, notifications, export
-- (service layer). Every workspace table is row-secured like 0001; a few routing tables that
-- hold only identifiers are deliberately not (see the end of this file).

-- ---------------------------------------------------------------- workspace settings
-- Non-sensitive knobs (trash retention, attachment size limit, timezone).
alter table tenants add column settings jsonb not null default '{}'::jsonb
  check (jsonb_typeof(settings) = 'object');

-- ---------------------------------------------------------------- teams
create table teams (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  name             text not null check (length(name) between 1 and 120),
  rr_last_user_id  uuid,
  archived_at      timestamptz,
  created_at       timestamptz not null default now(),
  unique (tenant_id, name),
  unique (tenant_id, id)
);

create table team_members (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  team_id     uuid not null,
  user_id     uuid not null,
  created_at  timestamptz not null default now(),
  primary key (team_id, user_id),
  foreign key (tenant_id, team_id) references teams (tenant_id, id) on delete cascade,
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);
create index team_members_user_idx on team_members (tenant_id, user_id);

-- ---------------------------------------------------------------- project settings
alter table projects
  add column restricted        boolean not null default false,
  add column requester_access  boolean not null default true,
  add column assignment        text not null default 'manual' check (assignment in ('manual', 'round_robin')),
  add column default_team_id   uuid,
  add foreign key (tenant_id, default_team_id) references teams (tenant_id, id) on delete set null (default_team_id);

-- ---------------------------------------------------------------- versioned configuration
-- Workflows and layouts belong to a record type, SLA policies to a project. Admins edit a
-- draft and publish it as a new version; earlier versions stay for restore.
create table config_versions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  kind          text not null check (kind in ('workflow', 'layout', 'sla')),
  owner_id      uuid not null,
  -- Drafts are version 0; publishing numbers them.
  version       integer not null check (version >= 0),
  state         text not null check (state in ('draft', 'published', 'superseded')),
  check ((state = 'draft') = (version = 0)),
  definition    jsonb not null,
  created_by    uuid,
  created_at    timestamptz not null default clock_timestamp(),
  published_at  timestamptz,
  unique (tenant_id, kind, owner_id, version),
  foreign key (tenant_id, created_by) references users (tenant_id, id) on delete set null (created_by)
);
create unique index config_versions_published on config_versions (tenant_id, kind, owner_id) where state = 'published';
create unique index config_versions_draft on config_versions (tenant_id, kind, owner_id) where state = 'draft';

-- Default workflow for record types created before workflows existed.
insert into config_versions (tenant_id, kind, owner_id, version, state, definition, published_at)
select rt.tenant_id, 'workflow', rt.id, 1, 'published', '{
  "initial": "new",
  "statuses": [
    {"key": "new", "name": "New", "category": "todo"},
    {"key": "in_progress", "name": "In progress", "category": "in_progress"},
    {"key": "waiting", "name": "Waiting", "category": "in_progress"},
    {"key": "done", "name": "Done", "category": "done"}
  ],
  "transitions": [
    {"key": "start", "name": "Start work", "from": ["new"], "to": "in_progress"},
    {"key": "wait", "name": "Wait for reply", "from": ["new", "in_progress"], "to": "waiting"},
    {"key": "resume", "name": "Resume", "from": ["waiting"], "to": "in_progress"},
    {"key": "resolve", "name": "Resolve", "from": ["new", "in_progress", "waiting"], "to": "done"},
    {"key": "reopen", "name": "Reopen", "from": ["done"], "to": "in_progress"}
  ]
}'::jsonb, now()
from record_types rt;

-- ---------------------------------------------------------------- records
alter table records
  add column workflow_version     integer,
  add column team_id              uuid,
  add column first_responded_at   timestamptz,
  add column resolved_at          timestamptz,
  add column pending_approval_id  uuid,
  add column via                  text not null default 'app' check (via in ('app', 'email', 'automation', 'api')),
  add foreign key (tenant_id, team_id) references teams (tenant_id, id) on delete set null (team_id);
alter table records alter column status set default 'new';
update records set status = 'new', workflow_version = 1 where status = 'New';
update records set workflow_version = 1 where workflow_version is null;
create index records_team_idx on records (tenant_id, team_id) where deleted_at is null;
create index records_status_idx on records (tenant_id, record_type_id, status) where deleted_at is null;
create index records_updated_idx on records (tenant_id, updated_at desc) where deleted_at is null;

-- ---------------------------------------------------------------- comments and watchers
create table comments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  record_id   uuid not null,
  author_id   uuid,
  body        text not null check (length(body) between 1 and 50000),
  internal    boolean not null default false,
  mentions    jsonb not null default '[]'::jsonb check (jsonb_typeof(mentions) = 'array'),
  via         text not null default 'app' check (via in ('app', 'email', 'automation')),
  created_at  timestamptz not null default clock_timestamp(),
  edited_at   timestamptz,
  deleted_at  timestamptz,
  deleted_by  uuid,
  search      tsvector generated always as (to_tsvector('simple', body)) stored,
  foreign key (tenant_id, record_id) references records (tenant_id, id) on delete cascade,
  foreign key (tenant_id, author_id) references users (tenant_id, id) on delete set null (author_id),
  foreign key (tenant_id, deleted_by) references users (tenant_id, id) on delete set null (deleted_by),
  unique (tenant_id, id)
);
create index comments_record_idx on comments (tenant_id, record_id, created_at);
create index comments_search_idx on comments using gin (search);

create table record_watchers (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  record_id   uuid not null,
  user_id     uuid not null,
  created_at  timestamptz not null default now(),
  primary key (record_id, user_id),
  foreign key (tenant_id, record_id) references records (tenant_id, id) on delete cascade,
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);
create index record_watchers_user_idx on record_watchers (tenant_id, user_id);

-- ---------------------------------------------------------------- attachments
create table attachments (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  record_id      uuid not null,
  comment_id     uuid,
  filename       text not null check (length(filename) between 1 and 255),
  content_type   text not null,
  size_bytes     bigint not null check (size_bytes >= 0),
  sha256         text not null,
  storage_key    text not null unique,
  -- Set from the comment at upload: a file on an internal note stays internal for good.
  internal       boolean not null default false,
  uploaded_by    uuid,
  created_at     timestamptz not null default clock_timestamp(),
  deleted_at     timestamptz,
  deleted_by     uuid,
  replicated_at  timestamptz,
  foreign key (tenant_id, record_id) references records (tenant_id, id) on delete cascade,
  foreign key (tenant_id, deleted_by) references users (tenant_id, id) on delete set null (deleted_by),
  foreign key (tenant_id, comment_id) references comments (tenant_id, id) on delete set null (comment_id),
  foreign key (tenant_id, uploaded_by) references users (tenant_id, id) on delete set null (uploaded_by)
);
create index attachments_record_idx on attachments (tenant_id, record_id);

-- Storage keys of purged attachments, deleted from object storage after the transaction.
-- The replica copy is kept until delete_after (the retention period).
create table blob_deletions (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references tenants(id) on delete cascade,
  storage_key   text not null,
  replica_only  boolean not null default false,
  delete_after  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------- saved views and links
create table saved_views (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  owner_id    uuid not null,
  name        text not null check (length(name) between 1 and 120),
  shared      boolean not null default false,
  definition  jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (tenant_id, owner_id) references users (tenant_id, id) on delete cascade
);

create table record_links (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  from_id     uuid not null,
  to_id       uuid not null,
  kind        text not null check (kind in ('relates', 'blocks', 'duplicates', 'parent')),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  check (from_id <> to_id),
  unique (tenant_id, from_id, to_id, kind),
  foreign key (tenant_id, from_id) references records (tenant_id, id) on delete cascade,
  foreign key (tenant_id, to_id) references records (tenant_id, id) on delete cascade,
  foreign key (tenant_id, created_by) references users (tenant_id, id) on delete set null (created_by)
);

-- ---------------------------------------------------------------- SLAs
create table calendars (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null check (length(name) between 1 and 120),
  timezone    text not null,
  hours       jsonb not null,
  holidays    jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  unique (tenant_id, name),
  unique (tenant_id, id)
);

create table sla_clocks (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  record_id         uuid not null,
  metric            text not null check (metric in ('first_response', 'resolution')),
  policy_name       text not null,
  target_minutes    integer not null check (target_minutes > 0),
  warn_percent      integer not null default 80 check (warn_percent between 1 and 99),
  calendar_id       uuid,
  started_at        timestamptz not null,
  run_started_at    timestamptz,
  consumed_minutes  double precision not null default 0,
  due_at            timestamptz,
  warn_at           timestamptz,
  status            text not null check (status in ('running', 'paused', 'met', 'cancelled')),
  met_at            timestamptz,
  warned_at         timestamptz,
  breached_at       timestamptz,
  updated_at        timestamptz not null default clock_timestamp(),
  unique (record_id, metric),
  foreign key (tenant_id, record_id) references records (tenant_id, id) on delete cascade,
  foreign key (tenant_id, calendar_id) references calendars (tenant_id, id) on delete set null (calendar_id)
);
create index sla_clocks_record_idx on sla_clocks (tenant_id, record_id);

-- ---------------------------------------------------------------- approvals
create table approvals (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  record_id        uuid not null,
  transition_key   text not null,
  transition_name  text not null,
  to_status        text not null,
  requested_by     uuid,
  status           text not null check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  mode             text not null check (mode in ('any', 'sequential')),
  steps            jsonb not null,
  current_step     integer not null default 0,
  fields           jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default clock_timestamp(),
  decided_at       timestamptz,
  foreign key (tenant_id, record_id) references records (tenant_id, id) on delete cascade,
  foreign key (tenant_id, requested_by) references users (tenant_id, id) on delete set null (requested_by),
  unique (tenant_id, id)
);
create index approvals_record_idx on approvals (tenant_id, record_id);
alter table records add foreign key (tenant_id, pending_approval_id) references approvals (tenant_id, id)
  on delete set null (pending_approval_id);

-- One-time links that let an approver decide from an email.
create table approval_tokens (
  token_hash   text primary key,
  tenant_id    uuid not null references tenants(id) on delete cascade,
  approval_id  uuid not null,
  user_id      uuid not null,
  step         integer not null,
  expires_at   timestamptz not null,
  used_at      timestamptz,
  foreign key (tenant_id, approval_id) references approvals (tenant_id, id) on delete cascade,
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);

-- ---------------------------------------------------------------- automation
create table automation_rules (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  project_id  uuid,
  name        text not null check (length(name) between 1 and 200),
  enabled     boolean not null default true,
  trigger     text not null check (trigger in (
                'record.created', 'record.updated', 'record.transitioned', 'comment.created',
                'sla.warning', 'sla.breached', 'approval.decided')),
  conditions  jsonb not null default '[]'::jsonb,
  actions     jsonb not null,
  position    integer not null default 0,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, created_by) references users (tenant_id, id) on delete set null (created_by)
);

-- Per-workspace secrets (webhook signing key). Row-secured; never exposed by the API.
create table workspace_secrets (
  tenant_id       uuid primary key references tenants(id) on delete cascade,
  webhook_secret  text not null
);

create table webhook_deliveries (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  rule_id       uuid,
  url           text not null,
  payload       jsonb not null,
  status        text not null default 'pending' check (status in ('pending', 'delivered', 'failed')),
  attempts      integer not null default 0,
  last_status   integer,
  last_error    text,
  created_at    timestamptz not null default now(),
  delivered_at  timestamptz
);

-- ---------------------------------------------------------------- notifications and email
alter table users add column notification_prefs jsonb not null default '{}'::jsonb;

create table notifications (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  user_id          uuid not null,
  kind             text not null,
  record_id        uuid,
  title            text not null,
  body             text not null default '',
  source_event_id  bigint,
  -- The person's preferences asked for an email; emailed_at is set once it is sent.
  email_wanted     boolean not null default false,
  -- The composed message, kept only until it is sent (it can hold a one-time link).
  email_payload    jsonb,
  email_attempts   integer not null default 0,
  email_next_at    timestamptz,
  emailed_at       timestamptz,
  read_at          timestamptz,
  created_at       timestamptz not null default clock_timestamp(),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade,
  foreign key (tenant_id, record_id) references records (tenant_id, id) on delete cascade,
  unique (source_event_id, user_id, kind)
);
create index notifications_user_idx on notifications (tenant_id, user_id, created_at desc);
create index notifications_email_idx on notifications (tenant_id, created_at) where email_payload is not null;

create table email_messages (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  record_id    uuid,
  direction    text not null check (direction in ('in', 'out')),
  message_id   text not null,
  from_addr    text not null,
  to_addr      text not null,
  subject      text not null default '',
  created_at   timestamptz not null default now(),
  foreign key (tenant_id, record_id) references records (tenant_id, id) on delete set null (record_id),
  unique (tenant_id, direction, message_id)
);

-- ---------------------------------------------------------------- outbox and backups
alter table outbox
  add column claimed_at  timestamptz,
  add column attempts    integer not null default 0,
  add column last_error  text;
create index outbox_tenant_pending_idx on outbox (tenant_id, id) where delivered_at is null;

create table export_runs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  status       text not null check (status in ('running', 'succeeded', 'failed')),
  location     text not null,
  counts       jsonb not null default '{}'::jsonb,
  bytes        bigint not null default 0,
  encrypted    boolean not null default false,
  error        text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);

-- ---------------------------------------------------------------- row-level security
do $$
declare t text;
begin
  foreach t in array array[
    'teams', 'team_members', 'config_versions', 'comments', 'record_watchers', 'attachments',
    'blob_deletions', 'saved_views', 'record_links', 'calendars', 'sla_clocks', 'approvals',
    'approval_tokens', 'automation_rules', 'workspace_secrets', 'webhook_deliveries',
    'notifications', 'email_messages', 'export_runs'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = tend247_current_tenant()) '
      'with check (tenant_id = tend247_current_tenant())', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------- routing tables (no RLS)
-- These hold only identifiers and timestamps. They are read before a workspace is known
-- (inbound email routing, background schedulers), so they cannot be row-secured.

-- Which workspace and project an inbound address belongs to (local part, lowercase).
create table inbound_addresses (
  address         text primary key check (address ~ '^[a-z0-9][a-z0-9._-]{0,40}$'),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  project_id      uuid not null,
  record_type_id  uuid not null,
  unique (tenant_id, project_id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, record_type_id) references record_types (tenant_id, id) on delete cascade
);

-- Short codes in reply-to addresses (reply+<code>@domain) mapping to a record.
create table email_threads (
  code        text primary key check (code ~ '^[a-z2-7]{16}$'),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  record_id   uuid not null,
  created_at  timestamptz not null default now(),
  unique (record_id),
  foreign key (tenant_id, record_id) references records (tenant_id, id) on delete cascade
);

-- "This workspace has events waiting": lets the background sweep find work without
-- reading row-secured tables across workspaces.
create table work_signals (
  tenant_id    uuid primary key references tenants(id) on delete cascade,
  signaled_at  timestamptz not null default now()
);

-- Timers: SLA warnings and breaches, webhook retries, attachment replication, nightly export
-- and trash purge. ref_id points into the workspace's own (row-secured) tables.
create table scheduled_jobs (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  kind        text not null,
  ref_id      uuid not null,
  run_at      timestamptz not null,
  claimed_at  timestamptz,
  attempts    integer not null default 0,
  last_error  text,
  unique (kind, ref_id)
);
create index scheduled_jobs_due_idx on scheduled_jobs (run_at);
