import { useEffect, useState, type FormEvent } from "react";
import { Link, NavLink } from "react-router";
import { api, ApiError, issuesByField } from "../../api.ts";
import { useSession } from "../../session.tsx";
import type { SavedTemplate, TemplateSummary } from "../../types.ts";

interface AdminProject {
  id: string;
  key: string;
  name: string;
  description: string;
  archivedAt: string | null;
}

export function AdminNav() {
  return (
    <nav className="subnav">
      <NavLink to="/app/admin" end>Projects</NavLink>
      <NavLink to="/app/admin/users">People</NavLink>
      <NavLink to="/app/admin/teams">Teams</NavLink>
      <NavLink to="/app/admin/automation">Automation</NavLink>
      <NavLink to="/app/admin/webhooks">Webhooks</NavLink>
      <NavLink to="/app/admin/import">Import</NavLink>
      <NavLink to="/app/admin/calendars">Calendars</NavLink>
      <NavLink to="/app/admin/settings">Settings</NavLink>
      <NavLink to="/app/admin/audit">Audit log</NavLink>
    </nav>
  );
}

/** Install a starter or saved template: a queue with fields, workflow, form, SLA and team, ready to use. */
function Templates({ taken, onInstalled }: { taken: string[]; onInstalled: () => Promise<void> }) {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [saved, setSaved] = useState<SavedTemplate[]>([]);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = () =>
    api.get<{ templates: TemplateSummary[]; saved: SavedTemplate[] }>("/api/admin/templates").then((r) => {
      setTemplates(r.templates);
      setSaved(r.saved);
    });
  useEffect(() => {
    void load();
  }, []);
  async function install(t: { key: string; name: string; projectKey?: string }) {
    setBusy(t.key);
    setError(null);
    setNotice(null);
    try {
      const projectKey = (keys[t.key] ?? t.projectKey ?? "").toUpperCase();
      await api.post(`/api/admin/templates/${t.key}/install`, { projectKey });
      await onInstalled();
      setNotice(`Installed ${t.name}.`);
    } catch (err) {
      setError(`${t.name}: ${Object.values(issuesByField(err))[0] ?? (err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }
  async function upload(file: File | undefined) {
    if (!file) return;
    setError(null);
    setNotice(null);
    try {
      const definition = JSON.parse(await file.text());
      const name = String(definition?.name ?? file.name.replace(/\.json$/i, "")).slice(0, 120);
      await api.post("/api/admin/templates/saved", { definition, name, source: "file" });
      await load();
      setNotice(`Added “${name}” to your templates.`);
    } catch (err) {
      if (err instanceof SyntaxError) setError(`${file.name} is not a template file.`);
      else if (err instanceof ApiError && err.code === "conflict") setError(`${err.message}. Rename or delete the existing one first.`);
      else if (err instanceof ApiError && err.issues.length) setError(`${err.message}: ${err.issues.slice(0, 3).map((i) => `${i.field} ${i.message}`).join("; ")}`);
      else setError((err as Error).message);
    }
  }
  async function remove(t: SavedTemplate) {
    if (!window.confirm(`Delete the template “${t.name}”? Projects made from it are not affected.`)) return;
    await api.delete(`/api/admin/templates/saved/${t.id}`);
    await load();
  }
  const card = (t: TemplateSummary & { id?: string; mine?: boolean; valid?: boolean; createdByName?: string | null; source?: string }) => {
    const key = keys[t.key] ?? t.projectKey;
    const clash = taken.includes((key ?? "").toUpperCase());
    return (
      <article key={t.key} className="card template">
        <h3>
          {t.name}
          {t.agile && <span className="tag-mini">sprints</span>}
        </h3>
        <p className="muted small">{t.summary}</p>
        {t.valid === false ? (
          <p className="error small">This template no longer passes the checks. Delete it, or save the project again.</p>
        ) : (
          <>
            <p className="small">
              <strong>{t.recordTypes?.length > 1 ? t.recordTypes.join(", ") : t.recordType}</strong>
              {t.fields?.length ? `: ${t.fields.join(", ")}` : ""}
            </p>
            <p className="small muted">
              {t.statuses?.join(" → ")}
              {t.approvals ? " · approval step" : ""}
              {t.sla ? " · SLA targets" : ""}
              {t.restricted ? " · private to its team" : ""}
            </p>
          </>
        )}
        {t.mine && (
          <p className="small muted">
            {t.source === "file" ? "Uploaded" : t.source === "wizard" ? "Built in the setup wizard" : "Saved from a project"}
            {t.createdByName ? ` by ${t.createdByName}` : ""}
          </p>
        )}
        <div className="row wrap">
          <label className="field">
            Key
            <input value={key ?? ""} maxLength={10} onChange={(e) => setKeys((k) => ({ ...k, [t.key]: e.target.value.toUpperCase() }))} />
          </label>
          <button className="primary" disabled={busy !== null || clash || t.valid === false} onClick={() => install(t)}>
            {busy === t.key ? "Installing…" : clash ? "Key in use" : "Install"}
          </button>
          {t.mine && (
            <>
              <a className="button subtle" href={`/api/admin/templates/saved/${t.id}/download`} download>
                Download
              </a>
              <button className="subtle" onClick={() => remove(t as unknown as SavedTemplate)}>
                Delete
              </button>
            </>
          )}
        </div>
      </article>
    );
  };
  return (
    <>
      <div className="card row between wrap setup-callout">
        <div>
          <h2>Set up a new project step by step</h2>
          <p className="muted small">Answer plain questions about the form, the steps, who sees it and how fast it should be handled. No configuration language needed.</p>
        </div>
        <Link className="button primary" to="/app/admin/new">
          Start the setup guide
        </Link>
      </div>
      <h2>Your templates</h2>
      <p className="muted">
        Save any project as a template from its page, or upload a template file from another workspace.{" "}
        <label className="button subtle small file-button">
          Upload a template file
          <input type="file" accept=".json,application/json" onChange={(e) => upload(e.target.files?.[0])} />
        </label>
      </p>
      {saved.length > 0 ? <div className="template-grid">{saved.map((t) => card({ ...(t as unknown as TemplateSummary), id: t.id, mine: true, valid: t.valid, createdByName: t.createdByName, source: t.source }))}</div> : <p className="muted small">None yet.</p>}
      <h2>Start from a template</h2>
      <p className="muted">Each template is a working queue. Install it, then rename anything, add fields or change the workflow.</p>
      <div className="template-grid">{templates.map((t) => card(t))}</div>
      {notice && <p className="muted">{notice}</p>}
      {error && <p className="error">{error}</p>}
    </>
  );
}

export function AdminProjects() {
  const { reload } = useSession();
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const load = () => api.get<{ projects: AdminProject[] }>("/api/admin/projects").then((r) => setProjects(r.projects));
  useEffect(() => {
    void load();
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    try {
      await api.post("/api/admin/projects", { key: key.toUpperCase(), name });
      setKey("");
      setName("");
      await load();
      await reload();
    } catch (err) {
      setErrors({ _: (err as Error).message, ...issuesByField(err) });
    }
  }

  return (
    <section>
      <AdminNav />
      <div className="row between wrap">
        <h1>Projects</h1>
        <Link className="button primary" to="/app/admin/new">
          Set up a new project
        </Link>
      </div>
      <p className="muted">A project is a queue with its own key, such as FIN or HR. Its key prefixes every record number and cannot change.</p>
      <table className="grid">
        <thead>
          <tr>
            <th>Key</th>
            <th>Name</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id}>
              <td>
                <Link to={`/app/admin/projects/${p.id}`}>{p.key}</Link>
              </td>
              <td>{p.name}</td>
              <td className="muted">{p.archivedAt ? "Archived" : "Active"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Add a project</h2>
      <form onSubmit={create} className="row wrap">
        <label className="field">
          Key
          <input value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="FIN" maxLength={10} required />
          {errors.key && <span className="error small">{errors.key}</span>}
        </label>
        <label className="field grow">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="AP Requests" required />
        </label>
        <button className="primary" type="submit">
          Add project
        </button>
      </form>
      {errors._ && <p className="error">{errors._}</p>}
      <Templates
        taken={projects.map((p) => p.key)}
        onInstalled={async () => {
          await load();
          await reload();
        }}
      />
    </section>
  );
}
