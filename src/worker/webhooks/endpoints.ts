// Webhook endpoints: admins subscribe a URL to workspace events (optionally one project's).
// Each matching event becomes a row in webhook_deliveries, signed and retried by the same
// delivery code as the automation webhook action, and listed in a delivery log that can
// redeliver any attempt.
import { z } from "zod";
import type { Tx } from "../db/client.ts";
import { audit, systemActor, type Actor } from "../audit.ts";
import { checkWebhookUrl, publicRecord } from "../automation/service.ts";
import { loadRecord } from "../records/access.ts";
import { getProject } from "../config/service.ts";
import { scheduleJob } from "../jobs/schedule.ts";
import { invalid, notFound } from "../lib/errors.ts";
import { isUuid } from "../lib/crypto.ts";
import { parse, parsePatch, uuid } from "../lib/validate.ts";

export const WEBHOOK_TOPICS = [
  "record.created",
  "record.updated",
  "record.transitioned",
  "record.deleted",
  "record.restored",
  "comment.created",
  "attachment.created",
  "approval.requested",
  "approval.decided",
  "sla.warning",
  "sla.breached",
] as const;

const endpointSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().trim().url().max(2000),
  topics: z.array(z.enum(WEBHOOK_TOPICS)).min(1).max(WEBHOOK_TOPICS.length),
  projectId: uuid.nullable().default(null),
  enabled: z.boolean().default(true),
});
const endpointPatch = endpointSchema.partial().strict();

export interface WebhookEndpoint {
  id: string;
  name: string;
  url: string;
  topics: string[];
  projectId: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastDelivery?: { status: string; createdAt: Date } | null;
}

const COLUMNS = (tx: Tx) => tx`e.id, e.name, e.url, e.topics, e.project_id, e.enabled, e.created_at, e.updated_at`;

async function validate(tx: Tx, data: z.infer<typeof endpointSchema>, allowHttp: boolean) {
  const problem = checkWebhookUrl(data.url, allowHttp);
  if (problem) throw invalid([{ field: "url", message: problem }]);
  if (data.projectId) await getProject(tx, data.projectId);
}

export async function listEndpoints(tx: Tx): Promise<WebhookEndpoint[]> {
  return tx<WebhookEndpoint[]>`
    select ${COLUMNS(tx)},
      (select jsonb_build_object('status', d.status, 'createdAt', d.created_at) from webhook_deliveries d
        where d.endpoint_id = e.id order by d.created_at desc limit 1) as last_delivery
    from webhook_endpoints e order by e.created_at`;
}

async function getEndpoint(tx: Tx, id: string): Promise<WebhookEndpoint> {
  if (!isUuid(id)) throw notFound("Webhook endpoint");
  const [e] = await tx<WebhookEndpoint[]>`select ${COLUMNS(tx)} from webhook_endpoints e where e.id = ${id}`;
  if (!e) throw notFound("Webhook endpoint");
  return e;
}

export async function createEndpoint(tx: Tx, actor: Actor, input: unknown, opts: { allowHttp?: boolean } = {}) {
  const data = parse(endpointSchema, input);
  await validate(tx, data, opts.allowHttp ?? false);
  const [row] = await tx<{ id: string }[]>`
    insert into webhook_endpoints (tenant_id, name, url, topics, project_id, enabled, created_by)
    values (${actor.tenantId}, ${data.name}, ${data.url}, ${tx.json([...new Set(data.topics)])}, ${data.projectId}, ${data.enabled}, ${actor.userId})
    returning id`;
  const e = await getEndpoint(tx, row!.id);
  await audit(tx, actor, { entity: "webhook_endpoint", entityId: e.id, action: "create", after: e });
  return e;
}

export async function updateEndpoint(tx: Tx, actor: Actor, id: string, input: unknown, opts: { allowHttp?: boolean } = {}) {
  const before = await getEndpoint(tx, id);
  const patch = parsePatch(endpointPatch, input);
  const next = parse(endpointSchema, { ...before, ...patch });
  await validate(tx, next, opts.allowHttp ?? false);
  await tx`
    update webhook_endpoints set name = ${next.name}, url = ${next.url}, topics = ${tx.json([...new Set(next.topics)])},
      project_id = ${next.projectId}, enabled = ${next.enabled}, updated_at = now()
    where id = ${before.id}`;
  const after = await getEndpoint(tx, id);
  await audit(tx, actor, { entity: "webhook_endpoint", entityId: id, action: "update", before, after });
  return after;
}

export async function deleteEndpoint(tx: Tx, actor: Actor, id: string): Promise<void> {
  const before = await getEndpoint(tx, id);
  await tx`delete from webhook_endpoints where id = ${before.id}`;
  await audit(tx, actor, { entity: "webhook_endpoint", entityId: id, action: "delete", before });
}

async function queue(tx: Tx, tenantId: string, e: { id: string; url: string }, topic: string, payload: Record<string, unknown>) {
  const [d] = await tx<{ id: string }[]>`
    insert into webhook_deliveries (tenant_id, endpoint_id, url, topic, payload)
    values (${tenantId}, ${e.id}, ${e.url}, ${topic}, ${tx.json(payload as never)})
    returning id`;
  await scheduleJob(tx, tenantId, "webhook", d!.id, new Date());
  return d!.id;
}

