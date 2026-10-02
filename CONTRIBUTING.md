# Contributing to Tend 24/7

Thanks for helping. Tend 24/7 is Apache-2.0 licensed; by contributing you agree your contribution is licensed the same way.

## Getting set up

Follow **Quick start (local)** in the README: Node 22+, Postgres 15+, `npm install`, the two database roles, `npm run db:migrate`, `npm run db:seed`, `npm run dev`.

## Before you open a pull request

```bash
npm run typecheck
npm test                 # real Postgres; see README > Tests
npm run licenses:check   # production dependencies must be Apache-2.0 compatible
npm run build
```

CI runs the same steps.

## Ground rules

- **Isolation first.** Every table holding workspace data has a `tenant_id` and a FORCE'd row-level security policy. `test/isolation.test.ts` fails if a new table doesn't. Run database work through `withTenant`, and never connect the app as a role that can bypass row-level security.
- **Configuration lives in rows.** Adding a field, status or record type must never need a migration (`test/no-migration.test.ts`).
- **Migrations are forward-only.** Never edit an applied migration; add a new one. The migrator refuses edited files by checksum.
- **Every change is recorded.** Record changes go to `record_events` and configuration changes to `audit_log`, both append-only, in the same transaction as the change.
- **Allowlists, not denylists**, for what API tokens and read-only phone sessions may call (`src/worker/auth/access.ts`, `src/worker/tokens/service.ts`). A new route is refused until someone lists it on purpose.
- **Tests come with behaviour.** Add or extend a suite under `test/` that exercises the change through the HTTP API where possible.
- **No new runtime dependency** without a good reason. If you add one, it must be Apache-2.0 compatible; run `npm run licenses:notices`.

## Writing style

User-facing text is plain, specific and short. No marketing words in the product; errors say what happened and what to do.

## Reporting bugs and ideas

Use the issue templates. For anything security-related, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
