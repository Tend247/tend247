// SLA clocks. Each record has at most one first-response and one resolution clock, set from
// the first matching policy of its project. Clocks are brought up to date inside the same
// transaction as every change that can affect them (create, priority, status, first reply),
// so stored due times are always current; a timer per clock raises warning and breach events.
import type { Tx } from "../db/client.ts";
import { emit } from "../audit.ts";
import { getPublished } from "../config/versions.ts";
import { cancelJob, scheduleJob } from "../jobs/schedule.ts";
import { addBusinessMinutes, businessMinutesBetween, type Calendar } from "./calendar.ts";
import { matchPolicy, type SlaDefinition } from "./definition.ts";
import type { Priority } from "../records/constants.ts";

export type Metric = "first_response" | "resolution";

export interface SlaClock {
  id: string;
  recordId: string;
  metric: Metric;
  policyName: string;
  targetMinutes: number;
  warnPercent: number;
  calendarId: string | null;
  startedAt: Date;
  runStartedAt: Date | null;
  consumedMinutes: number;
  dueAt: Date | null;
  warnAt: Date | null;
  status: "running" | "paused" | "met" | "cancelled";
  metAt: Date | null;
  warnedAt: Date | null;
  breachedAt: Date | null;
}

export interface SlaSubject {
  id: string;
  projectId: string;
  recordTypeId: string;
  priority: Priority;
  status: string;
  statusCategory: string;
  firstRespondedAt: Date | null;
  createdAt: Date;
  deletedAt?: Date | null;
}

const COLUMNS = (tx: Tx) => tx`
  id, record_id, metric, policy_name, target_minutes, warn_percent, calendar_id, started_at, run_started_at,
  consumed_minutes, due_at, warn_at, status, met_at, warned_at, breached_at`;

async function loadCalendar(tx: Tx, id: string | null): Promise<Calendar | null> {
  if (!id) return null;
  const [c] = await tx<Calendar[]>`select timezone, hours, holidays from calendars where id = ${id}`;
  return c ?? null;
}

function plan(c: Pick<SlaClock, "status" | "runStartedAt" | "targetMinutes" | "consumedMinutes" | "warnPercent">, cal: Calendar | null) {
  if (c.status !== "running" || !c.runStartedAt) return { dueAt: null, warnAt: null };
  const remaining = Math.max(0, c.targetMinutes - c.consumedMinutes);
  const warnRemaining = (c.targetMinutes * c.warnPercent) / 100 - c.consumedMinutes;
  try {
    return {
      dueAt: addBusinessMinutes(c.runStartedAt, remaining, cal),
      warnAt: warnRemaining > 0 ? addBusinessMinutes(c.runStartedAt, warnRemaining, cal) : c.runStartedAt,
    };
  } catch (err) {
    // A calendar edited down to (almost) no hours: keep the clock but never block the change.
    console.error("SLA due time could not be computed:", (err as Error).message);
    return { dueAt: null, warnAt: null };
  }
}

async function arm(tx: Tx, tenantId: string, c: Pick<SlaClock, "id" | "status" | "warnAt" | "dueAt" | "warnedAt" | "breachedAt">) {
  const next = c.status !== "running" ? null : !c.warnedAt && c.warnAt ? c.warnAt : !c.breachedAt && c.dueAt ? c.dueAt : null;
  if (next) await scheduleJob(tx, tenantId, "sla", c.id, next);
  else await cancelJob(tx, tenantId, "sla", c.id);
}

