// Records: the work items every team handles. Keys like FIN-142 come from a per-project
// counter incremented in the same transaction; every change is written to record_events
// and the outbox in that transaction too.
import { z } from "zod";
import type { Tx } from "../db/client.ts";
import { emit, type Actor } from "../audit.ts";
import { AppError, forbidden, invalid, notFound, type FieldIssue } from "../lib/errors.ts";
import { isUuid, base64url, fromBase64url, UUID_RE } from "../lib/crypto.ts";
import { listFields, getRecordType, getProject, assertNotArchived } from "../config/service.ts";
import { validateCustom } from "../config/fields.ts";
import { assertUsersExist } from "../users/service.ts";

export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface RecordRow {
  id: string;
  /** Creation order (bigint as text); used for pagination. */
  seq: string;
  key: string;
  number: number;
  projectId: string;
  recordTypeId: string;
  title: string;
  description: string;
  status: string;
  statusCategory: "todo" | "in_progress" | "done";
  priority: Priority;
  assigneeId: string | null;
  requesterId: string | null;
  custom: Record<string, unknown>;
  version: number;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  deletedBy: string | null;
}

export interface RecordEvent {
  id: string;
  kind: string;
  data: Record<string, unknown>;
  actorId: string | null;
  actorName: string | null;
  createdAt: Date;
}

const COLUMNS = (tx: Tx) => tx`
  id, seq::text as seq, key, number, project_id, record_type_id, title, description, status, status_category,
  priority, assignee_id, requester_id, custom, version, created_by, created_at, updated_at,
  deleted_at, deleted_by`;

const uuid = z
  .string()
  .refine(isUuid, "Must be an id")
  .transform((v) => v.toLowerCase());

const createSchema = z.object({
  recordTypeId: uuid,
  title: z.string().trim().min(1).max(500),
  description: z.string().max(50_000).default(""),
  priority: z.enum(PRIORITIES).default("medium"),
  assigneeId: uuid.nullable().optional(),
  requesterId: uuid.nullable().optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});

const patchSchema = z
  .object({
    version: z.number().int().min(1),
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(50_000).optional(),
    priority: z.enum(PRIORITIES).optional(),
    assigneeId: uuid.nullable().optional(),
    requesterId: uuid.nullable().optional(),
    custom: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw invalid(r.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })));
  return r.data;
}

const isStaff = (actor: Actor) => actor.role === "admin" || actor.role === "agent";

// ---------------------------------------------------------------- create

export async function createRecord(tx: Tx, actor: Actor, input: unknown): Promise<RecordRow> {
  const data = parse(createSchema, input);
  const recordType = await getRecordType(tx, data.recordTypeId);
  assertNotArchived(recordType, "This record type");
  const project = await getProject(tx, recordType.projectId);
  assertNotArchived(project, "This project");

  // Requesters file requests for themselves and cannot route them.
  let requesterId = data.requesterId ?? actor.userId;
  let assigneeId = data.assigneeId ?? null;
  if (!isStaff(actor)) {
    requesterId = actor.userId;
    assigneeId = null;
  }

  const fields = await listFields(tx, recordType.id, { includeArchived: true });
  const custom = validateCustom(fields, data.custom, "create");
  if (custom.issues.length) throw invalid(custom.issues);
  const refs = [...custom.userRefs];
  if (assigneeId) refs.push({ field: "assigneeId", id: assigneeId });
  if (requesterId && requesterId !== actor.userId) refs.push({ field: "requesterId", id: requesterId });
  await assertUsersExist(tx, refs);

  const [counter] = await tx<{ num: number }[]>`
    update projects set next_num = next_num + 1 where id = ${project.id} returning next_num - 1 as num`;
  const key = `${project.key}-${counter!.num}`;

  const [record] = await tx<RecordRow[]>`
    insert into records (
      tenant_id, project_id, record_type_id, number, key, title, description, priority,
      assignee_id, requester_id, custom, created_by
    ) values (
      ${actor.tenantId}, ${project.id}, ${recordType.id}, ${counter!.num}, ${key}, ${data.title},
      ${data.description}, ${data.priority}, ${assigneeId}, ${requesterId}, ${tx.json(custom.values as never)},
      ${actor.userId}
    )
    returning ${COLUMNS(tx)}`;
  await tx`
    insert into record_events (tenant_id, record_id, actor_id, kind, data)
    values (${actor.tenantId}, ${record!.id}, ${actor.userId}, 'created',
            ${tx.json({ title: record!.title, priority: record!.priority, custom: record!.custom } as never)})`;
  await emit(tx, actor.tenantId, "record.created", { recordId: record!.id, key, actorId: actor.userId });
  return record!;
}

// ---------------------------------------------------------------- read

