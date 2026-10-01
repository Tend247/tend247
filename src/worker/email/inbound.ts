// Inbound email (Cloudflare Email Routing → the Worker's email() handler).
//  - reply+<code>@<inbound domain>: a reply; it becomes a comment on that record.
//  - <alias>@<inbound domain>: a project's queue address; it creates a record.
// Mail must pass the receiving server's sender checks (DMARC, or SPF/DKIM aligned with the
// From domain). Auto-replies and duplicates are dropped; unknown senders are refused.
import PostalMime from "postal-mime";
import type { Tx } from "../db/client.ts";
import { withTenant } from "../db/client.ts";
import type { Actor } from "../audit.ts";
import { AppError } from "../lib/errors.ts";
import { findUserByEmail, insertUser } from "../users/service.ts";
import { createRecord } from "../records/service.ts";
import { createComment } from "../comments/service.ts";
import { loadRecord } from "../records/access.ts";
import { cleanContentType, cleanFilename } from "../attachments/service.ts";
import { getSettings } from "../settings/service.ts";
import { scheduleJob } from "../jobs/schedule.ts";
import { processTenantOutbox, type WorkerDeps } from "../jobs/runner.ts";

export type InboundOutcome =
  | "comment_added"
  | "record_created"
  | "duplicate"
  | "auto_reply"
  | "unauthenticated"
  | "unknown_address"
  | "unknown_sender"
  | "not_allowed";

export interface InboundMessage {
  /** Envelope recipient. */
  to: string;
  /** Envelope sender (MAIL FROM), when the platform provides it. */
  from?: string;
  raw: ReadableStream<Uint8Array> | Uint8Array | string;
}

const MAX_ATTACHMENTS = 10;

function headerValues(headers: { key: string; value: string }[], name: string): string[] {
  return headers.filter((h) => h.key === name).map((h) => h.value);
}

/** Remove RFC 5322 comments "(...)", which a sender can influence, from a header value. */
function stripComments(value: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "\\") {
      // Escaped character: never structural, inside or outside quotes and comments.
      if (depth === 0) out += value.slice(i, i + 2);
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
      if (depth === 0) out += ch;
    } else if (!quoted && ch === "(") depth++;
    else if (!quoted && ch === ")" && depth > 0) depth--;
    else if (depth === 0) out += ch;
  }
  return out;
}

/** Split on a separator outside double quotes (backslash escapes respected). */
function splitOutsideQuotes(value: string, sep: RegExp): string[] {
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "\\") {
      cur += value.slice(i, i + 2);
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (!quoted && sep.test(ch)) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((x) => x.trim()).filter(Boolean);
}

export interface AuthResult {
  method: string;
  result: string;
  props: Record<string, string>;
}

/** Parse an Authentication-Results value (RFC 8601): authserv-id, then method=result clauses. */
export function parseAuthResults(value: string): { authservId: string; results: AuthResult[] } {
  const clauses = splitOutsideQuotes(stripComments(value), /;/);
  const authservId = (clauses.shift() ?? "").split(/\s+/)[0]!.toLowerCase();
  const results: AuthResult[] = [];
  for (const clause of clauses) {
    const tokens = splitOutsideQuotes(clause, /\s/);
    const head = /^([a-z0-9_-]+)(?:\/[0-9]+)?=([a-z0-9_-]+)$/i.exec(tokens.shift() ?? "");
    if (!head) continue;
    const props: Record<string, string> = {};
    for (const t of tokens) {
      const m = /^([a-z0-9_-]+\.[a-z0-9_.-]+)=(.*)$/i.exec(t);
      if (m) props[m[1]!.toLowerCase()] = m[2]!.replace(/^"(.*)"$/, "$1").toLowerCase();
    }
    results.push({ method: head[1]!.toLowerCase(), result: head[2]!.toLowerCase(), props });
  }
  return { authservId, results };
}

/** Relaxed alignment: one domain equals or is a subdomain of the other (never a bare TLD). */
function aligned(domain: string | undefined, fromDomain: string): boolean {
  if (!domain) return false;
  const d = domain.replace(/\.$/, "");
  const shorter = d.length < fromDomain.length ? d : fromDomain;
  if (!shorter.includes(".")) return d === fromDomain;
  return d === fromDomain || d.endsWith(`.${fromDomain}`) || fromDomain.endsWith(`.${d}`);
}

