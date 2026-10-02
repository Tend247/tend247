// Burndown snapshots: one row per sprint day, rewritten whenever something that moves the line
// changes (a status category, story points, sprint membership). Days without a change carry
// the previous day's numbers forward when the chart is drawn.
import type { Tx } from "../db/client.ts";

const DAY = 86_400_000;

export function dayIndex(startAt: Date, at: Date, lastDay: number): number {
  return Math.min(Math.max(Math.floor((at.getTime() - startAt.getTime()) / DAY), 0), lastDay);
}

export function sprintDays(startAt: Date, endAt: Date): number {
  return Math.max(1, Math.ceil((endAt.getTime() - startAt.getTime()) / DAY));
}

/** Write today's snapshot for an active sprint (no-op for anything else). */
export async function touchSprint(tx: Tx, sprintId: string | null | undefined, at = new Date()): Promise<void> {
  if (!sprintId) return;
  const [s] = await tx<{ tenantId: string; state: string; startAt: Date | null; endAt: Date | null }[]>`
    select tenant_id, state, start_at, end_at from sprints where id = ${sprintId}`;
  if (!s || s.state !== "active" || !s.startAt || !s.endAt) return;
  const index = dayIndex(s.startAt, at, sprintDays(s.startAt, s.endAt));
  await tx`
    insert into sprint_snapshots (tenant_id, sprint_id, day_index, scope_points, remaining_points, scope_count, remaining_count, captured_at)
    select ${s.tenantId}, ${sprintId}, ${index},
      coalesce(sum(story_points), 0), coalesce(sum(story_points) filter (where status_category <> 'done'), 0),
      count(*), count(*) filter (where status_category <> 'done'), clock_timestamp()
    from records where sprint_id = ${sprintId} and deleted_at is null
    on conflict (sprint_id, day_index) do update set
      scope_points = excluded.scope_points, remaining_points = excluded.remaining_points,
      scope_count = excluded.scope_count, remaining_count = excluded.remaining_count, captured_at = excluded.captured_at`;
}
