// Whole-workspace bundles: read every workspace table into memory, write it as gzipped NDJSON,
// and import it as a NEW workspace with fresh ids. One engine serves four jobs:
//   - the public demo, which clones a golden copy into each visitor's sandbox (time-shifted
//     so the sample work looks as if it was filed today);
//   - the admin "Download workspace" button and `npm run workspace:export`;
//   - `npm run workspace:import`, which moves a workspace to another deployment;
//   - `npm run restore:check`, which proves a nightly export can be restored.
// Credentials (sessions, API tokens, sign-in and approval links, the webhook signing key) are
// never part of a bundle, and routing tables (inbound addresses, timers) are rebuilt rather
// than copied. A bundle still holds people's names and email addresses and webhook URLs
// (which can embed a receiver's secret): treat it as confidential.
import type { Sql, Tx } from "../db/client.ts";
import { EXPORT_TABLES, CHUNK_ROWS, decodeExportFile, readChunk } from "../backup/export.ts";
import { rearmAll } from "../sla/service.ts";
import type { BlobStore } from "../attachments/blobs.ts";
import { AppError } from "../lib/errors.ts";
import { UUID_RE } from "../lib/crypto.ts";

export const WORKSPACE_FORMAT = "tend247-workspace";
export const WORKSPACE_VERSION = 1;
export const WORKSPACE_TABLES = EXPORT_TABLES;

export type Row = Record<string, unknown>;

export interface WorkspaceHeader {
  format: typeof WORKSPACE_FORMAT;
  version: number;
  /** Latest migration applied where the bundle was made. */
  schema: string | null;
  workspace: { id: string; slug: string; name: string; settings: Record<string, unknown> };
  exportedAt: string;
}

export interface WorkspaceData {
  header: WorkspaceHeader;
  tables: Record<string, Row[]>;
}

export function countRows(data: WorkspaceData): Record<string, number> {
  return Object.fromEntries(WORKSPACE_TABLES.map((t) => [t.name, data.tables[t.name]?.length ?? 0]));
}

// ---------------------------------------------------------------- read

/** Read a workspace in one consistent snapshot. */
export async function readWorkspace(sql: Sql, tenantId: string, opts: { maxRows?: number } = {}): Promise<WorkspaceData> {
  return (await sql.begin("isolation level repeatable read read only", async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    const [t] = await tx<{ id: string; slug: string; name: string; settings: Record<string, unknown> }[]>`
      select id, slug, name, settings from tenants where id = ${tenantId}`;
    if (!t) throw new AppError("not_found", "Workspace not found");
    const [migration] = await tx<{ name: string }[]>`select name from schema_migrations order by name desc limit 1`;
    const tables: Record<string, Row[]> = {};
    let total = 0;
    for (const table of WORKSPACE_TABLES) {
      const rows: Row[] = [];
      for (let offset = 0; ; offset += CHUNK_ROWS) {
        const chunk = (await readChunk(tx as unknown as Tx, table, offset, tenantId)) as Row[];
        rows.push(...chunk);
        total += chunk.length;
        if (opts.maxRows && total > opts.maxRows) {
          throw new AppError("bad_request", "This workspace is too large to download here; use npm run workspace:export");
        }
        if (chunk.length < CHUNK_ROWS) break;
      }
      tables[table.name] = rows;
    }
    return {
      header: {
        format: WORKSPACE_FORMAT,
        version: WORKSPACE_VERSION,
        schema: migration?.name ?? null,
        workspace: { id: t.id, slug: t.slug, name: t.name, settings: t.settings ?? {} },
        exportedAt: new Date().toISOString(),
      },
      tables,
    };
  })) as WorkspaceData;
}

// ---------------------------------------------------------------- encode / decode

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipIfNeeded(bytes: Uint8Array): Promise<string> {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
}

/** Header line, one line per row ({"t": table, "r": row}), and an end line with counts. */
export async function encodeWorkspace(data: WorkspaceData): Promise<Uint8Array> {
  const lines = [JSON.stringify(data.header)];
  for (const t of WORKSPACE_TABLES) for (const r of data.tables[t.name] ?? []) lines.push(JSON.stringify({ t: t.name, r }));
  lines.push(JSON.stringify({ end: true, counts: countRows(data) }));
  return gzip(lines.join("\n") + "\n");
}

