# Installing Tend 24/7

Each company runs its own copy: one Cloudflare Worker in your account, backed by your Postgres. A one-command installer arrives with v1.0; until then, follow these steps.

## 1. Postgres

Use Neon, Supabase or PlanetScale Postgres (version 15 or later). Create **two roles**:

| Role | Used by | Must be |
| --- | --- | --- |
| Owner (e.g. `tend247_owner`) | Migrations and seed scripts, over a direct connection | Owner of the database or schema; can create the `pg_trgm` extension |
| App (e.g. `tend247_app`) | The Worker, through Hyperdrive | **Not** a superuser and **without** `BYPASSRLS` |

Workspace isolation relies on row-level security. A role that bypasses it would see every workspace, so the app checks its own role at startup and refuses to serve if it is unsafe. Some providers' default roles have elevated attributes; always create the dedicated app role.

```sql
create role tend247_app login password '<strong password>' nobypassrls;
```

Or let the migration script create it: set `TEND247_DB_APP_PASSWORD` before running migrations.

## 2. Migrate

```bash
export TEND247_DB_OWNER_URL='postgres://tend247_owner:<pw>@<host>/<db>?sslmode=require'
export TEND247_DB_APP_ROLE=tend247_app
npm run db:migrate
```

This applies `migrations/*.sql` in order and grants the app role the privileges it needs. Migrations are forward-only and checksummed: an applied migration that was edited later is refused.

## 3. Hyperdrive

Create the config with the **app role** connection string and **caching disabled**. The app checks this at startup (it writes, reads, changes and re-reads a probe row) and refuses to serve if caching is on, because a cached read could be stale or cross workspaces:

```bash
npx wrangler hyperdrive create tend247-db \
  --connection-string="postgres://tend247_app:<pw>@<host>/<db>?sslmode=require" \
  --caching-disabled
```

Put the returned ID into `wrangler.jsonc` (`hyperdrive[0].id`).

## 4. Storage, email and the cron

Create the attachment bucket (and, optionally, a replica and a backup bucket):

```bash
npx wrangler r2 bucket create tend247-attachments
npx wrangler r2 bucket create tend247-attachments-replica   # optional
npx wrangler r2 bucket create tend247-backups               # optional; ideally in another account
```

Uncomment `ATTACHMENTS_REPLICA` and `BACKUPS` in `wrangler.jsonc` if you created them. The one-minute Cron Trigger in `wrangler.jsonc` delivers notifications, runs automation, fires SLA and retry timers, empties the trash after its retention period and runs the nightly export (02:00 in the workspace time zone).

**Outbound email** (notifications, sign-in links, approval links). Pick one:

| Provider | Settings |
| --- | --- |
| Cloudflare Email Service | Verify your sending domain, uncomment `send_email` in `wrangler.jsonc`, set `TEND247_EMAIL_PROVIDER=cloudflare` |
| Postmark | `TEND247_EMAIL_PROVIDER=postmark`, secret `TEND247_EMAIL_API_KEY` = server token |
| Resend | `TEND247_EMAIL_PROVIDER=resend`, secret `TEND247_EMAIL_API_KEY` = API key |

Set `TEND247_EMAIL_FROM` (for example `IT Help <help@acme.com>`).

**Inbound email** (queue addresses and threaded replies). Pick a domain or subdomain for it, for example `help.acme.com`, turn on Cloudflare Email Routing for it, and add a catch-all rule that sends mail to this Worker. Set `TEND247_INBOUND_DOMAIN=help.acme.com`. Then give each project a queue address on its admin page (for example `it` for `it@help.acme.com`). Replies to notifications go to `reply+<code>@help.acme.com` and land on the right record as comments.

The Worker accepts mail only when the receiving server's `Authentication-Results` header (from `mx.cloudflare.net` by default) shows DMARC, DKIM or SPF passing for the sender's domain. Unknown senders are refused, unless their domain is in `TEND247_REQUESTER_DOMAINS`; those become requesters on their first message.

## 5. Secrets and settings

```bash
npx wrangler secret put TEND247_SESSION_SECRET          # 32+ random characters
npx wrangler secret put TEND247_OIDC_CLIENT_SECRET      # if using SSO
npx wrangler secret put TEND247_EMAIL_API_KEY           # Postmark or Resend
npx wrangler secret put TEND247_BACKUP_ENCRYPTION_KEY   # openssl rand -base64 32; keep a copy offline
```

Set `TEND247_OIDC_ISSUER`, `TEND247_OIDC_CLIENT_ID`, `TEND247_OIDC_ALLOWED_DOMAINS` and `TEND247_PUBLIC_URL` in `wrangler.jsonc` `vars`. Register `https://<your host>/auth/oidc/callback` as the redirect URI with your identity provider.

How SSO sign-ins are matched to people:

1. By the provider's subject identifier, once linked.
2. By email, only if the provider marks the email verified and its domain is in `TEND247_OIDC_ALLOWED_DOMAINS`. Microsoft Entra ID does not send `email_verified`; if you use a single-tenant Entra app and trust its email claim, set `TEND247_OIDC_TRUST_UNVERIFIED_EMAIL=true`.
3. Otherwise a new person is created only if `TEND247_OIDC_AUTO_PROVISION` is `agent` or `requester`, the email is verified, and its domain is allowed.

When SSO is configured, admins and agents must use it; email sign-in links are for requesters only.

## 6. Deploy

```bash
npm run deploy
```

## 7. First workspace

Until the installer ships, create the first workspace and admin with SQL as the owner role:

```sql
insert into tenants (slug, name) values ('acme', 'Acme Corp') returning id;
begin;
select set_config('app.tenant_id', '<id from above>', true);
insert into users (tenant_id, email, display_name, role)
values ('<id>', 'you@acme.com', 'Your Name', 'admin');
commit;
```

Then sign in with SSO (or an email link) and configure projects under **Admin**.

## 8. Backups and restore

Three layers, from most to least frequent:

1. **Point-in-time recovery at the Postgres host.** Turn it on (Neon: history retention; Supabase: PITR add-on; PlanetScale: backups and PITR). This is the primary way back from a bad change: restore the database to a moment before it.
2. **Nightly export** to the `BACKUPS` bucket: every workspace table as gzipped NDJSON, AES-GCM encrypted when `TEND247_BACKUP_ENCRYPTION_KEY` is set, with a `manifest.json` per night. Kept 14 nights and 12 month-starts by default. Admin → Settings shows the last run; admins are notified if one fails. Sessions, sign-in and approval tokens and webhook secrets are never exported. Decode a part with `npm run export:decrypt -- <file> [out.ndjson]`.
3. **Attachment replica** in `ATTACHMENTS_REPLICA`: every upload is copied; a purged file's replica is deleted only after the trash retention period.

**After any database restore**, run:

```bash
TEND247_DB_OWNER_URL=... npm run rebuild
```

This re-arms SLA timers from the stored due times, re-queues undelivered events and recreates the nightly jobs. It is safe to run more than once. A full restore drill and a workspace import command arrive with v1.0.
