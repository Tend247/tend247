// Agile projects: sprints planned from a ranked backlog, story points, epics, burndown and
// velocity. Turned on per project (projects.agile); every other project is unaffected.
//
// Sprint lifecycle: planned → active (one per project) → completed. Starting records the
// commitment (points and items in the sprint); completing records what was done and moves
// unfinished work to a planned sprint or back to the backlog. The burndown is drawn from daily
// snapshots (snapshots.ts); velocity from completed sprints.
import { z } from "zod";
import type { Tx } from "../db/client.ts";
import { emit, isStaff, type Actor } from "../audit.ts";
import { getProject, type Project } from "../config/service.ts";
import { loadRecord, RECORD_COLUMNS, visibleTo, type RecordRow } from "../records/access.ts";
import { recordEvent } from "../records/service.ts";
import { AppError, forbidden, invalid, notFound } from "../lib/errors.ts";
import { isUuid } from "../lib/crypto.ts";
import { parse, uuid } from "../lib/validate.ts";
import { dayIndex, sprintDays, touchSprint } from "./snapshots.ts";

const DAY = 86_400_000;
const GAP = 1024;

export interface Sprint {
  id: string;
  projectId: string;
  name: string;
  goal: string;
  state: "planned" | "active" | "completed";
  startAt: Date | null;
  endAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  committedPoints: number | null;
  committedCount: number | null;
  completedPoints: number | null;
  completedCount: number | null;
  points: number;
  count: number;
  donePoints: number;
  doneCount: number;
}

const SPRINT_COLUMNS = (tx: Tx) => tx`
  s.id, s.project_id, s.name, s.goal, s.state, s.start_at, s.end_at, s.started_at, s.completed_at,
  s.committed_points::float8 as committed_points, s.committed_count,
  s.completed_points::float8 as completed_points, s.completed_count,
  coalesce((select sum(r.story_points) from records r where r.sprint_id = s.id and r.deleted_at is null), 0)::float8 as points,
  (select count(*) from records r where r.sprint_id = s.id and r.deleted_at is null)::int as count,
  coalesce((select sum(r.story_points) from records r where r.sprint_id = s.id and r.deleted_at is null and r.status_category = 'done'), 0)::float8 as done_points,
  (select count(*) from records r where r.sprint_id = s.id and r.deleted_at is null and r.status_category = 'done')::int as done_count`;

function staffOnly(actor: Actor) {
  if (!isStaff(actor)) throw forbidden("Only admins and agents plan sprints");
}

async function agileProject(tx: Tx, actor: Actor, projectId: string): Promise<Project> {
  if (!isUuid(projectId)) throw notFound("Project");
  const project = await getProject(tx, projectId);
  // A restricted project's plan (sprint names, goals, totals) is for its team and admins, like
  // its records.
  if (project.restricted && actor.role !== "admin") {
    const [member] = project.defaultTeamId
      ? await tx`select 1 from team_members where team_id = ${project.defaultTeamId} and user_id = ${actor.userId}`
      : [];
    if (!member) throw notFound("Project");
  }
  if (!project.agile) throw new AppError("conflict", "Turn on agile features for this project first (Admin > Projects)");
  return project;
}

async function getSprint(tx: Tx, actor: Actor, id: string, lock = false): Promise<Sprint> {
  if (!isUuid(id)) throw notFound("Sprint");
  const [s] = await tx<Sprint[]>`select ${SPRINT_COLUMNS(tx)} from sprints s where s.id = ${id} ${lock ? tx`for update of s` : tx``}`;
  if (!s) throw notFound("Sprint");
  await agileProject(tx, actor, s.projectId).catch((err) => {
    // A sprint stays readable (and completable) if its project later stops being agile.
    if (err instanceof AppError && err.code === "conflict") return;
    throw err;
  });
  return s;
}

export async function listSprints(tx: Tx, actor: Actor, projectId: string): Promise<Sprint[]> {
  staffOnly(actor);
  await agileProject(tx, actor, projectId);
  return tx<Sprint[]>`
    select ${SPRINT_COLUMNS(tx)} from sprints s where s.project_id = ${projectId}
    order by case s.state when 'active' then 0 when 'planned' then 1 else 2 end, s.created_at`;
}

// ---------------------------------------------------------------- sprint lifecycle

const createSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  goal: z.string().trim().max(2000).default(""),
});
const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    goal: z.string().trim().max(2000),
    startAt: z.coerce.date().nullable(),
    endAt: z.coerce.date().nullable(),
  })
  .partial()
  .strict();
