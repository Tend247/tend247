import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api, issuesByField } from "../api.ts";
import { allRecordTypes, useSession } from "../session.tsx";
import { FieldInput } from "../components/FieldInput.tsx";
import { ErrorText } from "../components/ui.tsx";
import type { Priority, WorkRecord } from "../types.ts";

export function RecordNew() {
  const { projects, people, teams, me } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const types = allRecordTypes(projects);
  const [recordTypeId, setRecordTypeId] = useState(params.get("recordTypeId") ?? types[0]?.id ?? "");
  const type = types.find((t) => t.id === recordTypeId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [assigneeId, setAssigneeId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const staff = me?.role !== "requester";

  if (types.length === 0) {
    return <p className="muted">There is nothing to submit to yet. An admin can add record types under Admin.</p>;
  }

  const required = new Set(type?.layout.requiredOnCreate ?? []);
  const sections = type?.layout.create.sections ?? [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    const onForm = new Set(sections.flatMap((s) => s.fields));
    try {
      const values = Object.fromEntries(Object.entries(custom).filter(([k, v]) => v !== null && v !== "" && (staff || onForm.has(k))));
      const { record } = await api.post<{ record: WorkRecord }>("/api/records", {
        recordTypeId,
        title,
        description,
        ...(staff || onForm.has("priority") ? { priority } : {}),
        ...(staff ? { assigneeId: assigneeId || null, ...(teamId ? { teamId } : {}) } : {}),
        custom: values,
      });
      navigate(`/app/records/${record.key}`);
    } catch (err) {
      setErrors({ _: (err as Error).message, ...issuesByField(err) });
    } finally {
      setBusy(false);
    }
  }

  function renderField(key: string) {
    const req = required.has(key);
    const label = (text: string) => (
      <span>
        {text}
        {req && <span className="req"> *</span>}
      </span>
    );
    switch (key) {
      case "description":
        return (
          <label className="field" key={key}>
            {label("Description")}
            <textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
            {errors.description && <span className="error small">{errors.description}</span>}
          </label>
        );
      case "priority":
        return (
          <label className="field" key={key}>
            {label("Priority")}
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
        );
      case "assigneeId":
        if (!staff) return null;
        return (
          <label className="field" key={key}>
            {label("Assignee")}
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">{type?.project.assignment === "round_robin" ? "Next in rotation" : "Unassigned"}</option>
              {people.filter((p) => p.role !== "requester").map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
        );
      case "teamId":
        if (!staff) return null;
        return (
          <label className="field" key={key}>
            {label("Team")}
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">Project default</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        );
      default: {
        const f = type?.fields.find((x) => x.key === key);
        if (!f) return null;
        return (
          <FieldInput
            key={f.id}
            field={{ ...f, required: f.required || req }}
            people={people}
            value={custom[f.key] ?? f.defaultValue ?? null}
            error={errors[`custom.${f.key}`]}
            onChange={(v) => setCustom((c) => ({ ...c, [f.key]: v }))}
          />
        );
      }
    }
  }

  // Staff also get the routing fields when the layout leaves them out.
  const extras = staff ? (["priority", "assigneeId", "teamId"] as const).filter((k) => !sections.some((s) => s.fields.includes(k))) : [];

  return (
    <section className="narrow">
      <h1>New record</h1>
      <form onSubmit={submit} className="stack">
        <label className="field">
          Type
          <select value={recordTypeId} onChange={(e) => setRecordTypeId(e.target.value)}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.project.name} · {t.name}
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
        {sections.map((s, i) => (
          <fieldset key={i} className="section">
            {s.title && <legend>{s.title}</legend>}
            {s.fields.map(renderField)}
          </fieldset>
        ))}
        {extras.length > 0 && (
          <fieldset className="section">
            <legend>Routing</legend>
            <div className="row wrap">{extras.map(renderField)}</div>
          </fieldset>
        )}
        <ErrorText error={errors._} />
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
