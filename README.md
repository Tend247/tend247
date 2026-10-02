# Tend 24/7

Open-source work management for front and back-office teams. HR, IT, finance and service teams get their own request types, fields and workflows, configured by an admin rather than built by engineers. Every company runs its own copy on Cloudflare Workers with the Postgres it already uses.

Licensed under the [Apache License 2.0](LICENSE).

## Status

**1.0 release candidate (v1.0.0-rc.1): all four phases are built.** See the [roadmap](#roadmap). Try it at [tend247.com](https://tend247.com): **Try the live demo** gives you a private copy of Fernhollow Foods for 24 hours.

| Area | What ships |
| --- | --- |
| Workspaces | Row-level security on every table, forced, keyed on a transaction-local workspace setting. The app refuses to start on a role that could bypass it |
| Sign-in | OIDC single sign-on for staff, one-time email links for requesters, `__Host-` cookie sessions |
| Configuration | Projects, record types, ten custom field types. **Versioned workflows** (statuses in three categories; transitions guarded by role and required fields; post-transition actions) and **layouts** (create and view forms, sections, required fields). Publish, restore any earlier version, and map statuses when a version removes some |
| **Starter templates** | HR Cases, IT Service Desk, IT Enhancements and AP Requests: a queue with fields, workflow, form, SLA and team in one click ([docs/templates.md](docs/templates.md)) |
| Queues | Teams, a default team per project, manual, self or round-robin assignment. **Restricted projects** (HR, finance) are visible only to their teams, the assignee and the requester |
| Records | Keys like `FIN-142`, transitions, history with one-click revert of a field change, links (relates, blocks, duplicates, parent), bulk edit |
| **Requester portal** | A catalog of what employees can ask for, forms built from each type's create layout, "my requests", and a conversation with replies, files and reopen. Internal notes never show |
| Collaboration | Public and internal comments, @mentions, watchers, attachments in R2 with a per-workspace size limit |
| Finding work | Filter builder, saved and shared views, list and board (drag between workflow columns), sorts, and search across titles, descriptions and comments |
| **Dashboards** | Open work by status, priority and project; aging; created versus resolved per day; SLA attainment; workload. Limited to what the viewer can see |
| SLAs | Policies per project, matched by priority and type. First-response and resolution clocks on business-hours calendars (IANA time zones, holidays), paused in chosen statuses, with warning and breach notifications |
| Approvals | One approver or a sequence on any transition, decided in the app or from a one-time emailed link; no self-approval |
| Automation | Rules on record, comment, SLA and approval events: set field, assign (including round-robin), set team, transition, notify, comment, create a linked record, call a signed webhook with retries. Loop protection |
| **API and webhooks** | Scoped bearer tokens (`records`, `comments`, `config`; read or write) acting as their owner, rate limited. Webhook endpoints per event and project, signed, retried, with a delivery log and redeliver ([docs/api.md](docs/api.md)) |
| **Import** | People and records from CSV, with a dry run that reports every problem before anything is saved |
| **Phone access by QR** | Scan a code, approve the phone on your computer after checking its device and a match number, and get 4 hours of server-enforced read-only access as yourself. Linked devices can be revoked; every step is audited |
| Email | Outbound through Cloudflare Email Service, Postmark or Resend. Inbound through Cloudflare Email Routing: queue addresses create records, and `reply+code@` addresses thread replies as comments. Sender verification, dedupe, auto-reply filtering |
| Notifications | In-app and email, per-person preferences, idempotent per event |
| Backup and recovery | Trash with admin restore and purge. Nightly encrypted NDJSON export to R2 with health checks and alerts. Attachment replica. **Whole-workspace bundles** for moving a workspace between deployments, and **`npm run restore:check`** with a monthly drill in CI ([docs/restore.md](docs/restore.md)) |
| **Installer** | `npm run setup` migrates the database, creates the locked-down app role, Hyperdrive (caching off), R2, sign-in settings, the first workspace and admin, the secrets, and deploys ([docs/install.md](docs/install.md)) |
| **Public demo** | Turnstile-gated private sandboxes cloned from a versioned golden copy, a warm pool, a role switcher, a guided tour, a simulator, captured mail, and guardrails ([docs/demo.md](docs/demo.md)) |

Gates:

- Phase 0: `test/isolation.test.ts` and `test/no-migration.test.ts`.
- Phases 1–2: `test/gates.test.ts`.
- Phase 3: `test/gate-launch.test.ts`. Two template-built functions are worked end to end through the portal and the agent app, with an integration on a scoped token, a read-only phone and a workspace moved by bundle; a stranger gets a demo sandbox in seconds.
- `test/access.test.ts` covers API tokens and the adversarial cases for phone pairing.

221 tests in all.

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
npm run db:seed                 # Fernhollow Foods sample data (made-up company): the 4 starter templates, teams, SLAs, approvals

# 3. Worker secrets for local dev (never commit this file).
cat > .dev.vars <<'EOF'
TEND247_SESSION_SECRET=replace-with-at-least-32-random-characters
TEND247_DEV_LOGIN=true
TEND247_PUBLIC_SITE=true
EOF

npm run dev                     # http://localhost:5173
npm run site:dev                # the tend247.com configuration (marketing pages and the demo)
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

```bash
npm run setup -- --dry-run   # see every step
npm run setup                # install into your Cloudflare account and Postgres
```

See [docs/install.md](docs/install.md), including the database roles to create on PlanetScale, Neon or Supabase, and the manual steps. Then read the [admin guide](docs/admin-guide.md).

### tend247.com

The project's own site is the same Worker with the marketing pages and the public demo turned on (`wrangler.tend247.jsonc`, deployed with `npm run site:deploy`). See [docs/demo.md](docs/demo.md).

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
| `TEND247_DEMO` | var | Host the public demo (tend247.com only) |
| `TEND247_TURNSTILE_SITE_KEY`, `TEND247_TURNSTILE_SECRET` | var / secret | Turnstile widget guarding "Try the demo" |
| `TEND247_DEMO_POOL_SIZE`, `TEND247_DEMO_HOURS`, `TEND247_DEMO_MAX_RECORDS`, `TEND247_DEMO_MAX_SANDBOXES` | var | Demo pool size (3), sandbox lifetime (24 h), records per sandbox (300), live sandboxes (1,000) |

Bindings:

- `HYPERDRIVE` (required);
- the `ATTACHMENTS` R2 bucket;
- optional `ATTACHMENTS_REPLICA` and `BACKUPS` R2 buckets;
- an optional `EMAIL` send_email binding;
- optional rate limiters: `API_RATE_LIMITER`, plus `DEMO_START_LIMITER` and `DEMO_WRITE_LIMITER` for the demo;
- a one-minute Cron Trigger (in `wrangler.jsonc`).

## Layout

```
migrations/          forward-only SQL migrations (run as the schema owner)
scripts/             setup, migrate, seed, workspace export/import, restore check, rebuild,
                     decrypt an export, license check
src/worker/          Hono API, auth, tokens, phone pairing, config engine, templates, records,
                     workflows, SLAs, approvals, automation, webhooks, email in/out,
                     notifications, dashboards, import, bundles, background jobs, export, demo
src/web/             React app: staff (/app), portal (/portal), phone views (/m),
                     marketing pages and demo (/, /roadmap, /architecture)
docs/                install, admin guide, templates, API, restore, demo
test/                Vitest suites against real Postgres
```

## Roadmap

| Phase | Version | Scope | Exit gate |
| --- | --- | --- | --- |
| 0 · Foundations | v0.1 | Tenancy, sign-in, roles, audit, config engine, records | Isolation tests pass; adding a field needs no migration ✅ |
| 1 · Work core | v0.2 | Workflows, layouts, queues, assignment, comments, attachments, views, search | One internal team runs a live queue end to end ✅ (automated; live pilot next) |
| 2 · Service layer | v0.3 | SLAs, automation, approvals, email in/out, notifications, nightly export | SLA, approval and email flows hold through a pilot week ✅ (automated; pilot week next) |
| 3 · Launch | v1.0 | Portal, API, webhooks, templates, dashboards, demo, phone access by QR, installer | Pilot teams live on two functions; demo and installer public ✅ (automated; pilots next) |

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Changes per release are in [CHANGELOG.md](CHANGELOG.md).

## License

Apache-2.0. Third-party notices for the bundled dependencies are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (regenerate with `npm run licenses:notices`).