const startSchema = z.object({
  goal: z.string().trim().max(2000).optional(),
  startAt: z.coerce.date().optional(),
  /** Length in weeks (ignored when endAt is given). */
  weeks: z.number().int().min(1).max(8).default(2),
  endAt: z.coerce.date().optional(),
});
const completeSchema = z.object({
  /** Where unfinished work goes: a planned sprint of the same project, or null for the backlog. */
  moveTo: uuid.nullable().default(null),
});

export async function createSprint(tx: Tx, actor: Actor, projectId: string, input: unknown): Promise<Sprint> {
  staffOnly(actor);
  const project = await agileProject(tx, actor, projectId);
  const data = parse(createSchema, input ?? {});
  const [n] = await tx<{ n: number }[]>`select count(*)::int as n from sprints where project_id = ${project.id}`;
  if ((n?.n ?? 0) >= 500) throw new AppError("conflict", "This project already has 500 sprints");
  const [row] = await tx<{ id: string }[]>`
    insert into sprints (tenant_id, project_id, name, goal, created_by)
    values (${actor.tenantId}, ${project.id}, ${data.name ?? `${project.key} Sprint ${(n?.n ?? 0) + 1}`}, ${data.goal}, ${actor.userId})
    returning id`;
  return getSprint(tx, actor, row!.id);
}

export async function updateSprint(tx: Tx, actor: Actor, id: string, input: unknown): Promise<Sprint> {
  staffOnly(actor);
  const s = await getSprint(tx, actor, id, true);
  if (s.state === "completed") throw new AppError("conflict", "A completed sprint cannot be changed");
  const patch = parse(patchSchema, input);
  if (s.state === "active" && patch.startAt !== undefined && patch.startAt?.getTime() !== s.startAt?.getTime()) {
    // The burndown counts days from the start; moving it would misplace every day recorded so far.
    throw invalid([{ field: "startAt", message: "A running sprint keeps its start date; change its end date instead" }]);
  }
  const startAt = patch.startAt === undefined ? s.startAt : patch.startAt;
  const endAt = patch.endAt === undefined ? s.endAt : patch.endAt;
  if (startAt && endAt && endAt <= startAt) throw invalid([{ field: "endAt", message: "Must be after the start" }]);
  if (s.state === "active" && (!startAt || !endAt)) throw invalid([{ field: "endAt", message: "An active sprint needs both dates" }]);
  await tx`
    update sprints set name = ${patch.name ?? s.name}, goal = ${patch.goal ?? s.goal}, start_at = ${startAt}, end_at = ${endAt}
    where id = ${s.id}`;
  if (s.state === "active") await touchSprint(tx, s.id);
  return getSprint(tx, actor, s.id);
}

export async function startSprint(tx: Tx, actor: Actor, id: string, input: unknown): Promise<Sprint> {
  staffOnly(actor);
  const s = await getSprint(tx, actor, id, true);
  if (s.state !== "planned") throw new AppError("conflict", "Only a planned sprint can start");
  const [active] = await tx<{ name: string }[]>`select name from sprints where project_id = ${s.projectId} and state = 'active'`;
  if (active) throw new AppError("conflict", `Complete "${active.name}" before starting another sprint`);
  const data = parse(startSchema, input ?? {});
  const startAt = data.startAt ?? new Date();
  const endAt = data.endAt ?? new Date(startAt.getTime() + data.weeks * 7 * DAY);
  if (endAt <= startAt) throw invalid([{ field: "endAt", message: "Must be after the start" }]);
  await tx`
    update sprints set state = 'active', started_at = now(), start_at = ${startAt}, end_at = ${endAt},
      goal = ${data.goal ?? s.goal}, committed_points = ${s.points}, committed_count = ${s.count}
    where id = ${s.id}`;
  await touchSprint(tx, s.id, startAt); // the commitment is day 0, even for a sprint started late
  await emit(tx, actor.tenantId, "sprint.started", { sprintId: s.id, projectId: s.projectId, actorId: actor.userId }, actor);
  return getSprint(tx, actor, s.id);
}