export async function decodeWorkspace(bytes: Uint8Array): Promise<WorkspaceData> {
  const text = await gunzipIfNeeded(bytes);
  const lines = text.split("\n").filter((l) => l.trim());
  const header = JSON.parse(lines[0] ?? "null") as WorkspaceHeader | null;
  if (!header || header.format !== WORKSPACE_FORMAT) throw new Error("Not a Tend 24/7 workspace bundle");
  if (header.version > WORKSPACE_VERSION) throw new Error(`Bundle version ${header.version} is newer than this release understands`);
  const known = new Set(WORKSPACE_TABLES.map((t) => t.name));
  const tables: Record<string, Row[]> = {};
  let end: { counts: Record<string, number> } | null = null;
  for (const line of lines.slice(1)) {
    const item = JSON.parse(line) as { t?: string; r?: Row; end?: boolean; counts?: Record<string, number> };
    if (item.end) {
      end = { counts: item.counts ?? {} };
      continue;
    }
    if (!item.t || !known.has(item.t) || !item.r) throw new Error(`Unexpected line in bundle: ${line.slice(0, 80)}`);
    (tables[item.t] ??= []).push(item.r);
  }
  if (!end) throw new Error("The bundle is truncated (no end line)");
  for (const [name, n] of Object.entries(end.counts)) {
    if ((tables[name]?.length ?? 0) !== n) throw new Error(`The bundle is damaged: ${name} has ${tables[name]?.length ?? 0} rows, expected ${n}`);
  }
  return { header, tables };
}

/** Build workspace data from a nightly export (manifest plus its NDJSON parts). */
export async function workspaceFromExport(
  manifest: { format: string; workspace: { id: string; slug: string; name: string }; schema: string | null; finishedAt?: string; tables: Record<string, { rows: number; parts: string[] }> },
  readPart: (key: string) => Promise<Uint8Array>,
  keyB64: string | null,
): Promise<WorkspaceData> {
  if (manifest.format !== "tend247-export") throw new Error("Not a Tend 24/7 nightly export manifest");
  const tables: Record<string, Row[]> = {};
  for (const [name, entry] of Object.entries(manifest.tables)) {
    const rows: Row[] = [];
    for (const key of entry.parts) {
      const text = await decodeExportFile(await readPart(key), keyB64);
      for (const line of text.split("\n")) if (line.trim()) rows.push(JSON.parse(line) as Row);
    }
    if (rows.length !== entry.rows) throw new Error(`Export is incomplete: ${name} has ${rows.length} rows, manifest says ${entry.rows}`);
    tables[name] = rows;
  }
  return {
    header: {
      format: WORKSPACE_FORMAT,
      version: WORKSPACE_VERSION,
      schema: manifest.schema,
      workspace: { ...manifest.workspace, settings: {} },
      exportedAt: manifest.finishedAt ?? new Date().toISOString(),
    },
    tables,
  };
}

// ---------------------------------------------------------------- import

export interface ImportOptions {
  slug: string;
  name?: string;
  settings?: Record<string, unknown>;
  demo?: { state: "golden" | "pool" | "claimed"; seed: number; expiresAt: Date | null };
  /** Shift every timestamp by this many milliseconds (dates without a time are left alone). */
  timeShiftMs?: number;
  /** Copy attachment files from the source store into the target store. */
  blobs?: { from?: BlobStore; to?: BlobStore };
  /**
   * Make the copy quiet: webhook endpoints and automation rules off, no SLA timers. Restore
   * drills use it so a copy never notifies anyone or calls anything.
   */
  inert?: boolean;
  /** Turn webhook endpoints off in the copy (their URLs may point at the source's receivers). */
  disableWebhooks?: boolean;
}

export interface ImportResult {
  tenantId: string;
  counts: Record<string, number>;
  missingFiles: number;
}

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$/;
const INSERT_CHUNK = 500;

async function insertableColumns(tx: Tx): Promise<Map<string, Set<string>>> {
  const rows = await tx<{ tableName: string; columnName: string }[]>`
    select table_name, column_name from information_schema.columns
    where table_schema = 'public' and is_generated = 'NEVER' and coalesce(identity_generation, '') <> 'ALWAYS'
      and table_name in (select jsonb_array_elements_text(${tx.json(WORKSPACE_TABLES.map((t) => t.name))}))`;
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!out.has(r.tableName)) out.set(r.tableName, new Set());
    out.get(r.tableName)!.add(r.columnName);
  }
  return out;
}

async function toBytes(body: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  return body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
}

/**
 * Create a new workspace from bundle data. Every row id is replaced, and every reference to
 * one (columns and values inside JSON such as workflow approvers or SLA calendars) follows it,
 * so the copy shares nothing with its source and can live in the same database.
 */
