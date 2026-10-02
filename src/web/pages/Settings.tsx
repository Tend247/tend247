import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { useSession } from "../session.tsx";
import { useLoad, timeAgo, ErrorText, Empty } from "../components/ui.tsx";
import { Qr } from "../components/Qr.tsx";

interface Pairing {
  id: string;
  status: "pending" | "claimed" | "approved" | "denied" | "redeemed" | "expired" | "revoked";
  deviceLabel: string | null;
  matchNumber: number | null;
  expiresAt: string;
}

interface Device {
  id: string;
  deviceLabel: string | null;
  pairedAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
}

interface Token {
  id: string;
  userId: string;
  userName: string;
  name: string;
  hint: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

const SCOPES: { key: string; label: string; write?: boolean }[] = [
  { key: "records:read", label: "Read records" },
  { key: "records:write", label: "Create and change records", write: true },
  { key: "comments:read", label: "Read comments and files" },
  { key: "comments:write", label: "Add comments and files", write: true },
  { key: "config:read", label: "Read projects, fields and people" },
];

/** Link a phone by QR code: show the code, wait for the phone, approve what it says it is. */
function LinkPhone({ onLinked }: { onLinked: () => void }) {
  const [pairing, setPairing] = useState<{ id: string; url: string } | null>(null);
  const [state, setState] = useState<Pairing | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setError(null);
    setState(null);
    try {
      setPairing(await api.post<{ id: string; url: string }>("/api/devices/pair"));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    if (!pairing) return;
    const t = setInterval(async () => {
      try {
        const { pairing: p } = await api.get<{ pairing: Pairing }>(`/api/devices/pair/${pairing.id}`);
        setState(p);
        if (!["pending", "claimed", "approved"].includes(p.status)) clearInterval(t);
        if (p.status === "redeemed") onLinked();
      } catch {
        clearInterval(t);
      }
    }, 2000);
    return () => clearInterval(t);
  }, [pairing, onLinked]);

