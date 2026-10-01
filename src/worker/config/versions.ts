// Versioned configuration: workflows and layouts (per record type) and SLA policies (per
// project). Admins edit one draft, publish it as the next version, and can restore any
// earlier version; every publish is audited and earlier versions are kept.
import { z } from "zod";
import type { Tx } from "../db/client.ts";
import { audit, type Actor } from "../audit.ts";
import { AppError, invalid, notFound, type FieldIssue } from "../lib/errors.ts";
import { parse, configKey } from "../lib/validate.ts";
import { checkWorkflow, DEFAULT_WORKFLOW, workflowSchema, type WorkflowDefinition } from "../workflow/definition.ts";
import { checkLayout, defaultLayout, layoutSchema, type LayoutDefinition } from "../workflow/layout.ts";
import { slaSchema, type SlaDefinition } from "../sla/definition.ts";
import { addBusinessMinutes, type Calendar } from "../sla/calendar.ts";
import { getProject, getRecordType, listFields } from "./service.ts";

export const CONFIG_KINDS = ["workflow", "layout", "sla"] as const;
export type ConfigKind = (typeof CONFIG_KINDS)[number];

type DefinitionOf<K extends ConfigKind> = K extends "workflow"
  ? WorkflowDefinition
  : K extends "layout"
    ? LayoutDefinition
    : SlaDefinition;

export interface ConfigVersion<D = unknown> {
  id: string;
  kind: ConfigKind;
  ownerId: string;
  version: number;
  state: "draft" | "published" | "superseded";
  definition: D;
  createdBy: string | null;
  createdByName?: string | null;
  createdAt: Date;
  publishedAt: Date | null;
}

const COLUMNS = (tx: Tx) =>
  tx`v.id, v.kind, v.owner_id, v.version, v.state, v.definition, v.created_by, v.created_at, v.published_at`;

export function assertKind(kind: string): ConfigKind {
  if (!(CONFIG_KINDS as readonly string[]).includes(kind)) throw notFound("Configuration");
  return kind as ConfigKind;
}

async function assertOwner(tx: Tx, kind: ConfigKind, ownerId: string): Promise<void> {
  if (kind === "sla") await getProject(tx, ownerId);
  else await getRecordType(tx, ownerId);
}

/** The published definition, or the built-in default when none has been published. */
export async function getPublished<K extends ConfigKind>(
  tx: Tx,
  kind: K,
  ownerId: string,
): Promise<{ version: number; definition: DefinitionOf<K> } | null> {
  const [row] = await tx<{ version: number; definition: DefinitionOf<K> }[]>`
    select version, definition from config_versions
    where kind = ${kind} and owner_id = ${ownerId} and state = 'published'`;
  if (row) return row;
  if (kind === "workflow") return { version: 0, definition: DEFAULT_WORKFLOW as DefinitionOf<K> };
  if (kind === "layout") {
    const fields = await listFields(tx, ownerId);
    return { version: 0, definition: defaultLayout(fields) as DefinitionOf<K> };
  }
  return null;
}

export async function getWorkflow(tx: Tx, recordTypeId: string) {
  return (await getPublished(tx, "workflow", recordTypeId))!;
}

/** Published definitions for many owners at once (config endpoint). */
export async function publishedByOwner(tx: Tx, kind: ConfigKind): Promise<Map<string, { version: number; definition: unknown }>> {
  const rows = await tx<{ ownerId: string; version: number; definition: unknown }[]>`
    select owner_id, version, definition from config_versions where kind = ${kind} and state = 'published'`;
  return new Map(rows.map((r) => [r.ownerId, { version: r.version, definition: r.definition }]));
}

