// Phone views at /m. A paired phone always lands here (its session is read-only); anyone else
// can use them too. Everything here reads; nothing writes.
import { Link, NavLink, Route, Routes, useNavigate, useParams } from "react-router";
import { api } from "../api.ts";
import { allRecordTypes, useSession } from "../session.tsx";
import { useLoad, timeAgo, StatusPill, SlaBadge, Empty } from "../components/ui.tsx";
import type { Approval, Comment, Notification, RecordDetailData, WorkRecord } from "../types.ts";

export function Mobile() {
  const { me, reload, unread, site } = useSession();
  const navigate = useNavigate();
  if (!me) return null;
  async function signOut() {
    await api.post("/auth/logout");
    await reload();
    navigate(site?.demo.enabled ? "/" : "/signin");
  }
  return (
    <div className="mobile">
      <header className="mobile-bar">
        <Link to="/m" className="brand">
          Tend <span className="accent">24/7</span>
        </Link>
        <button className="link small" onClick={signOut}>
          Sign out
        </button>
      </header>
      {me.readOnly && <p className="readonly-note">Read-only on this phone. Use your computer to make changes.</p>}
      <nav className="mobile-tabs">
        <NavLink to="/m" end>
          {me.role === "requester" ? "My requests" : "My work"}
        </NavLink>
        <NavLink to="/m/notifications">Notifications{unread > 0 && <span className="badge">{unread}</span>}</NavLink>
        {!me.readOnly && <Link to={me.role === "requester" ? "/portal" : "/app"}>Full site</Link>}
      </nav>
      <main className="mobile-main">
        <Routes>
          <Route index element={<MyWork />} />
          <Route path="records/:key" element={<MobileRecord />} />
          <Route path="notifications" element={<MobileNotifications />} />
        </Routes>
      </main>
    </div>
  );
}

function Row({ r }: { r: WorkRecord }) {
  const { projects } = useSession();
  const type = allRecordTypes(projects).find((t) => t.id === r.recordTypeId);
  return (
    <li>
      <Link to={`/m/records/${r.key}`} className="mobile-row">
        <span className="mono muted small">{r.key}</span>
        <strong>{r.title}</strong>
        <span className="row">
          <StatusPill status={r.status} statuses={type?.workflow.statuses} category={r.statusCategory} />
          <span className={`pill ${r.priority}`}>{r.priority}</span>
          <span className="muted small">{timeAgo(r.updatedAt)}</span>
        </span>
      </Link>
    </li>
  );
}

function MyWork() {
  const { me } = useSession();
  const staff = me?.role !== "requester";
  const mine = useLoad(
    () => api.get<{ items: WorkRecord[] }>(`/api/records?statusCategory=todo,in_progress&limit=50${staff ? `&assigneeId=${me?.id}` : ""}`),
    [me?.id],
  );
  const approvals = useLoad(() => (staff ? api.get<{ approvals: Approval[] }>("/api/approvals") : Promise.resolve({ approvals: [] })), [staff]);
  return (
    <section>
      {approvals.data?.approvals.length ? (
        <>
          <h2>Waiting for your approval</h2>
          <ul className="mobile-list">
            {approvals.data.approvals.map((a) => (
              <li key={a.id}>
                <Link to={`/m/records/${a.recordKey}`} className="mobile-row">
                  <span className="mono muted small">{a.recordKey}</span>
                  <strong>{a.recordTitle}</strong>
                  <span className="muted small">
                    {a.requestedByName ?? "Someone"} asks to “{a.transitionName}”
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h2>{staff ? "Assigned to you" : "Your open requests"}</h2>
      {!mine.data ? (
        <p className="muted">Loading…</p>
      ) : !mine.data.items.length ? (
        <Empty>Nothing open.</Empty>
      ) : (
        <ul className="mobile-list">
          {mine.data.items.map((r) => (
            <Row key={r.id} r={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MobileRecord() {
  const { key = "" } = useParams();
  const { projects } = useSession();
  const detail = useLoad(() => api.get<RecordDetailData>(`/api/records/${key}`), [key]);
  const comments = useLoad(() => api.get<{ comments: Comment[] }>(`/api/records/${key}/comments`), [key]);
  if (detail.error) return <p className="muted">Not found.</p>;
  if (!detail.data) return <p className="muted">Loading…</p>;
  const r = detail.data.record;
  const type = allRecordTypes(projects).find((t) => t.id === r.recordTypeId);
  return (
    <section>
      <p className="mono muted small">{r.key}</p>
      <h1>{r.title}</h1>
      <div className="row wrap">
        <StatusPill status={r.status} statuses={type?.workflow.statuses} category={r.statusCategory} />
        <span className={`pill ${r.priority}`}>{r.priority}</span>
        {detail.data.sla.map((c) => (
          <SlaBadge key={c.id} clock={c} />
        ))}
      </div>
      <dl className="props">
        <dt>Assignee</dt>
        <dd>{r.assigneeName ?? "Unassigned"}</dd>
        <dt>Requester</dt>
        <dd>{r.requesterName ?? "—"}</dd>
        <dt>Team</dt>
        <dd>{r.teamName ?? "—"}</dd>
        <dt>Opened</dt>
        <dd>{timeAgo(r.createdAt)}</dd>
      </dl>
      {r.description && <p className="prewrap">{r.description}</p>}
      <h2>Conversation</h2>
      {!comments.data?.comments.length ? (
        <Empty>No comments.</Empty>
      ) : (
        <ul className="comments">
          {comments.data.comments.map((c) => (
            <li key={c.id} className={c.internal ? "internal" : ""}>
              <strong>{c.authorName ?? "Automation"}</strong> <span className="muted small">{timeAgo(c.createdAt)}</span>
              {c.internal && <span className="tag-mini">internal</span>}
              <p className="prewrap">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MobileNotifications() {
  const list = useLoad(() => api.get<{ notifications: Notification[] }>("/api/notifications"), []);
  if (!list.data) return <p className="muted">Loading…</p>;
  if (!list.data.notifications.length) return <Empty>No notifications.</Empty>;
  return (
    <ul className="notes">
      {list.data.notifications.map((n) => (
        <li key={n.id} className={n.readAt ? "" : "unread"}>
          {n.recordKey ? <Link to={`/m/records/${n.recordKey}`}>{n.title}</Link> : <span>{n.title}</span>}
          {n.body && <p className="clamp muted small">{n.body}</p>}
          <span className="muted small">{timeAgo(n.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}
