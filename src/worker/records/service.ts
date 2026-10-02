// Records: the work items every team handles. Keys like FIN-142 come from a per-project
// counter incremented in the same transaction; every change is written to record_events
// and the outbox in that transaction too, and SLA clocks are brought up to date with it.
import { z } from "zod";
import type { Tx } from "../db/client.ts";
import { emit, isStaff, type Actor } from "../audit.ts";
import { AppError, forbidden, invalid, notFound, type FieldIssue } from "../lib/errors.ts";
import { isUuid, base64url, fromBase64url } from "../lib/crypto.ts";
import { parse, uuid } from "../lib/validate.ts";
import { listFields, getRecordType, getProject, assertNotArchived } from "../config/service.ts";
import { getPublished, getWorkflow } from "../config/versions.ts";
import { validateCustom, type FieldDef } from "../config/fields.ts";
import { createFormFields, type LayoutDefinition } from "../workflow/layout.ts";
import { statusOf } from "../workflow/definition.ts";
import { assertUsersExist } from "../users/service.ts";
import { nextRoundRobin } from "../teams/service.ts";
import { syncSla } from "../sla/service.ts";
import { PRIORITIES, type Priority } from "./constants.ts";
import { loadRecord, RECORD_COLUMNS, visibleTo, type RecordRow } from "./access.ts";

export { PRIORITIES, type Priority, type RecordRow };

export interface RecordEvent {
  id: string;
  kind: string;
  data: Record<string, unknown>;
  actorId: string | null;
  actorName: string | null;
  createdAt: Date;
}

/** Titles end up in email subjects: control characters (line breaks included) become spaces. */
const title = z
  .string()
  .transform((v) => v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim())
  .pipe(z.string().min(1).max(500));

const createSchema = z.object({
  recordTypeId: uuid,
  title,
  description: z.string().max(50_000).default(""),
  priority: z.enum(PRIORITIES).optional(),
  assigneeId: uuid.nullable().optional(),
  requesterId: uuid.nullable().optional(),
  teamId: uuid.nullable().optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});

const patchFields = {
  title,
  description: z.string().max(50_000),
  priority: z.enum(PRIORITIES),
  assigneeId: uuid.nullable(),
  requesterId: uuid.nullable(),
  teamId: uuid.nullable(),
  custom: z.record(z.string(), z.unknown()),
};
export const recordPatchSchema = z.object(patchFields).partial().strict();
export type RecordPatch = z.infer<typeof recordPatchSchema>;
const patchSchema = recordPatchSchema.extend({ version: z.number().int().min(1) }).strict();

async function assertTeam(tx: Tx, teamId: string, field = "teamId"): Promise<void> {
  const [t] = await tx`select 1 from teams where id = ${teamId} and archived_at is null`;
  if (!t) throw invalid([{ field, message: "Unknown team" }]);
}

async function event(tx: Tx, actor: Actor, recordId: string, kind: string, data: Record<string, unknown>): Promise<void> {
  await tx`
    insert into record_events (tenant_id, record_id, actor_id, kind, data)
    values (${actor.tenantId}, ${recordId}, ${actor.userId}, ${kind}, ${tx.json(data as never)})`;
}
export { event as recordEvent };

// ---------------------------------------------------------------- create

/** Workspaces with a record quota (demo sandboxes) refuse records past it, however they arrive. */
async function assertRecordQuota(tx: Tx, tenantId: string): Promise<void> {
  const [t] = await tx<{ maxRecords: number | null }[]>`select max_records from tenants where id = ${tenantId}`;
  if (!t?.maxRecords) return;
  const [n] = await tx<{ n: number }[]>`select count(*)::int as n from records`;
  if ((n?.n ?? 0) >= t.maxRecords) {
    throw new AppError("forbidden", `This workspace holds up to ${t.maxRecords} records${t.maxRecords < 10_000 ? ". In the demo, use Reset to start over" : ""}.`);
  }
}

