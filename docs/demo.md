# The public demo (tend247.com)

tend247.com runs the same Worker as every self-hosted copy. Its configuration, `wrangler.tend247.jsonc`, turns on two extra things:

- the marketing pages at `/` (`TEND247_PUBLIC_SITE`);
- the public demo (`TEND247_DEMO`).

Self-hosted deployments leave both off.

## How it works

- **Try the live demo** shows a Cloudflare Turnstile check, then gives the visitor a private copy of **Fernhollow Foods**, signed in as Sam (agent). There is no sign-up.
- **Golden copy:** one read-only master per seed version (`FERNHOLLOW_SEED_VERSION` in `src/worker/demo/fernhollow.ts`), built by the same code as `npm run db:seed`. Nobody can sign in to it, and its timers never run.
- **Warm pool:** a few ready-made copies (`TEND247_DEMO_POOL_SIZE`, default 3), refilled every minute by the cron. Each copy is cloned from the golden one with fresh ids and every timestamp shifted to the moment of copying, so the sample work looks as if it was filed today. A copy left unclaimed for an hour is replaced.
- **Sandboxes** last `TEND247_DEMO_HOURS` (24) and are then deleted with their files. **Reset** swaps in a fresh copy and deletes the old one at once.
- **Role switcher:**
  - Jo, requester: lands in the portal;
  - Sam, agent;
  - Dana, team lead and approver;
  - Avery, admin.

  A four-step guided tour follows the same people.
- **Simulator:** while someone is looking (active in the last 20 minutes), every 2 to 4 minutes it does one of three things:
  - files a new request;
  - moves service desk work along;
  - adds a requester's reply.

  Each sandbox opens with an urgent incident filed 27 minutes earlier, so its 30-minute first-response SLA breaches within minutes.
- **Stats strip** on the landing page: sandboxes opened today and this week, requests filed today, and people exploring now. These come from anonymous daily counters (`demo_analytics`), with no visitor data.

## Guardrails

| Risk | Guardrail |
| --- | --- |
| Spam | Sandboxes never send email. Notifications, approval requests and replies go to the sandbox's **Sent mail** viewer, and sign-in links are never sent |
| Calling the outside world | Webhooks are recorded as `skipped`, never sent. API tokens are read-only. Inbound email addresses cannot be claimed |
| Bots | Turnstile on start, with a hostname check against `TEND247_PUBLIC_URL`. Starts and resets limited per visitor (`DEMO_START_LIMITER`, 5 a minute) |
| Flooding | Writes limited per visitor (`DEMO_WRITE_LIMITER`, 40 per 10 seconds). Sandboxes hold at most `TEND247_DEMO_MAX_RECORDS` records (300) and 40 people, enforced in the record and user services. Attachments up to 1 MB. Record import is off. At most `TEND247_DEMO_MAX_SANDBOXES` (1,000) live sandboxes |
| Seeing others | Every sandbox is its own workspace behind row-level security. Sessions never outlive their sandbox |

## Deploying tend247.com

The Worker is named `tend247-site`, so this deploy replaces the earlier static-site Worker in place and keeps its `tend247.com` and `www.tend247.com` custom domains.

One-time setup:

1. **Database.** Create a Postgres database for the demo (PlanetScale works well) with the two roles from [install.md](install.md#1-database-roles). Then run:

   ```bash
   TEND247_DB_OWNER_URL='postgres://tend247_owner:…@…/tend247_demo?sslmode=verify-full' \
   TEND247_DB_APP_ROLE=tend247_app TEND247_DB_APP_PASSWORD='…' npm run db:migrate
   ```

   Don't seed it: the demo builds its golden copy on first use.

2. **Hyperdrive.** Create it with caching disabled and put its id in `wrangler.tend247.jsonc`:

   ```bash
   npx wrangler hyperdrive create tend247-demo-db --connection-string='postgres://tend247_app:…@…/tend247_demo?sslmode=verify-full' --caching-disabled
   ```

3. **Storage.** Run `npx wrangler r2 bucket create tend247-demo-attachments`.

4. **Turnstile.** In the Cloudflare dashboard, add a Turnstile widget for `tend247.com` and `www.tend247.com` (managed mode). Put its **site key** in `TEND247_TURNSTILE_SITE_KEY` in `wrangler.tend247.jsonc`.

5. **Secrets:**

   ```bash
   npx wrangler secret put TEND247_SESSION_SECRET --config wrangler.tend247.jsonc
   npx wrangler secret put TEND247_TURNSTILE_SECRET --config wrangler.tend247.jsonc
   ```

6. **Deploy:** `npm run site:deploy`.

Then open tend247.com and click **Try the live demo**. The first click builds the golden copy, which takes a few seconds. The cron fills the pool within a few minutes.

To change the sample data, edit `src/worker/demo/fernhollow.ts`, bump `FERNHOLLOW_SEED_VERSION` and deploy. The next start builds the new golden copy; old pool copies are replaced; live sandboxes keep their data until they expire.

## Local development

```bash
npm run site:dev     # the tend247.com configuration against your local database
```

With `TEND247_DEV_LOGIN=true` and an empty `TEND247_TURNSTILE_SITE_KEY` in `.dev.vars`, **Try the live demo** skips the Turnstile check. Fire the cron by hand with `curl http://localhost:5173/cdn-cgi/local/scheduled` (pool refill, expiry, simulator).
