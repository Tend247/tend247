// Background work. Three entry points:
//  - processTenantOutbox: handle a workspace's queued events (notifications, automation),
//    then send pending emails and delete purged files. Runs right after each change.
//  - runDueJobs: fire due timers (SLA, webhook retries, replication, nightly export, purge).
//  - sweep: the every-minute cron that drives both for every workspace.
import type { Context } from "hono";
import type { Sql, Tx } from "../db/client.ts";
import { withTenant } from "../db/client.ts";
import type { AppConfig } from "../config.ts";
import type { AppDeps } from "../http.ts";
import type { EmailSender, OutboundEmail } from "../email/sender.ts";
import type { BlobStore } from "../attachments/blobs.ts";
import { notify, type NewNotification } from "../notifications/service.ts";
import { runAutomation } from "../automation/service.ts";
import { createApprovalTokens } from "../approvals/service.ts";
import { runSlaTimer, rearmAll } from "../sla/service.ts";
import { queueBlobDeletions } from "../records/service.ts";
import { getSettings } from "../settings/service.ts";
import { nextLocalTime } from "../sla/calendar.ts";
import { ensureJob, scheduleJob } from "./schedule.ts";
import { deliverWebhook } from "./webhooks.ts";
import { runExportStep } from "../backup/export.ts";
import { threadAddress } from "../email/threads.ts";

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface WorkerDeps {
  sql: Sql;
  config: AppConfig;
  email: EmailSender;
  blobs?: BlobStore;
  replica?: BlobStore;
  backups?: BlobStore;
  fetch: FetchFn;
  now: () => Date;
  /** Origin for links in emails. */
  origin: string;
}

export function workerDeps(deps: AppDeps, sql: Sql, c?: Context): WorkerDeps {
  let origin = deps.config.publicUrl ?? "http://localhost";
  if (!deps.config.publicUrl && c) {
    try {
      origin = new URL(c.req.url).origin;
    } catch {
      /* keep default */
    }
  }
  return {
    sql,
    config: deps.config,
    email: deps.email,
    blobs: deps.blobs,
    replica: deps.replica,
    backups: deps.backups,
    fetch: deps.webhookFetch ?? ((input, init) => fetch(input, init)),
    now: deps.now ?? (() => new Date()),
    origin,
  };
}

