import { Link } from "react-router";
import { useSession } from "../session.tsx";
import { SiteLayout, SiteSection } from "./SiteLayout.tsx";
import { ProductPreview } from "./ProductPreview.tsx";

const today = [
  {
    title: "Configure without code",
    body: "Admins add projects, record types and ten kinds of custom field at runtime. Configuration is data, so adding a field never changes the database schema.",
  },
  {
    title: "Workspaces that cannot leak",
    body: "Row-level security on every table, enforced by Postgres itself and proven by isolation tests on every build. The app refuses to start on an unsafe database role.",
  },
  {
    title: "History on everything",
    body: "Every record change and every configuration change lands in an append-only log with who, when, and the before and after values.",
  },
  {
    title: "A trash that forgives",
    body: "Deleted records move to a trash, and admins restore them with their full history intact.",
  },
  {
    title: "Sign in your way",
    body: "Staff use your company's single sign-on (Okta, Entra ID, Google Workspace). Requesters get one-time email links, no passwords.",
  },
  {
    title: "Safe with many hands",
    body: "Records get readable keys like FIN-142, and optimistic locking stops two agents silently overwriting each other.",
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
  return (
    <SiteLayout>
      <section className="hero">
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
            <span className="button-primary disabled" aria-disabled="true">
              Try the live demo
            </span>
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
          <p className="hero-note">
            The live demo opens with the 1.0 launch. <Link to="/roadmap">See the roadmap</Link>.
          </p>
        </div>
        <div className="hero-visual">
          <ProductPreview />
        </div>
      </section>

      <SiteSection id="features" title="What it does today" lead="Foundations shipped first: the parts every later feature depends on.">
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
        lead="Click Try the demo and you get a private copy of Fernhollow Foods, a made-up maker of sauces, spice blends and cold brew."
      >
        <ul className="ticks">
          <li>Your own sandbox, ready instantly and deleted within 24 hours, so nobody sees anyone else's mess.</li>
          <li>Switch roles to submit a request as an employee, work it as an agent, then change the workflow as an admin.</li>
          <li>A simulator keeps numbers moving: new requests arrive, work advances, and an SLA breaches while you watch.</li>
        </ul>
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
            <strong>Bring Postgres.</strong> Neon, Supabase or PlanetScale, all supported and tested.
          </li>
          <li>
            <strong>Migrate.</strong> One command creates the schema and a locked-down app role.
          </li>
          <li>
            <strong>Deploy.</strong> Push the Worker to your Cloudflare account and sign in with your SSO.
          </li>
        </ol>
        <p className="muted-dark">A one-command installer arrives with 1.0; until then the README walks through each step.</p>
      </SiteSection>
    </SiteLayout>
  );
}
