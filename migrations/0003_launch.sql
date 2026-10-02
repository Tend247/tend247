-- Tend 24/7 — Phase 3 (1.0): API tokens, webhook endpoints, read-only phone access, CSV
-- import and the public demo. Workspace tables are row-secured like 0001 and 0002;
-- demo_analytics holds only anonymous daily counters and is not (see the end of this file).

-- ---------------------------------------------------------------- API tokens
-- Bearer tokens for scripts and integrations. Each acts as the person who created it, limited
-- to its scopes. Only a hash of the secret is stored.
create table api_tokens (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  user_id       uuid not null,
  name          text not null check (length(name) between 1 and 120),
  token_hash    text not null unique,
  -- The first characters of the secret, shown in lists so people can tell tokens apart.
  hint          text not null,
  scopes        jsonb not null check (jsonb_typeof(scopes) = 'array'),
  expires_at    timestamptz,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now(),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);
create index api_tokens_user_idx on api_tokens (tenant_id, user_id);

-- ---------------------------------------------------------------- webhook endpoints
-- Subscriptions to workspace events, managed by admins. Deliveries reuse webhook_deliveries
-- (signed, retried and logged like the automation webhook action).
create table webhook_endpoints (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null check (length(name) between 1 and 120),
  url         text not null check (length(url) <= 2000),
  topics      jsonb not null check (jsonb_typeof(topics) = 'array'),
  project_id  uuid,
  enabled     boolean not null default true,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references projects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, created_by) references users (tenant_id, id) on delete set null (created_by)
);

alter table webhook_deliveries
  add column endpoint_id uuid,
  add column topic text,
  add foreign key (tenant_id, endpoint_id) references webhook_endpoints (tenant_id, id) on delete set null (endpoint_id),
  drop constraint webhook_deliveries_status_check,
  -- skipped: a demo sandbox records the delivery but never sends it.
  add constraint webhook_deliveries_status_check check (status in ('pending', 'delivered', 'failed', 'skipped'));
create index webhook_deliveries_created_idx on webhook_deliveries (tenant_id, created_at desc);

-- ---------------------------------------------------------------- read-only phone access
-- A signed-in desktop shows a QR code; the phone claims the one-time code, the desktop
-- approves the device it names, and the phone gets a short, read-only session for the same
-- person. code_hash and claim_hash are hashes of secrets held by the QR code and the phone.
create table device_pairings (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  user_id             uuid not null,
  code_hash           text not null unique,
  status              text not null default 'pending'
                        check (status in ('pending', 'claimed', 'approved', 'denied', 'redeemed', 'expired', 'revoked')),
  claim_hash          text,
  device_label        text check (length(device_label) <= 120),
  user_agent          text check (length(user_agent) <= 500),
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  claimed_at          timestamptz,
  decided_at          timestamptz,
  redeemed_at         timestamptz,
  session_expires_at  timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);
create index device_pairings_user_idx on device_pairings (tenant_id, user_id, created_at desc);

alter table sessions
  add column read_only   boolean not null default false,
  add column pairing_id  uuid,
  add foreign key (tenant_id, pairing_id) references device_pairings (tenant_id, id) on delete cascade;

-- ---------------------------------------------------------------- CSV import
alter table records
  drop constraint records_via_check,
  add constraint records_via_check check (via in ('app', 'email', 'automation', 'api', 'import'));

-- ---------------------------------------------------------------- the public demo
-- golden: the read-only master copy a seed version is cloned from; pool: a ready-made
-- sandbox nobody has claimed yet; claimed: a visitor's sandbox (expires_at set).
alter table tenants
  add column demo_state      text check (demo_state in ('golden', 'pool', 'claimed')),
  add column demo_seed       integer,
  add column claimed_at      timestamptz,
  add column last_active_at  timestamptz,
  -- Optional quotas (demo sandboxes set them; null means no limit).
  add column max_records     integer check (max_records > 0),
  add column max_users       integer check (max_users > 0),
  add constraint tenants_demo_state_needs_demo check (demo_state is null or demo);
create index tenants_demo_pool_idx on tenants (demo_seed, created_at) where demo_state = 'pool';
create index tenants_demo_claimed_idx on tenants (last_active_at) where demo_state = 'claimed';

-- What a demo sandbox would have emailed, shown in its mail viewer instead of being sent.
create table demo_mail (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  user_id     uuid,
  to_addr     text not null,
  subject     text not null,
  body        text not null,
  created_at  timestamptz not null default clock_timestamp(),
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete set null (user_id)
);
create index demo_mail_tenant_idx on demo_mail (tenant_id, created_at desc);

-- ---------------------------------------------------------------- row-level security
do $$
declare t text;
begin
  foreach t in array array['api_tokens', 'webhook_endpoints', 'device_pairings', 'demo_mail'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = tend247_current_tenant()) '
      'with check (tenant_id = tend247_current_tenant())', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------- anonymous counters (no RLS)
-- Daily totals for the demo's public stats strip (sandboxes started, requests filed, ...).
-- No workspace id, no visitor data.
create table demo_analytics (
  day    date not null,
  event  text not null check (event ~ '^[a-z][a-z0-9_.]{0,60}$'),
  count  integer not null default 0 check (count >= 0),
  primary key (day, event)
);
