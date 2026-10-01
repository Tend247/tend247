// Comments (public or internal), @mentions and watchers. Requesters never see internal
// comments. A staff member's first public reply marks the record's first response, which
// stops the first-response SLA clock.
import { z } from "zod";
import type { Tx } from "../db/client.ts";
import { emit, isStaff, type Actor } from "../audit.ts";
import { forbidden, invalid, notFound } from "../lib/errors.ts";
import { parse, uuid } from "../lib/validate.ts";
import { syncSla } from "../sla/service.ts";
import { loadRecord, type RecordRow } from "../records/access.ts";
import { recordEvent } from "../records/service.ts";

export interface Comment {
  id: string;
  recordId: string;
  authorId: string | null;
  authorName: string | null;
  body: string;
  internal: boolean;
  mentions: string[];
  via: "app" | "email" | "automation";
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

const COLUMNS = (tx: Tx) => tx`
  c.id, c.record_id, c.author_id, u.display_name as author_name, c.body, c.internal, c.mentions, c.via,
  c.created_at, c.edited_at, c.deleted_at`;

const commentSchema = z
  .object({
    body: z.string().trim().min(1).max(50_000),
    internal: z.boolean().default(false),
    /** People mentioned with @; they are notified and start watching. */
    mentions: z.array(uuid).max(20).default([]),
  })
  .strict();

async function visibleRecord(tx: Tx, actor: Actor, idOrKey: string, lock = false): Promise<RecordRow> {
  const r = await loadRecord(tx, actor, idOrKey, { lock });
  if (!r) throw notFound("Record");
  return r;
}

export async function addWatcher(tx: Tx, tenantId: string, recordId: string, userId: string): Promise<void> {
  await tx`
    insert into record_watchers (tenant_id, record_id, user_id) values (${tenantId}, ${recordId}, ${userId})
    on conflict do nothing`;
}

export async function createComment(tx: Tx, actor: Actor, recordIdOrKey: string, input: unknown): Promise<Comment> {
  const data = parse(commentSchema, input);
  const record = await visibleRecord(tx, actor, recordIdOrKey, true);
  const staff = isStaff(actor);
  if (data.internal && !staff) throw forbidden("Requesters cannot add internal notes");
  const mentions = [...new Set(data.mentions)];
  if (mentions.length) {
    // Internal notes can mention staff only; a public comment can mention the requester too.
    const found = await tx<{ id: string; role: Actor["role"] }[]>`
      select id, role from users where active
        and id in (select (jsonb_array_elements_text(${tx.json(mentions)}))::uuid)
        and (role in ('admin', 'agent') or (${!data.internal} and id = ${record.requesterId}))`;
    const okSet = new Set<string>();
    for (const u of found) {
      // Someone who cannot see the record (a restricted project) cannot be pulled in by a mention.
      if (await loadRecord(tx, { tenantId: actor.tenantId, userId: u.id, role: u.role }, record.id)) okSet.add(u.id);
    }
    const bad = mentions.findIndex((m) => !okSet.has(m));
    if (bad >= 0) throw invalid([{ field: `mentions.${bad}`, message: "Cannot mention this person here" }]);
  }
  const [row] = await tx<{ id: string }[]>`
    insert into comments (tenant_id, record_id, author_id, body, internal, mentions, via)
    values (${actor.tenantId}, ${record.id}, ${actor.userId}, ${data.body}, ${data.internal},
            ${tx.json(mentions)}, ${actor.via === "email" ? "email" : actor.via === "automation" ? "automation" : "app"})
    returning id`;
  if (actor.userId && staff) await addWatcher(tx, actor.tenantId, record.id, actor.userId);
  for (const m of mentions) await addWatcher(tx, actor.tenantId, record.id, m);
  await recordEvent(tx, actor, record.id, "commented", { commentId: row!.id, internal: data.internal });
  await tx`update records set updated_at = clock_timestamp() where id = ${record.id}`;

  // First response: a public reply from staff other than the requester.
  if (staff && !data.internal && actor.userId && actor.userId !== record.requesterId && !record.firstRespondedAt) {
    await tx`update records set first_responded_at = now() where id = ${record.id}`;
    await syncSla(tx, { ...record, firstRespondedAt: new Date() });
  }
  await emit(
    tx,
    actor.tenantId,
    "comment.created",
    { recordId: record.id, key: record.key, commentId: row!.id, internal: data.internal, actorId: actor.userId, mentions },
    actor,
  );
  return (await getComment(tx, row!.id))!;
}

async function getComment(tx: Tx, id: string): Promise<Comment | null> {
  const [c] = await tx<Comment[]>`select ${COLUMNS(tx)} from comments c left join users u on u.id = c.author_id where c.id = ${id}`;
  return c ?? null;
}

export async function listComments(tx: Tx, actor: Actor, recordIdOrKey: string): Promise<Comment[]> {
  const record = await visibleRecord(tx, actor, recordIdOrKey);
  return tx<Comment[]>`
    select ${COLUMNS(tx)} from comments c left join users u on u.id = c.author_id
    where c.record_id = ${record.id} and c.deleted_at is null ${isStaff(actor) ? tx`` : tx`and not c.internal`}
    order by c.created_at, c.id`;
}

/** A comment the actor can see (on a record they can see, and not internal for requesters). */
async function loadComment(tx: Tx, actor: Actor, id: string, opts: { includeDeleted?: boolean } = {}): Promise<Comment> {
  const c = await getComment(tx, id);
  if (!c || (c.deletedAt && !opts.includeDeleted) || (c.internal && !isStaff(actor))) throw notFound("Comment");
  if (!(await loadRecord(tx, actor, c.recordId, { includeDeleted: opts.includeDeleted }))) throw notFound("Comment");
  return c;
}

export async function editComment(tx: Tx, actor: Actor, id: string, input: unknown): Promise<Comment> {
  const { body } = parse(z.object({ body: z.string().trim().min(1).max(50_000) }).strict(), input);
  const c = await loadComment(tx, actor, id);
  if (c.authorId !== actor.userId) throw forbidden("Only the author can edit a comment");
  await tx`update comments set body = ${body}, edited_at = now() where id = ${id}`;
  await recordEvent(tx, actor, c.recordId, "comment_edited", { commentId: id, internal: c.internal });
  return (await getComment(tx, id))!;
}

/** Move a comment to the trash (its author or an admin). */
export async function deleteComment(tx: Tx, actor: Actor, id: string): Promise<void> {
  const c = await loadComment(tx, actor, id);
  if (c.authorId !== actor.userId && actor.role !== "admin") throw forbidden("Only the author or an admin can delete a comment");
  await tx`update comments set deleted_at = now(), deleted_by = ${actor.userId} where id = ${id}`;
  await tx`update attachments set deleted_at = now(), deleted_by = ${actor.userId} where comment_id = ${id} and deleted_at is null`;
  await recordEvent(tx, actor, c.recordId, "comment_deleted", { commentId: id, internal: c.internal });
}

export async function restoreComment(tx: Tx, actor: Actor, id: string): Promise<Comment> {
  if (actor.role !== "admin") throw forbidden("Only admins can restore from the trash");
  const c = await loadComment(tx, actor, id, { includeDeleted: true });
  if (!c.deletedAt) throw notFound("Deleted comment");
  await tx`update comments set deleted_at = null, deleted_by = null where id = ${id}`;
  await tx`update attachments set deleted_at = null, deleted_by = null where comment_id = ${id} and deleted_at = ${c.deletedAt}`;
  await recordEvent(tx, actor, c.recordId, "comment_restored", { commentId: id, internal: c.internal });
  return (await getComment(tx, id))!;
}

export async function listDeletedComments(tx: Tx, actor: Actor) {
  if (actor.role !== "admin") throw forbidden("Only admins can see the trash");
  return tx<(Comment & { recordKey: string })[]>`
    select ${COLUMNS(tx)}, r.key as record_key from comments c
    join records r on r.id = c.record_id left join users u on u.id = c.author_id
    where c.deleted_at is not null order by c.deleted_at desc limit 200`;
}

// ---------------------------------------------------------------- watchers

export async function listWatchers(tx: Tx, actor: Actor, recordIdOrKey: string) {
  const record = await visibleRecord(tx, actor, recordIdOrKey);
  const rows = await tx<{ id: string; displayName: string }[]>`
    select u.id, u.display_name from record_watchers w join users u on u.id = w.user_id
    where w.record_id = ${record.id} order by u.display_name`;
  // Requesters learn only whether they themselves watch.
  return isStaff(actor) ? rows : rows.filter((w) => w.id === actor.userId);
}

export async function setWatching(tx: Tx, actor: Actor, recordIdOrKey: string, input: unknown): Promise<void> {
  const { watching, userId } = parse(z.object({ watching: z.boolean(), userId: uuid.optional() }).strict(), input);
  const record = await visibleRecord(tx, actor, recordIdOrKey);
  const target = userId ?? actor.userId;
  if (!target) throw forbidden();
  if (target !== actor.userId) {
    if (!isStaff(actor)) throw forbidden("You can only change your own watching");
    const [u] = await tx<{ role: Actor["role"] }[]>`select role from users where id = ${target} and active and role in ('admin', 'agent')`;
    if (!u) throw invalid([{ field: "userId", message: "Only staff can be added as watchers" }]);
    if (watching && !(await loadRecord(tx, { tenantId: actor.tenantId, userId: target, role: u.role }, record.id))) {
      throw invalid([{ field: "userId", message: "This person cannot see the record" }]);
    }
  }
  if (watching) await addWatcher(tx, actor.tenantId, record.id, target);
  else await tx`delete from record_watchers where record_id = ${record.id} and user_id = ${target}`;
}
