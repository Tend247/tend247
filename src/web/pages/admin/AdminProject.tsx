import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { api, issuesByField } from "../../api.ts";
import { useSession } from "../../session.tsx";
import type { Field, FieldType, Project } from "../../types.ts";
import { ErrorText } from "../../components/ui.tsx";
import { SlaEditor } from "./SlaEditor.tsx";
import { AdminNav } from "./AdminProjects.tsx";

const TYPES: { value: FieldType; label: string }[] = [
  { value: "text", label: "Short text" },
  { value: "long_text", label: "Long text" },
  { value: "number", label: "Number" },
  { value: "currency", label: "Currency" },
  { value: "date", label: "Date" },
  { value: "select", label: "Single choice" },
  { value: "multi_select", label: "Multiple choice" },
  { value: "user", label: "Person" },
  { value: "checkbox", label: "Checkbox" },
  { value: "url", label: "Web address" },
];

export function AdminProject() {
  const { id = "" } = useParams();
  const { projects, reload } = useSession();
  const project = projects.find((p) => p.id === id);
  const [rtKey, setRtKey] = useState("");
  const [rtName, setRtName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function addType(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/api/admin/projects/${id}/record-types`, { key: rtKey, name: rtName });
      setRtKey("");
      setRtName("");
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!project) return <p className="muted">Project not found or archived.</p>;
  return (
    <section>
      <AdminNav />
      <p className="muted small">{project.key}</p>
      <h1>{project.name}</h1>
      <ProjectSettings project={project} />
      {project.recordTypes.map((t) => (
        <RecordTypeFields key={t.id} recordTypeId={t.id} name={t.name} />
      ))}
      <h2>Add a record type</h2>
      <form onSubmit={addType} className="row wrap">
        <label className="field">
          Key
          <input value={rtKey} onChange={(e) => setRtKey(e.target.value.toLowerCase())} placeholder="invoice_exception" required />
        </label>
        <label className="field grow">
          Name
          <input value={rtName} onChange={(e) => setRtName(e.target.value)} placeholder="Invoice exception" required />
        </label>
        <button className="primary" type="submit">
          Add record type
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      <SlaEditor project={project} />
    </section>
  );
}

function ProjectSettings({ project }: { project: Project }) {
  const { teams, reload } = useSession();
  const [form, setForm] = useState({
    name: project.name,
    restricted: project.restricted,
    requesterAccess: project.requesterAccess,
    assignment: project.assignment,
    defaultTeamId: project.defaultTeamId ?? "",
    inboundAddress: project.inbound?.address ?? "",
    inboundType: project.inbound?.recordTypeId ?? project.recordTypes[0]?.id ?? "",
  });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await api.patch(`/api/admin/projects/${project.id}`, {
        name: form.name,
        restricted: form.restricted,
        requesterAccess: form.requesterAccess,
        assignment: form.assignment,
        defaultTeamId: form.defaultTeamId || null,
        inbound: form.inboundAddress.trim() ? { address: form.inboundAddress.trim(), recordTypeId: form.inboundType } : null,
      });
      await reload();
      setSaved(true);
    } catch (err) {
      const issues = issuesByField(err);
      setError(Object.values(issues)[0] ?? (err as Error).message);
    }
  }

  return (
    <form className="card stack" onSubmit={save}>
      <h2>Settings</h2>
      <div className="row wrap">
        <label className="field grow">
          Name
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </label>
        <label className="field">
          Default team (receives new records)
          <select value={form.defaultTeamId} onChange={(e) => setForm({ ...form, defaultTeamId: e.target.value })}>
            <option value="">None</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Assignment
          <select value={form.assignment} onChange={(e) => setForm({ ...form, assignment: e.target.value as Project["assignment"] })}>
            <option value="manual">Manual (or pick up yourself)</option>
            <option value="round_robin">Round-robin within the team</option>
          </select>
        </label>
      </div>
      <label className="inline">
        <input type="checkbox" checked={form.restricted} onChange={(e) => setForm({ ...form, restricted: e.target.checked })} />
        Restricted: only admins, the project's teams, the assignee and the requester see its records (HR, finance)
      </label>
      <label className="inline">
        <input type="checkbox" checked={form.requesterAccess} onChange={(e) => setForm({ ...form, requesterAccess: e.target.checked })} />
        Requesters can submit to this project
      </label>
      <div className="row wrap">
        <label className="field grow">
          Inbound email address (the part before @; mail to it creates records)
          <input value={form.inboundAddress} placeholder="ap-requests" onChange={(e) => setForm({ ...form, inboundAddress: e.target.value.toLowerCase() })} />
        </label>
        <label className="field">
          Creates
          <select value={form.inboundType} onChange={(e) => setForm({ ...form, inboundType: e.target.value })}>
            {project.recordTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorText error={error} />
      <div className="row">
        <button className="primary" type="submit">
          Save settings
        </button>
        {saved && <span className="muted small">Saved.</span>}
      </div>
    </form>
  );
}

function RecordTypeFields({ recordTypeId, name }: { recordTypeId: string; name: string }) {
  const { reload } = useSession();
  const [fields, setFields] = useState<Field[]>([]);
  const [draft, setDraft] = useState({ key: "", label: "", type: "text" as FieldType, required: false, choices: "", currency: "USD" });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const load = useCallback(
    () =>
      api
        .get<{ fields: Field[] }>(`/api/admin/record-types/${recordTypeId}/fields?includeArchived=true`)
        .then((r) => setFields(r.fields)),
    [recordTypeId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    const options: Record<string, unknown> = {};
    if (draft.type === "select" || draft.type === "multi_select") {
      options.choices = draft.choices
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((label) => ({ value: label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""), label }));
    }
    if (draft.type === "currency") options.currency = draft.currency;
    try {
      await api.post(`/api/admin/record-types/${recordTypeId}/fields`, {
        key: draft.key,
        label: draft.label,
        type: draft.type,
        required: draft.required,
        options,
      });
      setDraft({ key: "", label: "", type: "text", required: false, choices: "", currency: "USD" });
      await load();
      await reload();
    } catch (err) {
      setErrors({ _: (err as Error).message, ...issuesByField(err) });
    }
  }

  async function toggleArchive(f: Field) {
    await api.patch(`/api/admin/fields/${f.id}`, { archived: !f.archivedAt });
    await load();
    await reload();
  }

  return (
    <div className="card">
      <div className="row between">
        <h2>{name}</h2>
        <div className="row">
          <Link className="button" to={`/app/admin/record-types/${recordTypeId}/workflow`}>
            Workflow
          </Link>
          <Link className="button" to={`/app/admin/record-types/${recordTypeId}/layout`}>
            Layout
          </Link>
        </div>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Label</th>
            <th>Key</th>
            <th>Type</th>
            <th>Required</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {fields.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No custom fields yet.
              </td>
            </tr>
          )}
          {fields.map((f) => (
            <tr key={f.id} className={f.archivedAt ? "dim" : ""}>
              <td>{f.label}</td>
              <td className="mono">{f.key}</td>
              <td>{TYPES.find((t) => t.value === f.type)?.label}</td>
              <td>{f.required ? "Yes" : ""}</td>
              <td>
                <button className="subtle" onClick={() => toggleArchive(f)}>
                  {f.archivedAt ? "Restore" : "Archive"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={add} className="row wrap">
        <label className="field grow">
          Label
          <input
            value={draft.label}
            onChange={(e) => {
              const label = e.target.value;
              const auto = autoKey(label);
              setDraft((d) => ({ ...d, label, key: d.key && d.key !== autoKey(d.label) ? d.key : auto }));
            }}
            required
          />
        </label>
        <label className="field">
          Key
          <input className="mono" value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} required />
          {errors.key && <span className="error small">{errors.key}</span>}
        </label>
        <label className="field">
          Type
          <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as FieldType })}>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        {(draft.type === "select" || draft.type === "multi_select") && (
          <label className="field grow">
            Choices (comma-separated)
            <input value={draft.choices} onChange={(e) => setDraft({ ...draft, choices: e.target.value })} required />
          </label>
        )}
        {draft.type === "currency" && (
          <label className="field">
            Currency
            <input value={draft.currency} maxLength={3} onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })} />
          </label>
        )}
        <label className="inline">
          <input type="checkbox" checked={draft.required} onChange={(e) => setDraft({ ...draft, required: e.target.checked })} />
          Required
        </label>
        <button type="submit">Add field</button>
      </form>
      {errors._ && <p className="error">{errors._}</p>}
    </div>
  );
}

function autoKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").replace(/^(\d)/, "f_$1");
}
