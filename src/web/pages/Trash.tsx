import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { WorkRecord } from "../types.ts";

export function Trash() {
  const [rows, setRows] = useState<WorkRecord[] | null>(null);
  const load = () => api.get<{ records: WorkRecord[] }>("/api/trash").then((r) => setRows(r.records));
  useEffect(() => {
    void load();
  }, []);

  async function restore(id: string) {
    await api.post(`/api/records/${id}/restore`);
    await load();
  }

  return (
    <section>
      <h1>Trash</h1>
      <p className="muted">Deleted records stay here until they are purged. Restoring brings back the record and its history.</p>
      {!rows ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">The trash is empty.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Key</th>
              <th>Title</th>
              <th>Deleted</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.key}</td>
                <td>{r.title}</td>
                <td className="muted">{r.deletedAt ? new Date(r.deletedAt).toLocaleString() : ""}</td>
                <td>
                  <button onClick={() => restore(r.id)}>Restore</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