export async function importWorkspace(sql: Sql, data: WorkspaceData, opts: ImportOptions): Promise<ImportResult> {
  const tenantId = crypto.randomUUID();
  const ids = new Map<string, string>([[data.header.workspace.id.toLowerCase(), tenantId]]);
  for (const t of WORKSPACE_TABLES) {
    for (const r of data.tables[t.name] ?? []) {
      if (typeof r.id === "string" && UUID_RE.test(r.id)) ids.set(r.id.toLowerCase(), crypto.randomUUID());
    }
  }
  const shift = opts.timeShiftMs ?? 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v.length === 36) {
        const mapped = ids.get(v.toLowerCase());
        if (mapped) return mapped;
      }
      if (shift && TIMESTAMP_RE.test(v)) return new Date(Date.parse(v.replace(/(\.\d{3})\d+/, "$1")) + shift).toISOString();
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Row).map(([k, x]) => [k.length === 36 ? (ids.get(k.toLowerCase()) ?? k) : k, walk(x)]));
    }
    return v;
  };

  let missingFiles = 0;
  const counts: Record<string, number> = {};
  await sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    await tx`
      insert into tenants (id, slug, name, settings, demo, demo_state, demo_seed, expires_at, claimed_at, last_active_at)
      values (${tenantId}, ${opts.slug}, ${opts.name ?? data.header.workspace.name},
              ${tx.json((opts.settings ?? data.header.workspace.settings ?? {}) as never)},
              ${Boolean(opts.demo)}, ${opts.demo?.state ?? null}, ${opts.demo?.seed ?? null}, ${opts.demo?.expiresAt ?? null},
              ${opts.demo?.state === "claimed" ? new Date() : null}, ${opts.demo?.state === "claimed" ? new Date() : null})`;
    const columns = await insertableColumns(tx as unknown as Tx);
    const pendingApprovals: { id: string; p: string }[] = [];

    for (const table of WORKSPACE_TABLES) {
      const source = data.tables[table.name] ?? [];
      counts[table.name] = source.length;
      if (!source.length) continue;
      const allowed = columns.get(table.name);
      if (!allowed) throw new Error(`Table ${table.name} is missing from this database; run migrations first`);
      const rows: Row[] = [];
      for (const raw of source) {
        // Every row must belong to the bundle's own workspace: a crafted bundle cannot write
        // into another workspace even over a connection that bypasses row-level security.
        if (String(raw.tenant_id ?? "").toLowerCase() !== data.header.workspace.id.toLowerCase()) {
          throw new Error(`The bundle is not consistent: a ${table.name} row belongs to another workspace`);
        }
        const row = walk(raw) as Row;
        if (table.name === "records" && row.pending_approval_id) {
          pendingApprovals.push({ id: row.id as string, p: row.pending_approval_id as string });
          row.pending_approval_id = null;
        }
        if (table.name === "attachments") {
          const oldKey = raw.storage_key as string;
          row.storage_key = `t/${tenantId}/a/${row.id as string}`;
          row.replicated_at = null;
          const blob = opts.blobs?.from ? await opts.blobs.from.get(oldKey) : null;
          if (blob && opts.blobs?.to) await opts.blobs.to.put(row.storage_key as string, await toBytes(blob.body), blob.contentType);
          else missingFiles++;
        }
        rows.push(row);
      }
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => allowed.has(c));
      const list = cols.map((c) => `"${c}"`).join(", ");
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        const chunk = rows.slice(i, i + INSERT_CHUNK);
        await tx.unsafe(
          `insert into ${table.name} (${list}) select ${list} from jsonb_populate_recordset(null::${table.name}, $1::jsonb)`,
          // postgres.js serializes the parameter as JSON once the server types it as jsonb.
          [chunk as never],
        );
      }
    }
    if (pendingApprovals.length) {
      await tx`
        update records set pending_approval_id = x.p
        from jsonb_to_recordset(${tx.json(pendingApprovals)}) as x(id uuid, p uuid)
        where records.id = x.id`;
    }
    if (opts.inert || opts.disableWebhooks) await tx`update webhook_endpoints set enabled = false`;
    if (opts.inert) await tx`update automation_rules set enabled = false`;
    else await rearmAll(tx as unknown as Tx, tenantId);
  });
  return { tenantId, counts, missingFiles };
}

/** Delete a workspace and its files (an expired demo sandbox, a restore drill copy). */
export async function deleteWorkspace(sql: Sql, tenantId: string, stores: (BlobStore | undefined)[] = []): Promise<void> {
  for (const store of stores) {
    if (!store?.list) continue;
    for (const key of await store.list(`t/${tenantId}/`)) await store.delete(key);
  }
  await sql`delete from tenants where id = ${tenantId}`;
}