export async function createRecord(tx: Tx, actor: Actor, input: unknown): Promise<RecordRow> {
  const data = parse(createSchema, input);
  const recordType = await getRecordType(tx, data.recordTypeId);
  assertNotArchived(recordType, "This record type");
  const project = await getProject(tx, recordType.projectId);
  assertNotArchived(project, "This project");
  await assertRecordQuota(tx, actor.tenantId);
  const staff = isStaff(actor);
  if (!staff && !project.requesterAccess) throw forbidden("This project does not take requests");

  const layout = (await getPublished(tx, "layout", recordType.id))!.definition as LayoutDefinition;
  const onForm = createFormFields(layout);
  const required = new Set(layout.requiredOnCreate);
  const fields = await listFields(tx, recordType.id, { includeArchived: true });
  const issues: FieldIssue[] = [];

  let { description, priority, assigneeId = null, requesterId = actor.userId, teamId } = data;
  let customInput = data.custom;
  if (!staff) {
    // Requesters file for themselves, cannot route, and set only what the create form shows.
    requesterId = actor.userId;
    assigneeId = null;
    teamId = undefined;
    if (!onForm.has("priority")) priority = undefined;
    if (!onForm.has("description")) description = "";
    for (const key of Object.keys(customInput ?? {})) {
      if (!onForm.has(key)) issues.push({ field: `custom.${key}`, message: "Unknown field" });
    }
  }
  if (required.has("description") && !description.trim()) issues.push({ field: "description", message: "Required" });
  if (staff && required.has("assigneeId") && !assigneeId) issues.push({ field: "assigneeId", message: "Required" });
  if (staff && required.has("teamId") && !teamId) issues.push({ field: "teamId", message: "Required" });

  const defs: FieldDef[] = fields.map((f) => (required.has(f.key) ? { ...f, required: true } : f));
  const custom = validateCustom(defs, customInput, "create");
  issues.push(...custom.issues);
  if (issues.length) throw invalid(issues);

  if (teamId) await assertTeam(tx, teamId);
  const team = teamId === undefined ? project.defaultTeamId : teamId;
  const refs = [...custom.userRefs];
  if (assigneeId) refs.push({ field: "assigneeId", id: assigneeId });
  if (requesterId && requesterId !== actor.userId) refs.push({ field: "requesterId", id: requesterId });
  await assertUsersExist(tx, refs);
  if (!assigneeId && team && project.assignment === "round_robin") assigneeId = await nextRoundRobin(tx, team);

  const workflow = await getWorkflow(tx, recordType.id);
  const initial = statusOf(workflow.definition, workflow.definition.initial)!;
  const [counter] = await tx<{ num: number }[]>`
    update projects set next_num = next_num + 1 where id = ${project.id} returning next_num - 1 as num`;
  const key = `${project.key}-${counter!.num}`;

  const [row] = await tx<{ id: string }[]>`
    insert into records (
      tenant_id, project_id, record_type_id, number, key, title, description, priority, status, status_category,
      workflow_version, assignee_id, requester_id, team_id, custom, created_by, via
    ) values (
      ${actor.tenantId}, ${project.id}, ${recordType.id}, ${counter!.num}, ${key}, ${data.title},
      ${description}, ${priority ?? "medium"}, ${initial.key}, ${initial.category}, ${workflow.version},
      ${assigneeId}, ${requesterId}, ${team}, ${tx.json(custom.values as never)}, ${actor.userId}, ${actor.via ?? "app"}
    )
    returning id`;
  const record = (await loadRecord(tx, { ...actor, role: "admin" }, row!.id))!;
  await event(tx, actor, record.id, "created", {
    title: record.title,
    priority: record.priority,
    status: record.status,
    assigneeId: record.assigneeId,
    teamId: record.teamId,
    custom: record.custom,
    via: record.via,
  });
  await emit(
    tx,
    actor.tenantId,
    "record.created",
    { recordId: record.id, key, actorId: actor.userId, assigneeId: record.assigneeId, teamId: record.teamId },
    actor,
  );
  await syncSla(tx, record);
  return record;
}

// ---------------------------------------------------------------- read

export async function getRecord(tx: Tx, actor: Actor, idOrKey: string): Promise<RecordRow> {
  const r = await loadRecord(tx, actor, idOrKey);
  if (!r) throw notFound("Record");
  return r;
}