/** Send a test event to an endpoint. */
export async function pingEndpoint(tx: Tx, actor: Actor, id: string): Promise<string> {
  const e = await getEndpoint(tx, id);
  return queue(tx, actor.tenantId, e, "ping", { event: "ping", endpointId: e.id, sentAt: new Date().toISOString() });
}

/** Queue deliveries for every enabled endpoint subscribed to this event (from the outbox). */
export async function fanOutEvent(
  tx: Tx,
  tenantId: string,
  ev: { id: string; topic: string; payload: Record<string, unknown> },
): Promise<number> {
  if (!(WEBHOOK_TOPICS as readonly string[]).includes(ev.topic)) return 0;
  const endpoints = await tx<{ id: string; url: string; projectId: string | null }[]>`
    select id, url, project_id from webhook_endpoints
    where enabled and topics ? ${ev.topic}`;
  if (!endpoints.length) return 0;
  const p = ev.payload;
  const recordId = typeof p.recordId === "string" ? p.recordId : null;
  const record = recordId ? await loadRecord(tx, systemActor(tenantId), recordId, { includeDeleted: true }) : null;
  const body: Record<string, unknown> = {
    event: ev.topic,
    eventId: ev.id,
    occurredAt: new Date().toISOString(),
    actorId: p.actorId ?? null,
    record: record ? publicRecord(record) : null,
  };
  if (ev.topic === "record.updated") body.fields = p.fields ?? [];
  if (ev.topic === "record.transitioned") Object.assign(body, { from: p.from ?? null, to: p.to ?? null, transition: p.transition ?? null });
  if (ev.topic === "comment.created" && typeof p.commentId === "string") {
    const [c] = await tx<{ id: string; authorId: string | null; body: string; internal: boolean; createdAt: Date }[]>`
      select id, author_id, body, internal, created_at from comments where id = ${p.commentId}`;
    // Internal notes are announced, never quoted: the receiver may not be staff-only.
    if (c) body.comment = { id: c.id, authorId: c.authorId, internal: c.internal, createdAt: c.createdAt, ...(c.internal ? {} : { body: c.body }) };
  }
  if (ev.topic === "attachment.created" && typeof p.attachmentId === "string") {
    const [a] = await tx<{ id: string; filename: string; contentType: string; sizeBytes: number; internal: boolean }[]>`
      select id, filename, content_type, size_bytes::int as size_bytes, internal from attachments where id = ${p.attachmentId}`;
    // Like internal notes: an internal file is announced, its name is not sent.
    if (a) body.attachment = a.internal ? { id: a.id, internal: true, sizeBytes: a.sizeBytes } : a;
  }
  if (ev.topic.startsWith("sla.")) Object.assign(body, { metric: p.metric, policyName: p.policyName, dueAt: p.dueAt });
  if (ev.topic.startsWith("approval.")) Object.assign(body, { approvalId: p.approvalId, approved: p.approved ?? null });
  let n = 0;
  for (const e of endpoints) {
    if (e.projectId && record?.projectId !== e.projectId) continue;
    await queue(tx, tenantId, e, ev.topic, body);
    n++;
  }
  return n;
}

export async function listDeliveries(tx: Tx, opts: { endpointId?: string; limit?: number } = {}) {
  const where = opts.endpointId && isUuid(opts.endpointId) ? tx`endpoint_id = ${opts.endpointId}` : tx`true`;
  return tx`
    select id, endpoint_id, rule_id, topic, url, status, attempts, last_status, last_error, created_at, delivered_at
    from webhook_deliveries where ${where} order by created_at desc limit ${Math.min(opts.limit ?? 100, 200)}`;
}

/** Send a past delivery again, as a new delivery with the same payload. */
export async function redeliver(tx: Tx, actor: Actor, id: string): Promise<string> {
  if (!isUuid(id)) throw notFound("Delivery");
  const [d] = await tx<{ endpointId: string | null; ruleId: string | null; url: string; topic: string | null; payload: Record<string, unknown> }[]>`
    select endpoint_id, rule_id, url, topic, payload from webhook_deliveries where id = ${id}`;
  if (!d) throw notFound("Delivery");
  // Endpoints re-read their current URL, so fixing a typo and redelivering works.
  let url = d.url;
  if (d.endpointId) {
    const [e] = await tx<{ url: string }[]>`select url from webhook_endpoints where id = ${d.endpointId}`;
    if (e) url = e.url;
  }
  const [row] = await tx<{ id: string }[]>`
    insert into webhook_deliveries (tenant_id, endpoint_id, rule_id, url, topic, payload)
    values (${actor.tenantId}, ${d.endpointId}, ${d.ruleId}, ${url}, ${d.topic}, ${tx.json(d.payload as never)})
    returning id`;
  await scheduleJob(tx, actor.tenantId, "webhook", row!.id, new Date());
  await audit(tx, actor, { entity: "webhook_delivery", entityId: row!.id, action: "redeliver", before: { from: id } });
  return row!.id;
}