export async function getConfigBundle(tx: Tx, kind: ConfigKind, ownerId: string) {
  await assertOwner(tx, kind, ownerId);
  const rows = await tx<ConfigVersion[]>`
    select ${COLUMNS(tx)}, u.display_name as created_by_name
    from config_versions v left join users u on u.id = v.created_by
    where v.kind = ${kind} and v.owner_id = ${ownerId}
    order by v.version desc limit 100`;
  const published = rows.find((r) => r.state === "published") ?? null;
  const fallback = published ? null : await getPublished(tx, kind, ownerId);
  return {
    published,
    draft: rows.find((r) => r.state === "draft") ?? null,
    /** What is in force when nothing has been published yet. */
    effective: published?.definition ?? fallback?.definition ?? null,
    versions: rows
      .filter((r) => r.state !== "draft")
      .map(({ definition: _d, ...meta }) => meta),
  };
}

export async function getVersion(tx: Tx, kind: ConfigKind, ownerId: string, version: number): Promise<ConfigVersion> {
  const [row] = await tx<ConfigVersion[]>`
    select ${COLUMNS(tx)} from config_versions v
    where v.kind = ${kind} and v.owner_id = ${ownerId} and v.version = ${version} and v.state <> 'draft'`;
  if (!row) throw notFound("Version");
  return row;
}

/** Validate a definition against the workspace (fields, approvers, calendars). */
async function validate(tx: Tx, kind: ConfigKind, ownerId: string, input: unknown): Promise<unknown> {
  if (kind === "workflow") {
    const def = parse(workflowSchema, input);
    const fields = await listFields(tx, ownerId);
    const issues = checkWorkflow(def, fields.map((f) => f.key));
    const approvers = [...new Set(def.transitions.flatMap((t) => t.approval?.approvers ?? []))];
    if (approvers.length) {
      const ok = await tx<{ id: string }[]>`
        select id from users where active and role in ('admin', 'agent')
          and id in (select (jsonb_array_elements_text(${tx.json(approvers)}))::uuid)`;
      const okSet = new Set(ok.map((u) => u.id));
      def.transitions.forEach((t, i) =>
        (t.approval?.approvers ?? []).forEach((a, j) => {
          if (!okSet.has(a)) issues.push({ field: `transitions.${i}.approval.approvers.${j}`, message: "Must be an active admin or agent" });
        }),
      );
    }
    if (issues.length) throw invalid(issues);
    return def;
  }
  if (kind === "layout") {
    const def = parse(layoutSchema, input);
    const fields = await listFields(tx, ownerId);
    const issues = checkLayout(def, fields.map((f) => f.key));
    if (issues.length) throw invalid(issues);
    return def;
  }
  const def = parse(slaSchema, input);
  const issues: FieldIssue[] = [];
  const calendarIds = [...new Set(def.policies.map((p) => p.calendarId).filter((c): c is string => !!c))];
  if (calendarIds.length) {
    const found = await tx<{ id: string }[]>`
      select id from calendars where id in (select (jsonb_array_elements_text(${tx.json(calendarIds)}))::uuid)`;
    const okSet = new Set(found.map((c) => c.id));
    def.policies.forEach((p, i) => {
      if (p.calendarId && !okSet.has(p.calendarId)) issues.push({ field: `policies.${i}.calendarId`, message: "Unknown calendar" });
    });
  }
  // Every target must be reachable on its calendar (a calendar with almost no hours could not).
  for (const [i, p] of def.policies.entries()) {
    if (!p.calendarId || issues.some((x) => x.field === `policies.${i}.calendarId`)) continue;
    const [cal] = await tx<Calendar[]>`select timezone, hours, holidays from calendars where id = ${p.calendarId}`;
    try {
      addBusinessMinutes(new Date(), Math.max(p.firstResponseMinutes ?? 0, p.resolutionMinutes ?? 0), cal!);
    } catch {
      issues.push({ field: `policies.${i}.calendarId`, message: "This calendar has too few working hours to reach the target" });
    }
  }
  const typeIds = [...new Set(def.policies.flatMap((p) => p.match.recordTypeIds))];
  if (typeIds.length) {
    const found = await tx<{ id: string }[]>`
      select id from record_types where project_id = ${ownerId}
        and id in (select (jsonb_array_elements_text(${tx.json(typeIds)}))::uuid)`;
    const okSet = new Set(found.map((t) => t.id));
    def.policies.forEach((p, i) =>
      p.match.recordTypeIds.forEach((t, j) => {
        if (!okSet.has(t)) issues.push({ field: `policies.${i}.match.recordTypeIds.${j}`, message: "Not a record type of this project" });
      }),
    );
  }
  if (issues.length) throw invalid(issues);
  return def;
}

