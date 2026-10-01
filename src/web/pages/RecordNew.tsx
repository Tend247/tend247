import { useMemo, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api, issuesByField } from "../api.ts";
import { useSession } from "../session.tsx";
import { FieldInput } from "../components/FieldInput.tsx";
import type { Priority, WorkRecord } from "../types.ts";

export function RecordNew() {
  const { projects, people, me } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const types = useMemo(
    () => projects.flatMap((p) => p.recordTypes.map((t) => ({ ...t, projectName: p.name }))),
    [projects],
  );
  const [recordTypeId, setRecordTypeId] = useState(params.get("recordTypeId") ?? types[0]?.id ?? "");
  const type = types.find((t) => t.id === recordTypeId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [assigneeId, setAssigneeId] = useState("");
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  if (types.length === 0) {
    return <p className="muted">No record types exist yet. An admin can add one under Admin.</p>;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const values = Object.fromEntries(Object.entries(custom).filter(([, v]) => v !== null && v !== ""));
      const { record } = await api.post<{ record: WorkRecord }>("/api/records", {
        recordTypeId,
        title,
        description,
        priority,
        assigneeId: assigneeId || null,
        custom: values,
      });
      navigate(`/app/records/${record.key}`);
    } catch (err) {
      setErrors({ _: (err as Error).message, ...issuesByField(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="narrow">
      <h1>New record</h1>
      <form onSubmit={submit} className="stack">
        <label className="field">
          Type
          <select value={recordTypeId} onChange={(e) => setRecordTypeId(e.target.value)}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.projectName} · {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>
            Title<span className="req"> *</span>
          </span>
          <input required value={title} onChange={(e) => setTitle(e.target.value)} />
          {errors.title && <span className="error small">{errors.title}</span>}
        </label>
        <label className="field">
          Description
          <textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="row">
          <label className="field">
            Priority
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
          {me?.role !== "requester" && (
            <label className="field">
              Assignee
              <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                <option value="">Unassigned</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {type?.fields.map((f) => (
          <FieldInput
            key={f.id}
            field={f}
            people={people}
            value={custom[f.key] ?? f.defaultValue ?? null}
            error={errors[`custom.${f.key}`]}
            onChange={(v) => setCustom((c) => ({ ...c, [f.key]: v }))}
          />
        ))}
        {errors._ && <p className="error">{errors._}</p>}
        <div className="row">
          <button type="submit" className="primary" disabled={busy}>
            Create
          </button>
          <button type="button" className="subtle" onClick={() => navigate(-1)}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
