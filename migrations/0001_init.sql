-- Tend 24/7 — Phase 0 schema: workspaces, people, sessions, config engine, records, history.
--
-- Isolation model: every table except `tenants` carries tenant_id and is protected by a
-- FORCE'd row-level-security policy keyed on the transaction-local setting app.tenant_id
-- (set with set_config('app.tenant_id', $1, true) — see src/worker/db/client.ts).
-- Configuration lives in rows: adding a field or record type never changes this schema.

create extension if not exists pg_trgm;

-- Current workspace for this transaction, or NULL (=> no rows visible) when unset.
create function tend247_current_tenant() returns uuid
language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

-- Guard for append-only tables. Rows can never be updated. They can be deleted only by the
-- table owner, which is who foreign-key cascades run as: deleting a workspace (an expired
-- demo sandbox) or purging a record from the trash removes its history; the app role
-- deleting history rows directly is refused.
create function tend247_append_only() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and pg_has_role(current_user, (select relowner from pg_class where oid = tg_relid), 'USAGE') then
    return old;
  end if;
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end
$$;

-- Workspaces. Deliberately not row-secured: a deployment belongs to one company, and the
-- table holds only names and flags. Sign-in resolves a workspace by slug before any
-- tenant context exists.
create table tenants (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name        text not null check (length(name) between 1 and 200),
  demo        boolean not null default false,
  expires_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index tenants_expires_idx on tenants (expires_at) where expires_at is not null;

create table users (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  email         text not null check (email = lower(email) and email like '%_@_%'),
  display_name  text not null check (length(display_name) between 1 and 200),
  role          text not null check (role in ('admin', 'agent', 'requester')),
  oidc_subject  text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (tenant_id, email),
  unique (tenant_id, oidc_subject),
  unique (tenant_id, id)
);

create table sessions (
  token_hash    text primary key,
  tenant_id     uuid not null references tenants(id) on delete cascade,
  user_id       uuid not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  last_seen_at  timestamptz not null default now(),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);
create index sessions_user_idx on sessions (tenant_id, user_id);

-- One-time sign-in links. user_id is null for a requester who self-registers: the account is
-- created only when the link is used, so requesting a link never adds anyone to the directory.
create table magic_links (
  token_hash  text primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  user_id     uuid,
  email       text not null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now(),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);

create table projects (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  key          text not null check (key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  name         text not null check (length(name) between 1 and 200),
  description  text not null default '',
  next_num     integer not null default 1 check (next_num > 0),
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  unique (tenant_id, key),
  unique (tenant_id, id)
);

create table record_types (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  project_id   uuid not null,
  key          text not null check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  name         text not null check (length(name) between 1 and 200),
  description  text not null default '',
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade,
  unique (tenant_id, project_id, key),
  unique (tenant_id, id)
);

create table field_defs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  record_type_id  uuid not null,
  key             text not null check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  label           text not null check (length(label) between 1 and 200),
  type            text not null check (type in (
                    'text', 'long_text', 'number', 'currency', 'date',
                    'select', 'multi_select', 'user', 'checkbox', 'url')),
  required        boolean not null default false,
  options         jsonb not null default '{}'::jsonb,
  default_value   jsonb,
  help_text       text not null default '',
  position        integer not null default 0,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  foreign key (tenant_id, record_type_id) references record_types (tenant_id, id) on delete cascade,
  unique (tenant_id, record_type_id, key)
);

create table records (
  id               uuid primary key default gen_random_uuid(),
  -- Monotonic creation order; list pagination uses it (timestamps can tie).
  seq              bigint generated always as identity,
  tenant_id        uuid not null references tenants(id) on delete cascade,
  project_id       uuid not null,
  record_type_id   uuid not null,
  number           integer not null,
  key              text not null,
  title            text not null check (length(title) between 1 and 500),
  description      text not null default '',
  status           text not null default 'New',
  status_category  text not null default 'todo' check (status_category in ('todo', 'in_progress', 'done')),
  priority         text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  assignee_id      uuid,
  requester_id     uuid,
  custom           jsonb not null default '{}'::jsonb check (jsonb_typeof(custom) = 'object'),
  version          integer not null default 1,
  created_by       uuid,
  -- clock_timestamp(), not now(): rows created in one transaction keep a stable order.
  created_at       timestamptz not null default clock_timestamp(),
  updated_at       timestamptz not null default clock_timestamp(),
  deleted_at       timestamptz,
  deleted_by       uuid,
  search           tsvector generated always as (
                     setweight(to_tsvector('simple', coalesce(key, '') || ' ' || title), 'A') ||
                     setweight(to_tsvector('simple', description), 'B')
                   ) stored,
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, record_type_id) references record_types (tenant_id, id) on delete cascade,
  -- Composite keys stop a record pointing at a user in another workspace (foreign-key
  -- checks bypass row-level security).
  foreign key (tenant_id, assignee_id) references users (tenant_id, id) on delete set null (assignee_id),
  foreign key (tenant_id, requester_id) references users (tenant_id, id) on delete set null (requester_id),
  foreign key (tenant_id, created_by) references users (tenant_id, id) on delete set null (created_by),
  foreign key (tenant_id, deleted_by) references users (tenant_id, id) on delete set null (deleted_by),
  unique (tenant_id, key),
  unique (tenant_id, project_id, number),
  unique (tenant_id, id)
);
create index records_list_idx on records (tenant_id, seq desc) where deleted_at is null;
create index records_project_idx on records (tenant_id, project_id, seq desc) where deleted_at is null;
create index records_assignee_idx on records (tenant_id, assignee_id) where deleted_at is null;
create index records_trash_idx on records (tenant_id, deleted_at) where deleted_at is not null;
create index records_custom_idx on records using gin (custom jsonb_path_ops);
create index records_search_idx on records using gin (search);
create index records_title_trgm_idx on records using gin (title gin_trgm_ops);