/** Bring a record's clocks in line with its current state. */
export async function syncSla(tx: Tx, record: SlaSubject, now = new Date()): Promise<void> {
  const [{ tenantId } = { tenantId: "" }] = await tx<{ tenantId: string }[]>`select tenant_id from records where id = ${record.id}`;
  const clocks = await tx<SlaClock[]>`select ${COLUMNS(tx)} from sla_clocks where record_id = ${record.id} for update`;
  const published = record.deletedAt ? null : await getPublished(tx, "sla", record.projectId);
  const def = published?.definition as SlaDefinition | undefined;
  const policy = def ? matchPolicy(def, record) : null;

  for (const metric of ["first_response", "resolution"] as const) {
    const existing = clocks.find((c) => c.metric === metric);
    const target = policy ? (metric === "first_response" ? policy.firstResponseMinutes : policy.resolutionMinutes) : null;
    if (!policy || !target) {
      if (existing && (existing.status === "running" || existing.status === "paused")) {
        const cal = await loadCalendar(tx, existing.calendarId);
        const consumed = existing.status === "running" && existing.runStartedAt
          ? existing.consumedMinutes + businessMinutesBetween(existing.runStartedAt, now, cal)
          : existing.consumedMinutes;
        await tx`
          update sla_clocks set status = 'cancelled', consumed_minutes = ${consumed}, run_started_at = null,
            due_at = null, warn_at = null, updated_at = clock_timestamp()
          where id = ${existing.id}`;
        await cancelJob(tx, tenantId, "sla", existing.id);
      }
      continue;
    }

    const met = metric === "first_response" ? !!record.firstRespondedAt : record.statusCategory === "done";
    const paused = !met && def!.pauseStatuses.includes(record.status);
    const desired: SlaClock["status"] = met ? "met" : paused ? "paused" : "running";
    const cal = await loadCalendar(tx, policy.calendarId);

    if (!existing) {
      if (met) continue; // Nothing to time.
      const startedAt = record.createdAt;
      const c = {
        status: desired,
        runStartedAt: desired === "running" ? startedAt : null,
        targetMinutes: target,
        consumedMinutes: 0,
        warnPercent: policy.warnPercent,
      };
      const { dueAt, warnAt } = plan(c, cal);
      const [row] = await tx<{ id: string }[]>`
        insert into sla_clocks (tenant_id, record_id, metric, policy_name, target_minutes, warn_percent, calendar_id,
                                started_at, run_started_at, consumed_minutes, due_at, warn_at, status)
        values (${tenantId}, ${record.id}, ${metric}, ${policy.name}, ${target}, ${policy.warnPercent}, ${policy.calendarId},
                ${startedAt}, ${c.runStartedAt}, 0, ${dueAt}, ${warnAt}, ${desired})
        returning id`;
      await arm(tx, tenantId, { id: row!.id, status: desired, warnAt, dueAt, warnedAt: null, breachedAt: null });
      continue;
    }

    // Close out the running stretch with the calendar it ran on.
    let consumed = existing.consumedMinutes;
    let runStartedAt = existing.runStartedAt;
    if (existing.status === "running" && desired !== "running" && runStartedAt) {
      consumed += businessMinutesBetween(runStartedAt, now, await loadCalendar(tx, existing.calendarId));
      runStartedAt = null;
    } else if (existing.status !== "running" && desired === "running") {
      runStartedAt = now;
    }
    const metAt = desired === "met" ? (existing.metAt ?? now) : null;
    const c = { status: desired, runStartedAt, targetMinutes: target, consumedMinutes: consumed, warnPercent: policy.warnPercent };
    const { dueAt, warnAt } = plan(c, cal);
    await tx`
      update sla_clocks set status = ${desired}, policy_name = ${policy.name}, target_minutes = ${target},
        warn_percent = ${policy.warnPercent}, calendar_id = ${policy.calendarId}, run_started_at = ${runStartedAt},
        consumed_minutes = ${consumed}, due_at = ${dueAt}, warn_at = ${warnAt}, met_at = ${metAt},
        updated_at = clock_timestamp()
      where id = ${existing.id}`;
    await arm(tx, tenantId, { id: existing.id, status: desired, warnAt, dueAt, warnedAt: existing.warnedAt, breachedAt: existing.breachedAt });
  }
}

/** Timer handler: raise the warning and breach events that are due, then re-arm. */
export async function runSlaTimer(tx: Tx, tenantId: string, clockId: string, now = new Date()): Promise<void> {
  const [c] = await tx<(SlaClock & { key: string; deletedAt: Date | null })[]>`
    select ${tx`sla_clocks.id, sla_clocks.record_id, metric, policy_name, target_minutes, due_at, warn_at, sla_clocks.status, warned_at, breached_at`},
           r.key, r.deleted_at
    from sla_clocks join records r on r.id = sla_clocks.record_id
    where sla_clocks.id = ${clockId} for update of sla_clocks`;
  if (!c || c.deletedAt || c.status !== "running") return;
  const payload = { recordId: c.recordId, key: c.key, clockId: c.id, metric: c.metric, policyName: c.policyName, dueAt: c.dueAt };
  let warnedAt = c.warnedAt;
  let breachedAt = c.breachedAt;
  if (!warnedAt && c.warnAt && c.warnAt <= now) {
    warnedAt = now;
    // A clock that is already past due skips straight to the breach.
    if (!(c.dueAt && c.dueAt <= now)) await emit(tx, tenantId, "sla.warning", payload);
  }
  if (!breachedAt && c.dueAt && c.dueAt <= now) {
    breachedAt = now;
    await emit(tx, tenantId, "sla.breached", payload);
  }
  if (warnedAt !== c.warnedAt || breachedAt !== c.breachedAt) {
    await tx`update sla_clocks set warned_at = ${warnedAt}, breached_at = ${breachedAt}, updated_at = clock_timestamp() where id = ${c.id}`;
  }
  await arm(tx, tenantId, { id: c.id, status: c.status, warnAt: c.warnAt, dueAt: c.dueAt, warnedAt, breachedAt });
}

export async function listClocks(tx: Tx, recordId: string): Promise<SlaClock[]> {
  return tx<SlaClock[]>`select ${COLUMNS(tx)} from sla_clocks where record_id = ${recordId} and status <> 'cancelled' order by metric`;
}

/** Re-arm every running clock's timer from its stored due times (after a restore). */
export async function rearmAll(tx: Tx, tenantId: string): Promise<number> {
  const running = await tx<SlaClock[]>`select ${COLUMNS(tx)} from sla_clocks where status = 'running'`;
  for (const c of running) await arm(tx, tenantId, c);
  return running.length;
}
