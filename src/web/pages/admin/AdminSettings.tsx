import { useEffect, useState } from "react";
import { api, issuesByField } from "../../api.ts";
import { useSession } from "../../session.tsx";
import { ErrorText, fmtBytes, timeAgo, useLoad } from "../../components/ui.tsx";
import { AdminNav } from "./AdminProjects.tsx";

interface Settings {
  trashRetentionDays: number;
  attachmentMaxMb: number;
  timezone: string;
}

interface Backups {
  configured: boolean;
  encrypted: boolean;
  nextRunAt: string | null;
  runs: { id: string; status: string; location: string; bytes: number; rows: number; error: string | null; startedAt: string; finishedAt: string | null }[];
}

export function AdminSettings() {
  const { reload } = useSession();
  const settings = useLoad(() => api.get<{ settings: Settings }>("/api/admin/settings"), []);
  const backups = useLoad(() => api.get<Backups>("/api/admin/backups"), []);
  const email = useLoad(() => api.get<{ provider: string; canDeliver: boolean; from: string | null; inboundDomain: string | null }>("/api/admin/email"), []);
  const [form, setForm] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings.data) setForm(settings.data.settings);
  }, [settings.data]);

  async function save() {
    setError(null);
    setSaved(false);
    try {
      await api.patch("/api/admin/settings", form);
      await reload();
      setSaved(true);
    } catch (err) {
      setError(Object.values(issuesByField(err))[0] ?? (err as Error).message);
    }
  }

  const last = backups.data?.runs[0];
  return (
    <section className="narrow">
      <AdminNav />
      <h1>Workspace settings</h1>
      {form && (
        <div className="card stack">
          <div className="row wrap">
            <label className="field">
              Keep deleted items for (days)
              <input type="number" min={1} max={365} value={form.trashRetentionDays} onChange={(e) => setForm({ ...form, trashRetentionDays: Number(e.target.value) })} />
            </label>
            <label className="field">
              Largest attachment (MB)
              <input type="number" min={1} max={100} value={form.attachmentMaxMb} onChange={(e) => setForm({ ...form, attachmentMaxMb: Number(e.target.value) })} />
            </label>
            <label className="field grow">
              Time zone (nightly jobs)
              <input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
            </label>
          </div>
          <ErrorText error={error} />
          <div className="row">
            <button className="primary" onClick={save}>
              Save
            </button>
            {saved && <span className="muted small">Saved.</span>}
          </div>
        </div>
      )}

      <h2>Email</h2>
      {email.data && (
        <div className="card">
          <p>
            Outbound: <strong>{email.data.canDeliver ? email.data.provider : "not configured"}</strong>
            {email.data.from && <span className="muted"> · from {email.data.from}</span>}
          </p>
          <p>
            Inbound: <strong>{email.data.inboundDomain ?? "not configured"}</strong>
            {email.data.inboundDomain && <span className="muted"> · replies go to reply+…@{email.data.inboundDomain}; set each project's queue address on its page</span>}
          </p>
          {!email.data.canDeliver && <p className="muted small">Set TEND247_EMAIL_PROVIDER and TEND247_EMAIL_FROM (see docs/install.md) to send notifications and sign-in links.</p>}
        </div>
      )}

      <h2>Backups</h2>
      {backups.data && (
        <div className={`card ${last?.status === "failed" ? "warn" : ""}`}>
          {!backups.data.configured ? (
            <p className="muted">Nightly export is off. Bind an R2 bucket as BACKUPS (ideally in another account) to turn it on; point-in-time recovery at your Postgres host is the first line of defence either way.</p>
          ) : (
            <>
              <p>
                Nightly export to the BACKUPS bucket, {backups.data.encrypted ? "encrypted (AES-GCM)" : <strong>not encrypted</strong>}.
                {backups.data.nextRunAt && <span className="muted"> Next run {timeAgo(backups.data.nextRunAt)}.</span>}
              </p>
              {last ? (
                <p>
                  Last export: <strong className={last.status === "failed" ? "error" : ""}>{last.status}</strong> {timeAgo(last.finishedAt ?? last.startedAt)} · {last.rows} rows · {fmtBytes(last.bytes)}
                  {last.error && <span className="error"> · {last.error}</span>}
                </p>
              ) : (
                <p className="muted">No export has run yet.</p>
              )}
              {backups.data.runs.length > 1 && (
                <table className="grid compact">
                  <tbody>
                    {backups.data.runs.slice(1).map((r) => (
                      <tr key={r.id}>
                        <td className="mono small">{r.location}</td>
                        <td>{r.status}</td>
                        <td className="muted small">{fmtBytes(r.bytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
