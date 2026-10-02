# Backups, restore and moving a workspace

Tend 24/7 protects your data in layers. From the most often used to the least:

| Layer | What it covers | Where it lives |
| --- | --- | --- |
| Trash | Deleted records, comments and files, for the retention period (30 days by default) | Your database; admins restore from **Trash** |
| Record history | Every field change, with one-click revert | Your database (`record_events`, append-only) |
| Point-in-time recovery | The whole database, to any moment in the provider's window | Your Postgres host |
| Nightly export | Every workspace as gzipped NDJSON, AES-GCM encrypted | The `BACKUPS` R2 bucket, ideally in another Cloudflare account |
| Attachment replica | Every uploaded file | The `ATTACHMENTS_REPLICA` R2 bucket |

## Point-in-time recovery

Turn it on at your host:

- **Neon**: set history retention.
- **Supabase**: add the PITR add-on.
- **PlanetScale**: backups and point-in-time recovery.

This is the first way back from a bad change: restore the database to a moment before it.

After **any** database restore, run:

```bash
TEND247_DB_OWNER_URL=... npm run rebuild
```

This re-arms SLA timers from their stored due times, re-queues events that were never handled, and recreates the nightly jobs. It is safe to run more than once.

## The nightly export

Bind a `BACKUPS` bucket (see `wrangler.jsonc`) and set `TEND247_BACKUP_ENCRYPTION_KEY` (`npm run setup` generates one).

**When it runs:** every night at 02:00 in the workspace's time zone. It writes `exports/<workspace>/<date>/`, one part per table chunk plus a `manifest.json`.

**How long exports are kept:** 14 nightly exports and 12 month-start exports by default (`TEND247_BACKUP_DAILY_KEEP`, `TEND247_BACKUP_MONTHLY_KEEP`).

**Checking it:** Admin > Settings shows the last run, and admins get a notification if a run fails.

**What is never exported:** sessions, API tokens, sign-in and approval links, and the webhook signing key.

Decode one part to read it:

```bash
npm run export:decrypt -- <file.ndjson.gz.enc> [out.ndjson]
```

## Restore check (do this monthly)

`npm run restore:check` proves a backup can be restored. It loads the backup as a new, temporary workspace in the database at `TEND247_DB_OWNER_URL`, compares every table's row count with the backup, then deletes the copy.

While the copy exists it is inert: its webhooks and automation are off and no SLA timers run, so it never notifies or calls anyone.

From a nightly export:

```bash
# Copy one night's folder out of the bucket, e.g. with rclone or the Cloudflare dashboard.
mkdir restore && cd restore
#   ... manifest.json and the .ndjson.gz(.enc) parts ...
cd ..
TEND247_BACKUP_ENCRYPTION_KEY=... npm run restore:check -- --export ./restore
```

From a workspace bundle:

```bash
npm run restore:check -- --bundle acme-2026-10-01.tend247.ndjson.gz
```

Add `--keep` to keep the restored copy as a workspace you can sign in to. Run the check against a staging database where you can. It is safe against production, but the copy briefly takes up space there.

The repository runs this drill every month in GitHub Actions (`.github/workflows/restore-drill.yml`). It builds the sample workspace, exports it and restores it.

## Restoring one workspace from an export

To bring back a workspace (for example, one deleted by mistake), restore it with `--keep`. You then have it as a new workspace with fresh ids next to the current one:

```bash
TEND247_BACKUP_ENCRYPTION_KEY=... npm run restore:check -- --export ./restore --keep
```

Then:

1. Turn its webhooks and automation back on under Admin.
2. Set its inbound email addresses again (addresses are unique per deployment).
3. Copy attachment files if you need them (see below).

## Moving a workspace to another deployment

1. **Export.** An admin downloads **Admin > Settings > Export this workspace**, or run:

   ```bash
   npm run workspace:export -- --workspace acme --out acme.tend247.ndjson.gz
   ```

   The admin download handles up to 250,000 rows; use the command for larger workspaces.

2. **Import** on the other deployment:

   ```bash
   TEND247_DB_OWNER_URL=... npm run workspace:import -- --in acme.tend247.ndjson.gz --slug acme --name "Acme Corp"
   ```

   Every id is replaced and every reference follows it, including references inside workflows, SLA policies and saved views. So a bundle can even be imported next to its original. Record keys (`FIN-142`) stay the same.

3. **After the import:**
   - **Webhook endpoints** arrive switched off. Turn them on once their URLs are right.
   - **Inbound email addresses** are not carried over. Set them again on each project's admin page.
   - **Attachment files** stay in the source bucket under `t/<old workspace id>/a/<file id>`. The copy expects them at `t/<new workspace id>/a/<new file id>`, so copy them with a script if you need them. The `importWorkspace` function in `src/worker/workspace/bundle.ts` can copy them between two bucket clients.
   - **People** sign in again with SSO or an email link, since sessions and tokens are not carried over.

A bundle holds people's names and email addresses, your records, and your webhook URLs (which can embed a receiver's secret). Treat bundle files as confidential.
