// Timers: one row per (kind, ref) in scheduled_jobs, a routing table read by the cron sweep
// before any workspace is known. Rescheduling replaces the time; finishing deletes the row.
import type { Db } from "../db/client.ts";

export const JOB_KINDS = ["sla", "webhook", "replicate", "export", "purge_trash"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export async function scheduleJob(db: Db, tenantId: string, kind: JobKind, refId: string, runAt: Date): Promise<void> {
  await db`
    insert into scheduled_jobs (tenant_id, kind, ref_id, run_at)
    values (${tenantId}, ${kind}, ${refId}, ${runAt})
    on conflict (kind, ref_id) do update
      set run_at = excluded.run_at, claimed_at = null, attempts = 0, last_error = null
      where scheduled_jobs.tenant_id = excluded.tenant_id`;
}

/** Schedule only if no timer exists yet (nightly jobs). */
export async function ensureJob(db: Db, tenantId: string, kind: JobKind, refId: string, runAt: Date): Promise<void> {
  await db`
    insert into scheduled_jobs (tenant_id, kind, ref_id, run_at) values (${tenantId}, ${kind}, ${refId}, ${runAt})
    on conflict (kind, ref_id) do nothing`;
}

export async function cancelJob(db: Db, tenantId: string, kind: JobKind, refId: string): Promise<void> {
  await db`delete from scheduled_jobs where tenant_id = ${tenantId} and kind = ${kind} and ref_id = ${refId}`;
}
