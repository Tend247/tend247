import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api.ts";
import { useSession } from "../session.tsx";
import { Empty, ErrorText, timeAgo, useLoad } from "../components/ui.tsx";
import type { Approval, Notification } from "../types.ts";

/** Notifications, with per-kind preferences. */
export function Notifications() {
  const { refreshUnread } = useSession();
  const list = useLoad(() => api.get<{ notifications: Notification[]; unread: number }>("/api/notifications"), []);
  const prefs = useLoad(() => api.get<{ prefs: { kind: string; label: string; inApp: boolean; email: boolean }[] }>("/api/notification-prefs"), []);

  async function readAll() {
    await api.post("/api/notifications/read", { all: true });
    await list.reload();
    await refreshUnread();
  }

  async function open(n: Notification) {
    if (!n.readAt) {
      await api.post("/api/notifications/read", { ids: [n.id] });
      void refreshUnread();
    }
  }

  async function setPref(kind: string, channel: "inApp" | "email", value: boolean) {
    const r = await api.patch<{ prefs: { kind: string; label: string; inApp: boolean; email: boolean }[] }>("/api/notification-prefs", { [kind]: { [channel]: value } });
    prefs.setData(r);
  }

  return (
    <section className="narrow">
      <div className="row between">
        <h1>Notifications</h1>
        {list.data && list.data.unread > 0 && (
          <button className="subtle" onClick={readAll}>
            Mark all read
          </button>
        )}
      </div>
      {!list.data ? (
        <p className="muted">Loading…</p>
      ) : list.data.notifications.length === 0 ? (
        <Empty>Nothing yet. You'll hear about assignments, mentions, replies and approvals here.</Empty>
      ) : (
        <ul className="notes">
          {list.data.notifications.map((n) => (
            <li key={n.id} className={n.readAt ? "" : "unread"}>
              {n.recordKey ? (
                <Link to={`/app/records/${n.recordKey}`} onClick={() => open(n)}>
                  {n.title}
                </Link>
              ) : (
                <span>{n.title}</span>
              )}
              {n.body && <p className="muted small clamp">{n.body}</p>}
              <span className="muted small">{timeAgo(n.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}

      <h2>Preferences</h2>
      {prefs.data && (
        <table className="grid">
          <thead>
            <tr>
              <th>Notify me about</th>
              <th>In the app</th>
              <th>By email</th>
            </tr>
          </thead>
          <tbody>
            {prefs.data.prefs.map((p) => (
              <tr key={p.kind}>
                <td>{p.label}</td>
                <td>
                  <input type="checkbox" aria-label={`${p.label} in the app`} checked={p.inApp} onChange={(e) => setPref(p.kind, "inApp", e.target.checked)} />
                </td>
                <td>
                  <input type="checkbox" aria-label={`${p.label} by email`} checked={p.email} onChange={(e) => setPref(p.kind, "email", e.target.checked)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Approvals waiting on me. */
export function Approvals() {
  const list = useLoad(() => api.get<{ approvals: Approval[] }>("/api/approvals"), []);
  const [error, setError] = useState<string | null>(null);

  async function decide(a: Approval, decision: "approve" | "reject") {
    setError(null);
    try {
      await api.post(`/api/approvals/${a.id}/decision`, { decision });
      await list.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className="narrow">
      <h1>Approvals</h1>
      <p className="muted">Requests waiting for your decision. Approving moves the record on; rejecting leaves it where it is.</p>
      <ErrorText error={error} />
      {!list.data ? (
        <p className="muted">Loading…</p>
      ) : list.data.approvals.length === 0 ? (
        <Empty>Nothing is waiting for you.</Empty>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Record</th>
              <th>Asks for</th>
              <th>From</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.approvals.map((a) => (
              <tr key={a.id}>
                <td>
                  <Link to={`/app/records/${a.recordKey}`}>{a.recordKey}</Link> {a.recordTitle}
                </td>
                <td>{a.transitionName}</td>
                <td className="muted">
                  {a.requestedByName ?? "someone"} · {timeAgo(a.createdAt)}
                </td>
                <td className="row">
                  <button className="primary small" onClick={() => decide(a, "approve")}>
                    Approve
                  </button>
                  <button className="danger small" onClick={() => decide(a, "reject")}>
                    Reject
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
