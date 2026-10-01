import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api.ts";
import { personName, useSession } from "../session.tsx";
import type { WorkRecord } from "../types.ts";

interface Page {
  items: WorkRecord[];
  nextCursor: string | null;
}

export function RecordList() {
  const { projects, people, me } = useSession();
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<WorkRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState(params.get("q") ?? "");

  const projectId = params.get("projectId") ?? "";
  const assignee = params.get("assigneeId") ?? "";
  const query = useMemo(() => {
    const p = new URLSearchParams();
    for (const k of ["projectId", "assigneeId", "statusCategory", "q"]) {
      const v = params.get(k);
      if (v) p.set(k, v);
    }
    return p;
  }, [params]);

  useEffect(() => {
    setLoading(true);
    api
      .get<Page>(`/api/records?${query}`)
      .then((page) => {
        setRows(page.items);
        setCursor(page.nextCursor);
      })
      .finally(() => setLoading(false));
  }, [query]);

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
    setParams(next);
  }

  const typeName = (id: string) =>
    projects.flatMap((p) => p.recordTypes).find((t) => t.id === id)?.name ?? "";

  return (
    <section>
      <div className="row between">
        <h1>Records</h1>
        <Link className="button primary" to="/app/records/new">
          New record
        </Link>
      </div>
      <div className="filters">
        <select value={projectId} onChange={(e) => setFilter("projectId", e.target.value)} aria-label="Project">
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {me?.role !== "requester" && (
          <select value={assignee} onChange={(e) => setFilter("assigneeId", e.target.value)} aria-label="Assignee">
            <option value="">Anyone</option>
            <option value="me">Assigned to me</option>
            <option value="none">Unassigned</option>
          </select>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setFilter("q", q);
          }}
        >
          <input type="search" placeholder="Search title, key or description" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
      </div>
      {loading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No records match. Create one with “New record”.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Key</th>
              <th>Title</th>
              <th>Type</th>
              <th>Priority</th>
              <th>Assignee</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link to={`/app/records/${r.key}`}>{r.key}</Link>
                </td>
                <td>{r.title}</td>
                <td className="muted">{typeName(r.recordTypeId)}</td>
                <td>
                  <span className={`pill ${r.priority}`}>{r.priority}</span>
                </td>
                <td>{personName(people, r.assigneeId)}</td>
                <td className="muted">{new Date(r.updatedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cursor && (
        <button className="subtle" onClick={more}>
          Load more
        </button>
      )}
    </section>
  );
}
