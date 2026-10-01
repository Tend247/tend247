// In-app and email notifications with per-person preferences. Rows are keyed by the event
// that caused them (unique source event, person and kind), so handling an event twice never
// notifies twice; emails are sent after the transaction and retried until sent.
import { z } from "zod";
import type { Tx } from "../db/client.ts";
import type { Actor, Role } from "../audit.ts";
import { parse, uuid } from "../lib/validate.ts";
import { loadRecord } from "../records/access.ts";

export const NOTIFICATION_KINDS = [
  "assigned",
  "mention",
  "comment",
  "status",
  "received",
  "approval",
  "approval_result",
  "sla",
  "automation",
  "backup",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface Pref {
  inApp: boolean;
  email: boolean;
}

export const KIND_LABELS: Record<NotificationKind, string> = {
  assigned: "Assigned to me",
  mention: "Mentions",
  comment: "Comments on records I follow or requested",
  status: "Status changes on records I follow or requested",
  received: "Confirmation when my request is received",
  approval: "Approvals waiting for me",
  approval_result: "Decisions on approvals I asked for",
  sla: "SLA warnings and breaches",
  automation: "Messages from automation rules",
  backup: "Backup failures (admins)",
};

function defaults(role: Role): Record<NotificationKind, Pref> {
  const requester = role === "requester";
  return {
    assigned: { inApp: true, email: true },
    mention: { inApp: true, email: true },
    comment: { inApp: true, email: true },
    status: { inApp: true, email: requester },
    received: { inApp: false, email: true },
    approval: { inApp: true, email: true },
    approval_result: { inApp: true, email: true },
    sla: { inApp: true, email: true },
    automation: { inApp: true, email: true },
    backup: { inApp: true, email: true },
  };
}

export function resolvePrefs(role: Role, stored: Partial<Record<string, Partial<Pref>>> | null): Record<NotificationKind, Pref> {
  const base = defaults(role);
  for (const k of NOTIFICATION_KINDS) {
    const s = stored?.[k];
    if (s) base[k] = { inApp: s.inApp ?? base[k].inApp, email: s.email ?? base[k].email };
  }
  return base;
}

export interface NewNotification {
  userId: string;
  kind: NotificationKind;
  recordId: string | null;
  title: string;
  body?: string;
}

/**
 * Record notifications for one event. Returns the rows that were new and want an email.
 * People who are inactive, or who turned both channels off, get nothing.
 */
export async function notify(tx: Tx, tenantId: string, sourceEventId: string | null, items: NewNotification[]) {
  const byKey = new Map<string, NewNotification>();
  for (const n of items) byKey.set(`${n.userId}:${n.kind}`, n);
  const unique = [...byKey.values()];
  if (!unique.length) return [];
  const users = await tx<{ id: string; role: Role; active: boolean; notificationPrefs: Record<string, Partial<Pref>> | null }[]>`
    select id, role, active, notification_prefs from users
    where id in (select (jsonb_array_elements_text(${tx.json(unique.map((n) => n.userId))}))::uuid)`;
  const byId = new Map(users.map((u) => [u.id, u]));
  const rows = [];
  for (const n of unique) {
    const u = byId.get(n.userId);
    if (!u || !u.active) continue;
    const pref = resolvePrefs(u.role, u.notificationPrefs)[n.kind];
    if (!pref.inApp && !pref.email) continue;
    // Nobody hears about a record they cannot open (restricted projects, lost team access).
    if (n.recordId && !(await loadRecord(tx, { tenantId, userId: u.id, role: u.role }, n.recordId))) continue;
    const [row] = await tx<{ id: string }[]>`
      insert into notifications (tenant_id, user_id, kind, record_id, title, body, source_event_id, email_wanted, read_at)
      values (${tenantId}, ${n.userId}, ${n.kind}, ${n.recordId}, ${n.title.slice(0, 300)}, ${(n.body ?? "").slice(0, 4000)},
              ${sourceEventId}, ${pref.email}, ${pref.inApp ? null : new Date()})
      on conflict (source_event_id, user_id, kind) do nothing
      returning id`;
    if (row && pref.email) rows.push({ id: row.id, ...n });
  }
  return rows;
}

export async function listNotifications(tx: Tx, actor: Actor, opts: { unreadOnly?: boolean } = {}) {
  if (!actor.userId) return { notifications: [], unread: 0 };
  const items = await tx<{ id: string; kind: string; recordId: string | null; recordKey: string | null; title: string; body: string; readAt: Date | null; createdAt: Date }[]>`
    select n.id, n.kind, n.record_id, r.key as record_key, n.title, n.body, n.read_at, n.created_at
    from notifications n left join records r on r.id = n.record_id
    where n.user_id = ${actor.userId} ${opts.unreadOnly ? tx`and n.read_at is null` : tx``}
    order by n.created_at desc limit 50`;
  const [{ n } = { n: 0 }] = await tx<{ n: number }[]>`
    select count(*)::int as n from notifications where user_id = ${actor.userId} and read_at is null`;
  return { notifications: items, unread: n };
}

export async function markRead(tx: Tx, actor: Actor, input: unknown): Promise<void> {
  const data = parse(z.object({ ids: z.array(uuid).max(100).optional(), all: z.boolean().optional() }).strict(), input);
  if (!actor.userId) return;
  if (data.all) {
    await tx`update notifications set read_at = now() where user_id = ${actor.userId} and read_at is null`;
  } else if (data.ids?.length) {
    await tx`
      update notifications set read_at = now()
      where user_id = ${actor.userId} and read_at is null
        and id in (select (jsonb_array_elements_text(${tx.json(data.ids)}))::uuid)`;
  }
}

export async function getPrefs(tx: Tx, actor: Actor) {
  const [u] = await tx<{ notificationPrefs: Record<string, Partial<Pref>> | null }[]>`
    select notification_prefs from users where id = ${actor.userId}`;
  const prefs = resolvePrefs(actor.role, u?.notificationPrefs ?? null);
  return NOTIFICATION_KINDS.filter((k) => actor.role !== "requester" || ["comment", "status", "received", "mention"].includes(k))
    .filter((k) => k !== "backup" || actor.role === "admin")
    .map((k) => ({ kind: k, label: KIND_LABELS[k], ...prefs[k] }));
}

const prefPatch = z.partialRecord(z.enum(NOTIFICATION_KINDS), z.object({ inApp: z.boolean(), email: z.boolean() }).partial().strict());

export async function updatePrefs(tx: Tx, actor: Actor, input: unknown) {
  const patch = parse(prefPatch, input);
  const [u] = await tx<{ notificationPrefs: Record<string, Partial<Pref>> | null }[]>`
    select notification_prefs from users where id = ${actor.userId}`;
  const merged: Record<string, Partial<Pref>> = { ...(u?.notificationPrefs ?? {}) };
  for (const [k, v] of Object.entries(patch)) merged[k] = { ...merged[k], ...v };
  await tx`update users set notification_prefs = ${tx.json(merged as never)} where id = ${actor.userId}`;
  return getPrefs(tx, actor);
}
