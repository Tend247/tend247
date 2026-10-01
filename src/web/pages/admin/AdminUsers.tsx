import { useEffect, useState, type FormEvent } from "react";
import { api, issuesByField } from "../../api.ts";
import { useSession } from "../../session.tsx";
import type { Person, Role } from "../../types.ts";
import { AdminNav } from "./AdminProjects.tsx";

export function AdminUsers() {
  const { me, reload } = useSession();
  const [users, setUsers] = useState<Person[]>([]);
  const [draft, setDraft] = useState({ email: "", displayName: "", role: "agent" as Role });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const load = () => api.get<{ users: Person[] }>("/api/admin/users").then((r) => setUsers(r.users));
  useEffect(() => {
    void load();
  }, []);

  async function add(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    try {
      await api.post("/api/admin/users", draft);
      setDraft({ email: "", displayName: "", role: "agent" });
      await load();
      await reload();
    } catch (err) {
      setErrors({ _: (err as Error).message, ...issuesByField(err) });
    }
  }

  async function update(u: Person, patch: Partial<Person>) {
    try {
      await api.patch(`/api/admin/users/${u.id}`, patch);
      await load();
      await reload();
    } catch (err) {
      setErrors({ _: (err as Error).message });
    }
  }

  return (
    <section>
      <AdminNav />
      <h1>People</h1>
      <p className="muted">Admins configure the workspace, agents work queues, requesters file and follow their own requests.</p>
      <table className="grid">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className={u.active === false ? "dim" : ""}>
              <td>{u.displayName}</td>
              <td>{u.email}</td>
              <td>
                <select value={u.role} disabled={u.id === me?.id} onChange={(e) => update(u, { role: e.target.value as Role })}>
                  <option value="admin">Admin</option>
                  <option value="agent">Agent</option>
                  <option value="requester">Requester</option>
                </select>
              </td>
              <td>
                {u.id !== me?.id && (
                  <button className="subtle" onClick={() => update(u, { active: !u.active })}>
                    {u.active ? "Deactivate" : "Reactivate"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Add a person</h2>
      <form onSubmit={add} className="row wrap">
        <label className="field grow">
          Name
          <input value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} required />
        </label>
        <label className="field grow">
          Email
          <input type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} required />
          {errors.email && <span className="error small">{errors.email}</span>}
        </label>
        <label className="field">
          Role
          <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as Role })}>
            <option value="admin">Admin</option>
            <option value="agent">Agent</option>
            <option value="requester">Requester</option>
          </select>
        </label>
        <button className="primary" type="submit">
          Add
        </button>
      </form>
      {errors._ && <p className="error">{errors._}</p>}
    </section>
  );
}