const domainAfterLastAt = (v: string | undefined) => (v ? v.slice(v.lastIndexOf("@") + 1) : undefined);

/**
 * Trust only the topmost Authentication-Results header, and only if our receiving server
 * wrote it (its authserv-id). Pass on DMARC for the From domain, or on DKIM or SPF aligned
 * with it. Comments and quoted strings, which the sender controls, are never matched.
 */
export function senderAuthenticated(headers: { key: string; value: string }[], authservId: string, fromDomain: string): boolean {
  const top = headerValues(headers, "authentication-results")[0];
  if (!top) return false;
  const parsed = parseAuthResults(top);
  if (parsed.authservId !== authservId.toLowerCase()) return false;
  // A method reported twice means something was injected into the header: trust none of it.
  const methods = parsed.results.map((r) => r.method);
  if (new Set(methods).size !== methods.length) return false;
  const from = fromDomain.toLowerCase();
  return parsed.results.some((r) => {
    if (r.result !== "pass") return false;
    if (r.method === "dmarc") return r.props["header.from"] === from;
    if (r.method === "dkim") return aligned(r.props["header.d"] ?? domainAfterLastAt(r.props["header.i"]), from);
    if (r.method === "spf") return aligned(domainAfterLastAt(r.props["smtp.mailfrom"]), from);
    return false;
  });
}

function isAutoReply(headers: { key: string; value: string }[]): boolean {
  const auto = headerValues(headers, "auto-submitted")[0]?.toLowerCase();
  if (auto && auto !== "no") return true;
  const precedence = headerValues(headers, "precedence")[0]?.toLowerCase();
  if (precedence && ["bulk", "junk", "list", "auto_reply"].includes(precedence)) return true;
  return headers.some((h) => h.key === "x-autoreply" || h.key === "x-autorespond");
}

