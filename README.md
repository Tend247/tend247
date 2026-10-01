# Tend 24/7

Open-source work management for front and back-office teams. HR, IT, finance and service teams get their own request types, fields and workflows, configured by an admin rather than built by engineers. Every company runs its own copy on Cloudflare Workers with the Postgres it already uses.

Licensed under the [Apache License 2.0](LICENSE).

## Status

**Phase 0 (v0.1, Foundations) is complete.** See the [roadmap](#roadmap).

| Shipped in Phase 0 | |
| --- | --- |
| Workspaces | Row-level security on every table, forced, keyed on a transaction-local workspace setting; the app refuses to start on a role that could bypass it |
| Sign-in | OIDC single sign-on for staff (verified-email linking, domain allowlist), one-time email links for requesters (redeemed by POST from the URL fragment), `__Host-` cookie sessions, dev login for local work |
| Roles | Admin, agent, requester |
| Configuration engine | Projects, record types and ten custom field types (text, long text, number, currency, date, single/multi choice, person, checkbox, URL); no schema change to add a field |
| Records | Keys like `FIN-142`, validation against field definitions, optimistic locking, full history, outbox events, trash with admin restore |
| Audit | Append-only audit log of every configuration change |
| Web | Agent app under `/app`; marketing pages (landing, roadmap, architecture) for tend247.com |

Email sign-in links need an outbound email provider, which arrives in Phase 2; until then they work only in local development, where links are printed to the console.

Both Phase 0 gates are covered by tests: `test/isolation.test.ts` (tenant isolation) and `test/no-migration.test.ts` (configuration never changes the schema).

## Quick start (local)

Requirements: Node 22+, Postgres 15+ with `pg_trgm`.

```bash
npm install

# 1. Database: an owner role for migrations and a separate app role for the Worker.
psql -U postgres <<'SQL'
create role tend247_owner login password 'owner_dev_pw' createrole;
create role tend247_app login password 'app_dev_pw' nobypassrls;
create database tend247_dev owner tend247_owner;
SQL

# 2. Configure local scripts.
cp .env.example .env            # set TEND247_DB_OWNER_URL
npm run db:migrate              # schema + grants for the app role
npm run db:seed                 # Fernhollow Foods sample data (made-up company)

# 3. Worker secrets for local dev (never commit this file).
cat > .dev.vars <<'EOF'
TEND247_SESSION_SECRET=replace-with-at-least-32-random-characters
TEND247_DEV_LOGIN=true
TEND247_PUBLIC_SITE=true
EOF

npm run dev                     # http://localhost:5173
```

The local Hyperdrive connection string lives in `wrangler.jsonc` (`localConnectionString`). Sign in with **Dev sign-in** as `admin@fernhollow.test`.

## Tests

```bash
npm test               # needs the test database below
npm run typecheck
npm run licenses:check # fails if a production dependency is not Apache-2.0 compatible
```

Tests run in Node against a real Postgres database, connecting as both the owner and the app role. Defaults point at `127.0.0.1:54329/tend247_test`; override with `TEND247_TEST_DB_OWNER_URL` and `TEND247_TEST_DB_APP_URL`. The suite drops and recreates the test schema on every run, so never point it at real data.

## Deploying

See [docs/install.md](docs/install.md). In short: create the two database roles on Neon, Supabase or PlanetScale, run migrations, create a Hyperdrive config with caching disabled, set secrets, and `npm run deploy`.

## Configuration

| Variable | Where | Purpose |
| --- | --- | --- |
| `TEND247_SESSION_SECRET` | secret | Signs sign-in state; 32+ characters |
| `TEND247_OIDC_ISSUER`, `TEND247_OIDC_CLIENT_ID`, `TEND247_OIDC_CLIENT_SECRET` | var / secret | Staff single sign-on |
| `TEND247_OIDC_AUTO_PROVISION` | var | `off`, `agent` or `requester`: create people on first SSO sign-in (requires allowed domains) |
| `TEND247_OIDC_ALLOWED_DOMAINS` | var | Email domains that may link to existing people or be provisioned through SSO |
| `TEND247_OIDC_TRUST_UNVERIFIED_EMAIL` | var | Link existing people by email even if the provider omits `email_verified` (Microsoft Entra ID); single-tenant providers only, requires allowed domains |
| `TEND247_REQUESTER_DOMAINS` | var | Email domains allowed to self-register as requesters |
| `TEND247_PUBLIC_URL` | var | Origin used in emailed links (recommended in production) |
| `TEND247_PUBLIC_SITE` | var | Serve the marketing pages at `/` (tend247.com only) |
| `TEND247_REPO_URL` | var | Source link shown on the marketing pages |
| `TEND247_DEV_LOGIN` | var | Passwordless sign-in for local development only |

## Layout

```
migrations/          forward-only SQL migrations (run as the schema owner)
scripts/             migrate, seed, license check
src/worker/          Hono API, auth, config engine, records (runs in the Worker)
src/web/             React app (/app) and marketing pages (/, /roadmap, /architecture)
test/                Vitest suites against real Postgres
```

## Roadmap

| Phase | Version | Scope | Exit gate |
| --- | --- | --- | --- |
| 0 · Foundations | v0.1 | Tenancy, sign-in, roles, audit, config engine, records | Isolation tests pass; adding a field needs no migration ✅ |
| 1 · Work core | v0.2 | Workflows, layouts, queues, assignment, comments, attachments, views, search | One internal team runs a live queue end to end |
| 2 · Service layer | v0.3 | SLAs, automation, approvals, email in/out, notifications, nightly export | SLA, approval and email flows hold through a pilot week |
| 3 · Launch | v1.0 | Portal, API, webhooks, templates, dashboards, demo, phone access by QR, installer | Pilot teams live on two functions |

## License

Apache-2.0. Third-party notices for the bundled dependencies are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (regenerate with `npm run licenses:notices`).
