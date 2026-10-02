// Planning for agile projects: the ranked backlog with sprints, the sprint board with
// swimlanes, and the burndown and velocity reports.
//
//   /app/plan                         → the first agile project
//   /app/plan/:projectId/backlog      → backlog and sprint planning
//   /app/plan/:projectId/board        → the active sprint's board
//   /app/plan/:projectId/reports      → burndown, velocity, epic progress
import { useCallback, useEffect, useMemo, useState, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { Link, Navigate, NavLink, useNavigate, useParams, useSearchParams } from "react-router";
import { api, issuesByField } from "../api.ts";
import { useSession } from "../session.tsx";
import { Empty, ErrorText, Progress, StatusPill } from "../components/ui.tsx";
import { GroupedBars, LineChart, StatTile } from "../components/charts.tsx";
import type { Backlog, Category, EpicProgress, Project, Sprint, SprintReport, Velocity, WorkflowStatus, WorkRecord } from "../types.ts";

const DAY = 86_400_000;
/** Status names for a project's records (an agile project's types usually share one workflow). */
function statusesOf(project: Project, recordTypeId?: string): WorkflowStatus[] {
  const own = project.recordTypes.find((t) => t.id === recordTypeId)?.workflow.statuses;
  return own ?? project.recordTypes.flatMap((t) => t.workflow.statuses);
}

const fmtPts = (n: number | null | undefined) => (n === null || n === undefined ? "–" : Number.isInteger(n) ? String(n) : n.toFixed(1));
const shortDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");

function errText(err: unknown): string {
  return Object.values(issuesByField(err))[0] ?? (err as Error).message;
}

export function Plan() {
  const { projectId, tab = "backlog" } = useParams();
  const { projects, me } = useSession();
  const agile = projects.filter((p) => p.agile);
  const navigate = useNavigate();
  if (!agile.length) {
    return (
      <section>
        <h1>Planning</h1>
        <Empty>
          No project uses sprints yet.{" "}
          {me?.role === "admin" ? (
            <>
              Install the <Link to="/app/admin">Agile Software Team template</Link>, or turn on agile features in a project's settings.
            </>
          ) : (
            "Ask an admin to turn on agile features for a project."
          )}
        </Empty>
      </section>
    );
  }
  const project = agile.find((p) => p.id === projectId);
  if (!project) return <Navigate to={`/app/plan/${agile[0]!.id}/backlog`} replace />;
  if (!["backlog", "board", "reports"].includes(tab)) return <Navigate to={`/app/plan/${project.id}/backlog`} replace />;

  return (
    <section className="plan">
      <div className="row between wrap">
        <div className="row wrap">
          <h1>{project.name}</h1>
          {agile.length > 1 && (
            <select aria-label="Project" value={project.id} onChange={(e) => navigate(`/app/plan/${e.target.value}/${tab}`)}>
              {agile.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <nav className="toggle" aria-label="Planning views">
          <NavLink to={`/app/plan/${project.id}/backlog`}>Backlog</NavLink>
          <NavLink to={`/app/plan/${project.id}/board`}>Sprint board</NavLink>
          <NavLink to={`/app/plan/${project.id}/reports`}>Reports</NavLink>
        </nav>
      </div>
      {tab === "backlog" && <BacklogView project={project} />}
      {tab === "board" && <SprintBoard project={project} />}
      {tab === "reports" && <Reports project={project} />}
    </section>
  );
}

// ---------------------------------------------------------------- backlog

type Section = { sprint: (Sprint & { records: WorkRecord[] }) | null; records: WorkRecord[] };
type DropAt = { section: string; index: number };

function BacklogView({ project }: { project: Project }) {
  const [data, setData] = useState<Backlog | null>(null);
  const [velocity, setVelocity] = useState<Velocity | null>(null);
  const [epicFilter, setEpicFilter] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<DropAt | null>(null);
  const [dialog, setDialog] = useState<{ kind: "start" | "complete" | "edit"; sprint: Sprint } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const typeName = useMemo(() => new Map(project.recordTypes.map((t) => [t.id, t.name])), [project]);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Backlog>(`/api/projects/${project.id}/backlog`));
    } catch (err) {
      setError(errText(err));
    }
  }, [project.id]);
  useEffect(() => {
    void load();
    void api.get<Velocity>(`/api/projects/${project.id}/velocity`).then(setVelocity).catch(() => {});
  }, [load, project.id]);

  if (!data) return <p className="muted">Loading…</p>;
  const visible = (rs: WorkRecord[]) => (epicFilter === null ? rs : rs.filter((r) => (epicFilter === "none" ? !r.epicId : r.epicId === epicFilter)));
  const sections: Section[] = [...data.sprints.map((s) => ({ sprint: s, records: visible(s.records) })), { sprint: null, records: visible(data.backlog) }];
  const sectionKey = (s: Sprint | null) => s?.id ?? "backlog";
  const active = data.sprints.find((s) => s.state === "active");

  /** Move a record to position `index` of a section (indexes count the visible list without it). */
  async function move(id: string, sprintId: string | null, index: number) {
    setError(null);
    const target = sections.find((s) => sectionKey(s.sprint) === (sprintId ?? "backlog"))!;
    const list = target.records.filter((r) => r.id !== id);
    const after = list[index - 1];
    const before = list[index];
    const rec = sections.flatMap((s) => s.records).find((r) => r.id === id);
    if (!rec) return;
    const body: Record<string, unknown> = {};
    if ((rec.sprintId ?? null) !== sprintId) body.sprintId = sprintId;
    if (after) body.afterId = after.id;
    if (before) body.beforeId = before.id;
    if (!Object.keys(body).length) return;
    // Show the move straight away; the reload brings the server's order.
    setData((d) => {
      if (!d) return d;
      const strip = (rs: WorkRecord[]) => rs.filter((r) => r.id !== id);
      const moved = { ...rec, sprintId };
      const insert = (rs: WorkRecord[]) => {
        const i = before ? rs.findIndex((r) => r.id === before.id) : after ? rs.findIndex((r) => r.id === after.id) + 1 : rs.length;
        return [...rs.slice(0, i < 0 ? rs.length : i), moved, ...rs.slice(i < 0 ? rs.length : i)];
      };
      return {
        ...d,
        sprints: d.sprints.map((s) => ({ ...s, records: s.id === sprintId ? insert(strip(s.records)) : strip(s.records) })),
        backlog: sprintId === null ? insert(strip(d.backlog)) : strip(d.backlog),
      };
    });
    try {
      await api.post(`/api/records/${rec.key}/plan`, body);
    } catch (err) {
      setError(`${rec.key}: ${errText(err)}`);
    }
    await load();
  }

  function onDragOverRow(e: DragEvent, section: string, index: number) {
    if (!dragging) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const below = e.clientY > rect.top + rect.height / 2;
    setDropAt({ section, index: index + (below ? 1 : 0) });
  }
  function onDrop(e: DragEvent, sprintId: string | null) {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/record") || dragging;
    const at = dropAt;
    setDragging(null);
    setDropAt(null);
    if (!id) return;
    const section = sections.find((s) => sectionKey(s.sprint) === (sprintId ?? "backlog"))!;
    // dropAt counts rows including the dragged one when it is in this section; convert.
    let index = at && at.section === (sprintId ?? "backlog") ? at.index : section.records.length;
    const from = section.records.findIndex((r) => r.id === id);
    if (from >= 0 && from < index) index -= 1;
    void move(id, sprintId, index);
  }
  function onRowKey(e: KeyboardEvent, rec: WorkRecord, sprintId: string | null, index: number, count: number) {
    if (!e.altKey) return;
    if (e.key === "ArrowUp" && index > 0) {
      e.preventDefault();
      void move(rec.id, sprintId, index - 1);
    } else if (e.key === "ArrowDown" && index < count - 1) {
      e.preventDefault();
      void move(rec.id, sprintId, index + 1);
    }
  }

  async function createSprint() {
    setError(null);
    try {
      await api.post(`/api/projects/${project.id}/sprints`, {});
      await load();
    } catch (err) {
      setError(errText(err));
    }
  }
  async function deleteSprint(s: Sprint) {
    if (!window.confirm(`Delete ${s.name}? Its ${s.count} item${s.count === 1 ? "" : "s"} go back to the backlog.`)) return;
    try {
      await api.delete(`/api/sprints/${s.id}`);
      await load();
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <div className="with-side plan-backlog">
      <EpicsPanel project={project} epics={data.epics} filter={epicFilter} onFilter={setEpicFilter} onChange={load} />
      <div className="main stack">
        <ErrorText error={error} />
        <p className="muted small">
          Drag items to rank them or plan them into a sprint. With an item focused, Alt+↑ and Alt+↓ move it.
          {velocity?.average !== null && velocity?.average !== undefined && <> Average velocity: {fmtPts(velocity.average)} points per sprint.</>}
        </p>
        {sections.map((section) => {
          const s = section.sprint;
          const key = sectionKey(s);
          const all = s ? s.records : data.backlog;
          const pts = all.reduce((a, r) => a + (r.storyPoints ?? 0), 0);
          return (
            <div
              key={key}
              className={`card sprint ${s?.state ?? "backlog"} ${dragging && dropAt?.section === key ? "drop-target" : ""}`}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                if (dropAt?.section !== key) setDropAt({ section: key, index: section.records.length });
              }}
              onDrop={(e) => onDrop(e, s?.id ?? null)}
            >
              <div className="row between wrap sprint-head">
                <div>
                  <h2>
                    {s ? s.name : "Backlog"}
                    {s?.state === "active" && <span className="tag-mini">active</span>}
                  </h2>
                  <p className="muted small">
                    {all.length} item{all.length === 1 ? "" : "s"} · {fmtPts(pts)} points
                    {s?.state === "active" && s.endAt && <> · ends {shortDate(s.endAt)} ({daysLeft(s.endAt)})</>}
                    {s?.state === "planned" && velocity?.average ? (pts > velocity.average * 1.15 ? " · more than the team usually finishes" : "") : ""}
                    {s?.goal && <> · Goal: {s.goal}</>}
                  </p>
                </div>
                <div className="row">
                  {s?.state === "planned" && (
                    <>
                      <button className="primary" disabled={Boolean(active)} title={active ? `Complete ${active.name} first` : ""} onClick={() => setDialog({ kind: "start", sprint: s })}>
                        Start sprint
                      </button>
                      <button className="subtle" onClick={() => setDialog({ kind: "edit", sprint: s })}>
                        Edit
                      </button>
                      <button className="subtle" onClick={() => deleteSprint(s)}>
                        Delete
                      </button>
                    </>
                  )}
                  {s?.state === "active" && (
                    <>
                      <Link className="button" to={`/app/plan/${project.id}/board`}>
                        Board
                      </Link>
                      <button className="subtle" onClick={() => setDialog({ kind: "edit", sprint: s })}>
                        Edit
                      </button>
                      <button className="primary" onClick={() => setDialog({ kind: "complete", sprint: s })}>
                        Complete sprint
                      </button>
                    </>
                  )}
                  {!s && (
                    <button onClick={createSprint} className="subtle">
                      Create sprint
                    </button>
                  )}
                </div>
              </div>
              {s && dialog?.sprint.id === s.id && dialog.kind === "start" && (
                <StartSprint sprint={s} onClose={() => setDialog(null)} onDone={load} />
              )}
              {s && dialog?.sprint.id === s.id && dialog.kind === "edit" && <EditSprint sprint={s} onClose={() => setDialog(null)} onDone={load} />}
              {s && dialog?.sprint.id === s.id && dialog.kind === "complete" && (
                <CompleteSprint sprint={s} planned={data.sprints.filter((x) => x.state === "planned")} projectId={project.id} onClose={() => setDialog(null)} onDone={load} />
              )}
              <ul className="backlog-list" aria-label={s ? s.name : "Backlog"}>
                {section.records.length === 0 && (
                  <li className="muted small empty-row">{s ? "Drag items here to plan them into this sprint." : epicFilter ? "Nothing in the backlog for this epic." : "The backlog is empty. Add an item below."}</li>
                )}
                {section.records.map((r, i) => (
                  <BacklogRow
                    key={r.id}
                    record={r}
                    typeName={typeName.get(r.recordTypeId) ?? ""}
                    statuses={statusesOf(project, r.recordTypeId)}
                    sprints={data.sprints}
                    dropBefore={dropAt?.section === key && dropAt.index === i && dragging !== r.id}
                    dropAfter={dropAt?.section === key && dropAt.index === i + 1 && i === section.records.length - 1 && dragging !== r.id}
                    dragging={dragging === r.id}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/record", r.id);
                      e.dataTransfer.effectAllowed = "move";
                      setDragging(r.id);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setDropAt(null);
                    }}
                    onDragOver={(e) => onDragOverRow(e, key, i)}
                    onKeyDown={(e) => onRowKey(e, r, s?.id ?? null, i, section.records.length)}
                    onPlan={(sprintId) => move(r.id, sprintId, sprintId === null ? 0 : (sections.find((x) => x.sprint?.id === sprintId)?.records.length ?? 0))}
                    onChange={load}
                  />
                ))}
              </ul>
              {!s && <QuickAdd project={project} epicId={epicFilter && epicFilter !== "none" ? epicFilter : null} onAdded={load} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function initials(name: string): string {
  const parts = name.replace(/\(.*?\)/g, "").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase();
}

function daysLeft(endAt: string): string {
  const d = Math.ceil((new Date(endAt).getTime() - Date.now()) / DAY);
  return d < 0 ? `${-d} day${d === -1 ? "" : "s"} over` : d === 0 ? "ends today" : `${d} day${d === 1 ? "" : "s"} left`;
}

function BacklogRow(props: {
  record: WorkRecord;
  typeName: string;
  statuses: WorkflowStatus[];
  sprints: Sprint[];
  dropBefore: boolean;
  dropAfter: boolean;
  dragging: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onPlan: (sprintId: string | null) => void;
  onChange: () => void;
}) {
  const { record: r } = props;
  const [points, setPoints] = useState(r.storyPoints === null ? "" : String(r.storyPoints));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setPoints(r.storyPoints === null ? "" : String(r.storyPoints)), [r.storyPoints]);
  async function savePoints() {
    const n = points.trim() === "" ? null : Number(points);
    if (n === r.storyPoints || (n !== null && !Number.isFinite(n))) return;
    setError(null);
    try {
      await api.patch(`/api/records/${r.id}`, { version: r.version, storyPoints: n });
      props.onChange();
    } catch (err) {
      setError(errText(err));
      setPoints(r.storyPoints === null ? "" : String(r.storyPoints));
    }
  }
  return (
    <li
      className={`backlog-row ${props.dropBefore ? "drop-before" : ""} ${props.dropAfter ? "drop-after" : ""} ${props.dragging ? "dragging" : ""}`}
      draggable
      tabIndex={0}
      aria-label={`${r.key} ${r.title}`}
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      onDragOver={props.onDragOver}
      onKeyDown={props.onKeyDown}
    >
      <span className="grip" aria-hidden="true">
        ⋮⋮
      </span>
      <span className="type-tag">{props.typeName}</span>
      <Link to={`/app/records/${r.key}`} className="row-key" draggable={false}>
        {r.key}
      </Link>
      <span className="row-title">
        {r.title}
        {error && <span className="error small"> {error}</span>}
      </span>
      <span className="epic-cell">
        {r.epicKey && (
          <span className="epic-chip" title={r.epicTitle ?? ""}>
            {r.epicTitle}
          </span>
        )}
      </span>
      <StatusPill status={r.status} category={r.statusCategory} statuses={props.statuses} />
      <span className="avatar-cell">
        {r.assigneeName && (
          <span className="avatar" title={`Assigned to ${r.assigneeName}`} aria-label={`Assigned to ${r.assigneeName}`}>
            {initials(r.assigneeName)}
          </span>
        )}
      </span>
      <select
        className="plan-select"
        aria-label={`Plan ${r.key}`}
        value={r.sprintId ?? ""}
        onChange={(e) => props.onPlan(e.target.value || null)}
        onClick={(e) => e.stopPropagation()}
      >
        <option value="">Backlog</option>
        {props.sprints.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <input
        className="points-input"
        type="number"
        min={0}
        max={1000}
        step={0.5}
        placeholder="–"
        aria-label={`Story points for ${r.key}`}
        value={points}
        onChange={(e) => setPoints(e.target.value)}
        onBlur={savePoints}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        }}
      />
    </li>
  );
}

function QuickAdd({ project, epicId, onAdded }: { project: Project; epicId: string | null; onAdded: () => void }) {
  const types = project.recordTypes.filter((t) => !t.isEpic);
  // Start with a type the one-line form can create (no required questions).
  const simple = types.find((t) => !t.fields.some((f) => f.required) && !t.layout.requiredOnCreate.length) ?? types[0];
  const [typeId, setTypeId] = useState(simple?.id ?? "");
  const [title, setTitle] = useState("");
  const [points, setPoints] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post("/api/records", { recordTypeId: typeId, title, storyPoints: points ? Number(points) : null, ...(epicId ? { epicId } : {}) });
      setTitle("");
      setPoints("");
      onAdded();
    } catch (err) {
      const issues = issuesByField(err);
      const missing = Object.keys(issues).filter((k) => k.startsWith("custom."));
      setError(missing.length ? `This type needs more details (${missing.map((k) => k.slice(7)).join(", ")}). Use “New record” instead.` : errText(err));
    }
  }
  if (!types.length) return null;
  return (
    <form className="row wrap quick-add" onSubmit={add}>
      <select value={typeId} onChange={(e) => setTypeId(e.target.value)} aria-label="Type">
        {types.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <input className="grow" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" aria-label="Title" required />
      <input className="points-input" type="number" min={0} step={0.5} value={points} onChange={(e) => setPoints(e.target.value)} placeholder="Pts" aria-label="Story points" />
      <button type="submit">Add</button>
      <ErrorText error={error} />
    </form>
  );
}

function EpicsPanel({ project, epics, filter, onFilter, onChange }: { project: Project; epics: EpicProgress[]; filter: string | null; onFilter: (f: string | null) => void; onChange: () => void }) {
  const epicType = project.recordTypes.find((t) => t.isEpic);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function add(e: FormEvent) {
    e.preventDefault();
    if (!epicType) return;
    setError(null);
    try {
      await api.post("/api/records", { recordTypeId: epicType.id, title });
      setTitle("");
      onChange();
    } catch (err) {
      setError(errText(err));
    }
  }
  return (
    <aside className="side epics">
      <h3>Epics</h3>
      <button className={`side-link ${filter === null ? "active" : ""}`} onClick={() => onFilter(null)}>
        All work
      </button>
      {epics.map((e) => (
        <button key={e.id} className={`side-link epic-link ${filter === e.id ? "active" : ""}`} onClick={() => onFilter(filter === e.id ? null : e.id)}>
          <span className="row between">
            <span>{e.title}</span>
            <span className="muted small epic-key">{e.key}</span>
          </span>
          <Progress done={e.donePoints} total={e.points} doneCount={e.doneCount} count={e.count} />
        </button>
      ))}
      {epics.length > 0 && (
        <button className={`side-link ${filter === "none" ? "active" : ""}`} onClick={() => onFilter("none")}>
          Not in an epic
        </button>
      )}
      {epicType ? (
        <form onSubmit={add} className="stack tight">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New epic" aria-label="New epic title" required />
          <button type="submit" className="subtle small">
            Add epic
          </button>
          <ErrorText error={error} />
        </form>
      ) : (
        <p className="muted small">Mark a record type as an epic type in Admin to group work into epics.</p>
      )}
    </aside>
  );
}

function StartSprint({ sprint, onClose, onDone }: { sprint: Sprint; onClose: () => void; onDone: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [goal, setGoal] = useState(sprint.goal);
  const [start, setStart] = useState(today);
  const [weeks, setWeeks] = useState(2);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      // Midday local time, so the sprint's days line up with the calendar days people see.
      const startAt = new Date(`${start}T09:00:00`);
      await api.post(`/api/sprints/${sprint.id}/start`, { goal, startAt: startAt.toISOString(), weeks });
      onClose();
      onDone();
    } catch (err) {
      setError(errText(err));
    }
  }
  return (
    <form className="dialog stack" onSubmit={submit}>
      <h3>Start {sprint.name}</h3>
      <p className="muted small">
        {sprint.count} item{sprint.count === 1 ? "" : "s"}, {fmtPts(sprint.points)} points. Starting records this as the team's commitment.
      </p>
      <label className="field">
        Sprint goal
        <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What the team wants to achieve" />
      </label>
      <div className="row wrap">
        <label className="field">
          Starts
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
        </label>
        <label className="field">
          Length
          <select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>
            {[1, 2, 3, 4].map((w) => (
              <option key={w} value={w}>
                {w} week{w === 1 ? "" : "s"}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorText error={error} />
      <div className="row">
        <button className="primary" type="submit">
          Start sprint
        </button>
        <button type="button" className="subtle" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function EditSprint({ sprint, onClose, onDone }: { sprint: Sprint; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(sprint.name);
  const [goal, setGoal] = useState(sprint.goal);
  const [end, setEnd] = useState(sprint.endAt ? sprint.endAt.slice(0, 10) : "");
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const body: Record<string, unknown> = { name, goal };
      if (sprint.state === "active" && end && end !== sprint.endAt?.slice(0, 10)) body.endAt = new Date(`${end}T18:00:00`).toISOString();
      await api.patch(`/api/sprints/${sprint.id}`, body);
      onClose();
      onDone();
    } catch (err) {
      setError(errText(err));
    }
  }
  return (
    <form className="dialog stack" onSubmit={submit}>
      <div className="row wrap">
        <label className="field grow">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </label>
        {sprint.state === "active" && (
          <label className="field">
            Ends
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
        )}
      </div>
      <label className="field">
        Goal
        <input value={goal} onChange={(e) => setGoal(e.target.value)} />
      </label>
      <ErrorText error={error} />
      <div className="row">
        <button className="primary" type="submit">
          Save
        </button>
        <button type="button" className="subtle" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function CompleteSprint({ sprint, planned, projectId, onClose, onDone }: { sprint: Sprint; planned: Sprint[]; projectId: string; onClose: () => void; onDone: () => void }) {
  const [target, setTarget] = useState<string>(planned[0]?.id ?? "new");
  const [error, setError] = useState<string | null>(null);
  const open = sprint.count - sprint.doneCount;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      let moveTo: string | null = target === "backlog" ? null : target;
      if (target === "new" && open > 0) {
        moveTo = (await api.post<{ sprint: Sprint }>(`/api/projects/${projectId}/sprints`, {})).sprint.id;
      }
      await api.post(`/api/sprints/${sprint.id}/complete`, { moveTo: open > 0 ? moveTo : null });
      onClose();
      onDone();
    } catch (err) {
      setError(errText(err));
    }
  }
  return (
    <form className="dialog stack" onSubmit={submit}>
      <h3>Complete {sprint.name}</h3>
      <p>
        <strong>{sprint.doneCount}</strong> done ({fmtPts(sprint.donePoints)} points) · <strong>{open}</strong> not done ({fmtPts(sprint.points - sprint.donePoints)} points)
      </p>
      {open > 0 && (
        <label className="field">
          Move the unfinished work to
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {planned.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value="new">A new sprint</option>
            <option value="backlog">The backlog</option>
          </select>
        </label>
      )}
      <ErrorText error={error} />
      <div className="row">
        <button className="primary" type="submit">
          Complete sprint
        </button>
        <button type="button" className="subtle" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- sprint board

interface BoardData {
  columns: { key: string; name: string; category: Category; total: number; records: WorkRecord[] }[];
}

type LaneBy = "none" | "epic" | "assignee" | "priority";
const PRIORITY_ORDER = ["urgent", "high", "medium", "low"];

function SprintBoard({ project }: { project: Project }) {
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const lanes = (params.get("lanes") as LaneBy) || "none";
  const mine = params.get("mine") === "1";
  const [sprint, setSprint] = useState<Sprint | null | undefined>(undefined);
  const [board, setBoard] = useState<BoardData | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { sprints } = await api.get<{ sprints: Sprint[] }>(`/api/projects/${project.id}/sprints`);
      const active = sprints.find((s) => s.state === "active") ?? null;
      setSprint(active);
      if (!active) return;
      const q = new URLSearchParams({ projectId: project.id, sprintId: "active", columns: "status", sort: "rank_asc" });
      if (mine) q.set("assigneeId", "me");
      setBoard(await api.get<BoardData>(`/api/board?${q}`));
    } catch (err) {
      setError(errText(err));
    }
  }, [project.id, mine]);
  useEffect(() => {
    void load();
  }, [load]);

  function setParam(k: string, v: string) {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  }

  async function drop(e: DragEvent, toStatus: string) {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/record");
    const rec = board?.columns.flatMap((c) => c.records).find((r) => r.id === id);
    if (!rec || rec.status === toStatus) return;
    const wf = project.recordTypes.find((t) => t.id === rec.recordTypeId)?.workflow;
    const option = (wf?.transitions ?? []).find((t) => t.to === toStatus && (t.from.length === 0 || t.from.includes(rec.status)) && t.roles.includes(me!.role));
    if (!option) {
      setError(`${rec.key} cannot move to that column from where it is.`);
      return;
    }
    setError(null);
    // Move the card at once; the reload confirms it.
    setBoard((b) =>
      b && {
        columns: b.columns.map((c) => ({
          ...c,
          records: c.key === toStatus ? [...c.records, { ...rec, status: toStatus }] : c.records.filter((r) => r.id !== id),
        })),
      },
    );
    try {
      const r = await api.post<{ approval: unknown }>(`/api/records/${rec.key}/transitions`, { transition: option.key, version: rec.version });
      if (r.approval) setError(`${rec.key}: approval requested for “${option.name}”.`);
    } catch (err) {
      setError(`${rec.key}: ${errText(err)}. Open the record to fill in what it needs.`);
    }
    await load();
  }

  if (sprint === undefined) return <p className="muted">Loading…</p>;
  if (sprint === null) {
    return (
      <Empty>
        No sprint is running. <Link to={`/app/plan/${project.id}/backlog`}>Plan and start one from the backlog.</Link>
      </Empty>
    );
  }
  const cards = board?.columns.flatMap((c) => c.records) ?? [];
  const laneOf = (r: WorkRecord): { key: string; name: string } => {
    if (lanes === "epic") return r.epicId ? { key: r.epicId, name: r.epicTitle ?? r.epicKey ?? "Epic" } : { key: "", name: "No epic" };
    if (lanes === "assignee") return r.assigneeId ? { key: r.assigneeId, name: r.assigneeName ?? "Someone" } : { key: "", name: "Unassigned" };
    if (lanes === "priority") return { key: r.priority, name: r.priority[0]!.toUpperCase() + r.priority.slice(1) };
    return { key: "all", name: "" };
  };
  const laneList: { key: string; name: string }[] = [];
  for (const r of cards) {
    const l = laneOf(r);
    if (!laneList.some((x) => x.key === l.key)) laneList.push(l);
  }
  laneList.sort((a, b) => {
    if (lanes === "priority") return PRIORITY_ORDER.indexOf(a.key) - PRIORITY_ORDER.indexOf(b.key);
    if (a.key === "") return 1; // "No epic" / "Unassigned" last
    if (b.key === "") return -1;
    if (lanes === "assignee" && a.key === me?.id) return -1;
    if (lanes === "assignee" && b.key === me?.id) return 1;
    return a.name.localeCompare(b.name);
  });
  if (!laneList.length) laneList.push({ key: "all", name: "" });
  const pct = sprint.points ? Math.round((sprint.donePoints / sprint.points) * 100) : 0;

  return (
    <div className="stack">
      <div className="card sprint-summary">
        <div className="row between wrap">
          <div>
            <h2>{sprint.name}</h2>
            <p className="muted small">
              {shortDate(sprint.startAt)} – {shortDate(sprint.endAt)} · {sprint.endAt ? daysLeft(sprint.endAt) : ""}
              {sprint.goal && <> · Goal: {sprint.goal}</>}
            </p>
          </div>
          <div className="sprint-progress">
            <Progress done={sprint.donePoints} total={sprint.points} doneCount={sprint.doneCount} count={sprint.count} />
            <span className="sr-only">{pct}% of points done</span>
          </div>
        </div>
      </div>
      <div className="filters">
        <label className="inline">
          Swimlanes
          <select value={lanes} onChange={(e) => setParam("lanes", e.target.value === "none" ? "" : e.target.value)}>
            <option value="none">None</option>
            <option value="epic">By epic</option>
            <option value="assignee">By assignee</option>
            <option value="priority">By priority</option>
          </select>
        </label>
        <label className="inline">
          <input type="checkbox" checked={mine} onChange={(e) => setParam("mine", e.target.checked ? "1" : "")} />
          Only my work
        </label>
      </div>
      <ErrorText error={error} />
      {board && (
        <div className="lanes" style={{ ["--cols" as string]: board.columns.length }}>
          <div className="lane-grid lane-columns" aria-hidden="true">
            {board.columns.map((c) => {
              const colPts = c.records.reduce((a, r) => a + (r.storyPoints ?? 0), 0);
              return (
                <div key={c.key} className={`lane-col-head ${c.category}`}>
                  <span>{c.name}</span>
                  <span className="muted">
                    {c.records.length}
                    {colPts ? ` · ${fmtPts(colPts)} pts` : ""}
                  </span>
                </div>
              );
            })}
          </div>
          {laneList.map((lane) => {
            const inLane = cards.filter((r) => laneOf(r).key === lane.key);
            const lanePts = inLane.reduce((a, r) => a + (r.storyPoints ?? 0), 0);
            const isCollapsed = collapsed.has(lane.key);
            return (
              <div key={lane.key || "none"} className="lane">
                {lanes !== "none" && (
                  <button
                    className="lane-head"
                    aria-expanded={!isCollapsed}
                    onClick={() =>
                      setCollapsed((s) => {
                        const n = new Set(s);
                        if (n.has(lane.key)) n.delete(lane.key);
                        else n.add(lane.key);
                        return n;
                      })
                    }
                  >
                    <span aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span> <strong>{lane.name}</strong>
                    <span className="muted small">
                      {inLane.length} item{inLane.length === 1 ? "" : "s"}
                      {lanePts ? ` · ${fmtPts(lanePts)} pts` : ""}
                    </span>
                  </button>
                )}
                {!isCollapsed && (
                  <div className="lane-grid">
                    {board.columns.map((c) => (
                      <div
                        key={c.key}
                        className={`board-col ${c.category}`}
                        aria-label={`${lane.name ? `${lane.name}, ` : ""}${c.name}`}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => drop(e, c.key)}
                      >
                        {c.records
                          .filter((r) => laneOf(r).key === lane.key)
                          .map((r) => (
                            <BoardCard key={r.id} record={r} typeName={project.recordTypes.find((t) => t.id === r.recordTypeId)?.name ?? ""} showEpic={lanes !== "epic"} />
                          ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BoardCard({ record: r, typeName, showEpic }: { record: WorkRecord; typeName: string; showEpic: boolean }) {
  return (
    <Link to={`/app/records/${r.key}`} className="card-mini" draggable onDragStart={(e) => e.dataTransfer.setData("text/record", r.id)}>
      <span className="row between small">
        <span className="muted">
          {typeName} · {r.key}
        </span>
        {r.storyPoints !== null && (
          <span className="points-chip" title="Story points">
            {fmtPts(r.storyPoints)}
          </span>
        )}
      </span>
      <span>{r.title}</span>
      <span className="row small wrap">
        {showEpic && r.epicTitle && <span className="epic-chip">{r.epicTitle}</span>}
        <span className={`pill ${r.priority}`}>{r.priority}</span>
        <span className="muted">{r.assigneeName ?? "Unassigned"}</span>
      </span>
    </Link>
  );
}

// ---------------------------------------------------------------- reports

function Reports({ project }: { project: Project }) {
  const [sprints, setSprints] = useState<Sprint[] | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [report, setReport] = useState<SprintReport | null>(null);
  const [velocity, setVelocity] = useState<Velocity | null>(null);
  const [epics, setEpics] = useState<EpicProgress[]>([]);
  const [table, setTable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [s, v, b] = await Promise.all([
          api.get<{ sprints: Sprint[] }>(`/api/projects/${project.id}/sprints`),
          api.get<Velocity>(`/api/projects/${project.id}/velocity`),
          api.get<Backlog>(`/api/projects/${project.id}/backlog`),
        ]);
        const reportable = s.sprints.filter((x) => x.state !== "planned");
        setSprints(reportable);
        setVelocity(v);
        setEpics(b.epics);
        const active = reportable.find((x) => x.state === "active");
        const latest = [...reportable].filter((x) => x.state === "completed").sort((a, b2) => (b2.completedAt ?? "").localeCompare(a.completedAt ?? ""))[0];
        setSelected((active ?? latest)?.id ?? "");
      } catch (err) {
        setError(errText(err));
      }
    })();
  }, [project.id]);
  useEffect(() => {
    if (!selected) return;
    void api
      .get<SprintReport>(`/api/sprints/${selected}/report`)
      .then(setReport)
      .catch((err) => setError(errText(err)));
  }, [selected]);

  if (!sprints) return <p className="muted">Loading…</p>;
  const s = report?.sprint;
  const lastRemaining = report ? [...report.days].reverse().find((d) => d.remaining !== null)?.remaining ?? null : null;

  return (
    <div className="viz-root stack">
      <ErrorText error={error} />
      {sprints.length === 0 ? (
        <Empty>Reports appear once a sprint has started.</Empty>
      ) : (
        <div className="card">
          <div className="row between wrap">
            <h2>Burndown</h2>
            <div className="row">
              <select aria-label="Sprint" value={selected} onChange={(e) => setSelected(e.target.value)}>
                {sprints.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                    {x.state === "active" ? " (active)" : ""}
                  </option>
                ))}
              </select>
              <button type="button" className="subtle small" onClick={() => setTable((t) => !t)} aria-pressed={table}>
                {table ? "Show chart" : "Show table"}
              </button>
            </div>
          </div>
          {s && report && (
            <>
              <div className="stats four">
                <StatTile label="Committed" value={`${fmtPts(s.committedPoints)} pts`} note={`${s.committedCount ?? 0} items at the start`} />
                <StatTile label="Done" value={`${fmtPts(s.state === "completed" ? s.completedPoints : s.donePoints)} pts`} note={`${s.state === "completed" ? s.completedCount : s.doneCount} items`} />
                <StatTile label="Remaining" value={`${fmtPts(s.state === "completed" ? 0 : lastRemaining)} pts`} note={s.state === "completed" ? "Sprint completed" : s.endAt ? daysLeft(s.endAt) : ""} />
                <StatTile label="Scope change" value={`${report.scopeChange > 0 ? "+" : ""}${fmtPts(report.scopeChange)} pts`} note="Added or re-estimated since the start" />
              </div>
              {table ? (
                <table className="grid compact">
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th className="num">Remaining</th>
                      <th className="num">Ideal</th>
                      <th className="num">Scope</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.days.map((d) => (
                      <tr key={d.index}>
                        <td>{d.date.slice(0, 10)}</td>
                        <td className="num">{fmtPts(d.remaining)}</td>
                        <td className="num">{fmtPts(d.ideal)}</td>
                        <td className="num">{fmtPts(d.scope)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <LineChart
                  title={`Burndown for ${s.name}: story points remaining each day against the ideal line`}
                  days={report.days.map((d) => d.date.slice(0, 10))}
                  series={[
                    { key: "remaining", label: "Remaining", color: "var(--series-1)", values: report.days.map((d) => d.remaining) },
                    { key: "ideal", label: "Ideal", color: "var(--viz-muted)", values: report.days.map((d) => d.ideal), dashed: true },
                  ]}
                />
              )}
            </>
          )}
        </div>
      )}

      <div className="card">
        <h2>Velocity</h2>
        {velocity && velocity.sprints.length ? (
          <>
            <p className="muted small">
              Points committed and completed in the last {velocity.sprints.length} sprint{velocity.sprints.length === 1 ? "" : "s"}.
              {velocity.average !== null && <> The average of the last three is {fmtPts(velocity.average)}: a fair guide for the next sprint.</>}
            </p>
            {table ? (
              <table className="grid compact">
                <thead>
                  <tr>
                    <th>Sprint</th>
                    <th className="num">Committed</th>
                    <th className="num">Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {velocity.sprints.map((v) => (
                    <tr key={v.id}>
                      <td>{v.name}</td>
                      <td className="num">{fmtPts(v.committed)}</td>
                      <td className="num">{fmtPts(v.completed)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <GroupedBars
                title="Velocity: story points committed and completed per sprint"
                categories={velocity.sprints.map((v) => v.name)}
                series={[
                  { key: "committed", label: "Committed", color: "var(--series-1)", values: velocity.sprints.map((v) => v.committed) },
                  { key: "completed", label: "Completed", color: "var(--series-2)", values: velocity.sprints.map((v) => v.completed) },
                ]}
                reference={velocity.average !== null ? { label: "Average", value: velocity.average } : null}
              />
            )}
          </>
        ) : (
          <p className="muted">Velocity appears after the first sprint is completed.</p>
        )}
      </div>

      <div className="card">
        <h2>Epic progress</h2>
        {epics.length ? (
          <table className="grid compact">
            <thead>
              <tr>
                <th>Epic</th>
                <th>Status</th>
                <th>Progress</th>
              </tr>
            </thead>
            <tbody>
              {epics.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Link to={`/app/records/${e.key}`}>{e.key}</Link> {e.title}
                  </td>
                  <td>
                    <StatusPill status={e.status} category={e.statusCategory} statuses={statusesOf(project, project.recordTypes.find((t) => t.isEpic)?.id)} />
                  </td>
                  <td>
                    <Progress done={e.donePoints} total={e.points} doneCount={e.doneCount} count={e.count} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No epics yet.</p>
        )}
      </div>
    </div>
  );
}