interface OutboxEvent {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------- outbox

export async function processTenantOutbox(w: WorkerDeps, tenantId: string, opts: { maxBatches?: number } = {}): Promise<number> {
  // Clear the signal first: anything committed after this re-creates it.
  await w.sql`delete from work_signals where tenant_id = ${tenantId}`;
  let handled = 0;
  for (let batch = 0; batch < (opts.maxBatches ?? 5); batch++) {
    const events = await withTenant(w.sql, tenantId, (tx) => tx<OutboxEvent[]>`
      update outbox set claimed_at = now(), attempts = attempts + 1
      where id in (
        select id from outbox
        where delivered_at is null and attempts < 10
          and (claimed_at is null or claimed_at < now() - interval '2 minutes')
        order by id limit 25 for update skip locked)
      returning id::text as id, topic, payload`);
    if (!events.length) break;
    for (const ev of events.sort((a, b) => Number(a.id) - Number(b.id))) {
      try {
        await withTenant(w.sql, tenantId, async (tx) => {
          const [row] = await tx<{ deliveredAt: Date | null }[]>`select delivered_at from outbox where id = ${ev.id} for update`;
          if (!row || row.deliveredAt) return;
          await handleEvent(tx, w, tenantId, ev);
          await tx`update outbox set delivered_at = now(), last_error = null where id = ${ev.id}`;
        });
        handled++;
      } catch (err) {
        console.error(`event ${ev.id} (${ev.topic}) failed:`, (err as Error).message);
        await withTenant(w.sql, tenantId, (tx) =>
          tx`update outbox set claimed_at = null, last_error = ${(err as Error).message.slice(0, 500)} where id = ${ev.id}`,
        );
      }
    }
  }
  await sendPendingEmails(w, tenantId);
  await processBlobDeletions(w, tenantId);
  return handled;
}

interface RecordInfo {
  id: string;
  key: string;
  title: string;
  status: string;
  requesterId: string | null;
  assigneeId: string | null;
  teamId: string | null;
  deletedAt: Date | null;
}

async function recordInfo(tx: Tx, id: unknown): Promise<RecordInfo | null> {
  if (typeof id !== "string") return null;
  const [r] = await tx<RecordInfo[]>`
    select id, key, title, status, requester_id, assignee_id, team_id, deleted_at from records where id = ${id}`;
  return r && !r.deletedAt ? r : null;
}

async function watchers(tx: Tx, recordId: string): Promise<{ userId: string; role: string }[]> {
  return tx<{ userId: string; role: string }[]>`
    select w.user_id, u.role from record_watchers w join users u on u.id = w.user_id where w.record_id = ${recordId}`;
}

async function statusName(tx: Tx, recordId: string, status: string): Promise<string> {
  const [row] = await tx<{ name: string | null }[]>`
    select (select s ->> 'name' from jsonb_array_elements(v.definition -> 'statuses') s where s ->> 'key' = ${status}) as name
    from records r join config_versions v on v.owner_id = r.record_type_id and v.kind = 'workflow' and v.state = 'published'
    where r.id = ${recordId}`;
  return row?.name ?? status;
}

/** Turn one event into notifications (and their emails), then run automation rules. */
async function handleEvent(tx: Tx, w: WorkerDeps, tenantId: string, ev: OutboxEvent): Promise<void> {
  const p = ev.payload;
  const actorId = (p.actorId as string | null | undefined) ?? null;
  const items: (NewNotification & { email?: Partial<OutboundEmail> & { threaded?: boolean } })[] = [];
  const r = await recordInfo(tx, p.recordId);
  const subject = r ? `[${r.key}] ${r.title}` : "";

  switch (ev.topic) {
    case "record.created": {
      if (!r) break;
      if (r.assigneeId && r.assigneeId !== actorId) {
        items.push({ userId: r.assigneeId, kind: "assigned", recordId: r.id, title: `${r.key} was assigned to you` });
      }
      if (r.requesterId && r.requesterId === actorId) {
        items.push({
          userId: r.requesterId,
          kind: "received",
          recordId: r.id,
          title: `We received your request ${r.key}`,
          email: { threaded: true, text: `We received your request "${r.title}" (${r.key}). We'll keep you posted here.` },
        });
      }
      break;
    }
    case "record.updated": {
      const to = p.assignedTo as string | null | undefined;
      if (r && to && to !== actorId) items.push({ userId: to, kind: "assigned", recordId: r.id, title: `${r.key} was assigned to you` });
      break;
    }
    case "record.transitioned": {
      if (!r) break;
      const name = await statusName(tx, r.id, String(p.to));
      const title = `${r.key} is now ${name}`;
      const people = new Set<string>();
      if (r.requesterId) people.add(r.requesterId);
      for (const wtc of await watchers(tx, r.id)) people.add(wtc.userId);
      people.delete(actorId ?? "");
      for (const userId of people) {
        items.push({ userId, kind: "status", recordId: r.id, title, email: { threaded: userId === r.requesterId } });
      }
      break;
    }
    case "comment.created": {
      if (!r) break;
      const [c] = await tx<{ body: string; internal: boolean; authorName: string | null }[]>`
        select c.body, c.internal, u.display_name as author_name from comments c left join users u on u.id = c.author_id
        where c.id = ${p.commentId as string} and c.deleted_at is null`;
      if (!c) break;
      const who = c.authorName ?? "Automation";
      const mentioned = new Set((p.mentions as string[] | undefined) ?? []);
      for (const m of mentioned) {
        if (m === actorId) continue;
        items.push({ userId: m, kind: "mention", recordId: r.id, title: `${who} mentioned you on ${r.key}`, body: c.body, email: { threaded: m === r.requesterId && !c.internal } });
      }
      const people = new Map<string, boolean>();
      if (!c.internal && r.requesterId) people.set(r.requesterId, true);
      for (const wtc of await watchers(tx, r.id)) {
        if (!c.internal || wtc.role !== "requester") people.set(wtc.userId, wtc.userId === r.requesterId);
      }
      for (const [userId, isRequester] of people) {
        if (userId === actorId || mentioned.has(userId)) continue;
        items.push({
          userId,
          kind: "comment",
          recordId: r.id,
          title: `${who} ${c.internal ? "added an internal note on" : "commented on"} ${r.key}`,
          body: c.body,
          email: { threaded: isRequester },
        });
      }
      break;
    }
    case "approval.requested": {
      if (!r) break;
      const approverIds = (p.approverIds as string[]) ?? [];
      const tokens = await createApprovalTokens(tx, tenantId, p.approvalId as string, Number(p.step ?? 0), approverIds);
      const [a] = await tx<{ transitionName: string; requestedByName: string | null }[]>`
        select a.transition_name, u.display_name as requested_by_name from approvals a
        left join users u on u.id = a.requested_by where a.id = ${p.approvalId as string}`;
      for (const t of tokens) {
        items.push({
          userId: t.userId,
          kind: "approval",
          recordId: r.id,
          title: `${a?.requestedByName ?? "Someone"} asks you to approve "${a?.transitionName}" on ${r.key}`,
          email: {
            text:
              `${a?.requestedByName ?? "Someone"} asks you to approve "${a?.transitionName}" on ${r.key}: ${r.title}.\n\n` +
              `Approve or reject (link works once, for 7 days):\n${w.origin}/auth/approval#${t.token}`,
          },
        });
      }
      break;
    }
    case "approval.decided": {
      const requestedBy = p.requestedBy as string | null;
      if (r && requestedBy && requestedBy !== actorId) {
        items.push({
          userId: requestedBy,
          kind: "approval_result",
          recordId: r.id,
          title: `Your approval request on ${r.key} was ${p.approved ? "approved" : "rejected"}`,
        });
      }
      break;
    }
    case "sla.warning":
    case "sla.breached": {
      if (!r) break;
      const metric = p.metric === "first_response" ? "first response" : "resolution";
      const title =
        ev.topic === "sla.warning"
          ? `${r.key} ${metric} is due ${p.dueAt ? `at ${new Date(p.dueAt as string).toISOString().slice(0, 16).replace("T", " ")} UTC` : "soon"}`
          : `${r.key} breached its ${metric} target`;
      let people: string[] = r.assigneeId ? [r.assigneeId] : [];
      if (!people.length && r.teamId) {
        people = (await tx<{ userId: string }[]>`select user_id from team_members where team_id = ${r.teamId}`).map((m) => m.userId);
      }
      for (const userId of people) items.push({ userId, kind: "sla", recordId: r.id, title });
      break;
    }
  }

  const created = await notify(tx, tenantId, ev.id, items);
  if (created.length) await composeEmails(tx, w, tenantId, created, items, subject);
  const auto = await runAutomation(tx, tenantId, ev);
  if (auto.notifications.length) await composeEmails(tx, w, tenantId, auto.notifications, [], subject);
}

/** Store the email for each new notification that wants one; sendPendingEmails sends it. */
async function composeEmails(
  tx: Tx,
  w: WorkerDeps,
  tenantId: string,
  created: { id: string; userId: string; kind: string; recordId: string | null; title: string; body?: string }[],
  specs: (NewNotification & { email?: Partial<OutboundEmail> & { threaded?: boolean } })[],
  subject: string,
): Promise<void> {
  for (const n of created) {
    const spec = specs.find((s) => s.userId === n.userId && s.kind === n.kind)?.email ?? {};
    const [rec] = n.recordId ? await tx<{ key: string; title: string }[]>`select key, title from records where id = ${n.recordId}` : [];
    const link = rec ? `${w.origin}/app/records/${rec.key}` : `${w.origin}/app`;
    let replyTo: string | undefined;
    let headers: Record<string, string> | undefined;
    if (spec.threaded && n.recordId && w.config.email.inboundDomain) {
      replyTo = await threadAddress(tx, tenantId, n.recordId, w.config.email.inboundDomain);
      const [last] = await tx<{ messageId: string }[]>`
        select message_id from email_messages where record_id = ${n.recordId} and direction = 'in' order by created_at desc limit 1`;
      if (last) headers = { "In-Reply-To": last.messageId, References: last.messageId };
    }
    const text =
      (spec.text ?? [n.title, n.body ? `\n${n.body}` : ""].join("\n")) +
      `\n\nOpen ${rec ? rec.key : "Tend 24/7"}: ${link}` +
      (replyTo ? "\n\nReply to this email to add a comment." : "") +
      "\n\n— Tend 24/7";
    const email = { subject: subject || n.title, text, ...(replyTo ? { replyTo } : {}), ...(headers ? { headers } : {}) };
    await tx`update notifications set email_payload = ${tx.json(email as never)} where id = ${n.id}`;
  }
}

const MAX_EMAIL_ATTEMPTS = 5;
const clean = (v: string) => v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();

/**
 * Send composed emails. A failure backs off (2, 4, 8, 16 minutes) and gives up after five
 * attempts, so one undeliverable address never holds up everyone else's mail.
 */
export async function sendPendingEmails(w: WorkerDeps, tenantId: string): Promise<number> {
  if (!w.email.canDeliver) return 0;
  return withTenant(w.sql, tenantId, async (tx) => {
    const rows = await tx<{ id: string; to: string; attempts: number; payload: Omit<OutboundEmail, "to"> }[]>`
      select n.id, u.email as to, n.email_attempts as attempts, n.email_payload as payload
      from notifications n join users u on u.id = n.user_id
      where n.email_payload is not null and n.emailed_at is null and u.active
        and (n.email_next_at is null or n.email_next_at <= now())
        and n.created_at > now() - interval '2 days'
      order by n.created_at limit 50
      for update of n skip locked`;
    let sent = 0;
    for (const row of rows) {
      const p = row.payload;
      const headers = p.headers ? Object.fromEntries(Object.entries(p.headers).map(([k, v]) => [clean(k), clean(v)])) : undefined;
      try {
        await w.email.send({ ...p, to: row.to, subject: clean(p.subject), ...(p.replyTo ? { replyTo: clean(p.replyTo) } : {}), ...(headers ? { headers } : {}) });
        await tx`update notifications set emailed_at = now(), email_payload = null where id = ${row.id}`;
        sent++;
      } catch (err) {
        const attempts = row.attempts + 1;
        console.error(`email send failed (attempt ${attempts}):`, (err as Error).message);
        if (attempts >= MAX_EMAIL_ATTEMPTS) {
          await tx`update notifications set email_attempts = ${attempts}, email_payload = null where id = ${row.id}`;
        } else {
          await tx`
            update notifications set email_attempts = ${attempts}, email_next_at = now() + make_interval(mins => ${2 ** attempts})
            where id = ${row.id}`;
        }
      }
    }
    return sent;
  });
}

/** Delete files queued by purges; replicas wait for their retention period. */
export async function processBlobDeletions(w: WorkerDeps, tenantId: string): Promise<void> {
  const due = await withTenant(w.sql, tenantId, (tx) => tx<{ id: string; storageKey: string; replicaOnly: boolean }[]>`
    select id::text as id, storage_key, replica_only from blob_deletions where delete_after <= now() order by id limit 100`);
  for (const d of due) {
    const store = d.replicaOnly ? w.replica : w.blobs;
    try {
      if (store) await store.delete(d.storageKey);
      await withTenant(w.sql, tenantId, (tx) => tx`delete from blob_deletions where id = ${d.id}::bigint`);
    } catch (err) {
      console.error("blob delete failed:", (err as Error).message);
    }
  }
}

// ---------------------------------------------------------------- timers

interface JobRow {
  id: string;
  tenantId: string;
  kind: string;
  refId: string;
  attempts: number;
  claimedAt: Date;
}

const RETRY_MINUTES = [1, 5, 15, 60, 240];

export async function runDueJobs(w: WorkerDeps, opts: { limit?: number } = {}): Promise<number> {
  const now = w.now();
  const jobs = await w.sql<JobRow[]>`
    update scheduled_jobs set claimed_at = ${now}, attempts = attempts + 1
    where id in (
      select id from scheduled_jobs
      where run_at <= ${now} and (claimed_at is null or claimed_at < ${new Date(now.getTime() - 10 * 60_000)})
      order by run_at limit ${opts.limit ?? 50} for update skip locked)
    returning id::text as id, tenant_id, kind, ref_id, attempts, claimed_at`;
  const touched = new Set<string>();
  for (const job of jobs) {
    try {
      await runJob(w, job, now);
      // Done unless the handler re-armed it (re-arming clears claimed_at).
      await w.sql`delete from scheduled_jobs where id = ${job.id}::bigint and claimed_at = ${job.claimedAt}`;
    } catch (err) {
      const msg = (err as Error).message.slice(0, 500);
      console.error(`job ${job.kind}/${job.refId} failed:`, msg);
      if (job.attempts >= 10) {
        await w.sql`delete from scheduled_jobs where id = ${job.id}::bigint`;
      } else {
        const delay = RETRY_MINUTES[Math.min(job.attempts - 1, RETRY_MINUTES.length - 1)]! * 60_000;
        await w.sql`
          update scheduled_jobs set claimed_at = null, last_error = ${msg}, run_at = ${new Date(now.getTime() + delay)}
          where id = ${job.id}::bigint`;
      }
    }
    touched.add(job.tenantId);
  }
  // Timers raise events (SLA warnings); handle them now rather than on the next sweep.
  for (const tenantId of touched) await processTenantOutbox(w, tenantId);
  return jobs.length;
}

async function runJob(w: WorkerDeps, job: JobRow, now: Date): Promise<void> {
  switch (job.kind) {
    case "sla":
      await withTenant(w.sql, job.tenantId, (tx) => runSlaTimer(tx, job.tenantId, job.refId, now));
      return;
    case "webhook":
      await deliverWebhook(w, job.tenantId, job.refId);
      return;
    case "replicate":
      await replicateAttachment(w, job.tenantId, job.refId);
      return;
    case "export": {
      const more = await runExportStep(w, job.tenantId);
      const settings = await getSettings(w.sql, job.tenantId);
      await scheduleJob(w.sql, job.tenantId, "export", job.tenantId, more ? now : nextLocalTime(now, settings.timezone, 2, 0));
      return;
    }
    case "purge_trash": {
      await purgeTrash(w, job.tenantId, now);
      const settings = await getSettings(w.sql, job.tenantId);
      await scheduleJob(w.sql, job.tenantId, "purge_trash", job.tenantId, nextLocalTime(now, settings.timezone, 3, 0));
      return;
    }
    default:
      console.error("unknown job kind", job.kind);
  }
}

async function replicateAttachment(w: WorkerDeps, tenantId: string, attachmentId: string): Promise<void> {
  if (!w.replica || !w.blobs) return;
  const [a] = await withTenant(w.sql, tenantId, (tx) => tx<{ storageKey: string; contentType: string; replicatedAt: Date | null }[]>`
    select storage_key, content_type, replicated_at from attachments where id = ${attachmentId}`);
  if (!a || a.replicatedAt) return;
  const blob = await w.blobs.get(a.storageKey);
  if (!blob) return;
  const bytes = blob.body instanceof Uint8Array ? blob.body : new Uint8Array(await new Response(blob.body).arrayBuffer());
  await w.replica.put(a.storageKey, bytes, a.contentType);
  await withTenant(w.sql, tenantId, (tx) => tx`update attachments set replicated_at = now() where id = ${attachmentId}`);
}

/** Empty the trash of anything deleted longer ago than the retention period. */
export async function purgeTrash(w: WorkerDeps, tenantId: string, now = w.now()): Promise<{ records: number; comments: number; attachments: number }> {
  const settings = await getSettings(w.sql, tenantId);
  const cutoff = new Date(now.getTime() - settings.trashRetentionDays * 86_400_000);
  const result = await withTenant(w.sql, tenantId, async (tx) => {
    const records = await tx<{ id: string }[]>`select id from records where deleted_at < ${cutoff} limit 500`;
    const ids = tx.json(records.map((r) => r.id));
    await queueBlobDeletions(tx, tenantId, tx`record_id in (select (jsonb_array_elements_text(${ids}))::uuid)`, settings.trashRetentionDays);
    if (records.length) await tx`delete from records where id in (select (jsonb_array_elements_text(${ids}))::uuid)`;
    const comments = await tx`delete from comments where deleted_at < ${cutoff}`;
    await queueBlobDeletions(tx, tenantId, tx`deleted_at < ${cutoff}`, settings.trashRetentionDays);
    const attachments = await tx`delete from attachments where deleted_at < ${cutoff}`;
    return { records: records.length, comments: comments.count, attachments: attachments.count };
  });
  await processBlobDeletions(w, tenantId);
  return result;
}

// ---------------------------------------------------------------- cron

/** Every minute: drain signaled workspaces, fire due timers; every 10 minutes, the backstop. */
export async function sweep(w: WorkerDeps): Promise<void> {
  const now = w.now();
  const signaled = await w.sql<{ tenantId: string }[]>`select tenant_id from work_signals order by signaled_at limit 50`;
  for (const s of signaled) await processTenantOutbox(w, s.tenantId);
  await runDueJobs(w);
  if (now.getUTCMinutes() % 10 === 0) {
    const tenants = await w.sql<{ id: string; demo: boolean }[]>`
      select id, demo from tenants where expires_at is null or expires_at > now()`;
    for (const t of tenants) {
      await processTenantOutbox(w, t.id, { maxBatches: 2 });
      const settings = await getSettings(w.sql, t.id);
      await ensureJob(w.sql, t.id, "purge_trash", t.id, nextLocalTime(now, settings.timezone, 3, 0));
      if (w.backups && !t.demo) await ensureJob(w.sql, t.id, "export", t.id, nextLocalTime(now, settings.timezone, 2, 0));
    }
  }
}

/**
 * After restoring the database: re-arm SLA timers from stored due times, re-queue undelivered
 * events and make sure the nightly jobs exist.
 */
export async function rebuildAfterRestore(w: WorkerDeps): Promise<{ tenants: number; clocks: number; events: number }> {
  const tenants = await w.sql<{ id: string }[]>`select id from tenants`;
  let clocks = 0;
  let events = 0;
  for (const t of tenants) {
    await withTenant(w.sql, t.id, async (tx) => {
      clocks += await rearmAll(tx, t.id);
      const r = await tx`update outbox set claimed_at = null, attempts = 0 where delivered_at is null`;
      events += r.count;
      if (r.count) await tx`insert into work_signals (tenant_id) values (${t.id}) on conflict do nothing`;
    });
    const settings = await getSettings(w.sql, t.id);
    await ensureJob(w.sql, t.id, "purge_trash", t.id, nextLocalTime(w.now(), settings.timezone, 3, 0));
    if (w.backups) await ensureJob(w.sql, t.id, "export", t.id, nextLocalTime(w.now(), settings.timezone, 2, 0));
  }
  return { tenants: tenants.length, clocks, events };
}
