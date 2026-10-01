// Attachments: files on a record (optionally on one of its comments), stored in object storage
// under a random key. Downloads go through the API, which re-checks access every time.
import type { Sql, Tx } from "../db/client.ts";
import { withTenant } from "../db/client.ts";
import { emit, isStaff, type Actor } from "../audit.ts";
import { AppError, forbidden, invalid, notFound } from "../lib/errors.ts";
import { isUuid } from "../lib/crypto.ts";
import { loadRecord } from "../records/access.ts";
import { recordEvent } from "../records/service.ts";
import { getSettings } from "../settings/service.ts";
import { scheduleJob } from "../jobs/schedule.ts";
import type { BlobStore } from "./blobs.ts";

export interface Attachment {
  id: string;
  recordId: string;
  commentId: string | null;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  uploadedBy: string | null;
  uploadedByName: string | null;
  createdAt: Date;
  deletedAt: Date | null;
}

const COLUMNS = (tx: Tx) => tx`
  a.id, a.record_id, a.comment_id, a.filename, a.content_type, a.size_bytes::int as size_bytes, a.sha256,
  a.uploaded_by, u.display_name as uploaded_by_name, a.created_at, a.deleted_at`;

/** Types a browser may render inline; everything else downloads as a file. */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function cleanFilename(raw: string | undefined): string {
  let name = raw ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep raw */
  }
  name = name.replace(/[\u0000-\u001f\u007f/\\]+/g, "_").replace(/^\.+/, "").trim();
  return (name || "file").slice(0, 255);
}