export async function completeSprint(tx: Tx, actor: Actor, id: string, input: unknown): Promise<{ sprint: Sprint; moved: number }> {
  staffOnly(actor);
  const s = await getSprint(tx, actor, id, true);
  if (s.state !== "active") throw new AppError("conflict", "Only the active sprint can be completed");
  const { moveTo } = parse(completeSchema, input ?? {});
  let target: Sprint | null = null;
  if (moveTo) {
    target = await getSprint(tx, actor, moveTo);
    if (target.projectId !== s.projectId || target.state !== "planned") {
      throw invalid([{ field: "moveTo", message: "Choose a planned sprint of the same project, or the backlog" }]);
    }
  }
  await touchSprint(tx, s.id); // the final day's numbers
  const moved = await tx<{ id: string }[]>`
    update records set sprint_id = ${target?.id ?? null}, version = version + 1, updated_at = clock_timestamp()
    where sprint_id = ${s.id} and deleted_at is null and status_category <> 'done'
    returning id`;
  for (const r of moved) {
    await recordEvent(tx, actor, r.id, "planned", { from: s.name, to: target?.name ?? null, reason: "sprint_completed" });
    await emit(tx, actor.tenantId, "record.updated", { recordId: r.id, actorId: actor.userId, fields: ["sprintId"] }, actor);
  }
  await tx`
    update sprints set state = 'completed', completed_at = now(), completed_points = ${s.donePoints}, completed_count = ${s.doneCount}
    where id = ${s.id}`;
  await emit(tx, actor.tenantId, "sprint.completed", { sprintId: s.id, projectId: s.projectId, actorId: actor.userId, moved: moved.length }, actor);
  return { sprint: await getSprint(tx, actor, s.id), moved: moved.length };
}

export async function deleteSprint(tx: Tx, actor: Actor, id: string): Promise<void> {
  staffOnly(actor);
  const s = await getSprint(tx, actor, id, true);
  if (s.state !== "planned") throw new AppError("conflict", "Only a planned sprint can be deleted; its work returns to the backlog");
  await tx`delete from sprints where id = ${s.id}`; // records keep their rank; sprint_id is set null
}

// ---------------------------------------------------------------- backlog and planning

/** Give unranked records of a project a position at the bottom, in creation order. */
async function rankUnranked(tx: Tx, projectId: string): Promise<void> {
  await tx`
    with base as (select coalesce(max(rank), 0) as top from records where project_id = ${projectId}),
    todo as (select id, row_number() over (order by seq) as n from records where project_id = ${projectId} and rank is null)
    update records r set rank = base.top + todo.n * ${GAP} from base, todo where r.id = todo.id`;
}

/** Spread a project's ranks out again once two neighbours have (almost) no room between them. */
async function renumber(tx: Tx, projectId: string): Promise<void> {
  await tx`
    with ordered as (select id, row_number() over (order by rank, seq) as n from records where project_id = ${projectId})
    update records r set rank = ordered.n * ${GAP} from ordered where r.id = ordered.id and r.rank is distinct from ordered.n * ${GAP}`;
}

async function rankOf(tx: Tx, id: string | undefined, projectId: string, field: string): Promise<number | null> {
  if (!id) return null;
  const [r] = await tx<{ rank: number | null; projectId: string }[]>`select rank, project_id from records where id = ${id}`;
  if (!r || r.projectId !== projectId) throw invalid([{ field, message: "Neighbours must be records of the same project" }]);
  return r.rank;
}

/** The rank just after `after` (or just before `before`): halfway to the record actually next to it. */
async function rankNextTo(tx: Tx, projectId: string, selfId: string, side: { after: number } | { before: number }): Promise<number> {
  if ("after" in side) {
    const [next] = await tx<{ rank: number }[]>`
      select rank from records where project_id = ${projectId} and id <> ${selfId} and rank > ${side.after} order by rank limit 1`;
    return next ? (side.after + next.rank) / 2 : side.after + GAP;
  }
  const [prev] = await tx<{ rank: number }[]>`
    select rank from records where project_id = ${projectId} and id <> ${selfId} and rank < ${side.before} order by rank desc limit 1`;
  return prev ? (prev.rank + side.before) / 2 : side.before - GAP;
}

/** Where a record goes between two neighbours (either may be missing). Null: nothing to do. */
async function placeBetween(tx: Tx, projectId: string, selfId: string, afterId?: string, beforeId?: string): Promise<number | null> {
  const read = async () => ({ after: await rankOf(tx, afterId, projectId, "afterId"), before: await rankOf(tx, beforeId, projectId, "beforeId") });
  let { after, before } = await read();
  if (after !== null && before !== null) {
    // Neighbours sent in the wrong order (or from a stale page): trust the one placed first.
    if (before <= after) before = null;
    else if (before - after < 1e-6) {
      await renumber(tx, projectId);
      ({ after, before } = await read());
    }
  }
  if (after !== null && before !== null) return (after + before) / 2;
  if (after !== null) return rankNextTo(tx, projectId, selfId, { after });
  if (before !== null) return rankNextTo(tx, projectId, selfId, { before });
  return null;
}

