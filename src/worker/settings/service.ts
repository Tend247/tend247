// Workspace settings: non-sensitive knobs stored on the workspace row.
import { z } from "zod";
import type { Db, Tx } from "../db/client.ts";
import { audit, type Actor } from "../audit.ts";
import { parse } from "../lib/validate.ts";
import { isTimeZone } from "../sla/calendar.ts";

export interface WorkspaceSettings {
  /** Days deleted records, comments and attachments stay in the trash. */
  trashRetentionDays: number;
  /** Largest attachment, in megabytes. */
  attachmentMaxMb: number;
  /** Workspace time zone (dates in emails, nightly jobs). */
  timezone: string;
}

export const DEFAULT_SETTINGS: WorkspaceSettings = { trashRetentionDays: 30, attachmentMaxMb: 25, timezone: "UTC" };

const settingsSchema = z
  .object({
    trashRetentionDays: z.number().int().min(1).max(365),
    attachmentMaxMb: z.number().int().min(1).max(100),
    timezone: z.string().refine(isTimeZone, "Unknown time zone"),
  })
  .partial()
  .strict();

export async function getSettings(db: Db, tenantId: string): Promise<WorkspaceSettings> {
  const [row] = await db<{ settings: Partial<WorkspaceSettings> }[]>`select settings from tenants where id = ${tenantId}`;
  return { ...DEFAULT_SETTINGS, ...(row?.settings ?? {}) };
}

export async function updateSettings(tx: Tx, actor: Actor, input: unknown): Promise<WorkspaceSettings> {
  const patch = parse(settingsSchema, input);
  const before = await getSettings(tx, actor.tenantId);
  const after = { ...before, ...patch };
  await tx`update tenants set settings = ${tx.json(after as never)} where id = ${actor.tenantId}`;
  await audit(tx, actor, { entity: "settings", entityId: actor.tenantId, action: "update", before, after });
  return after;
}