async function loadRecord(tx: Tx, idOrKey: string, opts: { includeDeleted?: boolean; lock?: boolean } = {}) {
  const where = UUID_RE.test(idOrKey) ? tx`id = ${idOrKey}` : tx`key = ${idOrKey.toUpperCase()}`;
  const [r] = await tx<RecordRow[]>`
    select ${COLUMNS(tx)} from records
    where ${where} ${opts.includeDeleted ? tx`` : tx`and deleted_at is null`}
    ${opts.lock ? tx`for update` : tx``}`;
  return r ?? null;
}

function canSee(actor: Actor, r: RecordRow): boolean {
  return isStaff(actor) || r.requesterId === actor.userId;
}

export async function getRecord(tx: Tx, actor: Actor, idOrKey: string): Promise<RecordRow> {
  const r = await loadRecord(tx, idOrKey);
  if (!r || !canSee(actor, r)) throw notFound("Record");
  return r;
}

export interface ListFilters {
  projectId?: string;
  recordTypeId?: string;
  statusCategory?: "todo" | "in_progress" | "done";
  assigneeId?: string | "me" | "none";
  q?: string;
  /** Exact-match filter on custom values, e.g. {"vendor":"Acme"}; served by the GIN index. */
  custom?: Record<string, unknown>;
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

// Cursors carry the creation sequence number, not a timestamp: timestamps can tie, and
// JavaScript dates drop the microseconds Postgres stores, which would skip records.
function encodeCursor(r: RecordRow): string {
  return base64url(new TextEncoder().encode(`s${r.seq}`));
}

function decodeCursor(cursor: string): string {
  try {
    const raw = new TextDecoder().decode(fromBase64url(cursor));
    if (!/^s\d{1,19}$/.test(raw)) throw new Error();
    return raw.slice(1);
  } catch {
    throw new AppError("bad_request", "Invalid cursor");
  }
}

export async function listRecords(tx: Tx, actor: Actor, filters: ListFilters): Promise<Page<RecordRow>> {
  let f = filters;
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 100);
  const issues: FieldIssue[] = [];
  if (f.projectId && !isUuid(f.projectId)) issues.push({ field: "projectId", message: "Must be an id" });
  if (f.assigneeId && isUuid(f.assigneeId)) f = { ...f, assigneeId: f.assigneeId.toLowerCase() };
  if (f.recordTypeId && !isUuid(f.recordTypeId)) issues.push({ field: "recordTypeId", message: "Must be an id" });
  if (f.assigneeId && !["me", "none"].includes(f.assigneeId) && !isUuid(f.assigneeId)) {
    issues.push({ field: "assigneeId", message: "Must be an id, 'me' or 'none'" });
  }
  if (issues.length) throw invalid(issues);

  const conds = [tx`deleted_at is null`];
  if (!isStaff(actor)) conds.push(tx`requester_id = ${actor.userId}`);
  if (f.projectId) conds.push(tx`project_id = ${f.projectId}`);
  if (f.recordTypeId) conds.push(tx`record_type_id = ${f.recordTypeId}`);
  if (f.statusCategory) conds.push(tx`status_category = ${f.statusCategory}`);
  if (f.assigneeId === "me") conds.push(tx`assignee_id = ${actor.userId}`);
  else if (f.assigneeId === "none") conds.push(tx`assignee_id is null`);
  else if (f.assigneeId) conds.push(tx`assignee_id = ${f.assigneeId}`);
  if (f.q && f.q.trim()) {
    const q = f.q.trim().slice(0, 200);
    conds.push(tx`(search @@ websearch_to_tsquery('simple', ${q}) or key = ${q.toUpperCase()} or title ilike ${"%" + q.replace(/[\\%_]/g, "\\$&") + "%"})`);
  }
  if (f.custom && Object.keys(f.custom).length) conds.push(tx`custom @> ${tx.json(f.custom as never)}`);
  if (f.cursor) conds.push(tx`seq < ${decodeCursor(f.cursor)}::bigint`);
  const where = conds.reduce((acc, c) => tx`${acc} and ${c}`);
  // ORDER BY must name records.seq: a bare "seq" resolves to the text alias in the select list.
  const rows = await tx<RecordRow[]>`
    select ${COLUMNS(tx)} from records where ${where}
    order by records.seq desc limit ${limit + 1}`;
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]!) : null };
}

// ---------------------------------------------------------------- update

const TRACKED = ["title", "description", "priority", "assigneeId", "requesterId"] as const;

