import { Link } from "react-router";
import { api } from "../api.ts";
import { Empty, timeAgo, useLoad } from "../components/ui.tsx";
import type { Attachment, Comment, WorkRecord } from "../types.ts";

interface TrashData {
  records: WorkRecord[];
  comments: Comment[];
  attachments: Attachment[];
}

export function Trash() {
  const { data, reload } = useLoad(() => api.get<TrashData>("/api/trash"), []);
  const settings = useLoad(() => api.get<{ settings: { trashRetentionDays: number } }>("/api/admin/settings"), []);
  const days = settings.data?.settings.trashRetentionDays ?? 30;

  async function act(fn: () => Promise<unknown>) {
    await fn();
    await reload();
  }

  return (
    <section>
      <h1>Trash</h1>
      <p className="muted">
        Deleted records, comments and files stay here for {days} days (change this in Admin → Settings), then are purged for good. Restoring brings back the item and its history.
      </p>
      {!data ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <h2>Records</h2>
          {data.records.length === 0 ? (
            <Empty>No deleted records.</Empty>
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
                {data.records.map((r) => (
                  <tr key={r.id}>
                    <td>{r.key}</td>
                    <td>{r.title}</td>
                    <td className="muted">{timeAgo(r.deletedAt)}</td>
                    <td className="row">
                      <button onClick={() => act(() => api.post(`/api/records/${r.id}/restore`))}>Restore</button>
                      <button
                        className="subtle danger"
                        onClick={() => window.confirm(`Delete ${r.key} forever, with its history and files? This cannot be undone.`) && act(() => api.delete(`/api/trash/records/${r.id}`))}
                      >
                        Delete forever
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h2>Comments</h2>
          {data.comments.length === 0 ? (
            <Empty>No deleted comments.</Empty>
          ) : (
            <table className="grid">
              <tbody>
                {data.comments.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/app/records/${c.recordKey}`}>{c.recordKey}</Link>
                    </td>
                    <td className="clamp">{c.body}</td>
                    <td className="muted">
                      {c.authorName ?? "Automation"} · deleted {timeAgo(c.deletedAt)}
                    </td>
                    <td>
                      <button onClick={() => act(() => api.post(`/api/comments/${c.id}/restore`))}>Restore</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h2>Files</h2>
          {data.attachments.length === 0 ? (
            <Empty>No deleted files.</Empty>
          ) : (
            <table className="grid">
              <tbody>
                {data.attachments.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <Link to={`/app/records/${a.recordKey}`}>{a.recordKey}</Link>
                    </td>
                    <td>{a.filename}</td>
                    <td className="muted">deleted {timeAgo(a.deletedAt)}</td>
                    <td>
                      <button onClick={() => act(() => api.post(`/api/attachments/${a.id}/restore`))}>Restore</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
