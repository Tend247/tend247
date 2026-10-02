import { useState, type FormEvent } from "react";
import { api, issuesByField } from "../../api.ts";
import { useSession } from "../../session.tsx";
import { ErrorText, timeAgo, useLoad, Empty } from "../../components/ui.tsx";
import { AdminNav } from "./AdminProjects.tsx";

interface Endpoint {
  id: string;
  name: string;
  url: string;
  topics: string[];
  projectId: string | null;
  enabled: boolean;
  lastDelivery: { status: string; createdAt: string } | null;
}

interface Delivery {
  id: string;
  endpointId: string | null;
  ruleId: string | null;
  topic: string | null;
  url: string;
  status: "pending" | "delivered" | "failed" | "skipped";
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

const TOPIC_LABELS: Record<string, string> = {
  "record.created": "Record created",
  "record.updated": "Record updated",
  "record.transitioned": "Status changed",
  "record.deleted": "Record deleted",
  "record.restored": "Record restored",
  "comment.created": "Comment added",
  "attachment.created": "File attached",
  "approval.requested": "Approval requested",
  "approval.decided": "Approval decided",
  "sla.warning": "SLA warning",
  "sla.breached": "SLA breached",
};

export function AdminWebhooks() {
  const { projects, me } = useSession();
  const endpoints = useLoad(() => api.get<{ endpoints: Endpoint[]; topics: string[] }>("/api/admin/webhooks"), []);
  const [selected, setSelected] = useState<string | null>(null);
  const deliveries = useLoad(
    () => api.get<{ deliveries: Delivery[] }>(`/api/admin/webhook-deliveries${selected ? `?endpointId=${selected}` : ""}`),
    [selected],
  );
  const secret = useLoad(() => api.get<{ secret: string }>("/api/admin/webhook-secret"), []);
  const [form, setForm] = useState({ name: "", url: "", topics: ["record.created"] as string[], projectId: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function create(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    try {
      await api.post("/api/admin/webhooks", { ...form, projectId: form.projectId || null });
      setForm({ name: "", url: "", topics: ["record.created"], projectId: "" });
      await endpoints.reload();
    } catch (err) {
      setErrors({ _: (err as Error).message, ...issuesByField(err) });
    }
  }
  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
    } finally {
      await endpoints.reload();
      await deliveries.reload();
    }
  }

  const topics = endpoints.data?.topics ?? Object.keys(TOPIC_LABELS);
  return (
    <section>
      <AdminNav />
      <h1>Webhooks</h1>
      <p className="muted">
        Send workspace events to another system as they happen. Each request is signed with{" "}
        <code className="mono">X-Tend-Signature: t=…,v1=HMAC-SHA256("t.body")</code> using the workspace secret, and failed deliveries
        retry with backoff for about 15 hours. {me?.demo && <strong>Demo sandboxes log deliveries but never send them.</strong>}
      </p>
      {secret.data && (
        <p className="small">
          Signing secret: <span className="secret">{secret.data.secret}</span>
        </p>
      )}

      <h2>Endpoints</h2>
      {!endpoints.data?.endpoints.length ? (
        <Empty>No endpoints yet.</Empty>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Name</th>
              <th>URL</th>
              <th>Events</th>
              <th>Last delivery</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {endpoints.data.endpoints.map((ep) => (
              <tr key={ep.id} className={ep.enabled ? "" : "dim"}>
                <td>
                  <button className="link" onClick={() => setSelected(selected === ep.id ? null : ep.id)}>
                    {ep.name}
                  </button>
                  {ep.projectId && <span className="tag-mini">{projects.find((p) => p.id === ep.projectId)?.key ?? "project"}</span>}
                </td>
                <td className="mono small">{ep.url}</td>
                <td className="small">{ep.topics.map((t) => TOPIC_LABELS[t] ?? t).join(", ")}</td>
                <td className="small">{ep.lastDelivery ? `${ep.lastDelivery.status}, ${timeAgo(ep.lastDelivery.createdAt)}` : "Never"}</td>
                <td className="row">
                  <button className="small" onClick={() => act(() => api.post(`/api/admin/webhooks/${ep.id}/ping`))}>
                    Send test
                  </button>
                  <button className="small" onClick={() => act(() => api.patch(`/api/admin/webhooks/${ep.id}`, { enabled: !ep.enabled }))}>
                    {ep.enabled ? "Pause" : "Resume"}
                  </button>
                  <button className="small danger" onClick={() => act(() => api.delete(`/api/admin/webhooks/${ep.id}`))}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Add an endpoint</h2>
      <form onSubmit={create} className="card stack">
        <div className="row wrap">
          <label className="field">
            Name
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="ERP sync" />
          </label>
          <label className="field grow">
            URL
            <input required type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/hooks/tend" />
            {errors.url && <span className="error small">{errors.url}</span>}
          </label>
          <label className="field">
            Project
            <select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <fieldset className="section">
          <legend>Events</legend>
          <div className="checks">
            {topics.map((t) => (
              <label key={t} className="inline">
                <input
                  type="checkbox"
                  checked={form.topics.includes(t)}
                  onChange={(e) => setForm({ ...form, topics: e.target.checked ? [...form.topics, t] : form.topics.filter((x) => x !== t) })}
                />
                {TOPIC_LABELS[t] ?? t}
              </label>
            ))}
          </div>
        </fieldset>
        <ErrorText error={errors._} />
        <div>
          <button className="primary" disabled={!form.topics.length}>
            Add endpoint
          </button>
        </div>
      </form>

      <h2>{selected ? `Deliveries to ${endpoints.data?.endpoints.find((e) => e.id === selected)?.name ?? "endpoint"}` : "Recent deliveries"}</h2>
      {!deliveries.data?.deliveries.length ? (
        <Empty>Nothing sent yet.</Empty>
      ) : (
        <table className="grid compact">
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Response</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {deliveries.data.deliveries.map((d) => (
              <tr key={d.id}>
                <td>{timeAgo(d.createdAt)}</td>
                <td className="small">{d.topic ? (TOPIC_LABELS[d.topic] ?? d.topic) : d.ruleId ? "Automation rule" : "—"}</td>
                <td>
                  <span className={`delivery ${d.status}`}>{d.status}</span>
                </td>
                <td>{d.attempts}</td>
                <td className="small">{d.lastError ?? (d.lastStatus ? `HTTP ${d.lastStatus}` : "")}</td>
                <td>
                  {d.status !== "pending" && (
                    <button className="small" onClick={() => act(() => api.post(`/api/admin/webhook-deliveries/${d.id}/redeliver`))}>
                      Redeliver
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
