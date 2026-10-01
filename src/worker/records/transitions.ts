// Moving a record through its workflow. A transition is allowed from its listed statuses, for
// its listed roles, once its required fields have values. If it needs approval, an approval
// request is opened instead and the move happens when the approvers agree.
import { z } from "zod";
import type { Tx } from "../db/client.ts";
import { emit, isStaff, type Actor } from "../audit.ts";
import { AppError, forbidden, invalid, notFound, type FieldIssue } from "../lib/errors.ts";
import { configKey, parse } from "../lib/validate.ts";
import { getWorkflow } from "../config/versions.ts";
import { BUILTIN_FIELDS, statusOf, type WorkflowDefinition, type WorkflowTransition } from "../workflow/definition.ts";
import { syncSla } from "../sla/service.ts";
import { requestApproval } from "../approvals/service.ts";
import { createComment } from "../comments/service.ts";
import { loadRecord, type RecordRow } from "./access.ts";
import { applyPatch, recordEvent, recordPatchSchema, type RecordPatch } from "./service.ts";

const transitionSchema = z
  .object({
    transition: configKey,
    version: z.number().int().min(1).optional(),
    /** Values to set as part of the move (e.g. a resolution field the transition requires). */
    fields: recordPatchSchema.omit({ requesterId: true }).optional(),
    comment: z.string().trim().min(1).max(50_000).optional(),
  })
  .strict();

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
}

const BUILTIN = new Set<string>(BUILTIN_FIELDS);

export function missingFields(record: RecordRow, t: WorkflowTransition): FieldIssue[] {
  return t.requiredFields
    .filter((f) => isEmpty(BUILTIN.has(f) ? (record as unknown as Record<string, unknown>)[f] : record.custom[f]))
    .map((f) => ({ field: BUILTIN.has(f) ? f : `custom.${f}`, message: `Required to ${t.name.toLowerCase()}` }));
}

function findTransition(def: WorkflowDefinition, record: RecordRow, key: string): WorkflowTransition {
  const t = def.transitions.find((x) => x.key === key);
  if (!t) throw notFound("Transition");
  if (t.from.length && !t.from.includes(record.status)) {
    throw new AppError("conflict", `"${t.name}" is not available from ${statusOf(def, record.status)?.name ?? record.status}`);
  }
  if (t.to === record.status) throw new AppError("conflict", `The record is already ${statusOf(def, t.to)?.name ?? t.to}`);
  return t;
}

export async function transitionRecord(tx: Tx, actor: Actor, idOrKey: string, input: unknown) {
  const data = parse(transitionSchema, input);
  let record = await loadRecord(tx, actor, idOrKey, { lock: true });
  if (!record) throw notFound("Record");
  if (data.version !== undefined && data.version !== record.version) {
    throw new AppError("version_conflict", "Someone else changed this record. Reload to see their changes.", {
      currentVersion: record.version,
    });
  }
  return runTransition(tx, actor, record, data.transition, { fields: data.fields, comment: data.comment });
}

/** Shared by the API, bulk edit and automation. The record must be loaded with a lock. */
export async function runTransition(
  tx: Tx,
  actor: Actor,
  loaded: RecordRow,
  key: string,
  opts: { fields?: RecordPatch; comment?: string } = {},
) {
  let record = loaded;
  const wf = await getWorkflow(tx, record.recordTypeId);
  const t = findTransition(wf.definition, record, key);
  if (!t.roles.includes(actor.role)) throw forbidden(`You cannot ${t.name.toLowerCase()} this record`);
  if (record.pendingApprovalId) throw new AppError("conflict", "This record is waiting for an approval decision");
  if (opts.fields && Object.keys(opts.fields).length) {
    if (!isStaff(actor)) throw forbidden("Requesters cannot change fields");
    record = await applyPatch(tx, actor, record, opts.fields);
  }
  const missing = missingFields(record, t);
  if (missing.length) throw invalid(missing, `Fill in the required fields to ${t.name.toLowerCase()}`);
  if (opts.comment) await createComment(tx, actor, record.id, { body: opts.comment, internal: false });
  if (t.approval) {
    const approval = await requestApproval(tx, actor, record, t);
    return { record: (await loadRecord(tx, { ...actor, role: "admin" }, record.id))!, approval };
  }
  return { record: await applyTransition(tx, actor, record, t, wf.definition), approval: null };
}

/** Perform the move (after any approval). */
export async function applyTransition(
  tx: Tx,
  actor: Actor,
  record: RecordRow,
  t: WorkflowTransition,
  def: WorkflowDefinition,
  extra: Record<string, unknown> = {},
): Promise<RecordRow> {
  const to = statusOf(def, t.to);
  if (!to) throw new AppError("conflict", `Status "${t.to}" no longer exists in this workflow`);
  const resolvedAt =
    to.category === "done" ? (record.statusCategory === "done" ? record.resolvedAt : new Date()) : null;
  await tx`
    update records set status = ${to.key}, status_category = ${to.category}, resolved_at = ${resolvedAt},
      pending_approval_id = null, version = version + 1, updated_at = clock_timestamp()
    where id = ${record.id}`;
  await recordEvent(tx, actor, record.id, "transitioned", {
    from: record.status,
    to: to.key,
    transition: t.key,
    name: t.name,
    ...extra,
  });
  let updated = (await loadRecord(tx, { ...actor, role: "admin" }, record.id))!;

  // Post-transition actions. A misconfigured action is logged, never blocks the move.
  for (const action of t.actions) {
    const patch: RecordPatch =
      action.type === "assign_self"
        ? actor.userId && isStaff(actor)
          ? { assigneeId: actor.userId }
          : {}
        : action.type === "unassign"
          ? { assigneeId: null }
          : !BUILTIN.has(action.field)
            ? { custom: { [action.field]: action.value } }
            : ({ [action.field]: action.value } as RecordPatch);
    if (!Object.keys(patch).length) continue;
    try {
      updated = await tx.savepoint((sp) => applyPatch(sp as Tx, actor, updated, parse(recordPatchSchema, patch)));
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      await recordEvent(tx, actor, record.id, "action_failed", { transition: t.key, action, error: err.message });
    }
  }

  await emit(
    tx,
    actor.tenantId,
    "record.transitioned",
    {
      recordId: record.id,
      key: record.key,
      actorId: actor.userId,
      from: record.status,
      to: to.key,
      toCategory: to.category,
      transition: t.key,
    },
    actor,
  );
  await syncSla(tx, updated);
  return updated;
}
