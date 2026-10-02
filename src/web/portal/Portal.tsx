// The requester portal: what employees see. A catalog of what they can ask for, a form built
// from each request type's create layout, their own requests, and a page per request with the
// public conversation, files, replies and reopen. Internal notes never reach this view (the
// API leaves them out for requesters).
import { useState, type FormEvent } from "react";
import { Link, NavLink, Route, Routes, useNavigate, useParams } from "react-router";
import { api } from "../api.ts";
import { allRecordTypes, useSession } from "../session.tsx";
import { useLoad, timeAgo, fmtBytes, StatusPill, ErrorText, Empty } from "../components/ui.tsx";
import { RecordNew } from "../pages/RecordNew.tsx";
import { DemoBar, DemoMail } from "../demo/DemoBar.tsx";
// Requesters can link a phone too; the settings page is shared.
import { Settings as PhoneAccess } from "../pages/Settings.tsx";
import type { Attachment, Comment, RecordDetailData, WorkRecord } from "../types.ts";

export function Portal() {
  const { me, site, reload } = useSession();
  const navigate = useNavigate();
  if (!me) return null;
  async function signOut() {
    await api.post("/auth/logout");
    await reload();
    navigate(site?.demo.enabled ? "/" : "/signin");
  }
  return (
    <div className="shell portal">
      {me.demo && <DemoBar />}
      <header className="topbar">
        <Link to="/portal" className="brand">
          {site?.workspace?.name ?? "Tend"} <span className="accent">help</span>
        </Link>
        <nav>
          <NavLink to="/portal" end>
            Get help
          </NavLink>
          <NavLink to="/portal/requests">My requests</NavLink>
          <NavLink to="/portal/settings">Phone access</NavLink>
        </nav>
        <div className="spacer" />
        <span className="muted small">{me.displayName}</span>
        <button className="link" onClick={signOut}>
          Sign out
        </button>
      </header>
      <main className="content portal-content">
        <Routes>
          <Route index element={<Catalog />} />
          <Route path="new" element={<RecordNew linkTo={(key) => `/portal/requests/${key}`} heading="Ask for help" />} />
          <Route path="requests" element={<MyRequests />} />
          <Route path="requests/:key" element={<Request />} />
          <Route path="settings" element={<PortalSettings />} />
          {me.demo && <Route path="demo-mail" element={<DemoMail />} />}
          <Route path="*" element={<p className="muted">Page not found.</p>} />
        </Routes>
      </main>
    </div>
  );
}

function Catalog() {
  const { projects, me } = useSession();
  const types = allRecordTypes(projects);
  const mine = useLoad(() => api.get<{ items: WorkRecord[] }>("/api/records?statusCategory=todo,in_progress&limit=5"), []);
  return (
    <section>
      <h1>How can we help, {me?.displayName.split(" ")[0]}?</h1>
      {types.length === 0 ? (
        <Empty>There is nothing to ask for yet. Your administrator can open request types for employees.</Empty>
      ) : (
        <div className="catalog">
          {types.map((t) => (
            <Link key={t.id} to={`/portal/new?recordTypeId=${t.id}`} className="catalog-item">
              <span className="catalog-project">{t.project.name}</span>
              <strong>{t.name}</strong>
              <span className="muted small">{t.description || t.project.description}</span>
            </Link>
          ))}
        </div>
      )}
      <h2>Your open requests</h2>
      {!mine.data?.items.length ? (
        <Empty>Nothing open. Requests you make show up here.</Empty>
      ) : (
        <RequestList items={mine.data.items} />
      )}
    </section>
  );
}

