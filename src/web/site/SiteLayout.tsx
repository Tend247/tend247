import type { ReactNode } from "react";
import { Link } from "react-router";
import { useSession } from "../session.tsx";

export function SiteLayout({ children }: { children: ReactNode }) {
  const { site, me } = useSession();
  const repo = site?.repoUrl;
  const demo = site?.demo.enabled ?? false;
  return (
    <div className="site">
      <header className="site-nav">
        <Link to="/" className="wordmark">
          Tend<span>24/7</span>
        </Link>
        <nav>
          <Link to="/#features">Features</Link>
          <Link to="/#demo">Demo</Link>
          <Link to="/roadmap">Roadmap</Link>
          <Link to="/architecture">Architecture</Link>
          <Link to="/#self-host">Self-host</Link>
          {repo && <a href={repo}>GitHub</a>}
          {me ? (
            <Link to={me.role === "requester" ? "/portal" : "/app"} className="nav-button">
              {me.demo ? "Back to your demo" : "Open app"}
            </Link>
          ) : demo ? (
            <Link to="/#top" className="nav-button">
              Try the demo
            </Link>
          ) : (
            <Link to="/signin" className="nav-button">
              Sign in
            </Link>
          )}
        </nav>
      </header>
      <main>{children}</main>
      <footer className="site-footer">
        <div>
          <span className="wordmark small">
            Tend<span>24/7</span>
          </span>
          <p>Open-source work management for front and back-office teams. Runs on Cloudflare Workers and Postgres.</p>
        </div>
        <nav>
          <Link to="/roadmap">Roadmap</Link>
          <Link to="/architecture">Architecture</Link>
          {repo && <a href={repo}>Source</a>}
          {!demo && <Link to="/signin">Sign in</Link>}
        </nav>
      </footer>
    </div>
  );
}

export function SiteSection({ id, title, lead, children }: { id?: string; title: string; lead?: string; children: ReactNode }) {
  return (
    <section id={id} className="site-section">
      <h2>{title}</h2>
      {lead && <p className="section-lead">{lead}</p>}
      {children}
    </section>
  );
}
