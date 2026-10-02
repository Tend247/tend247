# Changelog

All notable changes. Versions follow [semantic versioning](https://semver.org/); database migrations are forward-only and run with `npm run db:migrate` before you deploy.

## Unreleased

### Fixed
- Scripts (`db:migrate`, `db:seed`, `setup`, bundles, restore check) accept connection strings copied from provider dashboards. libpq-only options such as `sslrootcert=system` used to reach the server and fail with "unrecognized configuration parameter". `sslrootcert=system` now means `sslmode=verify-full`, `sslrootcert=<file>` trusts that CA, and other client-only options are dropped with a note. The Hyperdrive connection string made by `npm run setup` leaves them out too.

## 1.0.0-rc.2 (2026-10-02)

Agile planning, custom templates and a guided setup. **Migration:** `0004_agile_and_templates.sql`.

### Added
- **Setup guide** (Admin > Projects > Set up a new project) for admins who are not developers. It starts from scratch, a built-in or saved template, or a file, then asks plain questions:
  - basics: name, key, team, assignment, visibility, sprints;
  - types and a palette of ten question types;
  - steps, with any-to-any or in-order moves, and per-step approval and required answers;
  - response and resolution targets.

  A review runs the real install in a rolled-back transaction and points each problem at the step that fixes it. The project is then created in one go, and can be kept as a template.
- **Custom templates:**
  - **Save as template** on any project, with a list of what was generalised or left out (people, webhooks, the inbound address).
  - **Your templates**, with install, download and delete.
  - **Upload a template file** from another workspace.
  - One template format for built-in, saved, wizard and file templates (`docs/templates.md`), plus admin API routes to list, check, install, save, download and delete. Templates can never contain webhook actions.
- **Agile planning** per project (`docs/agile.md`):
  - sprints (plan, start with a goal and length, complete with carry-over to a planned or new sprint or the backlog);
  - a ranked backlog with drag and drop and keyboard reordering;
  - story points and epics, with an epics panel;
  - a sprint board with swimlanes by epic, assignee or priority;
  - burndown (from daily snapshots, with scope change), velocity, and epic progress.

  Restricted projects keep their plans to their team. The agile API comes with token scopes and `sprint.started` / `sprint.completed` webhook events.
- **Agile Software Team** built-in template (Story, Bug, Task, Epic).
- Fernhollow Foods gains the **Wholesale Ordering App** team: two finished sprints, one running with a moving burndown, one planned, three epics and a ranked backlog. The sample seed is now version 2, so demo golden copies rebuild.
- Line charts can show a partial series and a dashed reference line; a grouped bar chart for velocity.

### Changed
- Project settings gain **Agile**; record types gain **Epic type**.
- Records carry `storyPoints`, `sprintId`, `epicId`, `epicKey`, `epicTitle` and `rank`. Lists and boards filter by `sprintId` and `epicId` and sort by `rank_asc`. `GET /api/board?projectId=…&columns=status` draws a project's status board.
- Workspace bundles and nightly exports include sprints, burndown snapshots and saved templates.
- The dashboard, planning and setup-guide pages load on first visit, which keeps the main bundle smaller.

## 1.0.0-rc.1 (2026-10-02)

Phase 3: launch. **Migration:** `0003_launch.sql`.

### Added
- **Starter templates:** HR Cases, IT Service Desk, IT Enhancements and AP Requests, installed from Admin > Projects or `POST /api/admin/templates/:key/install`. The Fernhollow sample (`npm run db:seed`) is now built from them.
- **Requester portal** at `/portal`: a catalog, forms from each type's create layout, "my requests", and a conversation with replies, files and reopen. Requesters are sent there automatically, and links in emails still work.
- **API tokens** (`Authorization: Bearer t247.…`): scoped, expiring, revocable, rate limited per token, and acting as their owner. See `docs/api.md`.
- **Webhook endpoints:** subscribe a URL to events, optionally limited to one project. Deliveries are signed, retried, logged, and can be redelivered or test-pinged.
- **Dashboard:** open work, aging, throughput, SLA attainment and workload, all filtered by what the viewer can see.
- **CSV import** of people and records, with a dry run.
- **Read-only phone access by QR code:**
  - a single-use 128-bit code, carried in the URL fragment, that expires after 2 minutes;
  - desktop approval showing the phone's device, browser and a match number;
  - a 4-hour read-only session limited to an allowlist of routes;
  - linked devices with revoke, and audit events.
- **Phone views** at `/m`.
- **Whole-workspace bundles:** Admin > Settings > Export, `npm run workspace:export` and `npm run workspace:import`. Imports get fresh ids and follow every reference.
- **`npm run restore:check`** restores a nightly export or bundle into a temporary, inert workspace and compares every table. It runs monthly in CI (`restore-drill.yml`).
- **`npm run setup`** installs the whole thing (with `--dry-run`): migrate, app role, Hyperdrive, R2, sign-in settings, first workspace, secrets, deploy.
- **Public demo** (tend247.com):
  - Turnstile-gated sandboxes cloned from a versioned golden copy, with a warm pool;
  - a role switcher and guided tour;
  - a simulator, and an opening incident that breaches its SLA within minutes;
  - captured mail and a stats strip;
  - guardrails and quotas.
- CI job against PlanetScale Postgres (runs when the repository has its secrets).
- Docs: admin guide, templates, API, restore, demo; PlanetScale, Neon and Supabase role setup in the install guide.

### Changed
- tend247.com is now the full app Worker (`wrangler.tend247.jsonc`, still named `tend247-site`), not a static site. `vite.site.config.ts`, `wrangler.site.jsonc` and `site-public/` are gone; security headers moved to `public/_headers` and now allow Cloudflare Turnstile.
- `GET /auth/config` and `/healthz` answer even when the database check fails, so the landing page renders.
- The nightly export filters every table by workspace in addition to row-level security.
- Pages served by the Worker (sign-in link, approval, phone pairing) send a strict per-response Content-Security-Policy.
- API responses are `Cache-Control: no-store`, `nosniff` and `X-Frame-Options: DENY`.

### Upgrade notes
- Run `npm run db:migrate`, then deploy.
- If you deployed the static marketing site before, `npm run site:deploy` now replaces it in place (see `docs/demo.md` for the database, Hyperdrive, Turnstile and secrets it needs).

## 0.3.0

Phases 1 and 2 (`0002_work_core_and_service_layer.sql`): workflows, layouts, teams, restricted projects, comments, attachments, views, links, SLAs, approvals, automation, email in and out, notifications, trash, nightly export.

## 0.1.0

Phase 0 (`0001_init.sql`): workspaces with forced row-level security, sign-in (OIDC, email links), roles, audit log, the configuration engine and records.
