import type { Tx } from "./db/client.ts";

export type Role = "admin" | "agent" | "requester";

/**
 * Who is making a change. `userId` is null for the system itself (automation rules, the
 * SLA timer, email intake for an unknown address); such changes are attributed to no person.
 */
export interface Actor {
  tenantId: string;
  userId: string | null;
  role: Role;
  /** Where the change came from; stored on records and comments it creates. */
  via?: "app" | "email" | "automation" | "api" | "import";
  /**
   * Automation provenance: how many rule runs led here and which rules ran. Events carry it
   * so a rule never re-triggers itself and chains stop at a fixed depth.
   */
  chain?: { depth: number; ruleIds: string[] };
}

export const isStaff = (actor: { role: Role }) => actor.role === "admin" || actor.role === "agent";

/** The system actor used by automation, timers and inbound email. */
export function systemActor(tenantId: string, extra: Partial<Actor> = {}): Actor {
  return { tenantId, userId: null, role: "admin", via: "automation", ...extra };
}

/** Append a configuration change to the immutable audit log. */
export async function audit(
  tx: Tx,
  actor: Actor,
  entry: { entity: string; entityId: string | null; action: string; before?: unknown; after?: unknown },
): Promise<void> {
  await tx`
    insert into audit_log (tenant_id, actor_id, entity, entity_id, action, before, after)
    values (
      ${actor.tenantId}, ${actor.userId}, ${entry.entity}, ${entry.entityId}, ${entry.action},
      ${entry.before === undefined ? null : tx.json(entry.before as never)},
      ${entry.after === undefined ? null : tx.json(entry.after as never)}
    )`;
}

/**
 * Queue an event for asynchronous handling (notifications, automation, webhooks) in the same
 * transaction as the change. The work signal lets the background sweep find the workspace
 * without reading row-secured tables; `on conflict do nothing` keeps it off the hot path
 * (a periodic backstop sweep covers the rare race with a signal being cleared).
 */
export async function emit(
  tx: Tx,
  tenantId: string,
  topic: string,
  payload: Record<string, unknown>,
  actor?: Actor,
): Promise<void> {
  const body = actor?.chain ? { ...payload, chain: actor.chain } : payload;
  await tx`insert into outbox (tenant_id, topic, payload) values (${tenantId}, ${topic}, ${tx.json(body as never)})`;
  await tx`insert into work_signals (tenant_id) values (${tenantId}) on conflict do nothing`;
}
