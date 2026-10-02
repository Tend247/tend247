import { useState } from "react";
import { api } from "../api.ts";
import { useSession } from "../session.tsx";
import { useLoad, ErrorText } from "../components/ui.tsx";
import { BarList, LineChart, StatTile } from "../components/charts.tsx";

interface DashboardData {
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

const RANGES = [7, 30, 90];

export function Dashboard() {
  const { projects } = useSession();
  const [days, setDays] = useState(30);
  const [projectId, setProjectId] = useState("");
  const [table, setTable] = useState(false);
  const { data, error } = useLoad(
    () => api.get<DashboardData>(`/api/dashboard?days=${days}${projectId ? `&projectId=${projectId}` : ""}`),
    [days, projectId],
  );

  return (
    <section className="dashboard">
      <div className="row between">
        <h1>Dashboard</h1>
      </div>
      <div className="filters" role="group" aria-label="Dashboard filters">
        <div className="toggle" role="radiogroup" aria-label="Date range">
          {RANGES.map((d) => (
            <button key={d} type="button" role="radio" aria-checked={days === d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>
              Last {d} days
            </button>
          ))}
        </div>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <ErrorText error={error?.message} />
      {data && (
        <div className={`viz-root stack`}>
          <div className="stats">
            <StatTile hero label="Open now" value={data.totals.open.toLocaleString()} note={`${data.openByCategory.todo} not started · ${data.openByCategory.in_progress} in progress`} />
            <StatTile label="Unassigned" value={data.totals.unassigned.toLocaleString()} />
            <StatTile label={`Created, last ${data.window.days} days`} value={data.totals.createdInWindow.toLocaleString()} />
            <StatTile label={`Resolved, last ${data.window.days} days`} value={data.totals.resolvedInWindow.toLocaleString()} />
            <StatTile
              label="Open and past an SLA target"
              value={data.totals.breachedOpen.toLocaleString()}
              status={data.totals.breachedOpen ? "critical" : "good"}
              note={data.totals.breachedOpen ? "Needs attention" : "None breached"}
            />
          </div>

          <div className="card">
            <div className="row between">
              <h2>Created and resolved per day</h2>
              <button type="button" className="subtle small" onClick={() => setTable((t) => !t)} aria-pressed={table}>
                {table ? "Show chart" : "Show table"}
              </button>
            </div>
            {table ? (
              <table className="grid compact">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th className="num">Created</th>
                    <th className="num">Resolved</th>
                  </tr>
                </thead>
                <tbody>
                  {data.throughput.map((t) => (
                    <tr key={t.day}>
                      <td>{t.day}</td>
                      <td className="num">{t.created}</td>
                      <td className="num">{t.resolved}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <LineChart
                title="Records created and resolved per day"
                days={data.throughput.map((t) => t.day)}
                series={[
                  { key: "created", label: "Created", color: "var(--series-1)", values: data.throughput.map((t) => t.created) },
                  { key: "resolved", label: "Resolved", color: "var(--series-2)", values: data.throughput.map((t) => t.resolved) },
                ]}
              />
            )}
          </div>

          <div className="columns-2">
            <div className="card">
              <h2>SLA attainment, last {data.window.days} days</h2>
              <div className="stats two">
                {data.sla.map((s) => (
                  <StatTile
                    key={s.metric}
                    label={s.metric === "first_response" ? "First response met" : "Resolution met"}
                    value={s.attainment === null ? "—" : `${s.attainment}%`}
                    note={s.attainment === null ? "No targets came due" : `${s.met} met · ${s.breached} breached`}
                  />
                ))}
              </div>
            </div>
            <div className="card">
              <h2>How long open work has waited</h2>
              <BarList label="Open records by age" items={data.aging.map((a) => ({ label: a.bucket, value: a.count }))} />
            </div>
            <div className="card">
              <h2>Open by priority</h2>
              <BarList
                label="Open records by priority"
                items={(["urgent", "high", "medium", "low"] as const).map((p) => ({ label: p[0]!.toUpperCase() + p.slice(1), value: data.openByPriority[p] }))}
              />
            </div>
            <div className="card">
              <h2>Open by project</h2>
              {data.openByProject.length ? (
                <BarList label="Open records by project" items={data.openByProject.map((p) => ({ label: p.name, value: p.open }))} />
              ) : (
                <p className="muted">Nothing open.</p>
              )}
            </div>
          </div>

          <div className="card">
            <h2>Workload</h2>
            {data.workload.length ? (
              <BarList label="Open records per assignee" items={data.workload.map((w) => ({ label: w.name, value: w.open }))} />
            ) : (
              <p className="muted">No open work is assigned.</p>
            )}
            <p className="muted small">Times are in {data.window.timezone}.</p>
          </div>
        </div>
      )}
    </section>
  );
}