export async function updateRecord(tx: Tx, actor: Actor, idOrKey: string, input: unknown): Promise<RecordRow> {
  if (!isStaff(actor)) throw forbidden("Requesters cannot edit records");
  const patch = parse(patchSchema, input);
  const current = await loadRecord(tx, idOrKey, { lock: true });
  if (!current) throw notFound("Record");
  if (current.version !== patch.version) {
    throw new AppError("version_conflict", "Someone else changed this record. Reload to see their changes.", {
      currentVersion: current.version,
    });
  }

  const fields = await listFields(tx, current.recordTypeId, { includeArchived: true });
  const custom = validateCustom(fields, patch.custom, "update", current.custom);
  if (custom.issues.length) throw invalid(custom.issues);
  const refs = [...custom.userRefs];
  if (patch.assigneeId) refs.push({ field: "assigneeId", id: patch.assigneeId });
  if (patch.requesterId) refs.push({ field: "requesterId", id: patch.requesterId });
  await assertUsersExist(tx, refs);

  const next = {
    title: patch.title ?? current.title,
    description: patch.description ?? current.description,
    priority: patch.priority ?? current.priority,
    assigneeId: patch.assigneeId === undefined ? current.assigneeId : patch.assigneeId,
    requesterId: patch.requesterId === undefined ? current.requesterId : patch.requesterId,
  };
  const changes: { field: string; from: unknown; to: unknown }[] = [];
  for (const k of TRACKED) {
    if (next[k] !== current[k]) changes.push({ field: k, from: current[k], to: next[k] });
  }
  const keys = new Set([...Object.keys(current.custom), ...Object.keys(custom.values)]);
  for (const k of keys) {
    const from = current.custom[k] ?? null;
    const to = custom.values[k] ?? null;
    if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ field: `custom.${k}`, from, to });
  }
  if (changes.length === 0) return current;

  const [updated] = await tx<RecordRow[]>`
    update records set
      title = ${next.title}, description = ${next.description}, priority = ${next.priority},
      assignee_id = ${next.assigneeId}, requester_id = ${next.requesterId},
      custom = ${tx.json(custom.values as never)},
      version = version + 1, updated_at = clock_timestamp()
    where id = ${current.id}
    returning ${COLUMNS(tx)}`;
  await tx`
    insert into record_events (tenant_id, record_id, actor_id, kind, data)
    values (${actor.tenantId}, ${current.id}, ${actor.userId}, 'updated', ${tx.json({ changes } as never)})`;
  await emit(tx, actor.tenantId, "record.updated", {
    recordId: current.id,
    key: current.key,
    actorId: actor.userId,
    fields: changes.map((c) => c.field),
  });
  return updated!;
}

// ---------------------------------------------------------------- trash

export async function deleteRecord(tx: Tx, actor: Actor, idOrKey: string): Promise<RecordRow> {
  if (!isStaff(actor)) throw forbidden("Requesters cannot delete records");
  const current = await loadRecord(tx, idOrKey, { lock: true });
  if (!current) throw notFound("Record");
  const [deleted] = await tx<RecordRow[]>`
    update records set deleted_at = now(), deleted_by = ${actor.userId}, version = version + 1, updated_at = clock_timestamp()
    where id = ${current.id} returning ${COLUMNS(tx)}`;
  await tx`
    insert into record_events (tenant_id, record_id, actor_id, kind, data)
    values (${actor.tenantId}, ${current.id}, ${actor.userId}, 'deleted', '{}'::jsonb)`;
  await emit(tx, actor.tenantId, "record.deleted", { recordId: current.id, key: current.key, actorId: actor.userId });
  return deleted!;
}

export async function restoreRecord(tx: Tx, actor: Actor, idOrKey: string): Promise<RecordRow> {
  if (actor.role !== "admin") throw forbidden("Only admins can restore from the trash");
  const current = await loadRecord(tx, idOrKey, { includeDeleted: true, lock: true });
  if (!current || !current.deletedAt) throw notFound("Deleted record");
  const [restored] = await tx<RecordRow[]>`
    update records set deleted_at = null, deleted_by = null, version = version + 1, updated_at = clock_timestamp()
    where id = ${current.id} returning ${COLUMNS(tx)}`;
  await tx`
    insert into record_events (tenant_id, record_id, actor_id, kind, data)
    values (${actor.tenantId}, ${current.id}, ${actor.userId}, 'restored', '{}'::jsonb)`;
  await emit(tx, actor.tenantId, "record.restored", { recordId: current.id, key: current.key, actorId: actor.userId });
  return restored!;
}

export async function listTrash(tx: Tx, actor: Actor): Promise<RecordRow[]> {
  if (actor.role !== "admin") throw forbidden("Only admins can see the trash");
  return tx<RecordRow[]>`
    select ${COLUMNS(tx)} from records where deleted_at is not null order by deleted_at desc limit 200`;
}

// ---------------------------------------------------------------- history

export async function listEvents(tx: Tx, actor: Actor, idOrKey: string): Promise<RecordEvent[]> {
  const r = await loadRecord(tx, idOrKey, { includeDeleted: actor.role === "admin" });
  if (!r || !canSee(actor, r)) throw notFound("Record");
  return tx<RecordEvent[]>`
    select e.id::text as id, e.kind, e.data, e.actor_id, u.display_name as actor_name, e.created_at
    from record_events e left join users u on u.id = e.actor_id
    where e.record_id = ${r.id} order by e.id`;
}
