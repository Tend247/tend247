// "Try the live demo": a Cloudflare Turnstile check, then a private sandbox. The Turnstile
// script loads only on a deployment that hosts the demo (tend247.com).
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api.ts";
import { useSession } from "../session.tsx";

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: { sitekey: string; theme?: string; callback: (token: string) => void; "error-callback"?: () => void; "expired-callback"?: () => void }): string;
      reset(id?: string): void;
    };
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT}"]`);
    const s = existing ?? document.createElement("script");
    s.addEventListener("load", () => resolve());
    s.addEventListener("error", () => reject(new Error("Turnstile failed to load")));
    if (!existing) {
      s.src = SCRIPT;
      s.async = true;
      document.head.appendChild(s);
    }
  });
}

export function TryDemo({ className = "button-primary" }: { className?: string }) {
  const { site, me, reload } = useSession();
  const navigate = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const siteKey = site?.demo.turnstileSiteKey ?? null;

  useEffect(() => {
    if (!siteKey || me || !box.current) return;
    let cancelled = false;
    loadTurnstile()
      .then(() => {
        if (cancelled || !box.current || widget.current) return;
        widget.current = window.turnstile!.render(box.current, {
          sitekey: siteKey,
          theme: "dark",
          callback: (t) => setToken(t),
          "expired-callback": () => setToken(null),
          "error-callback": () => setError("The human check could not load. Reload the page to try again."),
        });
      })
      .catch((err: Error) => setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [siteKey, me]);

  if (!site?.demo.enabled) return null;
  if (me) {
    return (
      <button className={className} onClick={() => navigate(me.role === "requester" ? "/portal" : "/app")}>
        Back to your demo
      </button>
    );
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/demo/start", { turnstileToken: token ?? undefined });
      await reload();
      navigate("/app");
    } catch (err) {
      setError((err as Error).message);
      setToken(null);
      if (widget.current) window.turnstile?.reset(widget.current);
    } finally {
      setBusy(false);
    }
  }

  const waiting = Boolean(siteKey) && !token;
  return (
    <div className="try-demo">
      <button className={className} onClick={start} disabled={busy || waiting} aria-describedby="demo-note">
        {busy ? "Making your copy…" : "Try the live demo"}
      </button>
      <div ref={box} className="turnstile" />
      <p id="demo-note" className="hero-note">
        {waiting ? "Checking you're human…" : "No sign-up. Your own copy of Fernhollow Foods, deleted within 24 hours."}
      </p>
      {error && <p className="demo-error">{error}</p>}
    </div>
  );
}

interface Stats {
  sandboxesToday: number;
  sandboxesThisWeek: number;
  requestsToday: number;
  activeNow: number;
}

/** Live numbers from the demo: anonymous daily counters, refreshed every minute. */
export function StatsStrip() {
  const { site } = useSession();
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    if (!site?.demo.enabled) return;
    const load = () =>
      api
        .get<{ stats: Stats | null }>("/auth/demo/stats")
        .then((r) => setStats(r.stats))
        .catch(() => setStats(null));
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [site?.demo.enabled]);
  if (!stats) return null;
  const items = [
    { value: stats.activeNow, label: "people exploring now" },
    { value: stats.sandboxesToday, label: "sandboxes opened today" },
    { value: stats.requestsToday, label: "requests filed today" },
    { value: stats.sandboxesThisWeek, label: "sandboxes this week" },
  ];
  return (
    <ul className="stats-strip" aria-label="Live demo activity">
      {items.map((i) => (
        <li key={i.label}>
          <strong>{i.value.toLocaleString()}</strong>
          <span>{i.label}</span>
        </li>
      ))}
    </ul>
  );
}