const planSchema = z
  .object({
    /** The sprint to plan the record into, or null for the backlog; omit to keep it where it is. */
    sprintId: uuid.nullable().optional(),
    /** Put it just below this record … */
    afterId: uuid.optional(),
    /** … or just above this one. */
    beforeId: uuid.optional(),
  })
  .strict();

/** Move a record into or out of a sprint and/or to a new position in the backlog order. */
export async function planRecord(tx: Tx, actor: Actor, idOrKey: string, input: unknown): Promise<RecordRow> {
  staffOnly(actor);
  const data = parse(planSchema, input);
  const peek = await loadRecord(tx, actor, idOrKey);
  if (!peek) throw notFound("Record");
  // One ranking at a time per project, taken before any row lock so concurrent drags queue
  // instead of deadlocking when one of them renumbers the project.
  await tx`select pg_advisory_xact_lock(hashtext(${`rank:${peek.projectId}`}))`;
  const record = await loadRecord(tx, actor, idOrKey, { lock: true });
  if (!record) throw notFound("Record");
  const project = await agileProject(tx, actor, record.projectId);
  const [type] = await tx<{ isEpic: boolean }[]>`select is_epic from record_types where id = ${record.recordTypeId}`;
  if (type?.isEpic && data.sprintId) throw invalid([{ field: "sprintId", message: "Epics are not planned into sprints; plan their stories" }]);

  let sprintChanged = false;
  let target: Sprint | null = null;
  if (data.sprintId !== undefined && data.sprintId !== record.sprintId) {
    if (record.sprintId && record.statusCategory === "done") {
      const [from] = await tx<{ state: string }[]>`select state from sprints where id = ${record.sprintId}`;
      if (from?.state === "completed") throw new AppError("conflict", "This was finished in a completed sprint; reopen it to plan it again");
    }
    if (data.sprintId) {
      target = await getSprint(tx, actor, data.sprintId);
      if (target.projectId !== project.id || target.state === "completed") {
        throw invalid([{ field: "sprintId", message: "Choose a planned or active sprint of this project" }]);
      }
    }
    sprintChanged = true;
  }

  let rank = record.rank;
  if (data.afterId || data.beforeId) {
    await rankUnranked(tx, project.id);
    rank = (await placeBetween(tx, project.id, record.id, data.afterId, data.beforeId)) ?? rank;
  }
  if (rank === null) {
    await rankUnranked(tx, project.id);
    const [fresh] = await tx<{ rank: number }[]>`select rank from records where id = ${record.id}`;
    rank = fresh!.rank;
  }

  if (sprintChanged) {
    await tx`
      update records set sprint_id = ${target?.id ?? null}, rank = ${rank}, version = version + 1, updated_at = clock_timestamp()
      where id = ${record.id}`;
    const [from] = record.sprintId ? await tx<{ name: string }[]>`select name from sprints where id = ${record.sprintId}` : [];
    await recordEvent(tx, actor, record.id, "planned", { from: from?.name ?? null, to: target?.name ?? null });
    await emit(tx, actor.tenantId, "record.updated", { recordId: record.id, key: record.key, actorId: actor.userId, fields: ["sprintId"] }, actor);
    await touchSprint(tx, record.sprintId);
    await touchSprint(tx, target?.id);
  } else if (rank !== record.rank) {
    // Reordering is not a change to the record: no version bump, no history entry.
    await tx`update records set rank = ${rank} where id = ${record.id}`;
  }
  return (await loadRecord(tx, { ...actor, role: "admin" }, record.id))!;
}

export interface EpicProgress {
  id: string;
  key: string;
  title: string;
  status: string;
  statusCategory: string;
  count: number;
  doneCount: number;
  points: number;
  donePoints: number;
}

