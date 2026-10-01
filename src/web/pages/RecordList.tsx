import { useEffect, useMemo, useState, type DragEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api.ts";
import { allRecordTypes, useSession } from "../session.tsx";
import { Empty, ErrorText, StatusPill, timeAgo } from "../components/ui.tsx";
import type { Category, Priority, SavedView, WorkRecord, Workflow } from "../types.ts";

interface Page {
  items: WorkRecord[];
  nextCursor: string | null;
}

interface Board {
  columns: { key: string; name: string; category: Category; total: number; records: WorkRecord[] }[];
}

const FILTER_KEYS = ["projectId", "recordTypeId", "statusCategory", "priority", "assigneeId", "teamId", "requesterId", "sla", "q"];
const SORTS: [string, string][] = [
  ["created_desc", "Newest"],
  ["updated_desc", "Recently updated"],
  ["priority_desc", "Priority"],
  ["due_asc", "SLA due soonest"],
  ["created_asc", "Oldest"],
  ["key_asc", "Key"],
];

export function RecordList() {
  const { projects, people, teams, me } = useSession();
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<WorkRecord[]>([]);
  const [board, setBoard] = useState<Board | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState(params.get("q") ?? "");
  const [views, setViews] = useState<SavedView[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const staff = me?.role !== "requester";
  const mode = params.get("mode") === "board" ? "board" : "list";
  const types = allRecordTypes(projects);
  const recordTypeId = params.get("recordTypeId") ?? "";
  const workflowOf = (id: string): Workflow | undefined => types.find((t) => t.id === id)?.workflow;

  const query = useMemo(() => {
    const p = new URLSearchParams();
    for (const k of [...FILTER_KEYS, "sort"]) {
      const v = params.get(k);
      if (v) p.set(k, v);
    }
    return p;
  }, [params]);

  useEffect(() => {
    setLoading(true);
    setSelected(new Set());
    const load =
      mode === "board"
        ? api.get<Board>(`/api/board?${query}`).then((b) => setBoard(b))
        : api.get<Page>(`/api/records?${query}`).then((page) => {
            setRows(page.items);
            setCursor(page.nextCursor);
          });
    load.catch((e) => setError((e as Error).message)).finally(() => setLoading(false));
  }, [query, mode, tick]);

  useEffect(() => {
    api.get<{ views: SavedView[] }>("/api/views").then((r) => setViews(r.views)).catch(() => {});
  }, []);

  async function more() {
    if (!cursor) return;
    const page = await api.get<Page>(`/api/records?${query}&cursor=${cursor}`);
    setRows((r) => [...r, ...page.items]);
    setCursor(page.nextCursor);
  }

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === "projectId") next.delete("recordTypeId");
    setParams(next);
  }

  function applyView(v: SavedView) {
    const next = new URLSearchParams();
    for (const [k, val] of Object.entries(v.definition.filters)) next.set(k, Array.isArray(val) ? val.join(",") : String(val));
    if (v.definition.sort) next.set("sort", v.definition.sort);
    if (v.definition.mode === "board") next.set("mode", "board");
    next.set("view", v.id);
    setParams(next);
    setQ(next.get("q") ?? "");
  }

  async function saveView() {
    const name = window.prompt("Name this view");
    if (!name) return;
    const shared = staff && window.confirm("Share this view with your team? (Cancel keeps it personal)");
    const filters: Record<string, string> = {};
    for (const k of FILTER_KEYS) if (params.get(k)) filters[k] = params.get(k)!;
    const r = await api.post<{ view: SavedView }>("/api/views", {
      name,
      shared,
      definition: { filters, sort: params.get("sort") || undefined, mode },
    });
    setViews((v) => [...v, r.view]);
    setFilter("view", r.view.id);
  }

  async function deleteView(id: string) {
    if (!window.confirm("Delete this saved view?")) return;
    await api.delete(`/api/views/${id}`);
    setViews((v) => v.filter((x) => x.id !== id));
  }

  async function bulk(body: Record<string, unknown>) {
    setError(null);
    const r = await api.post<{ updated: number; results: { ok: boolean; key?: string; id: string; error?: string }[] }>("/api/records/bulk", {
      ids: [...selected],
      ...body,
    });
    const failed = r.results.filter((x) => !x.ok);
    if (failed.length) setError(`${r.updated} updated; ${failed.length} not: ${failed.map((f) => f.error).join("; ")}`);
    setTick((t) => t + 1);
  }

  // Board: drop a card on a column to run the one transition that leads there.
  async function drop(e: DragEvent, toStatus: string) {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/record");
    const rec = board?.columns.flatMap((c) => c.records).find((r) => r.id === id);
    if (!rec || rec.status === toStatus) return;
    const wf = workflowOf(rec.recordTypeId);
    const options = (wf?.transitions ?? []).filter(
      (t) => t.to === toStatus && (t.from.length === 0 || t.from.includes(rec.status)) && t.roles.includes(me!.role),
    );
    if (options.length === 0) {
      setError(`No transition leads from ${rec.status} to ${toStatus} for ${rec.key}.`);
      return;
    }
    try {
      const r = await api.post<{ approval: unknown }>(`/api/records/${rec.key}/transitions`, { transition: options[0]!.key, version: rec.version });
      if (r.approval) setError(`${rec.key}: approval requested for “${options[0]!.name}”.`);
      setTick((t) => t + 1);
    } catch (err) {
      setError(`${rec.key}: ${(err as Error).message}. Open the record to fill in what it needs.`);
    }
  }

  const activeView = params.get("view");
  const projectTypes = types.filter((t) => !params.get("projectId") || t.projectId === params.get("projectId"));
  const bulkTransitions = useMemo(() => {
    const keys = new Map<string, string>();
    for (const r of rows.filter((x) => selected.has(x.id))) {
      for (const t of workflowOf(r.recordTypeId)?.transitions ?? []) keys.set(t.key, t.name);
    }
    return [...keys];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, rows]);

  return (
    <section className="with-side">
      <aside className="side">
        <h3>Views</h3>
        <button className={`side-link ${!activeView && params.toString() === "" ? "active" : ""}`} onClick={() => setParams(new URLSearchParams())}>
          All records
        </button>
        {staff && (
          <>
            <button className="side-link" onClick={() => setParams(new URLSearchParams({ assigneeId: "me", statusCategory: "todo,in_progress" }))}>
              My open work
            </button>
            <button className="side-link" onClick={() => setParams(new URLSearchParams({ teamId: "mine", assigneeId: "none", statusCategory: "todo,in_progress" }))}>
              Unassigned in my teams
            </button>
            <button className="side-link" onClick={() => setParams(new URLSearchParams({ sla: "breached" }))}>
              SLA breached
            </button>
          </>
        )}
        {views.map((v) => (
          <div key={v.id} className={`side-view ${activeView === v.id ? "active" : ""}`}>
            <button className="side-link" onClick={() => applyView(v)}>
              {v.name}
              {v.shared && <span className="muted small"> · shared</span>}
            </button>
            {(v.ownerId === me?.id || me?.role === "admin") && (
              <button className="link small" aria-label={`Delete view ${v.name}`} onClick={() => deleteView(v.id)}>
                ×
              </button>
            )}
          </div>
        ))}
        <button className="subtle small" onClick={saveView}>
          Save current view
        </button>
      </aside>

      <div className="main">
        <div className="row between">
          <h1>Records</h1>
          <div className="row">
            <div className="toggle" role="group" aria-label="Display">
              <button className={mode === "list" ? "on" : ""} onClick={() => setFilter("mode", "")}>
                List
              </button>
              <button className={mode === "board" ? "on" : ""} onClick={() => setFilter("mode", "board")}>
                Board
              </button>
            </div>
            <Link className="button primary" to="/app/records/new">
              New record
            </Link>
          </div>
        </div>

        <div className="filters">
          <select value={params.get("projectId") ?? ""} onChange={(e) => setFilter("projectId", e.target.value)} aria-label="Project">
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select value={recordTypeId} onChange={(e) => setFilter("recordTypeId", e.target.value)} aria-label="Record type">
            <option value="">All types</option>
            {projectTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <select value={params.get("statusCategory") ?? ""} onChange={(e) => setFilter("statusCategory", e.target.value)} aria-label="Status">
            <option value="">Any status</option>
            <option value="todo,in_progress">Open</option>
            <option value="todo">To do</option>
            <option value="in_progress">In progress</option>
            <option value="done">Done</option>
          </select>
          <select value={params.get("priority") ?? ""} onChange={(e) => setFilter("priority", e.target.value)} aria-label="Priority">
            <option value="">Any priority</option>
            <option value="urgent,high">High and urgent</option>
            {(["urgent", "high", "medium", "low"] as Priority[]).map((p) => (
              <option key={p} value={p}>
                {p[0]!.toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
          {staff && (
            <>
              <select value={params.get("assigneeId") ?? ""} onChange={(e) => setFilter("assigneeId", e.target.value)} aria-label="Assignee">
                <option value="">Anyone</option>
                <option value="me">Assigned to me</option>
                <option value="none">Unassigned</option>
                {people.filter((p) => p.role !== "requester").map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
              <select value={params.get("teamId") ?? ""} onChange={(e) => setFilter("teamId", e.target.value)} aria-label="Team">
                <option value="">Any team</option>
                <option value="mine">My teams</option>
                <option value="none">No team</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <select value={params.get("sla") ?? ""} onChange={(e) => setFilter("sla", e.target.value)} aria-label="SLA">
                <option value="">Any SLA</option>
                <option value="at_risk">At risk</option>
                <option value="breached">Breached</option>
              </select>
            </>
          )}
          {mode === "list" && (
            <select value={params.get("sort") ?? "created_desc"} onChange={(e) => setFilter("sort", e.target.value === "created_desc" ? "" : e.target.value)} aria-label="Sort">
              {SORTS.map(([v, l]) => (
                <option key={v} value={v}>
                  Sort: {l}
                </option>
              ))}
            </select>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setFilter("q", q);
            }}
          >
            <input type="search" placeholder="Search titles, descriptions, comments, or a key like FIN-12" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
        </div>

        {staff && selected.size > 0 && mode === "list" && (
          <div className="bulkbar">
            <strong>{selected.size} selected</strong>
            <select defaultValue="" onChange={(e) => e.target.value && bulk({ patch: { assigneeId: e.target.value === "none" ? null : e.target.value } })} aria-label="Assign selected">
              <option value="">Assign to…</option>
              <option value={me!.id}>Me</option>
              <option value="none">Nobody</option>
              {people.filter((p) => p.role !== "requester" && p.id !== me!.id).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
            <select defaultValue="" onChange={(e) => e.target.value && bulk({ patch: { priority: e.target.value } })} aria-label="Set priority">
              <option value="">Priority…</option>
              {["urgent", "high", "medium", "low"].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <select defaultValue="" onChange={(e) => e.target.value && bulk({ patch: { teamId: e.target.value === "none" ? null : e.target.value } })} aria-label="Set team">
              <option value="">Team…</option>
              <option value="none">No team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            {bulkTransitions.length > 0 && (
              <select defaultValue="" onChange={(e) => e.target.value && bulk({ transition: e.target.value })} aria-label="Move selected">
                <option value="">Move…</option>
                {bulkTransitions.map(([k, name]) => (
                  <option key={k} value={k}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            <button className="subtle" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        )}
        <ErrorText error={error} />

        {loading ? (
          <p className="muted">Loading…</p>
        ) : mode === "board" && board ? (
          <>
          {!recordTypeId && <p className="muted small">Pick a record type to see its workflow's columns and drag cards between them.</p>}
          <div className="board">
            {board.columns.map((col) => (
              <div key={col.key} className={`board-col ${col.category}`} onDragOver={(e) => e.preventDefault()} onDrop={(e) => drop(e, col.key)}>
                <div className="board-head">
                  <span>{col.name}</span>
                  <span className="muted">{col.total}</span>
                </div>
                {col.records.map((r) => (
                  <Link
                    key={r.id}
                    to={`/app/records/${r.key}`}
                    className="card-mini"
                    draggable={staff && Boolean(recordTypeId)}
                    onDragStart={(e) => e.dataTransfer.setData("text/record", r.id)}
                  >
                    <span className="small muted">{r.key}</span>
                    <span>{r.title}</span>
                    <span className="row small">
                      <span className={`pill ${r.priority}`}>{r.priority}</span>
                      <span className="muted">{r.assigneeName ?? "Unassigned"}</span>
                    </span>
                  </Link>
                ))}
                {col.total > col.records.length && <p className="muted small">+{col.total - col.records.length} more</p>}
              </div>
            ))}
          </div>
          </>
        ) : rows.length === 0 ? (
          <Empty>No records match. Create one with “New record”.</Empty>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                {staff && (
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={selected.size === rows.length}
                      onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                    />
                  </th>
                )}
                <th>Key</th>
                <th>Title</th>
                <th>Status</th>
                <th>Priority</th>
                {staff && <th>Assignee</th>}
                {staff && <th>Team</th>}
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={selected.has(r.id) ? "selected" : ""}>
                  {staff && (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.key}`}
                        checked={selected.has(r.id)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(r.id);
                          else next.delete(r.id);
                          setSelected(next);
                        }}
                      />
                    </td>
                  )}
                  <td>
                    <Link to={`/app/records/${r.key}`}>{r.key}</Link>
                  </td>
                  <td>
                    {r.title}
                    {r.pendingApprovalId && <span className="tag-mini">awaiting approval</span>}
                  </td>
                  <td>
                    <StatusPill status={r.status} category={r.statusCategory} statuses={workflowOf(r.recordTypeId)?.statuses} />
                  </td>
                  <td>
                    <span className={`pill ${r.priority}`}>{r.priority}</span>
                  </td>
                  {staff && <td>{r.assigneeName ?? <span className="muted">Unassigned</span>}</td>}
                  {staff && <td className="muted">{r.teamName ?? ""}</td>}
                  <td className="muted" title={new Date(r.updatedAt).toLocaleString()}>
                    {timeAgo(r.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {mode === "list" && cursor && (
          <button className="subtle" onClick={more}>
            Load more
          </button>
        )}
      </div>
    </section>
  );
}