export function cleanContentType(raw: string | undefined): string {
  const t = (raw ?? "").split(";")[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(t) ? t : "application/octet-stream";
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function checkTarget(tx: Tx, actor: Actor, recordIdOrKey: string, commentId: string | null) {
  const record = await loadRecord(tx, actor, recordIdOrKey);
  if (!record) throw notFound("Record");
  let internal = false;
  if (commentId) {
    if (!isUuid(commentId)) throw invalid([{ field: "commentId", message: "Must be an id" }]);
    const [c] = await tx<{ internal: boolean; authorId: string | null }[]>`
      select internal, author_id from comments where id = ${commentId} and record_id = ${record.id} and deleted_at is null`;
    if (!c || (c.internal && !isStaff(actor))) throw notFound("Comment");
    if (c.authorId !== actor.userId) throw forbidden("Attach files to your own comments");
    internal = c.internal;
  }
  return { record, internal };
}

/**
 * Store an upload. The size limit and access are checked first, the file is written to
 * storage outside any transaction, then the row is inserted (the file is removed again if
 * that fails).
 */
export async function uploadAttachment(
  sql: Sql,
  actor: Actor,
  blobs: BlobStore,
  recordIdOrKey: string,
  file: { filename?: string; contentType?: string; bytes: Uint8Array; commentId?: string | null },
  opts: { replicate?: boolean } = {},
): Promise<Attachment> {
  const settings = await getSettings(sql, actor.tenantId);
  const max = settings.attachmentMaxMb * 1024 * 1024;
  if (file.bytes.byteLength > max) throw new AppError("bad_request", `Files can be at most ${settings.attachmentMaxMb} MB`);
  if (file.bytes.byteLength === 0) throw new AppError("bad_request", "The file is empty");
  const commentId = file.commentId?.toLowerCase() ?? null;
  await withTenant(sql, actor.tenantId, (tx) => checkTarget(tx, actor, recordIdOrKey, commentId));

  const id = crypto.randomUUID();
  const storageKey = `t/${actor.tenantId}/a/${id}`;
  const contentType = cleanContentType(file.contentType);
  const digest = await sha256(file.bytes);
  await blobs.put(storageKey, file.bytes, contentType);
  try {
    return await withTenant(sql, actor.tenantId, async (tx) => {
      const { record, internal } = await checkTarget(tx, actor, recordIdOrKey, commentId);
      await tx`
        insert into attachments (id, tenant_id, record_id, comment_id, filename, content_type, size_bytes, sha256, storage_key, internal, uploaded_by)
        values (${id}, ${actor.tenantId}, ${record.id}, ${commentId}, ${cleanFilename(file.filename)}, ${contentType},
                ${file.bytes.byteLength}, ${digest}, ${storageKey}, ${internal}, ${actor.userId})`;
      await recordEvent(tx, actor, record.id, "attachment_added", { attachmentId: id, filename: cleanFilename(file.filename) });
      await emit(tx, actor.tenantId, "attachment.created", { recordId: record.id, attachmentId: id, actorId: actor.userId }, actor);
      if (opts.replicate) await scheduleJob(tx, actor.tenantId, "replicate", id, new Date());
      const { storageKey: _k, internal: _i, ...attachment } = (await getAttachment(tx, id))!;
      return attachment;
    });
  } catch (err) {
    await blobs.delete(storageKey).catch(() => {});
    throw err;
  }
}

async function getAttachment(tx: Tx, id: string): Promise<(Attachment & { storageKey: string; internal: boolean }) | null> {
  const [a] = await tx<(Attachment & { storageKey: string; internal: boolean })[]>`
    select ${COLUMNS(tx)}, a.storage_key, a.internal
    from attachments a left join users u on u.id = a.uploaded_by
    where a.id = ${id}`;
  return a ?? null;
}

/** An attachment the actor may see (record visible; not on an internal note for requesters). */
async function loadAttachment(tx: Tx, actor: Actor, id: string, opts: { includeDeleted?: boolean } = {}) {
  if (!isUuid(id)) throw notFound("Attachment");
  const a = await getAttachment(tx, id.toLowerCase());
  if (!a || (a.deletedAt && !opts.includeDeleted) || (a.internal && !isStaff(actor))) throw notFound("Attachment");
  if (!(await loadRecord(tx, actor, a.recordId, { includeDeleted: opts.includeDeleted }))) throw notFound("Attachment");
  return a;
}

export async function listAttachments(tx: Tx, actor: Actor, recordIdOrKey: string): Promise<Attachment[]> {
  const record = await loadRecord(tx, actor, recordIdOrKey);
  if (!record) throw notFound("Record");
  const rows = await tx<(Attachment & { internal: boolean })[]>`
    select ${COLUMNS(tx)}, a.internal
    from attachments a left join users u on u.id = a.uploaded_by
    where a.record_id = ${record.id} and a.deleted_at is null order by a.created_at`;
  return rows.filter((a) => isStaff(actor) || !a.internal).map(({ internal: _i, ...a }) => a);
}

/** Build the download response. Only plain images render inline; the rest is a download. */
export async function downloadAttachment(tx: Tx, actor: Actor, blobs: BlobStore, id: string, inline: boolean): Promise<Response> {
  const a = await loadAttachment(tx, actor, id);
  const blob = await blobs.get(a.storageKey);
  if (!blob) throw notFound("File");
  const canInline = inline && INLINE_TYPES.has(a.contentType);
  const encoded = encodeURIComponent(a.filename).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Response(blob.body as BodyInit, {
    headers: {
      "content-type": canInline ? a.contentType : "application/octet-stream",
      "content-length": String(blob.size),
      "content-disposition": `${canInline ? "inline" : "attachment"}; filename*=UTF-8''${encoded}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
    },
  });
}

export async function deleteAttachment(tx: Tx, actor: Actor, id: string): Promise<void> {
  const a = await loadAttachment(tx, actor, id);
  if (a.uploadedBy !== actor.userId && !isStaff(actor)) throw forbidden("You can only remove your own files");
  await tx`update attachments set deleted_at = now(), deleted_by = ${actor.userId} where id = ${a.id}`;
  await recordEvent(tx, actor, a.recordId, "attachment_removed", { attachmentId: a.id, filename: a.filename });
}

export async function restoreAttachment(tx: Tx, actor: Actor, id: string): Promise<Attachment> {
  if (actor.role !== "admin") throw forbidden("Only admins can restore from the trash");
  const a = await loadAttachment(tx, actor, id, { includeDeleted: true });
  if (!a.deletedAt) throw notFound("Deleted attachment");
  if (a.commentId) {
    const [c] = await tx`select 1 from comments where id = ${a.commentId} and deleted_at is not null`;
    if (c) throw new AppError("conflict", "Restore the comment this file belongs to instead");
  }
  await tx`update attachments set deleted_at = null, deleted_by = null where id = ${a.id}`;
  await recordEvent(tx, actor, a.recordId, "attachment_restored", { attachmentId: a.id, filename: a.filename });
  const { storageKey: _k, internal: _i, ...rest } = (await getAttachment(tx, a.id))!;
  return rest;
}

export async function listDeletedAttachments(tx: Tx, actor: Actor) {
  if (actor.role !== "admin") throw forbidden("Only admins can see the trash");
  return tx<(Attachment & { recordKey: string })[]>`
    select ${COLUMNS(tx)}, r.key as record_key from attachments a
    join records r on r.id = a.record_id left join users u on u.id = a.uploaded_by
    where a.deleted_at is not null order by a.deleted_at desc limit 200`;
}