  async function decide(approve: boolean) {
    if (!pairing) return;
    try {
      const { pairing: p } = await api.post<{ pairing: Pairing }>(`/api/devices/pair/${pairing.id}/${approve ? "approve" : "deny"}`);
      setState(p);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const status = state?.status ?? "pending";
  return (
    <div className="card">
      <h2>Phone access</h2>
      <p className="muted">
        See your work on your phone without signing in there: scan a code, approve the phone here, and it gets read-only access for 4
        hours. It can look, not change anything.
      </p>
      {!pairing || ["denied", "expired", "redeemed", "revoked"].includes(status) ? (
        <>
          {status === "redeemed" && <p className="notice">Linked. Your phone is showing your work.</p>}
          {status === "denied" && <p className="muted">You declined that phone.</p>}
          {status === "expired" && <p className="muted">That code expired.</p>}
          <button className="primary" onClick={start}>
            Link a phone
          </button>
        </>
      ) : status === "pending" ? (
        <div className="pair">
          <Qr value={pairing.url} label="QR code to link your phone" />
          <div>
            <p>Scan with your phone's camera. The code works once and expires in 2 minutes.</p>
            <button className="subtle" onClick={() => setPairing(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : status === "claimed" ? (
        <div className="pair-confirm">
          <p>A phone scanned your code:</p>
          <p className="device">{state?.deviceLabel ?? "Unknown device"}</p>
          <p>
            Its screen should show <strong className="match">{state?.matchNumber}</strong>. Approve only if this is your phone and the
            number matches.
          </p>
          <div className="row">
            <button className="primary" onClick={() => decide(true)}>
              Approve this phone
            </button>
            <button className="danger" onClick={() => decide(false)}>
              Not mine
            </button>
          </div>
        </div>
      ) : (
        <p className="muted">Approved. Waiting for the phone to finish…</p>
      )}
      <ErrorText error={error} />
    </div>
  );
}

function LinkedDevices({ version }: { version: number }) {
  const { data, reload } = useLoad(() => api.get<{ devices: Device[] }>("/api/devices"), [version]);
  async function revoke(id: string) {
    await api.delete(`/api/devices/${id}`);
    await reload();
  }
  return (
    <div className="card">
      <h2>Linked devices</h2>
      {!data?.devices.length ? (
        <Empty>No phones are linked.</Empty>
      ) : (
        <table className="grid compact">
          <thead>
            <tr>
              <th>Device</th>
              <th>Linked</th>
              <th>Last seen</th>
              <th>Access ends</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.devices.map((d) => (
              <tr key={d.id}>
                <td>{d.deviceLabel ?? "Phone"}</td>
                <td>{timeAgo(d.pairedAt)}</td>
                <td>{timeAgo(d.lastSeenAt)}</td>
                <td>{timeAgo(d.expiresAt)}</td>
                <td>
                  <button className="danger small" onClick={() => revoke(d.id)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ApiTokens() {
  const { me } = useSession();
  const isAdmin = me?.role === "admin";
  const [all, setAll] = useState(false);
  const { data, reload } = useLoad(() => api.get<{ tokens: Token[] }>(`/api/tokens${all ? "?all=1" : ""}`), [all]);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["records:read"]);
  const [days, setDays] = useState("90");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.post<{ secret: string }>("/api/tokens", { name, scopes, expiresInDays: days === "never" ? null : Number(days) });
      setSecret(r.secret);
      setName("");
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  async function revoke(id: string) {
    await api.delete(`/api/tokens/${id}`);
    await reload();
  }

  return (
    <div className="card">
      <h2>API tokens</h2>
      <p className="muted">
        For scripts and integrations: send <code className="mono">Authorization: Bearer &lt;token&gt;</code>. A token acts as you, with
        only the permissions you tick. {me?.demo && "In the demo, tokens are read-only."}
      </p>
      {secret && (
        <div className="card warn">
          <p>
            <strong>Copy this token now.</strong> It will not be shown again.
          </p>
          <p className="secret">{secret}</p>
          <button className="subtle small" onClick={() => void navigator.clipboard?.writeText(secret)}>
            Copy
          </button>{" "}
          <button className="subtle small" onClick={() => setSecret(null)}>
            Done
          </button>
        </div>
      )}
      <form onSubmit={create} className="stack">
        <div className="row wrap">
          <label className="field grow">
            Name
            <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Weekly report script" />
          </label>
          <label className="field">
            Expires
            <select value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In a year</option>
              <option value="never">Never</option>
            </select>
          </label>
        </div>
        <div className="checks">
          {SCOPES.filter((s) => !(me?.demo && s.write)).map((s) => (
            <label key={s.key} className="inline">
              <input
                type="checkbox"
                checked={scopes.includes(s.key)}
                onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, s.key] : cur.filter((x) => x !== s.key)))}
              />
              {s.label}
            </label>
          ))}
        </div>
        <ErrorText error={error} />
        <div>
          <button className="primary" disabled={!scopes.length}>
            Create token
          </button>
        </div>
      </form>
      {isAdmin && (
        <label className="inline" style={{ marginTop: "1rem" }}>
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show everyone's tokens
        </label>
      )}
      {data?.tokens.length ? (
        <table className="grid compact" style={{ marginTop: "0.75rem" }}>
          <thead>
            <tr>
              <th>Name</th>
              {all && <th>Owner</th>}
              <th>Starts with</th>
              <th>Permissions</th>
              <th>Last used</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.tokens.map((t) => (
              <tr key={t.id} className={t.revokedAt ? "dim" : ""}>
                <td>{t.name}</td>
                {all && <td>{t.userName}</td>}
                <td className="mono">{t.hint}…</td>
                <td className="small">{t.scopes.join(", ")}</td>
                <td>{t.lastUsedAt ? timeAgo(t.lastUsedAt) : "Never"}</td>
                <td>{t.revokedAt ? "Revoked" : t.expiresAt ? timeAgo(t.expiresAt) : "Never"}</td>
                <td>
                  {!t.revokedAt && (
                    <button className="danger small" onClick={() => revoke(t.id)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

export function Settings() {
  const { me } = useSession();
  const [linked, setLinked] = useState(0);
  const onLinked = useCallback(() => setLinked((n) => n + 1), []);
  return (
    <section className="narrow-wide">
      <h1>Your settings</h1>
      <LinkPhone onLinked={onLinked} />
      <LinkedDevices version={linked} />
      {me?.role !== "requester" && <ApiTokens />}
    </section>
  );
}
