import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { api, ApiError, issuesByField } from "../api.ts";
import { personName, useSession } from "../session.tsx";
import { FieldInput, formatValue } from "../components/FieldInput.tsx";
import type { Field, Priority, RecordEvent, WorkRecord } from "../types.ts";

export function RecordDetail() {
  const { key = "" } = useParams();
  const { projects, people, me } = useSession();
  const navigate = useNavigate();
  const [record, setRecord] = useState<WorkRecord | null>(null);
  const [events, setEvents] = useState<RecordEvent[]>([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<WorkRecord>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ record: WorkRecord }>(`/api/records/${key}`);
      setRecord(r.record);
      const ev = await api.get<{ events: RecordEvent[] }>(`/api/records/${key}/events`);
      setEvents(ev.events);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
    }
  }, [key]);

  useEffect(() => {
    void load();
  }, [load]);

  if (notFound) return <p className="muted">Record not found.</p>;
  if (!record) return <p className="muted">Loading…</p>;

  const type = projects.flatMap((p) => p.recordTypes).find((t) => t.id === record.recordTypeId);
  const fields: Field[] = type?.fields ?? [];
  const staff = me?.role !== "requester";
  const fieldLabel = (path: string) =>
    path.startsWith("custom.")
      ? fields.find((f) => `custom.${f.key}` === path)?.label ?? path.slice(7)
      : ({ title: "Title", description: "Description", priority: "Priority", assigneeId: "Assignee", requesterId: "Requester" } as Record<string, string>)[path] ?? path;

  function startEdit() {
    setDraft({ title: record!.title, description: record!.description, priority: record!.priority, assigneeId: record!.assigneeId, custom: { ...record!.custom } });
    setErrors({});
    setEditing(true);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const custom: Record<string, unknown> = {};
    for (const f of fields) {
      const before = record!.custom[f.key] ?? null;
      const after = draft.custom?.[f.key] ?? null;
      if (JSON.stringify(before) !== JSON.stringify(after)) custom[f.key] = after === "" ? null : after;
    }
    try {
      const r = await api.patch<{ record: WorkRecord }>(`/api/records/${record!.id}`, {
        version: record!.version,
        title: draft.title,
        description: draft.description,
        priority: draft.priority,
        assigneeId: draft.assigneeId ?? null,
        custom,
      });
      setRecord(r.record);
      setEditing(false);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === "version_conflict") {
        setErrors({ _: "Someone else changed this record while you were editing. Reload to see their changes." });
      } else setErrors({ _: (err as Error).message, ...issuesByField(err) });
    }
  }

  async function remove() {
    if (!window.confirm(`Move ${record!.key} to the trash? An admin can restore it.`)) return;
    await api.delete(`/api/records/${record!.id}`);
    navigate("/app");
  }

  return (
    <section className="detail">
      <div className="row between">
        <div>
          <p className="muted small">
            {record.key} · {type?.name}
          </p>
          <h1>{record.title}</h1>
        </div>
        {staff && !editing && (
          <div className="row">
            <button onClick={startEdit}>Edit</button>
            <button className="subtle danger" onClick={remove}>
              Delete
            </button>
          </div>
        )}
      </div>

      {editing ? (
        <form onSubmit={save} className="stack narrow">
          <label className="field">
            Title
            <input value={draft.title ?? ""} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </label>
          <label className="field">
            Description
            <textarea rows={5} value={draft.description ?? ""} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </label>
          <div className="row">
            <label className="field">
              Priority
              <select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value as Priority })}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>
            <label className="field">
              Assignee
              <select value={draft.assigneeId ?? ""} onChange={(e) => setDraft({ ...draft, assigneeId: e.target.value || null })}>
                <option value="">Unassigned</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {fields.map((f) => (
            <FieldInput
              key={f.id}
              field={f}
              people={people}
              value={draft.custom?.[f.key] ?? null}
              error={errors[`custom.${f.key}`]}
              onChange={(v) => setDraft({ ...draft, custom: { ...draft.custom, [f.key]: v } })}
            />
          ))}
          {errors._ && <p className="error">{errors._}</p>}
          <div className="row">
            <button className="primary" type="submit">
              Save
            </button>
            <button className="subtle" type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="columns">
          <div>
            <p className="prewrap">{record.description || <span className="muted">No description.</span>}</p>
          </div>
          <dl className="props">
            <dt>Status</dt>
            <dd>{record.status}</dd>
            <dt>Priority</dt>
            <dd>
              <span className={`pill ${record.priority}`}>{record.priority}</span>
            </dd>
            <dt>Assignee</dt>
            <dd>{personName(people, record.assigneeId)}</dd>
            <dt>Requester</dt>
            <dd>{personName(people, record.requesterId)}</dd>
            {fields.map((f) => (
              <div key={f.id} className="contents">
                <dt>{f.label}</dt>
                <dd>{formatValue(f, record.custom[f.key], people)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <h2>History</h2>
      <ol className="timeline">
        {events.map((ev) => (
          <li key={ev.id}>
            <span className="muted small">{new Date(ev.createdAt).toLocaleString()}</span>{" "}
            <strong>{ev.actorName ?? "System"}</strong>{" "}
            {ev.kind === "updated" ? (
              <>
                changed{" "}
                {(ev.data.changes ?? []).map((c) => fieldLabel(c.field)).join(", ")}
              </>
            ) : (
              ({ created: "created this record", deleted: "moved it to the trash", restored: "restored it from the trash" } as Record<string, string>)[ev.kind] ?? ev.kind
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
