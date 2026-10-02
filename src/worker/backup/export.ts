// Nightly export: every workspace table as gzipped NDJSON in the BACKUPS bucket, optionally
// AES-GCM encrypted, written in chunks (one timer step per chunk) so no single run hits the
// Worker's limits. A manifest closes each export; old exports are pruned on a daily and
// monthly schedule. Secrets (sessions, sign-in and approval tokens, webhook keys) are
// never exported.
import type { Tx } from "../db/client.ts";
import { withTenant } from "../db/client.ts";
import { fromBase64url } from "../lib/crypto.ts";
import { notify } from "../notifications/service.ts";
import type { WorkerDeps } from "../jobs/runner.ts";

export const EXPORT_FORMAT = "tend247-export";
export const EXPORT_VERSION = 1;
export const CHUNK_ROWS = 2000;
const STEP_CHUNKS = 5;
const MAGIC = new TextEncoder().encode("T247E1");

/** Tables in dependency order, with a stable sort for paging. */
export const EXPORT_TABLES: { name: string; order: string; omit?: string[] }[] = [
  { name: "users", order: "id", omit: ["oidc_subject"] },
  { name: "teams", order: "id" },
  { name: "team_members", order: "team_id, user_id" },
  { name: "projects", order: "id" },
  { name: "record_types", order: "id" },
  { name: "field_defs", order: "id" },
  { name: "config_versions", order: "id" },
  { name: "calendars", order: "id" },
  { name: "sprints", order: "id" },
  { name: "records", order: "seq", omit: ["search"] },
  { name: "record_events", order: "id" },
  { name: "comments", order: "id", omit: ["search"] },
  { name: "attachments", order: "id" },
  { name: "record_watchers", order: "record_id, user_id" },
  { name: "record_links", order: "id" },
  { name: "saved_views", order: "id" },
  { name: "sla_clocks", order: "id" },
  { name: "approvals", order: "id" },
  { name: "sprint_snapshots", order: "sprint_id, day_index" },
  { name: "workspace_templates", order: "id" },
  { name: "automation_rules", order: "id" },
  { name: "webhook_endpoints", order: "id" },
  { name: "email_messages", order: "id" },
  { name: "audit_log", order: "id" },
];

interface Progress {
  table: number;
  offset: number;
  part: number;
  tables: Record<string, { rows: number; parts: string[] }>;
}

interface ExportRun {
  id: string;
  status: string;
  location: string;
  counts: Progress;
  bytes: number;
  encrypted: boolean;
  startedAt: Date;
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function encrypt(keyB64: string, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", fromBase64url(keyB64.replace(/=+$/, "")), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data as Uint8Array<ArrayBuffer>));
  const out = new Uint8Array(MAGIC.length + iv.length + ct.length);
  out.set(MAGIC, 0);
  out.set(iv, MAGIC.length);
  out.set(ct, MAGIC.length + iv.length);
  return out;
}

/** Reverse of the export encoding (used by the restore script and tests). */
export async function decodeExportFile(data: Uint8Array, keyB64: string | null): Promise<string> {
  let bytes = data;
  const isEncrypted = MAGIC.every((b, i) => bytes[i] === b);
  if (isEncrypted) {
    if (!keyB64) throw new Error("This export is encrypted; set TEND247_BACKUP_ENCRYPTION_KEY");
    const key = await crypto.subtle.importKey("raw", fromBase64url(keyB64.replace(/=+$/, "")), "AES-GCM", false, ["decrypt"]);
    const iv = bytes.slice(MAGIC.length, MAGIC.length + 12);
    bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, bytes.slice(MAGIC.length + 12)));
  }
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

async function encode(w: WorkerDeps, text: string): Promise<Uint8Array> {
  const zipped = await gzip(text);
  return w.config.backup.encryptionKey ? encrypt(w.config.backup.encryptionKey, zipped) : zipped;
}

export async function readChunk(tx: Tx, table: (typeof EXPORT_TABLES)[number], offset: number, tenantId: string): Promise<unknown[]> {
  // Table and column names come from the fixed list above, never from input. The tenant filter
  // repeats what row-level security enforces, so a connection that bypasses it (an owner
  // with BYPASSRLS running a script) still reads only this workspace.
  const omit = (table.omit ?? []).map((c) => ` - '${c}'`).join("");
  const rows = await tx.unsafe(
    `select to_jsonb(t)${omit} as j from ${table.name} t where t.tenant_id = $1 order by ${table.order} limit ${CHUNK_ROWS} offset ${Number(offset)}`,
    [tenantId],
  );
  return (rows as unknown as { j: unknown }[]).map((r) => r.j);
}

/**
 * Do one step of tonight's export. Returns true while there is more to write (the caller
 * re-arms the timer immediately) and false once the manifest is written or nothing to do.
 */
