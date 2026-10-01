import { useEffect, useState } from "react";
import { api } from "../../api.ts";
import { AdminNav } from "./AdminProjects.tsx";

interface Entry {
  id: string;
  entity: string;
  action: string;
  actorName: string | null;
  createdAt: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

function describe(e: Entry): string {
  const name = (e.after?.name ?? e.after?.label ?? e.after?.email ?? e.before?.name ?? "") as string;
  return `${e.action === "create" ? "Created" : "Updated"} ${e.entity.replace("_", " ")}${name ? ` “${name}”` : ""}`;
}

export function AdminAudit() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  useEffect(() => {
    void api.get<{ entries: Entry[] }>("/api/admin/audit?limit=100").then((r) => setEntries(r.entries));
  }, []);
  return (
    <section>
      <AdminNav />
      <h1>Audit log</h1>
      <p className="muted">Every configuration change, newest first. Entries cannot be edited or deleted.</p>
      {!entries ? (
        <p className="muted">Loading…</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>What</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="muted">{new Date(e.createdAt).toLocaleString()}</td>
                <td>{e.actorName ?? "System"}</td>
                <td>{describe(e)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
