// The configuration engine: projects, record types and custom fields are rows, so a
// workspace admin changes them at runtime and the schema never moves.
import { z } from "zod";
import type { Tx } from "../db/client.ts";
import { audit, type Actor } from "../audit.ts";
import { AppError, invalid, notFound, type FieldIssue } from "../lib/errors.ts";
import {
  coerceValue,
  fieldPatchSchema,
  newFieldSchema,
  validateOptions,
  type FieldDef,
  type FieldOptions,
  type FieldType,
} from "./fields.ts";

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string;
  archivedAt: Date | null;
  createdAt: Date;
}

export interface RecordType {
  id: string;
  projectId: string;
  key: string;
  name: string;
  description: string;
  archivedAt: Date | null;
}

export interface CompiledRecordType extends RecordType {
  fields: FieldDef[];
}

export interface CompiledProject extends Project {
  recordTypes: CompiledRecordType[];
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw invalid(r.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })));
  return r.data;
}

const projectSchema = z.object({
  key: z.string().trim().regex(/^[A-Z][A-Z0-9]{1,9}$/, "2–10 capital letters or digits, starting with a letter"),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(""),
});
const projectPatchSchema = z
  .object({ name: z.string().trim().min(1).max(200), description: z.string().max(5000), archived: z.boolean() })
  .partial()
  .strict();

const recordTypeSchema = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{0,62}$/, "Lowercase letters, digits and underscores"),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(""),
});
const recordTypePatchSchema = z
  .object({ name: z.string().trim().min(1).max(200), description: z.string().max(5000), archived: z.boolean() })
  .partial()
  .strict();

// ---------------------------------------------------------------- projects

export async function listProjects(tx: Tx, opts: { includeArchived?: boolean } = {}): Promise<Project[]> {
  return tx<Project[]>`
    select id, key, name, description, archived_at, created_at from projects
    where ${opts.includeArchived ? tx`true` : tx`archived_at is null`}
    order by name`;
}

export async function getProject(tx: Tx, id: string): Promise<Project> {
  const [p] = await tx<Project[]>`select id, key, name, description, archived_at, created_at from projects where id = ${id}`;
  if (!p) throw notFound("Project");
  return p;
}

export async function createProject(tx: Tx, actor: Actor, input: unknown): Promise<Project> {
  const data = parse(projectSchema, input);
  const [p] = await tx<Project[]>`
    insert into projects (tenant_id, key, name, description)
    values (${actor.tenantId}, ${data.key}, ${data.name}, ${data.description})
    returning id, key, name, description, archived_at, created_at`;
  await audit(tx, actor, { entity: "project", entityId: p!.id, action: "create", after: p });
  return p!;
}

/** The project key is permanent: it is baked into every record key (FIN-142). */
export async function updateProject(tx: Tx, actor: Actor, id: string, input: unknown): Promise<Project> {
  const patch = parse(projectPatchSchema, input);
  const before = await getProject(tx, id);
  const archivedAt = patch.archived === undefined ? before.archivedAt : patch.archived ? new Date() : null;
  const [after] = await tx<Project[]>`
    update projects set
      name = ${patch.name ?? before.name},
      description = ${patch.description ?? before.description},
      archived_at = ${archivedAt}
    where id = ${id}
    returning id, key, name, description, archived_at, created_at`;
  await audit(tx, actor, { entity: "project", entityId: id, action: "update", before, after });
  return after!;
}

// ---------------------------------------------------------------- record types

export async function getRecordType(tx: Tx, id: string): Promise<RecordType> {
  const [rt] = await tx<RecordType[]>`
    select id, project_id, key, name, description, archived_at from record_types where id = ${id}`;
  if (!rt) throw notFound("Record type");
  return rt;
}

export async function createRecordType(tx: Tx, actor: Actor, projectId: string, input: unknown): Promise<RecordType> {
  const data = parse(recordTypeSchema, input);
  await getProject(tx, projectId);
  const [rt] = await tx<RecordType[]>`
    insert into record_types (tenant_id, project_id, key, name, description)
    values (${actor.tenantId}, ${projectId}, ${data.key}, ${data.name}, ${data.description})
    returning id, project_id, key, name, description, archived_at`;
  await audit(tx, actor, { entity: "record_type", entityId: rt!.id, action: "create", after: rt });
  return rt!;
}

export async function updateRecordType(tx: Tx, actor: Actor, id: string, input: unknown): Promise<RecordType> {
  const patch = parse(recordTypePatchSchema, input);
  const before = await getRecordType(tx, id);
  const archivedAt = patch.archived === undefined ? before.archivedAt : patch.archived ? new Date() : null;
  const [after] = await tx<RecordType[]>`
    update record_types set
      name = ${patch.name ?? before.name},
      description = ${patch.description ?? before.description},
      archived_at = ${archivedAt}
    where id = ${id}
    returning id, project_id, key, name, description, archived_at`;
  await audit(tx, actor, { entity: "record_type", entityId: id, action: "update", before, after });
  return after!;
}

// ---------------------------------------------------------------- fields

const FIELD_COLUMNS = (tx: Tx) =>
  tx`id, key, label, type, required, options, default_value, help_text, position, archived_at`;

export async function listFields(tx: Tx, recordTypeId: string, opts: { includeArchived?: boolean } = {}): Promise<FieldDef[]> {
  return tx<FieldDef[]>`
    select ${FIELD_COLUMNS(tx)} from field_defs
    where record_type_id = ${recordTypeId} and ${opts.includeArchived ? tx`true` : tx`archived_at is null`}
    order by position, created_at`;
}

