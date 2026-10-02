# Installing Tend 24/7

Each company runs its own copy: one Cloudflare Worker in your account, backed by your Postgres. You need Node 22+, a Cloudflare account (`npx wrangler login`) and a Postgres 15+ database. macOS, Linux or WSL.

There are two ways to install:

- **One command:** prepare the database roles (step 1), then run `npm run setup`. It does everything else.
- **By hand:** the same steps, one at a time (steps 2 to 8 below).

## 1. Database roles

Workspace isolation relies on Postgres row-level security. A role that can bypass it would see every workspace, so Tend 24/7 uses **two dedicated roles** and checks them at startup:

| Role | Used by | Must be |
| --- | --- | --- |
| `tend247_owner` | Migrations, the installer and the scripts, over a direct connection | Owner of the database; can create roles and the `pg_trgm` extension. **Not** a superuser, **no** `BYPASSRLS` |
| `tend247_app` | The Worker, through Hyperdrive | **Not** a superuser, **no** `BYPASSRLS`, does not own the schema |

The Worker refuses to serve on an unsafe app role, and the export and import scripts refuse an owner that can bypass row-level security. Hosted providers' default admin roles usually have elevated attributes, so don't use them for either role.

Connect as your provider's admin role and run:

```sql
create role tend247_owner login password '<strong password>' createrole;
grant tend247_owner to <your admin role>;        -- lets the admin role create a database owned by it
create database tend247 owner tend247_owner;
```

The app role is created for you by `npm run setup` (or by `npm run db:migrate` when `TEND247_DB_APP_PASSWORD` is set).

Check both roles afterwards. Every row must show `false` twice:

```sql
select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('tend247_owner', 'tend247_app');
```

### PlanetScale (Postgres)

The default `postgres` role is not a superuser but has `BYPASSRLS`, `CREATEROLE`, `CREATEDB`, `pg_read_all_data` and `pg_write_all_data`. Use it only to run the SQL above, which works as written with `<your admin role>` = `postgres`. Then use `tend247_owner`'s connection string, with `sslmode=verify-full`, for everything else. `pg_trgm` is available.

### Neon

Run the SQL above as the project's owner role (for example `neondb_owner`). Roles you create in the Neon console join `neon_superuser`, which can bypass row-level security, so **create the two roles with SQL**, not in the console. Use the direct (unpooled) connection string.

### Supabase

Run the SQL above in the SQL editor as `postgres`. Use the direct connection on port 5432, not the transaction pooler. Leave Supabase's own `anon` and `authenticated` roles alone: Tend 24/7 doesn't use them.

## 2. One command: `npm run setup`

```bash
git clone https://github.com/Tend247/tend247 && cd tend247
npm ci
npx wrangler login
npm run setup -- --dry-run      # shows every step and command, changes nothing
npm run setup
```

It asks for:

- `tend247_owner`'s connection string
- your company name and the first admin's email
- how staff sign in:
  - **single sign-on**: OIDC issuer, client id and secret, allowed email domains
  - **email links**: Resend or Postmark API key and a From address

It then:

1. migrates the database and creates (or re-keys) `tend247_app`;
2. checks that the app role is safe;
3. creates a Hyperdrive config with caching disabled and writes its id into `wrangler.jsonc`;
4. creates the `tend247-attachments` R2 bucket;
5. sets the sign-in variables;
6. creates the first workspace and admin;
7. builds and deploys;
8. stores the Worker secrets (a generated session key and backup encryption key, and your SSO or email credentials).

The backup key is printed once at the end. Keep it in a password manager, because you need it to read the nightly exports.

To run it without prompts (for example from a script), pass flags and keep secrets in the environment or in `.env` so they stay out of shell history:

```bash
export TEND247_DB_OWNER_URL='postgres://tend247_owner:…@host/tend247?sslmode=verify-full'
export TEND247_OIDC_CLIENT_SECRET='…'
npm run setup -- --yes --workspace-name "Acme Foods" --admin-email it@acme.com \
  --sign-in oidc --oidc-issuer https://login.microsoftonline.com/<tenant>/v2.0 --oidc-client-id <id> --oidc-domains acme.com \
  --public-url https://help.acme.com
```

`wrangler hyperdrive create` takes the app role's connection string on its command line, so run setup on a machine you trust. If `tend247_app` already exists and the owner cannot change its password, set `TEND247_DB_APP_PASSWORD` to its current password.

Setup is safe to run again. It skips the workspace when one exists. If a Hyperdrive config named `tend247-db` already exists, pass its id with `--hyperdrive-id`.

## 3. By hand: migrate

```bash
export TEND247_DB_OWNER_URL='postgres://tend247_owner:<pw>@<host>/<db>?sslmode=require'
export TEND247_DB_APP_ROLE=tend247_app
export TEND247_DB_APP_PASSWORD='<strong password>'    # creates the app role if it is missing
npm run db:migrate
```

This applies `migrations/*.sql` in order and grants the app role what it needs. Migrations are forward-only and checksummed: a migration that was edited after it was applied is refused.