/** The new part of a reply: everything above the quoted history. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .{4,200}wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim()) || /^From: .+/.test(line.trim()) && out.length > 0) break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function toBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

export async function handleInboundEmail(w: WorkerDeps, msg: InboundMessage): Promise<{ outcome: InboundOutcome; key?: string }> {
  const parsed = await PostalMime.parse(msg.raw as never);
  const from = (parsed.from && "address" in parsed.from ? parsed.from.address : undefined)?.toLowerCase();
  const fromName = parsed.from && "name" in parsed.from ? parsed.from.name : "";
  const [local = "", domain = ""] = msg.to.toLowerCase().split("@");
  const inbound = w.config.email.inboundDomain;
  if (!inbound || domain !== inbound || !from) return { outcome: "unknown_address" };
  if (isAutoReply(parsed.headers)) return { outcome: "auto_reply" };
  // Plain envelope senders only: quoted or odd ones could be echoed into the server's
  // Authentication-Results header to fake a result.
  if (msg.from !== undefined && !/^[^\s"\\();<>,]+@[a-z0-9.-]+$/i.test(msg.from) && msg.from !== "") return { outcome: "unauthenticated" };
  const fromDomain = from.split("@")[1] ?? "";
  if (!senderAuthenticated(parsed.headers, w.config.email.inboundAuthservId, fromDomain)) return { outcome: "unauthenticated" };
  // Our own notifications bouncing back would loop.
  if (w.config.email.from && w.config.email.from.toLowerCase().includes(`<${from}>`)) return { outcome: "auto_reply" };

  const messageId = (parsed.messageId ?? "").trim().slice(0, 500) || `<no-id-${crypto.randomUUID()}@tend247>`;
  const subject = (parsed.subject ?? "").trim().slice(0, 500);
  const text = (parsed.text ?? (parsed.html ? parsed.html.replace(/<[^>]+>/g, " ") : "")).slice(0, 50_000);

  let tenantId: string;
  let target: { kind: "reply"; recordId: string } | { kind: "new"; projectId: string; recordTypeId: string };
  const reply = /^reply\+([a-z2-7]{16})$/.exec(local);
  if (reply) {
    const [t] = await w.sql<{ tenantId: string; recordId: string }[]>`select tenant_id, record_id from email_threads where code = ${reply[1]!}`;
    if (!t) return { outcome: "unknown_address" };
    tenantId = t.tenantId;
    target = { kind: "reply", recordId: t.recordId };
  } else {
    const [a] = await w.sql<{ tenantId: string; projectId: string; recordTypeId: string }[]>`
      select tenant_id, project_id, record_type_id from inbound_addresses where address = ${local}`;
    if (!a) return { outcome: "unknown_address" };
    tenantId = a.tenantId;
    target = { kind: "new", projectId: a.projectId, recordTypeId: a.recordTypeId };
  }

  const settings = await getSettings(w.sql, tenantId);
  const result = await withTenant(w.sql, tenantId, async (tx): Promise<{ outcome: InboundOutcome; key?: string; recordId?: string; commentId?: string; actor?: Actor }> => {
    const dup = await tx`select 1 from email_messages where direction = 'in' and message_id = ${messageId}`;
    if (dup.length) return { outcome: "duplicate" };
    let user = await findUserByEmail(tx, from);
    if (user && !user.active) return { outcome: "unknown_sender" };
    if (!user) {
      // New people can write in only from the configured requester domains, and only to a queue.
      if (target.kind !== "new" || !w.config.requesterDomains.includes(fromDomain)) return { outcome: "unknown_sender" };
      const created = await insertUser(tx, tenantId, { email: from, displayName: (fromName || from.split("@")[0]!).slice(0, 200), role: "requester" });
      user = { ...created, oidcSubject: null };
    }
    const actor: Actor = { tenantId, userId: user.id, role: user.role, via: "email" };
    try {
      if (target.kind === "reply") {
        const record = await loadRecord(tx, actor, target.recordId);
        if (!record) return { outcome: "not_allowed" };
        const body = stripQuoted(text) || "(empty reply)";
        const comment = await createComment(tx, actor, record.id, { body, internal: false });
        await logMessage(tx, tenantId, record.id, messageId, from, msg.to, subject);
        return { outcome: "comment_added", key: record.key, recordId: record.id, commentId: comment.id, actor };
      }
      const record = await createRecord(tx, actor, {
        recordTypeId: target.recordTypeId,
        title: subject || "(no subject)",
        description: text.trim(),
      });
      await logMessage(tx, tenantId, record.id, messageId, from, msg.to, subject);
      return { outcome: "record_created", key: record.key, recordId: record.id, actor };
    } catch (err) {
      // Validation errors (required fields the email cannot supply, closed projects) refuse the mail.
      if (err instanceof AppError) return { outcome: "not_allowed" };
      throw err;
    }
  });

  if (result.recordId && result.actor && w.blobs && parsed.attachments.length) {
    await saveAttachments(w, tenantId, result.actor, result.recordId, result.commentId ?? null, parsed.attachments, settings.attachmentMaxMb);
  }
  if (result.recordId) await processTenantOutbox(w, tenantId);
  return { outcome: result.outcome, key: result.key };
}

async function logMessage(tx: Tx, tenantId: string, recordId: string, messageId: string, from: string, to: string, subject: string) {
  await tx`
    insert into email_messages (tenant_id, record_id, direction, message_id, from_addr, to_addr, subject)
    values (${tenantId}, ${recordId}, 'in', ${messageId}, ${from}, ${to.toLowerCase()}, ${subject})`;
}

async function saveAttachments(
  w: WorkerDeps,
  tenantId: string,
  actor: Actor,
  recordId: string,
  commentId: string | null,
  attachments: Awaited<ReturnType<typeof PostalMime.parse>>["attachments"],
  maxMb: number,
) {
  for (const a of attachments.slice(0, MAX_ATTACHMENTS)) {
    const bytes = toBytes(a.content);
    if (!bytes.byteLength || bytes.byteLength > maxMb * 1024 * 1024) continue;
    const id = crypto.randomUUID();
    const storageKey = `t/${tenantId}/a/${id}`;
    const contentType = cleanContentType(a.mimeType);
    await w.blobs!.put(storageKey, bytes, contentType);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    await withTenant(w.sql, tenantId, async (tx) => {
      await tx`
        insert into attachments (id, tenant_id, record_id, comment_id, filename, content_type, size_bytes, sha256, storage_key, uploaded_by)
        values (${id}, ${tenantId}, ${recordId}, ${commentId}, ${cleanFilename(a.filename ?? "attachment")}, ${contentType},
                ${bytes.byteLength}, ${digest}, ${storageKey}, ${actor.userId})`;
      if (w.replica) await scheduleJob(tx, tenantId, "replicate", id, w.now());
    });
  }
}
