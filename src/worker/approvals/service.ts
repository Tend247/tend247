// Approvals. A transition configured with approvers opens an approval request instead of
// moving the record. "any": one approver's decision settles it; "sequential": each approver in
// order. Nobody approves their own request. Approvers decide in the app or from a one-time
// emailed link.
import { z } from "zod";
import type { Sql, Tx } from "../db/client.ts";
import { withTenant } from "../db/client.ts";
import { emit, isStaff, type Actor } from "../audit.ts";
import { AppError, forbidden, notFound } from "../lib/errors.ts";
import { isUuid, randomToken, sha256Hex } from "../lib/crypto.ts";
import { parse } from "../lib/validate.ts";
import { getWorkflow } from "../config/versions.ts";
import type { WorkflowTransition } from "../workflow/definition.ts";
import { loadRecord, visibleTo, type RecordRow } from "../records/access.ts";
import { recordEvent } from "../records/service.ts";
import { applyTransition } from "../records/transitions.ts";
import { createComment } from "../comments/service.ts";

export interface ApprovalStep {
  approvers: string[];
  decision?: "approved" | "rejected";
  decidedBy?: string;
  decidedAt?: string;
}

export interface Approval {
  id: string;
  recordId: string;
  transitionKey: string;
  transitionName: string;
  toStatus: string;
  requestedBy: string | null;
  requestedByName: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  mode: "any" | "sequential";
  steps: ApprovalStep[];
  currentStep: number;
  createdAt: Date;
  decidedAt: Date | null;
}

const COLUMNS = (tx: Tx) => tx`
  a.id, a.record_id, a.transition_key, a.transition_name, a.to_status, a.requested_by,
  u.display_name as requested_by_name, a.status, a.mode, a.steps, a.current_step, a.created_at, a.decided_at`;

const TOKEN_TTL_DAYS = 7;

export async function requestApproval(tx: Tx, actor: Actor, record: RecordRow, t: WorkflowTransition): Promise<Approval> {
  const listed = t.approval!.approvers;
  const active = await tx<{ id: string; role: Actor["role"] }[]>`
    select id, role from users where active and role in ('admin', 'agent')
      and id in (select (jsonb_array_elements_text(${tx.json(listed)}))::uuid)`;
  const activeSet = new Set<string>();
  for (const u of active) {
    // An approver must be able to see the record (restricted projects).
    if (await loadRecord(tx, { tenantId: actor.tenantId, userId: u.id, role: u.role }, record.id)) activeSet.add(u.id);
  }
  // The person asking never approves their own request.
  const approvers = listed.filter((a) => activeSet.has(a) && a !== actor.userId);
  if (!approvers.length) throw new AppError("conflict", `No one else can approve "${t.name}"; ask an admin to update the approvers`);
  const steps: ApprovalStep[] = t.approval!.mode === "any" ? [{ approvers }] : approvers.map((a) => ({ approvers: [a] }));
  const [row] = await tx<{ id: string }[]>`
    insert into approvals (tenant_id, record_id, transition_key, transition_name, to_status, requested_by, status, mode, steps)
    values (${actor.tenantId}, ${record.id}, ${t.key}, ${t.name}, ${t.to}, ${actor.userId}, 'pending', ${t.approval!.mode},
            ${tx.json(steps as never)})
    returning id`;
  await tx`
    update records set pending_approval_id = ${row!.id}, version = version + 1, updated_at = clock_timestamp()
    where id = ${record.id}`;
  await recordEvent(tx, actor, record.id, "approval_requested", { approvalId: row!.id, transition: t.key, name: t.name });
  await emit(
    tx,
    actor.tenantId,
    "approval.requested",
    { approvalId: row!.id, recordId: record.id, key: record.key, step: 0, approverIds: steps[0]!.approvers, actorId: actor.userId },
    actor,
  );
  return (await getApproval(tx, row!.id))!;
}

async function getApproval(tx: Tx, id: string, lock = false): Promise<Approval | null> {
  const [a] = await tx<Approval[]>`
    select ${COLUMNS(tx)} from approvals a left join users u on u.id = a.requested_by where a.id = ${id}
    ${lock ? tx`for update of a` : tx``}`;
  return a ?? null;
}

const decisionSchema = z
  .object({ decision: z.enum(["approve", "reject"]), comment: z.string().trim().min(1).max(5000).optional() })
  .strict();

