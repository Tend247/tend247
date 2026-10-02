import { useEffect, useState, type FormEvent } from "react";
import { Link, NavLink } from "react-router";
import { api, issuesByField } from "../../api.ts";
import { useSession } from "../../session.tsx";

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

interface TemplateSummary {
  key: string;
  name: string;
  summary: string;
  projectKey: string;
  restricted: boolean;
  recordType: string;
  fields: string[];
  statuses: string[];
  approvals: boolean;
  sla: boolean;
}

/** Install a starter template: a queue with fields, workflow, form, SLA and team, ready to use. */
function Templates({ taken, onInstalled }: { taken: string[]; onInstalled: () => Promise<void> }) {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.get<{ templates: TemplateSummary[] }>("/api/admin/templates").then((r) => setTemplates(r.templates));
  }, []);
  async function install(t: TemplateSummary) {
    setBusy(t.key);
    setError(null);
    try {
      const projectKey = (keys[t.key] ?? t.projectKey).toUpperCase();
      await api.post(`/api/admin/templates/${t.key}/install`, { projectKey });
      await onInstalled();
    } catch (err) {
      setError(`${t.name}: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <h2>Start from a template</h2>
      <p className="muted">Each template is a working queue. Install it, then rename anything, add fields or change the workflow.</p>
      <div className="template-grid">
        {templates.map((t) => {
          const key = keys[t.key] ?? t.projectKey;
          const clash = taken.includes(key.toUpperCase());
          return (
            <article key={t.key} className="card template">
              <h3>{t.name}</h3>
              <p className="muted small">{t.summary}</p>
              <p className="small">
                <strong>{t.recordType}</strong>: {t.fields.join(", ")}
              </p>
              <p className="small muted">
                {t.statuses.join(" → ")}
                {t.approvals ? " · approval step" : ""}
                {t.sla ? " · SLA targets" : ""}
                {t.restricted ? " · private to its team" : ""}
              </p>
              <div className="row">
                <label className="field">
                  Key
                  <input value={key} maxLength={10} onChange={(e) => setKeys((k) => ({ ...k, [t.key]: e.target.value.toUpperCase() }))} />
                </label>
                <button className="primary" disabled={busy !== null || clash} onClick={() => install(t)}>
                  {busy === t.key ? "Installing…" : clash ? "Key in use" : "Install"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
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
      <h1>Projects</h1>
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
