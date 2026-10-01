import type { Tx } from "./db/client.ts";

export interface Actor {
  tenantId: string;
  userId: string;
  role: "admin" | "agent" | "requester";
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

/** Queue an event for asynchronous delivery (notifications, webhooks, automation). */
export async function emit(tx: Tx, tenantId: string, topic: string, payload: Record<string, unknown>): Promise<void> {
  await tx`insert into outbox (tenant_id, topic, payload) values (${tenantId}, ${topic}, ${tx.json(payload as never)})`;
}