export async function decideApproval(tx: Tx, actor: Actor, approvalId: string, input: unknown): Promise<Approval> {
  const { decision, comment } = parse(decisionSchema, input);
  if (!isUuid(approvalId)) throw notFound("Approval");
  const approval = await getApproval(tx, approvalId.toLowerCase(), true);
  if (!approval) throw notFound("Approval");
  const record = await loadRecord(tx, actor, approval.recordId, { lock: true });
  if (!record) throw notFound("Approval");
  if (approval.status !== "pending") throw new AppError("conflict", `This approval was already ${approval.status}`);
  const step = approval.steps[approval.currentStep]!;
  if (!actor.userId || !step.approvers.includes(actor.userId)) throw forbidden("You are not an approver for this step");
  if (actor.userId === approval.requestedBy) throw forbidden("You cannot approve your own request");

  const steps = approval.steps.map((s, i) =>
    i === approval.currentStep
      ? { ...s, decision: decision === "approve" ? "approved" : "rejected", decidedBy: actor.userId!, decidedAt: new Date().toISOString() }
      : s,
  ) as ApprovalStep[];
  if (comment) await createComment(tx, actor, record.id, { body: comment, internal: true });

  const moreSteps = decision === "approve" && approval.currentStep + 1 < steps.length;
  const status = decision === "reject" ? "rejected" : moreSteps ? "pending" : "approved";
  await tx`
    update approvals set steps = ${tx.json(steps as never)}, status = ${status},
      current_step = ${moreSteps ? approval.currentStep + 1 : approval.currentStep},
      decided_at = ${status === "pending" ? null : new Date()}
    where id = ${approval.id}`;

  if (moreSteps) {
    await recordEvent(tx, actor, record.id, "approval_step", { approvalId: approval.id, step: approval.currentStep });
    await emit(tx, actor.tenantId, "approval.requested", {
      approvalId: approval.id,
      recordId: record.id,
      key: record.key,
      step: approval.currentStep + 1,
      approverIds: steps[approval.currentStep + 1]!.approvers,
      actorId: approval.requestedBy,
    });
    return (await getApproval(tx, approval.id))!;
  }

  await recordEvent(tx, actor, record.id, "approval_decided", { approvalId: approval.id, decision: status, name: approval.transitionName });
  if (status === "rejected") {
    await tx`update records set pending_approval_id = null, version = version + 1, updated_at = clock_timestamp() where id = ${record.id}`;
  } else {
    const wf = await getWorkflow(tx, record.recordTypeId);
    const t = wf.definition.transitions.find((x) => x.key === approval.transitionKey && x.to === approval.toStatus);
    if (!t) {
      // The workflow changed while the request waited: the move it asked for no longer exists.
      await tx`update approvals set status = 'cancelled' where id = ${approval.id}`;
      await tx`update records set pending_approval_id = null where id = ${record.id}`;
      await recordEvent(tx, actor, record.id, "approval_cancelled", { approvalId: approval.id, reason: "workflow changed" });
    } else {
      await applyTransition(tx, actor, record, t, wf.definition, { approvalId: approval.id });
    }
  }
  await emit(
    tx,
    actor.tenantId,
    "approval.decided",
    { approvalId: approval.id, recordId: record.id, key: record.key, approved: status === "approved", actorId: actor.userId, requestedBy: approval.requestedBy },
    actor,
  );
  return (await getApproval(tx, approval.id))!;
}

/** Withdraw a pending request (the person who asked, or an admin). */
export async function cancelApproval(tx: Tx, actor: Actor, approvalId: string): Promise<Approval> {
  if (!isUuid(approvalId)) throw notFound("Approval");
  const approval = await getApproval(tx, approvalId.toLowerCase(), true);
  if (!approval || !(await loadRecord(tx, actor, approval.recordId))) throw notFound("Approval");
  if (approval.status !== "pending") throw new AppError("conflict", `This approval was already ${approval.status}`);
  if (approval.requestedBy !== actor.userId && actor.role !== "admin") throw forbidden("Only the requester or an admin can withdraw this");
  await tx`update approvals set status = 'cancelled', decided_at = now() where id = ${approval.id}`;
  await tx`update records set pending_approval_id = null, version = version + 1, updated_at = clock_timestamp() where id = ${approval.recordId}`;
  await recordEvent(tx, actor, approval.recordId, "approval_cancelled", { approvalId: approval.id });
  return (await getApproval(tx, approval.id))!;
}

export async function listRecordApprovals(tx: Tx, actor: Actor, recordIdOrKey: string): Promise<Approval[]> {
  const record = await loadRecord(tx, actor, recordIdOrKey);
  if (!record) throw notFound("Record");
  const rows = await tx<Approval[]>`
    select ${COLUMNS(tx)} from approvals a left join users u on u.id = a.requested_by
    where a.record_id = ${record.id} order by a.created_at desc limit 20`;
  // Requesters see the state of their request, not who approves it.
  return isStaff(actor) ? rows : rows.map((a) => ({ ...a, steps: a.steps.map((s) => ({ decision: s.decision, approvers: [] })) }));
}