async function getField(tx: Tx, id: string): Promise<FieldDef & { recordTypeId: string }> {
  const [f] = await tx<(FieldDef & { recordTypeId: string })[]>`
    select ${FIELD_COLUMNS(tx)}, record_type_id from field_defs where id = ${id}`;
  if (!f) throw notFound("Field");
  return f;
}

function checkDefault(type: FieldType, options: FieldOptions, value: unknown): FieldIssue[] {
  if (value === undefined || value === null) return [];
  if (type === "user") return [{ field: "defaultValue", message: "Person fields cannot have a default" }];
  const r = coerceValue({ type, options }, value);
  return r.ok ? [] : [{ field: "defaultValue", message: r.message }];
}

/** Add a field. No DDL: the value lives in records.custom under the field key. */
export async function createField(tx: Tx, actor: Actor, recordTypeId: string, input: unknown): Promise<FieldDef> {
  const data = parse(newFieldSchema, input);
  await getRecordType(tx, recordTypeId);
  const { options, issues } = validateOptions(data.type, data.options);
  issues.push(...checkDefault(data.type, options, data.defaultValue));
  if (issues.length) throw invalid(issues);
  const [{ next } = { next: 0 }] = await tx<{ next: number }[]>`
    select coalesce(max(position) + 1, 0)::int as next from field_defs where record_type_id = ${recordTypeId}`;
  const [f] = await tx<FieldDef[]>`
    insert into field_defs (tenant_id, record_type_id, key, label, type, required, options, default_value, help_text, position)
    values (
      ${actor.tenantId}, ${recordTypeId}, ${data.key}, ${data.label}, ${data.type}, ${data.required},
      ${tx.json(options as never)}, ${data.defaultValue === undefined || data.defaultValue === null ? null : tx.json(data.defaultValue as never)},
      ${data.helpText}, ${data.position ?? next}
    )
    returning ${FIELD_COLUMNS(tx)}`;
  await audit(tx, actor, { entity: "field", entityId: f!.id, action: "create", after: f });
  return f!;
}

/** Change a field. Key and type are permanent; removing a choice that records use is refused. */
export async function updateField(tx: Tx, actor: Actor, id: string, input: unknown): Promise<FieldDef> {
  const patch = parse(fieldPatchSchema, input);
  const before = await getField(tx, id);
  let options = before.options;
  const issues: FieldIssue[] = [];
  if (patch.options !== undefined) {
    const v = validateOptions(before.type, patch.options);
    issues.push(...v.issues);
    options = v.options;
    if (!v.issues.length && (before.type === "select" || before.type === "multi_select")) {
      const kept = new Set((options.choices ?? []).map((c) => c.value));
      const removed = (before.options.choices ?? []).map((c) => c.value).filter((value) => !kept.has(value));
      if (removed.length) {
        // `?|` matches a jsonb string equal to, or an array containing, any removed value.
        const [{ n } = { n: 0 }] = await tx<{ n: number }[]>`
          select count(*)::int as n from records
          where record_type_id = ${before.recordTypeId}
            and (custom -> ${before.key}) ?| array(select jsonb_array_elements_text(${tx.json(removed)}))`;
        if (n > 0) {
          issues.push({ field: "options.choices", message: `Records still use: ${removed.join(", ")}` });
        }
      }
    }
  }
  const defaultValue = patch.defaultValue === undefined ? before.defaultValue : patch.defaultValue;
  issues.push(...checkDefault(before.type, options, defaultValue));
  if (issues.length) throw invalid(issues);
  const archivedAt = patch.archived === undefined ? before.archivedAt : patch.archived ? new Date() : null;
  const [after] = await tx<FieldDef[]>`
    update field_defs set
      label = ${patch.label ?? before.label},
      required = ${patch.required ?? before.required},
      options = ${tx.json(options as never)},
      default_value = ${defaultValue === null || defaultValue === undefined ? null : tx.json(defaultValue as never)},
      help_text = ${patch.helpText ?? before.helpText},
      position = ${patch.position ?? before.position},
      archived_at = ${archivedAt}
    where id = ${id}
    returning ${FIELD_COLUMNS(tx)}`;
  const { recordTypeId: _rt, ...beforeDef } = before;
  await audit(tx, actor, { entity: "field", entityId: id, action: "update", before: beforeDef, after });
  return after!;
}

// ---------------------------------------------------------------- compiled config

/** Everything a client needs to render forms: projects → record types → active fields. */
export async function getCompiledConfig(tx: Tx): Promise<CompiledProject[]> {
  const projects = await listProjects(tx);
  const types = await tx<RecordType[]>`
    select id, project_id, key, name, description, archived_at from record_types
    where archived_at is null order by name`;
  const fields = await tx<(FieldDef & { recordTypeId: string })[]>`
    select ${FIELD_COLUMNS(tx)}, record_type_id from field_defs
    where archived_at is null order by position, created_at`;
  return projects.map((p) => ({
    ...p,
    recordTypes: types
      .filter((t) => t.projectId === p.id)
      .map((t) => ({
        ...t,
        fields: fields.filter((f) => f.recordTypeId === t.id).map(({ recordTypeId: _r, ...f }) => f),
      })),
  }));
}

export async function listAudit(tx: Tx, opts: { limit?: number; before?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return tx`
    select a.id::text as id, a.entity, a.entity_id, a.action, a.before, a.after, a.created_at,
           a.actor_id, u.display_name as actor_name
    from audit_log a left join users u on u.id = a.actor_id
    where ${opts.before ? tx`a.id < ${opts.before}` : tx`true`}
    order by a.id desc limit ${limit}`;
}

export function assertNotArchived(entity: { archivedAt: Date | null }, what: string): void {
  if (entity.archivedAt) throw new AppError("bad_request", `${what} is archived`);
}