export async function saveDraft(tx: Tx, actor: Actor, kind: ConfigKind, ownerId: string, input: unknown): Promise<ConfigVersion> {
  await assertOwner(tx, kind, ownerId);
  const definition = await validate(tx, kind, ownerId, input);
  const [row] = await tx<ConfigVersion[]>`
    insert into config_versions as v (tenant_id, kind, owner_id, version, state, definition, created_by)
    values (
      ${actor.tenantId}, ${kind}, ${ownerId}, 0, 'draft', ${tx.json(definition as never)}, ${actor.userId}
    )
    on conflict (tenant_id, kind, owner_id) where state = 'draft'
    do update set definition = excluded.definition, created_by = excluded.created_by, created_at = clock_timestamp()
    returning ${COLUMNS(tx)}`;
  return row!;
}

export async function discardDraft(tx: Tx, actor: Actor, kind: ConfigKind, ownerId: string): Promise<void> {
  await assertOwner(tx, kind, ownerId);
  const deleted = await tx`delete from config_versions where kind = ${kind} and owner_id = ${ownerId} and state = 'draft'`;
  if (deleted.count === 0) throw notFound("Draft");
  void actor;
}

const publishOptions = z
  .object({ statusMap: z.record(configKey, configKey).default({}) })
  .strict()
  .default({ statusMap: {} });

/**
 * Make `definition` the published version. For a workflow, records in statuses that no
 * longer exist must be moved: the caller passes statusMap {removed: replacement}; without it
 * the publish is refused with the statuses and record counts that need a mapping.
 */
async function publish(
  tx: Tx,
  actor: Actor,
  kind: ConfigKind,
  ownerId: string,
  definition: unknown,
  draftId: string | null,
  rawOptions: unknown,
  restoredFrom?: number,
): Promise<ConfigVersion> {
  const { statusMap } = parse(publishOptions, rawOptions ?? {});
  const before = await getPublished(tx, kind, ownerId);
  if (kind === "workflow") {
    await remapStatuses(tx, actor, ownerId, before?.definition as WorkflowDefinition, definition as WorkflowDefinition, statusMap);
  }
  await tx`
    update config_versions set state = 'superseded'
    where kind = ${kind} and owner_id = ${ownerId} and state = 'published'`;
  const next = tx`(select coalesce(max(version), 0) + 1 from config_versions where kind = ${kind} and owner_id = ${ownerId})`;
  const [row] = draftId
    ? await tx<ConfigVersion[]>`
        update config_versions v set state = 'published', published_at = now(), version = ${next}
        where id = ${draftId} returning ${COLUMNS(tx)}`
    : await tx<ConfigVersion[]>`
        insert into config_versions as v (tenant_id, kind, owner_id, version, state, definition, created_by, published_at)
        values (${actor.tenantId}, ${kind}, ${ownerId}, ${next}, 'published', ${tx.json(definition as never)}, ${actor.userId}, now())
        returning ${COLUMNS(tx)}`;
  if (kind === "workflow") {
    await tx`update records set workflow_version = ${row!.version} where record_type_id = ${ownerId}`;
  }
  await audit(tx, actor, {
    entity: kind,
    entityId: ownerId,
    action: restoredFrom ? "restore" : "publish",
    before: before ? { version: before.version, definition: before.definition } : null,
    after: { version: row!.version, definition: row!.definition, ...(restoredFrom ? { restoredFrom } : {}), statusMap },
  });
  return row!;
}

