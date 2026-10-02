// Dashboard numbers for staff: open work, aging, throughput, SLA attainment and workload.
// Every query goes through the same visibility rule as record lists, so an agent's dashboard
// never counts records from restricted projects they cannot open.
import type { Tx } from "../db/client.ts";
import type { Actor } from "../audit.ts";
import { visibleTo } from "../records/access.ts";
import { forbidden } from "../lib/errors.ts";
import { isUuid } from "../lib/crypto.ts";

export interface Dashboard {
  window: { days: number; since: string; timezone: string };
  totals: { open: number; unassigned: number; createdInWindow: number; resolvedInWindow: number; breachedOpen: number };
  openByCategory: { todo: number; in_progress: number };
  openByPriority: Record<"low" | "medium" | "high" | "urgent", number>;
  openByProject: { projectId: string; key: string; name: string; open: number }[];
  aging: { bucket: string; count: number }[];
  throughput: { day: string; created: number; resolved: number }[];
  sla: { metric: "first_response" | "resolution"; met: number; breached: number; attainment: number | null }[];
  workload: { userId: string; name: string; open: number }[];
}

const AGING = ["Under 1 day", "1–3 days", "3–7 days", "7–30 days", "Over 30 days"];

export async function getDashboard(
  tx: Tx,
  actor: Actor,
  opts: { projectId?: string; days?: number; timezone: string },
): Promise<Dashboard> {
  if (actor.role === "requester") throw forbidden();
  const days = Math.min(Math.max(Math.round(opts.days ?? 30), 7), 90);
  const tz = opts.timezone;
  const project = opts.projectId && isUuid(opts.projectId) ? tx`and records.project_id = ${opts.projectId}` : tx``;
  const visible = tx`records.deleted_at is null and ${visibleTo(tx, actor)} ${project}`;
  const [win] = await tx<{ since: string; sinceTs: Date }[]>`
    select d::text as since, (d::timestamp at time zone ${tz}) as since_ts
    from (select (now() at time zone ${tz})::date - ${days - 1}::int as d) x`;
  const since = win!.since;
  const sinceTs = win!.sinceTs;
  const [totals] = await tx<{ open: number; unassigned: number; created: number; resolved: number }[]>`
    select
      count(*) filter (where status_category <> 'done')::int as open,
      count(*) filter (where status_category <> 'done' and assignee_id is null)::int as unassigned,
      count(*) filter (where created_at >= ${sinceTs})::int as created,
      count(*) filter (where resolved_at >= ${sinceTs})::int as resolved
    from records where ${visible}`;
  const [breached] = await tx<{ n: number }[]>`
    select count(distinct records.id)::int as n from sla_clocks c join records on records.id = c.record_id
    where ${visible} and records.status_category <> 'done' and c.breached_at is not null and c.status in ('running', 'paused')`;

  const byCategory = await tx<{ statusCategory: string; n: number }[]>`
    select status_category, count(*)::int as n from records where ${visible} and status_category <> 'done' group by 1`;
  const byPriority = await tx<{ priority: string; n: number }[]>`
    select priority, count(*)::int as n from records where ${visible} and status_category <> 'done' group by 1`;
  const byProject = await tx<{ projectId: string; key: string; name: string; open: number }[]>`
    select p.id as project_id, p.key, p.name, count(records.id)::int as open
    from records join projects p on p.id = records.project_id
    where ${visible} and records.status_category <> 'done'
    group by p.id, p.key, p.name order by open desc, p.key`;
  const aging = await tx<{ bucket: number; n: number }[]>`
    select case
        when now() - created_at < interval '1 day' then 0
        when now() - created_at < interval '3 days' then 1
        when now() - created_at < interval '7 days' then 2
        when now() - created_at < interval '30 days' then 3
        else 4 end as bucket,
      count(*)::int as n
    from records where ${visible} and status_category <> 'done' group by 1`;
  const created = await tx<{ day: string; n: number }[]>`
    select (created_at at time zone ${tz})::date::text as day, count(*)::int as n
    from records where ${visible} and created_at >= ${sinceTs} group by 1`;
  const resolved = await tx<{ day: string; n: number }[]>`
    select (resolved_at at time zone ${tz})::date::text as day, count(*)::int as n
    from records where ${visible} and resolved_at >= ${sinceTs} group by 1`;
  const sla = await tx<{ metric: "first_response" | "resolution"; met: number; breached: number }[]>`
    select c.metric,
      count(*) filter (where c.breached_at is null and c.status = 'met' and c.met_at >= ${sinceTs})::int as met,
      count(*) filter (where c.breached_at >= ${sinceTs})::int as breached
    from sla_clocks c join records on records.id = c.record_id
    where ${visible} and (c.met_at >= ${sinceTs} or c.breached_at >= ${sinceTs})
    group by c.metric`;
  const workload = await tx<{ userId: string; name: string; open: number }[]>`
    select u.id as user_id, u.display_name as name, count(*)::int as open
    from records join users u on u.id = records.assignee_id
    where ${visible} and records.status_category <> 'done'
    group by u.id, u.display_name order by open desc, name limit 10`;

  const throughput: Dashboard["throughput"] = [];
  const start = new Date(`${since}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    const day = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    throughput.push({ day, created: created.find((r) => r.day === day)?.n ?? 0, resolved: resolved.find((r) => r.day === day)?.n ?? 0 });
  }
  const category = (k: string) => byCategory.find((r) => r.statusCategory === k)?.n ?? 0;

  return {
    window: { days, since, timezone: tz },
    totals: {
      open: totals?.open ?? 0,
      unassigned: totals?.unassigned ?? 0,
      createdInWindow: totals?.created ?? 0,
      resolvedInWindow: totals?.resolved ?? 0,
      breachedOpen: breached?.n ?? 0,
    },
    openByCategory: {
      todo: category("todo"),
      in_progress: category("in_progress"),
    },
    openByPriority: {
      low: byPriority.find((r) => r.priority === "low")?.n ?? 0,
      medium: byPriority.find((r) => r.priority === "medium")?.n ?? 0,
      high: byPriority.find((r) => r.priority === "high")?.n ?? 0,
      urgent: byPriority.find((r) => r.priority === "urgent")?.n ?? 0,
    },
    openByProject: byProject,
    aging: AGING.map((bucket, i) => ({ bucket, count: aging.find((a) => a.bucket === i)?.n ?? 0 })),
    throughput,
    sla: (["first_response", "resolution"] as const).map((metric) => {
      const row = sla.find((s) => s.metric === metric);
      const met = row?.met ?? 0;
      const br = row?.breached ?? 0;
      return { metric, met, breached: br, attainment: met + br ? Math.round((met / (met + br)) * 1000) / 10 : null };
    }),
    workload,
  };
}
