// SLA policies for a project, stored as versioned JSON (config_versions kind "sla"). The first
// policy whose conditions match a record sets its first-response and resolution targets.
import { z } from "zod";
import { configKey, uuid } from "../lib/validate.ts";
import { PRIORITIES, type Priority } from "../records/constants.ts";

const policySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    match: z
      .object({
        priorities: z.array(z.enum(PRIORITIES)).max(4).default([]),
        recordTypeIds: z.array(uuid).max(50).default([]),
      })
      .default({ priorities: [], recordTypeIds: [] }),
    firstResponseMinutes: z.number().int().min(1).max(525_600).nullable().default(null),
    resolutionMinutes: z.number().int().min(1).max(525_600).nullable().default(null),
    calendarId: uuid.nullable().default(null),
    warnPercent: z.number().int().min(1).max(99).default(80),
  })
  .refine((p) => p.firstResponseMinutes !== null || p.resolutionMinutes !== null, "Set a first-response or resolution target");

export const slaSchema = z.object({
  policies: z.array(policySchema).max(50),
  /** Statuses (any record type in the project) during which clocks stop. */
  pauseStatuses: z.array(configKey).max(50).default([]),
});

export type SlaPolicy = z.infer<typeof policySchema>;
export type SlaDefinition = z.infer<typeof slaSchema>;

export function matchPolicy(
  def: SlaDefinition,
  record: { priority: Priority; recordTypeId: string },
): SlaPolicy | null {
  for (const p of def.policies) {
    if (p.match.priorities.length && !p.match.priorities.includes(record.priority)) continue;
    if (p.match.recordTypeIds.length && !p.match.recordTypeIds.includes(record.recordTypeId)) continue;
    return p;
  }
  return null;
}
