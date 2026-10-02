// The strip across the top of a demo sandbox: who you are, a role switcher, how long the
// sandbox has left, the mail it would have sent, Reset, and a short guided tour.
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api.ts";
import { useSession } from "../session.tsx";
import { useLoad } from "../components/ui.tsx";

interface DemoInfo {
  persona: "requester" | "agent" | "lead" | "admin" | null;
  personas: { key: string; label: string }[];
  expiresAt: string;
  mailCount: number;
  readOnly: boolean;
}

const TOUR: { persona: DemoInfo["persona"]; title: string; body: string; to: string }[] = [
  { persona: "requester", title: "Ask for help as Jo", body: "Open the help portal and report a broken printer on the bottling line.", to: "/portal" },
  { persona: "agent", title: "Work the queue as Sam", body: "An urgent incident is about to breach its 30-minute SLA. Pick it up.", to: "/app" },
  { persona: "lead", title: "Approve as Dana", body: "An invoice payment and a change request are waiting for your approval.", to: "/app/approvals" },
  { persona: "admin", title: "Configure as Avery", body: "Add a field, change a workflow, or install a starter template.", to: "/app/admin" },
];

const TOUR_KEY = "t247.demo.tour";
function readTour(): { hidden: boolean; done: string[] } {
  try {
    return { hidden: false, done: [], ...JSON.parse(localStorage.getItem(TOUR_KEY) ?? "{}") };
  } catch {
    return { hidden: false, done: [] };
  }
}
function writeTour(v: { hidden: boolean; done: string[] }) {
  try {
    localStorage.setItem(TOUR_KEY, JSON.stringify(v));
  } catch {
    /* private browsing: the tour just forgets */
  }
}

function left(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return h ? `${h} h ${m} min left` : `${m} min left`;
}

export function DemoBar() {
  const { reload, me } = useSession();
  const navigate = useNavigate();
  const info = useLoad(() => api.get<DemoInfo>("/api/demo/info"), [me?.id]);
  const [busy, setBusy] = useState(false);
  const [tour, setTour] = useState(readTour);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  if (!info.data) return null;
  const d = info.data;

  async function become(persona: string) {
    setBusy(true);
    try {
      await api.post("/api/demo/persona", { persona });
      const step = TOUR.find((s) => s.persona === persona);
      await reload();
      navigate(step?.to ?? "/app");
    } finally {
      setBusy(false);
    }
  }
  async function reset() {
    if (!window.confirm("Start over with a fresh copy of Fernhollow Foods? Everything you changed here is discarded.")) return;
    setBusy(true);
    try {
      await api.post("/api/demo/reset");
      await reload();
      navigate(d.persona === "requester" ? "/portal" : "/app");
    } finally {
      setBusy(false);
    }
  }
  function markDone(p: string) {
    const next = { ...tour, done: [...new Set([...tour.done, p])] };
    setTour(next);
    writeTour(next);
  }

  return (
    <div className="demo-bar" role="region" aria-label="Demo controls">
      <div className="demo-row">
        <span className="demo-tag">Demo</span>
        <label className="inline">
          <span className="sr-only">Role</span>
          You are
          <select value={d.persona ?? ""} disabled={busy || d.readOnly} onChange={(e) => void become(e.target.value)}>
            {d.personas.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <span className="muted small">{left(d.expiresAt)}</span>
        <div className="spacer" />
        {!d.readOnly && (
          <>
            <Link to={me?.role === "requester" ? "/portal/demo-mail" : "/app/demo-mail"} className="demo-link">
              Sent mail{d.mailCount ? ` (${d.mailCount})` : ""}
            </Link>
            {tour.hidden && (
              <button className="link small" onClick={() => setTour({ ...tour, hidden: false })}>
                Show tour
              </button>
            )}
            <button className="small" disabled={busy} onClick={reset}>
              Reset
            </button>
          </>
        )}
      </div>
      {!tour.hidden && !d.readOnly && (
        <ol className="tour">
          {TOUR.map((s) => {
            const here = s.persona === d.persona;
            const done = tour.done.includes(s.persona ?? "");
            return (
              <li key={s.title} className={`${here ? "here" : ""} ${done ? "done" : ""}`}>
                <strong>{s.title}</strong>
                <span className="small">{s.body}</span>
                {here ? (
                  <span className="row">
                    <Link to={s.to} className="small">
                      Go
                    </Link>
                    <button className="link small" onClick={() => markDone(s.persona ?? "")}>
                      {done ? "Done" : "Mark done"}
                    </button>
                  </span>
                ) : (
                  <button className="link small" disabled={busy} onClick={() => void become(s.persona ?? "agent")}>
                    Switch
                  </button>
                )}
              </li>
            );
          })}
          <li className="tour-close">
            <button
              className="link small"
              onClick={() => {
                const next = { ...tour, hidden: true };
                setTour(next);
                writeTour(next);
              }}
            >
              Hide tour
            </button>
          </li>
        </ol>
      )}
    </div>
  );
}

/** Plain text with this site's own links made clickable (approval and sign-in links work in the sandbox). */
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (!/^https?:\/\//.test(p)) return p;
        try {
          return new URL(p).origin === window.location.origin ? (
            <a key={i} href={p}>
              {p}
            </a>
          ) : (
            p
          );
        } catch {
          return p;
        }
      })}
    </>
  );
}

interface Mail {
  id: string;
  toAddr: string;
  subject: string;
  body: string;
  createdAt: string;
}

/** What the sandbox would have emailed. Links in these messages work inside the sandbox. */
export function DemoMail() {
  const mail = useLoad(() => api.get<{ mail: Mail[] }>("/api/demo/mail"), []);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="narrow">
      <h1>Sent mail</h1>
      <p className="muted">
        The demo never sends email. Everything Fernhollow Foods would have sent (notifications, approval requests, replies to requesters)
        lands here instead.
      </p>
      {!mail.data?.mail.length ? (
        <p className="muted">Nothing yet. Comment on a request or ask for an approval and the email appears here.</p>
      ) : (
        <ul className="notes">
          {mail.data.mail.map((m) => (
            <li key={m.id}>
              <button className="link" onClick={() => setOpen(open === m.id ? null : m.id)}>
                {m.subject}
              </button>
              <span className="muted small">
                to {m.toAddr} · {new Date(m.createdAt).toLocaleString()}
              </span>
              {open === m.id && (
                <pre className="mail-body">
                  <Linkified text={m.body} />
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