export async function runExportStep(w: WorkerDeps, tenantId: string): Promise<boolean> {
  if (!w.backups) return false;
  const now = w.now();
  const [tenant] = await w.sql<{ slug: string; name: string; demo: boolean }[]>`select slug, name, demo from tenants where id = ${tenantId}`;
  if (!tenant || tenant.demo) return false;
  const date = now.toISOString().slice(0, 10);
  const location = `exports/${tenant.slug}/${date}/`;

  let run = await withTenant(w.sql, tenantId, async (tx) => {
    const [existing] = await tx<ExportRun[]>`
      select id, status, location, counts, bytes::int as bytes, encrypted, started_at from export_runs
      where location = ${location} order by started_at desc limit 1`;
    if (existing) return existing;
    const counts: Progress = { table: 0, offset: 0, part: 0, tables: {} };
    const [row] = await tx<ExportRun[]>`
      insert into export_runs (tenant_id, status, location, counts, encrypted)
      values (${tenantId}, 'running', ${location}, ${tx.json(counts as never)}, ${Boolean(w.config.backup.encryptionKey)})
      returning id, status, location, counts, bytes::int as bytes, encrypted, started_at`;
    return row!;
  });
  if (run.status !== "running") return false;

  const ext = w.config.backup.encryptionKey ? ".ndjson.gz.enc" : ".ndjson.gz";
  try {
    for (let step = 0; step < STEP_CHUNKS; step++) {
      const p = run.counts;
      if (p.table >= EXPORT_TABLES.length) {
        await finish(w, tenantId, tenant, run, now);
        return false;
      }
      const table = EXPORT_TABLES[p.table]!;
      const rows = await withTenant(w.sql, tenantId, (tx) => readChunk(tx, table, p.offset, tenantId));
      const entry = p.tables[table.name] ?? { rows: 0, parts: [] };
      let bytes = run.bytes;
      if (rows.length) {
        const key = `${location}${table.name}.${String(p.part).padStart(4, "0")}${ext}`;
        const body = await encode(w, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
        await w.backups.put(key, body, "application/octet-stream");
        entry.rows += rows.length;
        entry.parts.push(key);
        bytes += body.byteLength;
      }
      const done = rows.length < CHUNK_ROWS;
      const next: Progress = {
        table: done ? p.table + 1 : p.table,
        offset: done ? 0 : p.offset + rows.length,
        part: done ? 0 : p.part + 1,
        tables: { ...p.tables, [table.name]: entry },
      };
      run = { ...run, counts: next, bytes };
      await withTenant(w.sql, tenantId, (tx) =>
        tx`update export_runs set counts = ${tx.json(next as never)}, bytes = ${bytes} where id = ${run.id}`,
      );
    }
    return true;
  } catch (err) {
    const message = (err as Error).message.slice(0, 500);
    await withTenant(w.sql, tenantId, async (tx) => {
      await tx`update export_runs set status = 'failed', error = ${message}, finished_at = now() where id = ${run.id}`;
      // Tell the admins: a silent backup failure is the worst kind.
      const admins = await tx<{ id: string }[]>`select id from users where role = 'admin' and active`;
      await notify(
        tx,
        tenantId,
        null,
        admins.map((a) => ({ userId: a.id, kind: "backup" as const, recordId: null, title: `Nightly export failed: ${message}` })),
      );
    });
    return false;
  }
}

async function finish(w: WorkerDeps, tenantId: string, tenant: { slug: string; name: string }, run: ExportRun, now: Date) {
  const [migration] = await w.sql<{ name: string }[]>`select name from schema_migrations order by name desc limit 1`.catch(() => []);
  const manifest = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    workspace: { id: tenantId, slug: tenant.slug, name: tenant.name },
    schema: migration?.name ?? null,
    startedAt: run.startedAt,
    finishedAt: now,
    encrypted: run.encrypted,
    tables: run.counts.tables,
  };
  await w.backups!.put(`${run.location}manifest.json`, new TextEncoder().encode(JSON.stringify(manifest, null, 2)), "application/json");
  await withTenant(w.sql, tenantId, (tx) =>
    tx`update export_runs set status = 'succeeded', finished_at = now() where id = ${run.id}`,
  );
  await pruneExports(w, tenant.slug);
}

/** Keep the newest N daily exports and the first export of each of the last M months. */
export async function pruneExports(w: WorkerDeps, slug: string): Promise<string[]> {
  if (!w.backups?.list) return [];
  const keys = await w.backups.list(`exports/${slug}/`);
  const dates = [...new Set(keys.map((k) => k.split("/")[2]).filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort().reverse();
  const keep = new Set(dates.slice(0, w.config.backup.dailyKeep));
  const months = new Map<string, string>();
  for (const d of [...dates].reverse()) if (!months.has(d.slice(0, 7))) months.set(d.slice(0, 7), d);
  [...months.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, w.config.backup.monthlyKeep)
    .forEach(([, d]) => keep.add(d));
  const drop = dates.filter((d) => !keep.has(d));
  for (const key of keys) {
    if (drop.includes(key.split("/")[2]!)) await w.backups.delete(key);
  }
  return drop;
}

export async function backupHealth(tx: Tx, tenantId: string, configured: boolean, encrypted: boolean) {
  const runs = await tx<{ id: string; status: string; location: string; bytes: number; error: string | null; startedAt: Date; finishedAt: Date | null; counts: Progress }[]>`
    select id, status, location, bytes::int as bytes, error, started_at, finished_at, counts from export_runs
    order by started_at desc limit 10`;
  const [next] = await tx<{ runAt: Date }[]>`
    select run_at from scheduled_jobs where tenant_id = ${tenantId} and kind = 'export' and ref_id = ${tenantId}`;
  return {
    configured,
    encrypted,
    nextRunAt: next?.runAt ?? null,
    runs: runs.map(({ counts, ...r }) => ({
      ...r,
      rows: Object.values(counts.tables ?? {}).reduce((n, t) => n + t.rows, 0),
    })),
  };
}