/** Everything the backlog page shows: the active and planned sprints, the backlog, the epics. */
export async function getBacklog(tx: Tx, actor: Actor, projectId: string) {
  staffOnly(actor);
  const project = await agileProject(tx, actor, projectId);
  const sprints = await tx<Sprint[]>`
    select ${SPRINT_COLUMNS(tx)} from sprints s where s.project_id = ${project.id} and s.state <> 'completed'
    order by case s.state when 'active' then 0 else 1 end, s.created_at`;
  const records = await tx<RecordRow[]>`
    select ${RECORD_COLUMNS(tx, actor)} from records
    join record_types rt on rt.id = records.record_type_id
    where records.project_id = ${project.id} and records.deleted_at is null and not rt.is_epic and ${visibleTo(tx, actor)}
      and (records.sprint_id in (select id from sprints where project_id = ${project.id} and state <> 'completed')
           or records.status_category <> 'done')
    order by records.rank asc nulls last, records.seq asc
    limit 1000`;
  const epics = await tx<EpicProgress[]>`
    select e.id, e.key, e.title, e.status, e.status_category,
      count(c.id)::int as count, count(c.id) filter (where c.status_category = 'done')::int as done_count,
      coalesce(sum(c.story_points), 0)::float8 as points,
      coalesce(sum(c.story_points) filter (where c.status_category = 'done'), 0)::float8 as done_points
    from records e
    join record_types rt on rt.id = e.record_type_id and rt.is_epic
    left join records c on c.epic_id = e.id and c.deleted_at is null
    where e.project_id = ${project.id} and e.deleted_at is null
    group by e.id order by e.status_category = 'done', e.rank asc nulls last, e.seq`;
  return {
    project: { id: project.id, key: project.key, name: project.name },
    sprints: sprints.map((s) => ({ ...s, records: records.filter((r) => r.sprintId === s.id) })),
    // Unfinished work with no open sprint (including anything left on a completed sprint).
    backlog: records.filter((r) => !r.sprintId || !sprints.some((s) => s.id === r.sprintId)),
    epics,
  };
}

// ---------------------------------------------------------------- reports

/** Burndown for one sprint: remaining points per day (carried forward), and the ideal line. */
export async function sprintReport(tx: Tx, actor: Actor, id: string, now = new Date()) {
  staffOnly(actor);
  const s = await getSprint(tx, actor, id);
  if (s.state === "planned" || !s.startAt || !s.endAt) {
    return { sprint: s, days: [], scopeChange: 0 };
  }
  const total = sprintDays(s.startAt, s.endAt);
  const snaps = await tx<{ dayIndex: number; scopePoints: number; remainingPoints: number; scopeCount: number; remainingCount: number }[]>`
    select day_index, scope_points::float8 as scope_points, remaining_points::float8 as remaining_points, scope_count, remaining_count
    from sprint_snapshots where sprint_id = ${s.id} order by day_index`;
  const last = s.state === "completed" ? total : dayIndex(s.startAt, now, total);
  const start = snaps[0] ?? { scopePoints: s.committedPoints ?? 0, remainingPoints: s.committedPoints ?? 0, scopeCount: 0, remainingCount: 0 };
  const committed = s.committedPoints ?? start.scopePoints;
  const days = [];
  let carry = start;
  for (let i = 0; i <= total; i++) {
    const snap = snaps.find((x) => x.dayIndex === i);
    if (snap) carry = snap;
    const date = new Date(s.startAt.getTime() + i * DAY).toISOString();
    days.push({
      index: i,
      date,
      ideal: Math.round((committed - (committed * i) / total) * 10) / 10,
      remaining: i <= last ? carry.remainingPoints : null,
      scope: i <= last ? carry.scopePoints : null,
    });
  }
  const latestScope = [...days].reverse().find((d) => d.scope !== null)?.scope ?? committed;
  return { sprint: s, days, scopeChange: Math.round((latestScope - committed) * 10) / 10 };
}

/** Committed versus completed points for the project's last completed sprints. */
export async function velocity(tx: Tx, actor: Actor, projectId: string, limit = 8) {
  staffOnly(actor);
  await agileProject(tx, actor, projectId);
  const rows = await tx<{ id: string; name: string; committed: number; completed: number; completedAt: Date }[]>`
    select id, name, coalesce(committed_points, 0)::float8 as committed, coalesce(completed_points, 0)::float8 as completed, completed_at
    from sprints where project_id = ${projectId} and state = 'completed'
    order by completed_at desc limit ${limit}`;
  const sprints = rows.reverse();
  const done = sprints.map((r) => r.completed);
  const recent = done.slice(-3);
  return {
    sprints,
    average: recent.length ? Math.round((recent.reduce((a, b) => a + b, 0) / recent.length) * 10) / 10 : null,
  };
}
