import { useState, type FormEvent } from "react";
import { api } from "../../api.ts";
import { useSession } from "../../session.tsx";
import { ErrorText, useLoad } from "../../components/ui.tsx";
import type { Team } from "../../types.ts";
import { AdminNav } from "./AdminProjects.tsx";

export function AdminTeams() {
  const { people, reload } = useSession();
  const teams = useLoad(() => api.get<{ teams: Team[] }>("/api/admin/teams"), []);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const staff = people.filter((p) => p.role !== "requester");

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await teams.reload();
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    await act(() => api.post("/api/admin/teams", { name }));
    setName("");
  }

  return (
    <section>
      <AdminNav />
      <h1>Teams</h1>
      <p className="muted">Teams own queues. A project's default team receives its new records, round-robin if the project is set that way, and in a restricted project only its teams can see the records.</p>
      <ErrorText error={error} />
      {(teams.data?.teams ?? []).map((t) => {
        const ids = new Set(t.members.map((m) => m.id));
        return (
          <div key={t.id} className={`card ${t.archivedAt ? "dim" : ""}`}>
            <div className="row between">
              <h2>{t.name}</h2>
              <button className="subtle" onClick={() => act(() => api.patch(`/api/admin/teams/${t.id}`, { archived: !t.archivedAt }))}>
                {t.archivedAt ? "Restore" : "Archive"}
              </button>
            </div>
            <div className="checkline">
              {staff.map((p) => (
                <label key={p.id} className="inline">
                  <input
                    type="checkbox"
                    checked={ids.has(p.id)}
                    onChange={(e) =>
                      act(() => api.patch(`/api/admin/teams/${t.id}`, { memberIds: e.target.checked ? [...ids, p.id] : [...ids].filter((x) => x !== p.id) }))
                    }
                  />
                  {p.displayName}
                </label>
              ))}
            </div>
          </div>
        );
      })}
      <h2>Add a team</h2>
      <form className="row" onSubmit={create}>
        <input placeholder="Accounts payable" value={name} onChange={(e) => setName(e.target.value)} required />
        <button className="primary" type="submit">
          Add team
        </button>
      </form>
    </section>
  );
}