export const SORTS = ["created_desc", "created_asc", "updated_desc", "priority_desc", "key_asc", "due_asc"] as const;
export type Sort = (typeof SORTS)[number];

export interface ListFilters {
  projectId?: string;
  recordTypeId?: string;
  status?: string[];
  statusCategory?: ("todo" | "in_progress" | "done")[];
  priority?: Priority[];
  assigneeId?: string | "me" | "none";
  teamId?: string | "mine" | "none";
  requesterId?: string | "me";
  /** Records an SLA clock has breached, or warned about and not yet breached. */
  sla?: "breached" | "at_risk";
  createdAfter?: string;
  createdBefore?: string;
  q?: string;
  /** Exact-match filter on custom values, e.g. {"vendor":"Acme"}; served by the GIN index. */
  custom?: Record<string, unknown>;
  sort?: Sort;
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

// Cursors carry the creation sequence number for the default order (timestamps can tie, and
// JavaScript dates drop microseconds), and an offset for the other orders.
function encodeCursor(value: string): string {
  return base64url(new TextEncoder().encode(value));
}

function decodeCursor(cursor: string): { seq?: string; offset?: number } {
  try {
    const raw = new TextDecoder().decode(fromBase64url(cursor));
    if (/^s\d{1,19}$/.test(raw)) return { seq: raw.slice(1) };
    if (/^o\d{1,5}$/.test(raw)) return { offset: Number(raw.slice(1)) };
    throw new Error();
  } catch {
    throw new AppError("bad_request", "Invalid cursor");
  }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;

/** The WHERE clause for a set of filters (visibility included). */
function whereFor(tx: Tx, actor: Actor, f: ListFilters) {
  const issues: FieldIssue[] = [];
  const id = (name: string, v: string | undefined, specials: string[] = []) => {
    if (v && !specials.includes(v) && !isUuid(v)) issues.push({ field: name, message: `Must be an id${specials.length ? ` or ${specials.join(", ")}` : ""}` });
    return v && isUuid(v) ? v.toLowerCase() : v;
  };
  const projectId = id("projectId", f.projectId);
  const recordTypeId = id("recordTypeId", f.recordTypeId);
  const assigneeId = id("assigneeId", f.assigneeId, ["me", "none"]);
  const teamId = id("teamId", f.teamId, ["mine", "none"]);
  const requesterId = id("requesterId", f.requesterId, ["me"]);
  for (const k of ["createdAfter", "createdBefore"] as const) {
    if (f[k] && (!DATE_ONLY.test(f[k]!) || Number.isNaN(Date.parse(f[k]!)))) issues.push({ field: k, message: "Must be a date" });
  }
  if (f.priority?.some((p) => !PRIORITIES.includes(p))) issues.push({ field: "priority", message: "Unknown priority" });
  if (f.statusCategory?.some((c) => !["todo", "in_progress", "done"].includes(c))) {
    issues.push({ field: "statusCategory", message: "Must be todo, in_progress or done" });
  }
  if (f.sla && !["breached", "at_risk"].includes(f.sla)) issues.push({ field: "sla", message: "Must be breached or at_risk" });
  if (issues.length) throw invalid(issues);

  const conds = [tx`records.deleted_at is null`, visibleTo(tx, actor)];
  if (projectId) conds.push(tx`records.project_id = ${projectId}`);
  if (recordTypeId) conds.push(tx`records.record_type_id = ${recordTypeId}`);
  if (f.status?.length) conds.push(tx`records.status in (select jsonb_array_elements_text(${tx.json(f.status)}))`);
  if (f.statusCategory?.length) {
    conds.push(tx`records.status_category in (select jsonb_array_elements_text(${tx.json(f.statusCategory)}))`);
  }
  if (f.priority?.length) conds.push(tx`records.priority in (select jsonb_array_elements_text(${tx.json(f.priority)}))`);
  if (assigneeId === "me") conds.push(tx`records.assignee_id = ${actor.userId}`);
  else if (assigneeId === "none") conds.push(tx`records.assignee_id is null`);
  else if (assigneeId) conds.push(tx`records.assignee_id = ${assigneeId}`);
  if (teamId === "mine") conds.push(tx`records.team_id in (select team_id from team_members where user_id = ${actor.userId})`);
  else if (teamId === "none") conds.push(tx`records.team_id is null`);
  else if (teamId) conds.push(tx`records.team_id = ${teamId}`);
  if (requesterId === "me") conds.push(tx`records.requester_id = ${actor.userId}`);
  else if (requesterId) conds.push(tx`records.requester_id = ${requesterId}`);
  if (f.sla === "breached") {
    conds.push(tx`exists (select 1 from sla_clocks sc where sc.record_id = records.id and sc.breached_at is not null and sc.status in ('running', 'paused'))`);
  } else if (f.sla === "at_risk") {
    conds.push(tx`exists (select 1 from sla_clocks sc where sc.record_id = records.id and sc.warned_at is not null and sc.breached_at is null and sc.status = 'running')`);
  }
  if (f.createdAfter) conds.push(tx`records.created_at >= ${new Date(f.createdAfter)}`);
  if (f.createdBefore) conds.push(tx`records.created_at < ${new Date(f.createdBefore)}`);
  if (f.q && f.q.trim()) {
    const q = f.q.trim().slice(0, 200);
    const like = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
    const internalOk = isStaff(actor) ? tx`true` : tx`not c.internal`;
    conds.push(tx`(
      records.search @@ websearch_to_tsquery('simple', ${q}) or records.key = ${q.toUpperCase()} or records.title ilike ${like}
      or exists (select 1 from comments c where c.record_id = records.id and c.deleted_at is null and ${internalOk}
                 and c.search @@ websearch_to_tsquery('simple', ${q})))`);
  }
  if (f.custom && Object.keys(f.custom).length) conds.push(tx`records.custom @> ${tx.json(f.custom as never)}`);
  return conds.reduce((acc, c) => tx`${acc} and ${c}`);
}

function orderFor(tx: Tx, sort: Sort) {
  // ORDER BY must name records.seq: a bare "seq" resolves to the text alias in the select list.
  switch (sort) {
    case "created_asc":
      return tx`records.seq asc`;
    case "updated_desc":
      return tx`records.updated_at desc, records.seq desc`;
    case "priority_desc":
      return tx`array_position(array['urgent','high','medium','low'], records.priority), records.seq desc`;
    case "key_asc":
      return tx`records.project_id, records.number asc`;
    case "due_asc":
      return tx`(select min(sc.due_at) from sla_clocks sc where sc.record_id = records.id and sc.status = 'running') asc nulls last, records.seq desc`;
    default:
      return tx`records.seq desc`;
  }
}

export async function listRecords(tx: Tx, actor: Actor, filters: ListFilters): Promise<Page<RecordRow>> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
  const sort = filters.sort ?? "created_desc";
  if (!SORTS.includes(sort)) throw invalid([{ field: "sort", message: `Must be one of ${SORTS.join(", ")}` }]);
  const where = whereFor(tx, actor, filters);
  const cursor = filters.cursor ? decodeCursor(filters.cursor) : {};
  const bySeq = sort === "created_desc";
  if (bySeq && cursor.offset !== undefined) throw new AppError("bad_request", "Invalid cursor");
  const page = bySeq && cursor.seq ? tx`and records.seq < ${cursor.seq}::bigint` : tx``;
  const offset = bySeq ? 0 : (cursor.offset ?? 0);
  const rows = await tx<RecordRow[]>`
    select ${RECORD_COLUMNS(tx)} from records where ${where} ${page}
    order by ${orderFor(tx, sort)} limit ${limit + 1} offset ${offset}`;
  const items = rows.slice(0, limit);
  let nextCursor: string | null = null;
  if (rows.length > limit) nextCursor = encodeCursor(bySeq ? `s${items[items.length - 1]!.seq}` : `o${offset + limit}`);
  return { items, nextCursor };
}

/**
 * Records grouped into board columns: the workflow's statuses when a record type is given,
 * otherwise the three status categories. Each column carries its total and up to 50 cards.
 */
export async function getBoard(tx: Tx, actor: Actor, filters: ListFilters & { recordTypeId?: string }) {
  const where = whereFor(tx, actor, filters);
  let columns: { key: string; name: string; category: string }[];
  let groupBy;
  if (filters.recordTypeId) {
    await getRecordType(tx, filters.recordTypeId.toLowerCase());
    const wf = await getWorkflow(tx, filters.recordTypeId.toLowerCase());
    columns = wf.definition.statuses.map((s) => ({ key: s.key, name: s.name, category: s.category }));
    groupBy = tx`records.status`;
  } else {
    columns = [
      { key: "todo", name: "To do", category: "todo" },
      { key: "in_progress", name: "In progress", category: "in_progress" },
      { key: "done", name: "Done", category: "done" },
    ];
    groupBy = tx`records.status_category`;
  }
  const rows = await tx<(RecordRow & { col: string; total: number })[]>`
    select * from (
      select ${RECORD_COLUMNS(tx)}, ${groupBy} as col,
             row_number() over (partition by ${groupBy} order by ${orderFor(tx, "priority_desc")}) as rn,
             count(*) over (partition by ${groupBy})::int as total
      from records where ${where}
    ) ranked where rn <= 50`;
  return {
    columns: columns.map((c) => {
      const cards = rows.filter((r) => r.col === c.key);
      return { ...c, total: cards[0]?.total ?? 0, records: cards.map(({ col: _c, total: _t, ...r }) => r) };
    }),
  };
}

// ---------------------------------------------------------------- update

const TRACKED = ["title", "description", "priority", "assigneeId", "requesterId", "teamId"] as const;

/**
 * Apply a patch to a loaded, locked record: validation, history, outbox and SLA. No
 * permission or version checks (callers do those).
 */
export async function applyPatch(tx: Tx, actor: Actor, current: RecordRow, patch: RecordPatch, kind = "updated"): Promise<RecordRow> {
  const fields = await listFields(tx, current.recordTypeId, { includeArchived: true });
  const custom = validateCustom(fields, patch.custom, "update", current.custom);
  if (custom.issues.length) throw invalid(custom.issues);
  const refs = [...custom.userRefs];
  if (patch.assigneeId) refs.push({ field: "assigneeId", id: patch.assigneeId });
  if (patch.requesterId) refs.push({ field: "requesterId", id: patch.requesterId });
  await assertUsersExist(tx, refs);
  if (patch.teamId && patch.teamId !== current.teamId) await assertTeam(tx, patch.teamId);

  const next = {
    title: patch.title ?? current.title,
    description: patch.description ?? current.description,
    priority: patch.priority ?? current.priority,
    assigneeId: patch.assigneeId === undefined ? current.assigneeId : patch.assigneeId,
    requesterId: patch.requesterId === undefined ? current.requesterId : patch.requesterId,
    teamId: patch.teamId === undefined ? current.teamId : patch.teamId,
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

  await tx`
    update records set
      title = ${next.title}, description = ${next.description}, priority = ${next.priority},
      assignee_id = ${next.assigneeId}, requester_id = ${next.requesterId}, team_id = ${next.teamId},
      custom = ${tx.json(custom.values as never)},
      version = version + 1, updated_at = clock_timestamp()
    where id = ${current.id}`;
  const updated = (await loadRecord(tx, { ...actor, role: "admin" }, current.id))!;
  await event(tx, actor, current.id, kind, { changes });
  await emit(
    tx,
    actor.tenantId,
    "record.updated",
    {
      recordId: current.id,
      key: current.key,
      actorId: actor.userId,
      fields: changes.map((c) => c.field),
      ...(next.assigneeId !== current.assigneeId ? { assignedTo: next.assigneeId } : {}),
    },
    actor,
  );
  if (next.priority !== current.priority) await syncSla(tx, updated);
  return updated;
}

export async function updateRecord(tx: Tx, actor: Actor, idOrKey: string, input: unknown): Promise<RecordRow> {
  if (!isStaff(actor)) throw forbidden("Requesters cannot edit records");
  const patch = parse(patchSchema, input);
  const current = await loadRecord(tx, actor, idOrKey, { lock: true });
  if (!current) throw notFound("Record");
  if (current.version !== patch.version) {
    throw new AppError("version_conflict", "Someone else changed this record. Reload to see their changes.", {
      currentVersion: current.version,
    });
  }
  const { version: _v, ...changes } = patch;
  return applyPatch(tx, actor, current, changes);
}

/** Undo one field change from the history, if the field still holds the value it was set to. */
export async function revertChange(tx: Tx, actor: Actor, idOrKey: string, eventId: string, input: unknown) {
  if (!isStaff(actor)) throw forbidden("Requesters cannot edit records");
  const { version, field } = parse(z.object({ version: z.number().int().min(1), field: z.string().min(1).max(100) }).strict(), input);
  const current = await loadRecord(tx, actor, idOrKey, { lock: true });
  if (!current) throw notFound("Record");
  if (current.version !== version) throw new AppError("version_conflict", "Someone else changed this record. Reload first.");
  if (!/^\d{1,19}$/.test(eventId)) throw notFound("Change");
  const [ev] = await tx<{ data: { changes?: { field: string; from: unknown; to: unknown }[] } }[]>`
    select data from record_events where id = ${eventId}::bigint and record_id = ${current.id} and kind in ('updated', 'reverted')`;
  const change = ev?.data.changes?.find((c) => c.field === field);
  if (!change) throw notFound("Change");
  const now = field.startsWith("custom.") ? (current.custom[field.slice(7)] ?? null) : current[field as (typeof TRACKED)[number]];
  if (JSON.stringify(now ?? null) !== JSON.stringify(change.to ?? null)) {
    throw new AppError("conflict", "This field has changed again since; edit it directly instead");
  }
  const patch: RecordPatch = field.startsWith("custom.")
    ? { custom: { [field.slice(7)]: change.from ?? null } }
    : ({ [field]: change.from } as RecordPatch);
  return applyPatch(tx, actor, current, parse(recordPatchSchema, patch), "reverted");
}

// ---------------------------------------------------------------- trash

export async function deleteRecord(tx: Tx, actor: Actor, idOrKey: string): Promise<RecordRow> {
  if (!isStaff(actor)) throw forbidden("Requesters cannot delete records");
  const current = await loadRecord(tx, actor, idOrKey, { lock: true });
  if (!current) throw notFound("Record");
  await tx`
    update records set deleted_at = now(), deleted_by = ${actor.userId}, version = version + 1, updated_at = clock_timestamp()
    where id = ${current.id}`;
  await event(tx, actor, current.id, "deleted", {});
  await emit(tx, actor.tenantId, "record.deleted", { recordId: current.id, key: current.key, actorId: actor.userId }, actor);
  return (await loadRecord(tx, { ...actor, role: "admin" }, current.id, { includeDeleted: true }))!;
}

export async function restoreRecord(tx: Tx, actor: Actor, idOrKey: string): Promise<RecordRow> {
  if (actor.role !== "admin") throw forbidden("Only admins can restore from the trash");
  const current = await loadRecord(tx, actor, idOrKey, { includeDeleted: true, lock: true });
  if (!current || !current.deletedAt) throw notFound("Deleted record");
  await tx`
    update records set deleted_at = null, deleted_by = null, version = version + 1, updated_at = clock_timestamp()
    where id = ${current.id}`;
  await event(tx, actor, current.id, "restored", {});
  await emit(tx, actor.tenantId, "record.restored", { recordId: current.id, key: current.key, actorId: actor.userId }, actor);
  const restored = (await loadRecord(tx, actor, current.id))!;
  await syncSla(tx, restored);
  return restored;
}

export async function listTrash(tx: Tx, actor: Actor): Promise<RecordRow[]> {
  if (actor.role !== "admin") throw forbidden("Only admins can see the trash");
  return tx<RecordRow[]>`
    select ${RECORD_COLUMNS(tx)} from records where records.deleted_at is not null order by records.deleted_at desc limit 200`;
}

/**
 * Delete a trashed record for good, with its history, comments and attachments. Stored files
 * are queued for deletion after the transaction (and their replicas after the retention period).
 */
export async function purgeRecord(tx: Tx, actor: Actor, recordId: string, opts: { replicaRetentionDays?: number } = {}): Promise<void> {
  if (actor.role !== "admin") throw forbidden("Only admins can empty the trash");
  const [r] = await tx<{ id: string }[]>`select id from records where id = ${recordId} and deleted_at is not null for update`;
  if (!r) throw notFound("Deleted record");
  await queueBlobDeletions(tx, actor.tenantId, tx`record_id = ${r.id}`, opts.replicaRetentionDays ?? 30);
  await tx`delete from records where id = ${r.id}`;
}

/** Queue stored files (and, after the retention period, their replicas) for deletion. */
export async function queueBlobDeletions(tx: Tx, tenantId: string, where: ReturnType<Tx>, retentionDays: number): Promise<void> {
  await tx`
    insert into blob_deletions (tenant_id, storage_key, replica_only, delete_after)
    select ${tenantId}::uuid, storage_key, false, now() from attachments where ${where}
    union all
    select ${tenantId}::uuid, storage_key, true, now() + make_interval(days => ${retentionDays}) from attachments
    where ${where} and replicated_at is not null`;
}

// ---------------------------------------------------------------- history

const REQUESTER_EVENTS = ["created", "transitioned", "status_mapped", "approval_requested", "approval_decided"];

export async function listEvents(tx: Tx, actor: Actor, idOrKey: string): Promise<RecordEvent[]> {
  const r = await loadRecord(tx, actor, idOrKey, { includeDeleted: actor.role === "admin" });
  if (!r) throw notFound("Record");
  const kinds = isStaff(actor) ? tx`true` : tx`e.kind in (select jsonb_array_elements_text(${tx.json(REQUESTER_EVENTS)}))`;
  const events = await tx<RecordEvent[]>`
    select e.id::text as id, e.kind, e.data, e.actor_id, u.display_name as actor_name, e.created_at
    from record_events e left join users u on u.id = e.actor_id
    where e.record_id = ${r.id} and ${kinds} order by e.id`;
  if (isStaff(actor)) return events;
  // Requesters see that an approval was decided, not who decided it.
  return events.map((e) =>
    e.kind === "approval_decided" || (e.kind === "transitioned" && e.data.approvalId) ? { ...e, actorId: null, actorName: null } : e,
  );
}

// ---------------------------------------------------------------- bulk

const bulkSchema = z
  .object({
    ids: z.array(z.string().min(1).max(40)).min(1).max(100),
    patch: recordPatchSchema.omit({ title: true, description: true, requesterId: true }).optional(),
    transition: z.string().min(1).max(41).optional(),
  })
  .strict()
  .refine((b) => b.patch || b.transition, "Send a patch, a transition or both");

/**
 * Apply one change to many records. Each record succeeds or fails on its own (a savepoint per
 * record); failures are reported, not fatal.
 */
export async function bulkUpdate(
  tx: Tx,
  actor: Actor,
  input: unknown,
  transition: (tx: Tx, actor: Actor, record: RecordRow, key: string) => Promise<unknown>,
) {
  if (!isStaff(actor)) throw forbidden("Requesters cannot edit records");
  const data = parse(bulkSchema, input);
  const results: { id: string; key?: string; ok: boolean; error?: string }[] = [];
  for (const id of [...new Set(data.ids)]) {
    try {
      const key = await tx.savepoint(async (sp) => {
        const current = await loadRecord(sp as Tx, actor, id, { lock: true });
        if (!current) throw notFound("Record");
        let record = current;
        if (data.patch) record = await applyPatch(sp as Tx, actor, record, data.patch);
        if (data.transition) await transition(sp as Tx, actor, record, data.transition);
        return current.key;
      });
      results.push({ id, key, ok: true });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      const issue = err.details?.issues?.[0];
      results.push({ id, ok: false, error: issue ? `${issue.field}: ${issue.message}` : err.message });
    }
  }
  return { updated: results.filter((r) => r.ok).length, results };
}