async function remapStatuses(
  tx: Tx,
  actor: Actor,
  recordTypeId: string,
  before: WorkflowDefinition | undefined,
  after: WorkflowDefinition,
  statusMap: Record<string, string>,
): Promise<void> {
  const newKeys = new Map(after.statuses.map((s) => [s.key, s]));
  // Every status any record of this type is in today (trash included: a restore must land
  // on a valid status), compared with the new definition.
  const inUse = await tx<{ status: string; n: number }[]>`
    select status, count(*)::int as n from records where record_type_id = ${recordTypeId} group by status`;
  const missing = inUse.filter((s) => !newKeys.has(s.status));
  const issues: FieldIssue[] = [];
  for (const m of missing) {
    const target = statusMap[m.status];
    if (!target) issues.push({ field: `statusMap.${m.status}`, message: `${m.n} record(s) are in "${m.status}"; choose a new status` });
    else if (!newKeys.has(target)) issues.push({ field: `statusMap.${m.status}`, message: `Unknown status "${target}"` });
  }
  if (issues.length) {
    throw new AppError("validation_failed", "Some records are in statuses this version removes", {
      issues,
      statusesNeedingMap: missing.map((m) => ({
        key: m.status,
        name: before?.statuses.find((s) => s.key === m.status)?.name ?? m.status,
        count: m.n,
      })),
    });
  }
  for (const m of missing) {
    const to = newKeys.get(statusMap[m.status]!)!;
    const moved = await tx<{ id: string }[]>`
      update records set status = ${to.key}, status_category = ${to.category}, version = version + 1, updated_at = clock_timestamp()
      where record_type_id = ${recordTypeId} and status = ${m.status}
      returning id`;
    if (moved.length) {
      await tx`
        insert into record_events (tenant_id, record_id, actor_id, kind, data)
        select ${actor.tenantId}, (r)::uuid, ${actor.userId}, 'status_mapped',
               ${tx.json({ from: m.status, to: to.key } as never)}
        from jsonb_array_elements_text(${tx.json(moved.map((x) => x.id))}) as r`;
    }
  }
  // Statuses whose category changed keep their records but move them between categories.
  const cats = after.statuses.map((s) => ({ key: s.key, category: s.category }));
  await tx`
    update records r set status_category = s.category
    from jsonb_to_recordset(${tx.json(cats as never)}) as s(key text, category text)
    where r.record_type_id = ${recordTypeId} and r.status = s.key and r.status_category <> s.category`;
}

export async function publishDraft(tx: Tx, actor: Actor, kind: ConfigKind, ownerId: string, options: unknown) {
  await assertOwner(tx, kind, ownerId);
  const [draft] = await tx<ConfigVersion[]>`
    select ${COLUMNS(tx)} from config_versions v
    where v.kind = ${kind} and v.owner_id = ${ownerId} and v.state = 'draft' for update`;
  if (!draft) throw notFound("Draft");
  // Re-validate: fields or approvers may have changed since the draft was saved.
  const definition = await validate(tx, kind, ownerId, draft.definition);
  await tx`update config_versions set definition = ${tx.json(definition as never)} where id = ${draft.id}`;
  return publish(tx, actor, kind, ownerId, definition, draft.id, options);
}

/** Publish a copy of an earlier version as the newest version. */
export async function restoreVersion(tx: Tx, actor: Actor, kind: ConfigKind, ownerId: string, version: number, options: unknown) {
  await assertOwner(tx, kind, ownerId);
  const old = await getVersion(tx, kind, ownerId, version);
  if (old.state === "published") throw new AppError("bad_request", "That version is already published");
  const definition = await validate(tx, kind, ownerId, old.definition);
  return publish(tx, actor, kind, ownerId, definition, null, options, version);
}

/** Publish a definition directly (new record types, templates, seeds). */
export async function publishDefinition(tx: Tx, actor: Actor, kind: ConfigKind, ownerId: string, definition: unknown) {
  await assertOwner(tx, kind, ownerId);
  const valid = await validate(tx, kind, ownerId, definition);
  return publish(tx, actor, kind, ownerId, valid, null, {});
}