-- Append-only history of every record change; feeds the audit trail and activity view.
create table record_events (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  record_id   uuid not null,
  -- No ON DELETE action: history rows are immutable, so people with history are
  -- deactivated, never deleted. Workspace purges remove both in one statement.
  actor_id    uuid,
  kind        text not null,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default clock_timestamp(),
  foreign key (tenant_id, record_id) references records (tenant_id, id) on delete cascade,
  foreign key (tenant_id, actor_id) references users (tenant_id, id)
);
create index record_events_record_idx on record_events (tenant_id, record_id, id);
create trigger record_events_append_only before update or delete on record_events
  for each row execute function tend247_append_only();

-- Append-only log of configuration changes (projects, record types, fields, users).
create table audit_log (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null references tenants(id) on delete cascade,
  actor_id     uuid,
  entity       text not null,
  entity_id    uuid,
  action       text not null,
  before       jsonb,
  after        jsonb,
  created_at   timestamptz not null default now(),
  foreign key (tenant_id, actor_id) references users (tenant_id, id)
);
create index audit_log_tenant_idx on audit_log (tenant_id, id desc);
create trigger audit_log_append_only before update or delete on audit_log
  for each row execute function tend247_append_only();

-- Events written in the same transaction as the change they describe. A consumer drains
-- them to Queues (Phase 2); a cron sweep re-sends anything left undelivered.
create table outbox (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references tenants(id) on delete cascade,
  topic         text not null,
  payload       jsonb not null,
  created_at    timestamptz not null default now(),
  delivered_at  timestamptz
);
create index outbox_pending_idx on outbox (id) where delivered_at is null;

-- Written and read at startup to prove Hyperdrive query caching is off (see db/checks.ts).
-- Holds no workspace data.
create table hyperdrive_probe (
  id          uuid primary key,
  value       text not null,
  created_at  timestamptz not null default now()
);

-- Row-level security on every tenant table.
do $$
declare t text;
begin
  foreach t in array array[
    'users', 'sessions', 'magic_links', 'projects', 'record_types', 'field_defs',
    'records', 'record_events', 'audit_log', 'outbox'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = tend247_current_tenant()) '
      'with check (tenant_id = tend247_current_tenant())', t);
  end loop;
end
$$;