## 4. Hyperdrive

Create the config with the **app role** connection string and **caching disabled**. The app checks this at startup by writing a probe row, reading it, changing it and reading it again. It refuses to serve if caching is on, because a cached read could be stale or cross workspaces.

```bash
npx wrangler hyperdrive create tend247-db \
  --connection-string="postgres://tend247_app:<pw>@<host>/<db>?sslmode=require" \
  --caching-disabled
```

Put the returned id into `wrangler.jsonc` (`hyperdrive[0].id`).

## 5. Storage, email and the cron

```bash
npx wrangler r2 bucket create tend247-attachments
npx wrangler r2 bucket create tend247-attachments-replica   # optional
npx wrangler r2 bucket create tend247-backups               # optional; ideally in another account
```

Uncomment `ATTACHMENTS_REPLICA` and `BACKUPS` in `wrangler.jsonc` if you created them. The one-minute Cron Trigger does the background work:

- delivers notifications and runs automation;
- fires SLA and retry timers;
- empties the trash after its retention period;
- runs the nightly export (02:00 in the workspace time zone).

**Outbound email** (notifications, sign-in links, approval links). Pick one:

| Provider | Settings |
| --- | --- |
| Cloudflare Email Service | Verify your sending domain, uncomment `send_email` in `wrangler.jsonc`, set `TEND247_EMAIL_PROVIDER=cloudflare` |
| Postmark | `TEND247_EMAIL_PROVIDER=postmark`, secret `TEND247_EMAIL_API_KEY` = server token |
| Resend | `TEND247_EMAIL_PROVIDER=resend`, secret `TEND247_EMAIL_API_KEY` = API key |

Set `TEND247_EMAIL_FROM` (for example `IT Help <help@acme.com>`).

**Inbound email** (queue addresses and threaded replies):

1. Pick a domain or subdomain for it, for example `help.acme.com`.
2. Turn on Cloudflare Email Routing for it and add a catch-all rule that sends mail to this Worker.
3. Set `TEND247_INBOUND_DOMAIN=help.acme.com`.
4. Give each project a queue address on its admin page, for example `it` for `it@help.acme.com`.

Replies to notifications go to `reply+<code>@help.acme.com` and land on the right record as comments.

The Worker accepts mail only when the receiving server's `Authentication-Results` header (from `mx.cloudflare.net` by default) shows DMARC, DKIM or SPF passing for the sender's domain. Unknown senders are refused, unless their domain is in `TEND247_REQUESTER_DOMAINS`; those become requesters on their first message.

**API rate limit.** `wrangler.jsonc` binds `API_RATE_LIMITER`, which allows 300 requests per minute per API token. Change the limit there, or remove the binding to turn it off.

## 6. Secrets and settings

```bash
npx wrangler secret put TEND247_SESSION_SECRET          # 32+ random characters
npx wrangler secret put TEND247_OIDC_CLIENT_SECRET      # if using SSO
npx wrangler secret put TEND247_EMAIL_API_KEY           # Postmark or Resend
npx wrangler secret put TEND247_BACKUP_ENCRYPTION_KEY   # openssl rand -base64 32; keep a copy offline
```

Set `TEND247_OIDC_ISSUER`, `TEND247_OIDC_CLIENT_ID`, `TEND247_OIDC_ALLOWED_DOMAINS` and `TEND247_PUBLIC_URL` in the `vars` of `wrangler.jsonc`. Register `https://<your host>/auth/oidc/callback` as the redirect URI with your identity provider.

How SSO sign-ins are matched to people:

1. By the provider's subject identifier, once linked.
2. By email, only if the provider marks the email verified and its domain is in `TEND247_OIDC_ALLOWED_DOMAINS`. Microsoft Entra ID does not send `email_verified`. If you use a single-tenant Entra app and trust its email claim, set `TEND247_OIDC_TRUST_UNVERIFIED_EMAIL=true`.
3. Otherwise a new person is created only if `TEND247_OIDC_AUTO_PROVISION` is `agent` or `requester`, the email is verified, and its domain is allowed.

When SSO is configured, admins and agents must use it; email sign-in links are for requesters only.

## 7. Deploy

```bash
npm run deploy
```

## 8. First workspace

`npm run setup` creates it. By hand, run this SQL as the owner role:

```sql
insert into tenants (slug, name) values ('acme', 'Acme Corp') returning id;
begin;
select set_config('app.tenant_id', '<id from above>', true);
insert into users (tenant_id, email, display_name, role) values ('<id>', 'you@acme.com', 'Your Name', 'admin');
commit;
```

Then sign in with SSO (or an email link), go to **Admin > Projects** and install a starter template ([docs/templates.md](templates.md)).

## Updating

```bash
git pull
npm ci
npm run db:migrate     # as the owner; forward-only
npm run deploy
```

Read `CHANGELOG.md` first; it lists every migration and anything you need to do.

## Backups

See [docs/restore.md](restore.md) for the backup layers, restoring, moving a workspace to another deployment, and the monthly restore drill.