function RequestList({ items }: { items: WorkRecord[] }) {
  const { projects } = useSession();
  const statuses = (r: WorkRecord) => allRecordTypes(projects).find((t) => t.id === r.recordTypeId)?.workflow.statuses;
  return (
    <ul className="request-list">
      {items.map((r) => (
        <li key={r.id}>
          <Link to={`/portal/requests/${r.key}`}>
            <span className="mono muted">{r.key}</span> <strong>{r.title}</strong>
          </Link>
          <span className="row">
            <StatusPill status={r.status} statuses={statuses(r)} category={r.statusCategory} />
            <span className="muted small">updated {timeAgo(r.updatedAt)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function MyRequests() {
  const [done, setDone] = useState(false);
  const list = useLoad(
    () => api.get<{ items: WorkRecord[] }>(`/api/records?limit=100&statusCategory=${done ? "done" : "todo,in_progress"}`),
    [done],
  );
  return (
    <section>
      <div className="row between">
        <h1>My requests</h1>
        <Link to="/portal" className="button primary">
          New request
        </Link>
      </div>
      <div className="toggle" role="radiogroup" aria-label="Which requests">
        <button role="radio" aria-checked={!done} className={!done ? "on" : ""} onClick={() => setDone(false)}>
          Open
        </button>
        <button role="radio" aria-checked={done} className={done ? "on" : ""} onClick={() => setDone(true)}>
          Closed
        </button>
      </div>
      {!list.data?.items.length ? <Empty>{done ? "No closed requests." : "No open requests."}</Empty> : <RequestList items={list.data.items} />}
    </section>
  );
}

function Request() {
  const { key = "" } = useParams();
  const { projects } = useSession();
  const detail = useLoad(() => api.get<RecordDetailData>(`/api/records/${key}`), [key]);
  const comments = useLoad(() => api.get<{ comments: Comment[] }>(`/api/records/${key}/comments`), [key]);
  const files = useLoad(() => api.get<{ attachments: Attachment[] }>(`/api/records/${key}/attachments`), [key]);
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (detail.error) return <p className="muted">That request was not found.</p>;
  if (!detail.data) return <p className="muted">Loading…</p>;
  const r = detail.data.record;
  const type = allRecordTypes(projects).find((t) => t.id === r.recordTypeId);
  const shown = (type?.layout.create.sections ?? []).flatMap((s) => s.fields).filter((f) => type?.fields.some((x) => x.key === f));

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/records/${key}/comments`, { body: reply, internal: false });
      setReply("");
      await comments.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function move(transition: string) {
    setError(null);
    try {
      await api.post(`/api/records/${key}/transitions`, { transition, ...(reply.trim() ? { comment: reply.trim() } : {}) });
      setReply("");
      await Promise.all([detail.reload(), comments.reload()]);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  async function upload(f: File | undefined) {
    if (!f) return;
    setError(null);
    try {
      await api.upload(`/api/records/${key}/attachments`, f);
      await files.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const display = (v: unknown, fieldKey: string) => {
    const f = type?.fields.find((x) => x.key === fieldKey);
    if (v === null || v === undefined || v === "") return "—";
    if (f?.type === "select") return f.options.choices?.find((c) => c.value === v)?.label ?? String(v);
    if (f?.type === "multi_select" && Array.isArray(v)) return v.map((x) => f.options.choices?.find((c) => c.value === x)?.label ?? x).join(", ");
    if (f?.type === "checkbox") return v ? "Yes" : "No";
    return String(v);
  };

  return (
    <section className="portal-request">
      <p className="muted small">
        <Link to="/portal/requests">My requests</Link> / {r.key}
      </p>
      <h1>{r.title}</h1>
      <div className="row">
        <StatusPill status={r.status} statuses={type?.workflow.statuses} category={r.statusCategory} />
        <span className="muted small">
          {type?.project.name} · opened {timeAgo(r.createdAt)}
          {r.assigneeName && ` · ${r.assigneeName} is on it`}
        </span>
      </div>
      {r.description && <p className="prewrap">{r.description}</p>}
      {shown.length > 0 && (
        <dl className="props">
          {shown.map((f) => (
            <div key={f} className="contents">
              <dt>{type?.fields.find((x) => x.key === f)?.label}</dt>
              <dd>{display(r.custom[f], f)}</dd>
            </div>
          ))}
        </dl>
      )}

      <h2>Conversation</h2>
      {!comments.data?.comments.length ? (
        <Empty>No replies yet. We'll let you know here and by email.</Empty>
      ) : (
        <ul className="comments">
          {comments.data.comments.map((c) => (
            <li key={c.id}>
              <strong>{c.authorName ?? "Tend 24/7"}</strong> <span className="muted small">{timeAgo(c.createdAt)}</span>
              <p className="prewrap">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={send} className="stack">
        <label className="field">
          Reply
          <textarea rows={3} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Add details or answer a question" />
        </label>
        <div className="row wrap">
          <button className="primary" disabled={!reply.trim() || busy}>
            Send reply
          </button>
          {detail.data.transitions.map((t) => (
            <button key={t.key} type="button" onClick={() => move(t.key)}>
              {t.name}
            </button>
          ))}
          <label className="button">
            Attach a file
            <input type="file" hidden onChange={(e) => void upload(e.target.files?.[0])} />
          </label>
        </div>
        <ErrorText error={error} />
      </form>

      {files.data?.attachments.length ? (
        <>
          <h2>Files</h2>
          <ul className="files">
            {files.data.attachments.map((a) => (
              <li key={a.id}>
                <a href={`/api/attachments/${a.id}`}>{a.filename}</a>{" "}
                <span className="muted small">
                  {fmtBytes(a.sizeBytes)} · {timeAgo(a.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function PortalSettings() {
  return (
    <section>
      <PhoneAccess />
    </section>
  );
}