/** Pending approvals waiting on this person. */
export async function listMyApprovals(tx: Tx, actor: Actor) {
  if (!actor.userId || !isStaff(actor)) return [];
  return tx<(Approval & { recordKey: string; recordTitle: string })[]>`
    select ${COLUMNS(tx)}, records.key as record_key, records.title as record_title
    from approvals a join records on records.id = a.record_id left join users u on u.id = a.requested_by
    where a.status = 'pending' and records.deleted_at is null and ${visibleTo(tx, actor)}
      and a.steps -> a.current_step -> 'approvers' ? ${actor.userId}
    order by a.created_at`;
}

// ---------------------------------------------------------------- email links

/** One-time decision links for the approvers of the current step (sent by email). */
export async function createApprovalTokens(tx: Tx, tenantId: string, approvalId: string, step: number, userIds: string[]) {
  const out: { userId: string; token: string }[] = [];
  for (const userId of userIds) {
    const secret = randomToken(32);
    await tx`
      insert into approval_tokens (token_hash, tenant_id, approval_id, user_id, step, expires_at)
      values (${await sha256Hex(secret)}, ${tenantId}, ${approvalId}, ${userId}, ${step},
              now() + make_interval(days => ${TOKEN_TTL_DAYS}))`;
    out.push({ userId, token: `${tenantId}.${secret}` });
  }
  return out;
}

function splitToken(token: string): { tenantId: string; secret: string } {
  const [tenantId, secret] = token.split(".");
  if (!tenantId || !secret || !isUuid(tenantId) || secret.length < 20 || secret.length > 100) throw notFound("Approval link");
  return { tenantId: tenantId.toLowerCase(), secret };
}

async function assertLiveWorkspace(sql: Sql, tenantId: string): Promise<void> {
  const [t] = await sql`select 1 from tenants where id = ${tenantId} and (expires_at is null or expires_at > now())`;
  if (!t) throw notFound("Approval link");
}

/** What an emailed link points at, without using it. */
export async function peekApprovalToken(sql: Sql, token: string) {
  const { tenantId, secret } = splitToken(token);
  await assertLiveWorkspace(sql, tenantId);
  return withTenant(sql, tenantId, async (tx) => {
    const [row] = await tx<{ approvalId: string; step: number; usedAt: Date | null; expiresAt: Date; userId: string; role: Actor["role"]; active: boolean }[]>`
      select t.approval_id, t.step, t.used_at, t.expires_at, t.user_id, u.role, u.active
      from approval_tokens t join users u on u.id = t.user_id where t.token_hash = ${await sha256Hex(secret)}`;
    if (!row || row.usedAt || row.expiresAt < new Date() || !row.active) throw notFound("Approval link");
    const a = (await getApproval(tx, row.approvalId))!;
    if (!(await loadRecord(tx, { tenantId, userId: row.userId, role: row.role }, a.recordId))) throw notFound("Approval link");
    const [r] = await tx<{ key: string; title: string }[]>`select key, title from records where id = ${a.recordId}`;
    return {
      record: r,
      transitionName: a.transitionName,
      requestedByName: a.requestedByName,
      status: a.status !== "pending" || a.currentStep !== row.step ? "decided" : "pending",
    };
  });
}

/** Decide through an emailed link. The link works once, for its own step, within 7 days. */
export async function decideByToken(sql: Sql, token: string, input: unknown): Promise<Approval> {
  const { tenantId, secret } = splitToken(token);
  const hash = await sha256Hex(secret);
  await assertLiveWorkspace(sql, tenantId);
  return withTenant(sql, tenantId, async (tx) => {
    const [row] = await tx<{ approvalId: string; userId: string; step: number; role: Actor["role"]; active: boolean }[]>`
      update approval_tokens t set used_at = now()
      from users u
      where t.token_hash = ${hash} and t.used_at is null and t.expires_at > now() and u.id = t.user_id
      returning t.approval_id, t.user_id, t.step, u.role, u.active`;
    if (!row || !row.active) throw notFound("Approval link");
    const approval = await getApproval(tx, row.approvalId);
    if (!approval || approval.status !== "pending" || approval.currentStep !== row.step) {
      throw new AppError("conflict", "This approval has already been decided");
    }
    const actor: Actor = { tenantId, userId: row.userId, role: row.role, via: "email" };
    return decideApproval(tx, actor, row.approvalId, input);
  });
}
