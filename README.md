# Tend 24/7

Open-source work management for front and back-office teams. HR, IT, finance and service teams get their own request types, fields and workflows, configured by an admin rather than built by engineers. Every company runs its own copy on Cloudflare Workers with the Postgres it already uses.

Licensed under the [Apache License 2.0](LICENSE).

## Status

**Phases 0–2 are complete (v0.3): foundations, work core and service layer.** See the [roadmap](#roadmap).

| Area | What ships |
| --- | --- |
| Workspaces | Row-level security on every table, forced, keyed on a transaction-local workspace setting; the app refuses to start on a role that could bypass it |
| Sign-in | OIDC single sign-on for staff, one-time email links for requesters, `__Host-` cookie sessions |
| Configuration | Projects, record types, ten custom field types; **versioned workflows** (statuses in three categories, transitions guarded by role and required fields, post-transition actions) and **layouts** (create and view forms, sections, required fields); publish, restore any earlier version, status mapping when a version removes statuses |
| Queues | Teams, default team per project, manual, self or round-robin assignment; **restricted projects** (HR, finance) visible only to their teams, the assignee and the requester |
| Records | Keys like `FIN-142`, transitions, history with one-click revert of a field change, links (relates, blocks, duplicates, parent), bulk edit |
| Collaboration | Public and internal comments, @mentions, watchers, attachments in R2 with per-workspace size limit |
| Finding work | Filter builder, saved and shared views, list and board (drag between workflow columns), sorts, search across titles, descriptions and comments |
| SLAs | Policies per project matched by priority and type; first-response and resolution clocks on business-hours calendars (IANA time zones, holidays), paused in chosen statuses, warning and breach notifications |
| Approvals | One approver or a sequence on any transition; decided in the app or from a one-time emailed link; no self-approval |
| Automation | Rules on record, comment, SLA and approval events: set field, assign (incl. round-robin), set team, transition, notify, comment, create a linked record, signed webhook with retries; loop protection |
| Email | Outbound through Cloudflare Email Service, Postmark or Resend; inbound through Cloudflare Email Routing: queue addresses create records, `reply+code@` addresses thread replies as comments; sender verification, dedupe, auto-reply filtering |
| Notifications | In-app and email, per-person preferences, idempotent per event |
| Backup and recovery | Trash for records, comments and files (retention configurable) with admin restore and purge; nightly chunked NDJSON export to R2, gzip plus optional AES-GCM, daily and monthly retention, health on the admin page and an alert on failure; attachment replica; `npm run rebuild` after a restore |

Gates: `test/isolation.test.ts` and `test/no-migration.test.ts` (Phase 0), `test/gates.test.ts` (Phases 1–2: an email to the IT desk becomes a routed record, SLA clocks pause and meet, a manager approves from an emailed link, the requester's emailed reply threads back). 164 tests in all.

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
npm run db:seed                 # Fernhollow Foods sample data (made-up company): 4 queues, teams, SLAs, approvals

# 3. Worker secrets for local dev (never commit this file).
cat > .dev.vars <<'EOF'
TEND247_SESSION_SECRET=replace-with-at-least-32-random-characters
TEND247_DEV_LOGIN=true
TEND247_PUBLIC_SITE=true
EOF

npm run dev                     # http://localhost:5173
```

The local Hyperdrive connection string lives in `wrangler.jsonc` (`localConnectionString`). Sign in with **Dev sign-in** as `admin@fernhollow.test` (admin), `dana@`, `sam@` or `lee@fernhollow.test` (agents) or `jo@fernhollow.test` (requester). R2 buckets are simulated locally, and in development outbound email is printed to the console.

## Tests

```bash
npm test               # needs the test database below
npm run typecheck
npm run licenses:check # fails if a production dependency is not Apache-2.0 compatible
```

CI (GitHub Actions, `.github/workflows/ci.yml`; a GitLab equivalent is in `.gitlab-ci.yml`) runs all four on every push and pull request. Tests run in Node against a real Postgres database, connecting as both the owner and the app role. Defaults point at `127.0.0.1:54329/tend247_test`; override with `TEND247_TEST_DB_OWNER_URL` and `TEND247_TEST_DB_APP_URL`. The suite drops and recreates the test schema on every run, so never point it at real data.

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
| `TEND247_EMAIL_PROVIDER` | var | `none`, `cloudflare` (needs the `EMAIL` send_email binding), `postmark` or `resend` |
| `TEND247_EMAIL_FROM` | var | From address for notifications and sign-in links |
| `TEND247_EMAIL_API_KEY` | secret | Postmark server token or Resend API key |
| `TEND247_INBOUND_DOMAIN` | var | Domain Email Routing delivers to the Worker (queue addresses, `reply+…` threads) |
| `TEND247_INBOUND_AUTHSERV_ID` | var | Whose `Authentication-Results` to trust (default `mx.cloudflare.net`) |
| `TEND247_BACKUP_ENCRYPTION_KEY` | secret | 32 random bytes, base64: encrypts the nightly export |
| `TEND247_BACKUP_DAILY_KEEP`, `TEND247_BACKUP_MONTHLY_KEEP` | var | Export retention (default 14 daily, 12 monthly) |

Bindings: `HYPERDRIVE` (required), `ATTACHMENTS` R2 bucket (attachments), optional `ATTACHMENTS_REPLICA` and `BACKUPS` R2 buckets, optional `EMAIL` send_email binding, and a one-minute Cron Trigger (in `wrangler.jsonc`).

## Layout

```
migrations/          forward-only SQL migrations (run as the schema owner)
scripts/             migrate, seed, rebuild after restore, decrypt an export, license check
src/worker/          Hono API, auth, config engine, records, workflows, SLAs, approvals,
                     automation, email in/out, notifications, background jobs, export
src/web/             React app (/app) and marketing pages (/, /roadmap, /architecture)
test/                Vitest suites against real Postgres
```

## Roadmap

| Phase | Version | Scope | Exit gate |
| --- | --- | --- | --- |
| 0 · Foundations | v0.1 | Tenancy, sign-in, roles, audit, config engine, records | Isolation tests pass; adding a field needs no migration ✅ |
| 1 · Work core | v0.2 | Workflows, layouts, queues, assignment, comments, attachments, views, search | One internal team runs a live queue end to end ✅ (automated; live pilot next) |
| 2 · Service layer | v0.3 | SLAs, automation, approvals, email in/out, notifications, nightly export | SLA, approval and email flows hold through a pilot week ✅ (automated; pilot week next) |
| 3 · Launch | v1.0 | Portal, API, webhooks, templates, dashboards, demo, phone access by QR, installer | Pilot teams live on two functions |

## License

Apache-2.0. Third-party notices for the bundled dependencies are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (regenerate with `npm run licenses:notices`).
