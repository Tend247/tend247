import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { api, ApiError } from "../api.ts";
import { useSession } from "../session.tsx";

interface AuthConfig {
  workspace: { slug: string; name: string; demo: boolean } | null;
  demo?: { enabled: boolean };
  databaseReady?: boolean;
  devLogin: boolean;
  oidc: boolean;
  magicLinks: boolean;
}

const ERRORS: Record<string, string> = {
  link_invalid: "That sign-in link is not valid.",
  link_expired: "That sign-in link has expired or was already used. Request a new one.",
  sso_expired: "Single sign-on took too long. Try again.",
  sso_failed: "Single sign-on failed. Try again or contact your admin.",
  not_invited: "Your account is not set up in this workspace yet. Ask an admin to add you.",
};

export function SignIn() {
  const { reload } = useSession();
  const [params] = useSearchParams();
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(ERRORS[params.get("error") ?? ""] ?? null);
  const [sent, setSent] = useState(false);
  const workspace = params.get("workspace") ?? undefined;

  useEffect(() => {
    api
      .get<AuthConfig>(`/auth/config${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`)
      .then(setCfg)
      .catch((e) => setMessage(e instanceof ApiError ? e.message : "Could not reach the server"));
  }, [workspace]);

  async function magic(e: FormEvent) {
    e.preventDefault();
    await api.post("/auth/magic", { email, workspace });
    setSent(true);
  }

  async function devLogin(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post("/auth/dev", { email, workspace });
      await reload();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Sign-in failed");
    }
  }

  if (!cfg) return <div className="center muted">{message ?? "Loading…"}</div>;
  if (!cfg.workspace) {
    return (
      <div className="center">
        {cfg.demo?.enabled ? (
          <p>
            This is the public demo site: there is nothing to sign in to. <a href="/">Try the live demo</a> instead.
          </p>
        ) : cfg.databaseReady === false ? (
          <p>Tend 24/7 cannot reach its database right now. An administrator can find details in the server logs.</p>
        ) : (
          <p>No workspace is set up yet. Run the seed script or the installer.</p>
        )}
      </div>
    );
  }

  return (
    <div className="signin">
      <h1>Tend 24/7</h1>
      <p className="muted">Sign in to {cfg.workspace.name}</p>
      {message && <p className="error">{message}</p>}
      {cfg.oidc && (
        <a className="button primary block" href={`/auth/oidc/start${workspace ? `?workspace=${workspace}` : ""}`}>
          Sign in with single sign-on
        </a>
      )}
      {sent ? (
        <p>If that address can sign in here, a link is on its way. It works once and expires in 15 minutes.</p>
      ) : (
        (cfg.magicLinks || cfg.devLogin) && (
          <form onSubmit={cfg.magicLinks ? magic : devLogin} className="stack">
            <label className="field">
              Email
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </label>
            {cfg.magicLinks && (
              <button type="submit" className="block">
                Email me a sign-in link
              </button>
            )}
            {cfg.devLogin && (
              <button type="button" className="block subtle" onClick={devLogin}>
                Dev sign-in (no password)
              </button>
            )}
          </form>
        )
      )}
      {!cfg.oidc && !cfg.magicLinks && !cfg.devLogin && (
        <p className="muted">No sign-in method is configured. See docs/install.md.</p>
      )}
    </div>
  );
}
