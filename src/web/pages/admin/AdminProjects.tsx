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
      <NavLink to="/app/admin/calendars">Calendars</NavLink>
      <NavLink to="/app/admin/settings">Settings</NavLink>
      <NavLink to="/app/admin/audit">Audit log</NavLink>
    </nav>
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
    </section>
  );
}
