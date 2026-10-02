import { Link } from "react-router";
import { useSession } from "../session.tsx";
import { SiteLayout, SiteSection } from "./SiteLayout.tsx";
import { ProductPreview } from "./ProductPreview.tsx";
import { StatsStrip, TryDemo } from "../demo/TryDemo.tsx";

const today = [
  {
    title: "Configure without code",
    body: "Admins add record types, ten kinds of custom field, workflows and form layouts at runtime. Every version is kept, so any earlier one can be restored.",
  },
  {
    title: "Queues that route themselves",
    body: "Teams own queues, new work is assigned round-robin, and automation rules set fields, assign, move, notify or call a webhook when something happens.",
  },
  {
    title: "SLAs on real working hours",
    body: "First-response and resolution targets count business hours in each calendar's time zone, skip holidays, pause while waiting, and warn before a breach.",
  },
  {
    title: "Approvals and email that thread",
    body: "Steps can need one approver or a sequence, decided in the app or from a one-time email link. Mail to a queue creates a record; replies land as comments.",
  },
  {
    title: "Workspaces that cannot leak",
    body: "Row-level security on every table, enforced by Postgres itself and proven by isolation tests on every build. HR and finance queues can be restricted to their teams.",
  },
  {
    title: "Recoverable by design",
    body: "Full history on every record, a trash for records, comments and files, a nightly encrypted export to a bucket you control, and an attachment replica.",
  },
  {
    title: "A portal for everyone else",
    body: "Employees pick what they need from a catalog, follow their requests, reply and attach files. They never see internal notes.",
  },
  {
    title: "An API and webhooks",
    body: "Scoped API tokens for scripts, signed webhooks for other systems, CSV import for people and records, and dashboards for team leads.",
  },
  {
    title: "Your work on your phone",
    body: "Scan a QR code, approve the phone on your computer, and it shows your queue for four hours, read-only, with nothing to sign in to.",
  },
];

const templates = [
  { name: "HR Cases", body: "Shift swaps, leave questions and policy requests, private to HR and the requester." },
  { name: "IT Service Desk", body: "Break-fix requests from the plant floor and the office, with SLAs by priority." },
  { name: "IT Enhancements", body: "Change requests for internal systems, with approval before work starts." },
  { name: "AP Requests", body: "Invoice exceptions, vendor questions and payment holds for accounts payable." },
];

export function Landing() {
  const { site } = useSession();
  const repo = site?.repoUrl;
  const demo = site?.demo.enabled ?? false;
  return (
    <SiteLayout>
      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="hero-kicker">Can AI build a work-management stack in 12 hours? Claude Opus 5.5 Extra can!</p>
          <p className="eyebrow">Open-source work management for front and back-office teams</p>
          <h1>Every team's requests, from intake to done, in one place.</h1>
          <p className="callout">
            Free and open source. {repo ? <a href={repo}>Get the source</a> : "Get the source"} and deploy it on your own
            Cloudflare account and Postgres.
          </p>
          <p className="hero-body">
            Tend 24/7 gives HR, IT, finance and service teams their own request types, fields and workflows, configured by an
            admin instead of built by engineers. Every change is recorded, and every workspace is isolated in the database.
          </p>
          <div className="hero-actions">
            {demo ? (
              <TryDemo />
            ) : (
              <a className="button-primary" href="https://tend247.com/#demo">
                Try the live demo
              </a>
            )}
            {repo ? (
              <a className="button-outline" href={repo}>
                View the source
              </a>
            ) : (
              <Link className="button-outline" to="/architecture">
                See the architecture
              </Link>
            )}
          </div>
        </div>
        <div className="hero-visual">
          <ProductPreview />
        </div>
      </section>

      <StatsStrip />

      <SiteSection id="features" title="What it does" lead="Version 1.0: the work core, the service layer, a requester portal, an API and the public demo, tested end to end.">
        <div className="cards">
          {today.map((c) => (
            <article key={c.title} className="card-dark">
              <h3>{c.title}</h3>
              <p>{c.body}</p>
            </article>
          ))}
        </div>
      </SiteSection>

      <SiteSection
        title="Built for front and back office"
        lead="Four starter templates ship with 1.0. Install one, rename anything, add your own fields, and the queue is live."
      >
        <div className="cards four">
          {templates.map((t) => (
            <article key={t.name} className="card-dark">
              <span className="tag">Template</span>
              <h3>{t.name}</h3>
              <p>{t.body}</p>
            </article>
          ))}
        </div>
      </SiteSection>

      <SiteSection
        id="demo"
        title="A demo that never gets junked up"
        lead="Try the demo gives you a private copy of Fernhollow Foods, a made-up maker of sauces, spice blends and cold brew."
      >
        <ul className="ticks">
          <li>Your own sandbox, ready instantly and deleted within 24 hours, so nobody sees anyone else's mess.</li>
          <li>Switch roles to submit a request as an employee, work it as an agent, then change the workflow as an admin.</li>
          <li>A simulator keeps numbers moving: new requests arrive, work advances, and an SLA breaches while you watch.</li>
          <li>Nothing leaves the sandbox: email lands in a viewer instead of an inbox, and webhooks are logged, not sent.</li>
        </ul>
        {demo && (
          <p className="muted-dark">
            Start from the <a href="#top">Try the live demo</a> button at the top of the page.
          </p>
        )}
      </SiteSection>

      <SiteSection
        id="self-host"
        title="Run it on your own infrastructure"
        lead="Each company runs its own copy. Your data stays in your Cloudflare account and your Postgres."
      >
        <ol className="steps">
          <li>
            <strong>Get the code.</strong> Fork the repository.
          </li>
          <li>
            <strong>Bring Postgres.</strong> Neon, Supabase, PlanetScale or any Postgres 15+.
          </li>
          <li>
            <strong>Migrate.</strong> One command creates the schema and a locked-down app role.
          </li>
          <li>
            <strong>Deploy.</strong> <code>npm run setup</code> creates the Cloudflare resources and deploys the Worker; sign in with your SSO.
          </li>
        </ol>
        <p className="muted-dark">
          {repo ? <a href={`${repo}/blob/main/docs/install.md`}>The install guide</a> : "The install guide"} explains each step, including
          the database roles to create on PlanetScale, Neon or Supabase.
        </p>
      </SiteSection>
    </SiteLayout>
  );
}
