import { SiteLayout, SiteSection } from "./SiteLayout.tsx";
import { ArchitectureDiagram } from "./ArchitectureDiagram.tsx";

const principles = [
  ["Configuration is data", "Record types, fields and workflows are rows an admin edits. No customer change ever needs a database migration."],
  ["Isolation lives in the database", "Every table is protected by Postgres row-level security keyed to the workspace, so a bug in app code cannot leak data."],
  ["Everything is recorded", "Record history and the configuration audit log are append-only: they can be read, never edited."],
  ["One source of truth", "Postgres and the attachment bucket hold everything. Caches, timers and queues are rebuilt from them after a restore."],
  ["Portable Postgres", "Plain SQL that runs the same on Neon, Supabase and PlanetScale, checked by the test suite."],
  ["Fail closed", "The app refuses to serve if its database role could bypass row-level security or the schema is not migrated."],
];

const steps = [
  ["Request arrives", "The Worker, placed near the database, receives every browser, portal, email and API request."],
  ["Who and where", "The session cookie names the workspace and the person; roles decide what they may do."],
  ["Scoped transaction", "The Worker opens a transaction and sets the workspace; row-level security filters every query."],
  ["Change, history, event", "The change, its history entry and an outbox event commit together, or not at all."],
  ["Work happens next", "Right after the response, and on a one-minute cron, the Worker drains the outbox: notifications, automation, emails, SLA timers."],
];

const stack = [
  ["API and hosting", "Cloudflare Workers, Hono, Smart Placement"],
  ["Web app", "React and Vite, served as Workers static assets"],
  ["Database", "Postgres through Hyperdrive: Neon, Supabase or PlanetScale"],
  ["Files", "R2, with a replica bucket for recovery"],
  ["Background work", "Outbox and timers in Postgres, drained after each response and by a one-minute Cron Trigger"],
  ["Email", "Email Routing in; Cloudflare Email Sending, Postmark or Resend out"],
  ["Backups", "Point-in-time recovery at the Postgres host, plus a nightly AES-GCM export to R2"],
  ["Live updates", "Short polling today; Durable Objects with WebSocket hibernation later"],
  ["Integrations", "Scoped API tokens, signed webhooks with retries, CSV import, whole-workspace bundles"],
  ["Public demo", "Turnstile, a golden copy cloned per visitor with fresh ids and shifted dates, a warm pool, Workers Rate Limiting"],
  ["Sign-in", "Your OIDC provider for staff; one-time email links for requesters"],
];

type St = "shipped" | "partial" | "planned";
const requirements: { group: string; ids: string; status: St; items: string[] }[] = [
  { group: "Records and configuration", ids: "FR-01 to FR-05", status: "shipped", items: ["Records with keys and custom fields", "Versioned workflows and layouts", "Four starter templates"] },
  { group: "Work routing", ids: "FR-06 to FR-09", status: "shipped", items: ["Teams, queues, round-robin", "Automation rules", "Approvals and business-hours SLAs"] },
  { group: "Collaboration", ids: "FR-10 to FR-13", status: "shipped", items: ["Public and internal comments, mentions", "Attachments", "Email threading and notifications"] },
  { group: "Finding work", ids: "FR-14 to FR-16", status: "shipped", items: ["Filters, saved views, boards, bulk edit", "Search across comments", "Dashboards"] },
  { group: "Access and audit", ids: "FR-17 to FR-19", status: "shipped", items: ["Roles plus restricted projects", "Append-only audit trail", "SSO and email-link sign-in"] },
  { group: "Integration", ids: "FR-20 to FR-24", status: "shipped", items: ["REST API with scoped tokens", "Signed webhooks", "Requester portal, CSV import"] },
  { group: "Self-hosting", ids: "S-01 to S-10", status: "shipped", items: ["Migrations and locked-down app role", "PlanetScale in CI; Neon and Supabase guides", "One-command installer"] },
  { group: "Backup and recovery", ids: "B-01 to B-10", status: "shipped", items: ["Trash with admin restore", "Nightly export and replica", "Scheduled restore test"] },
  { group: "Landing page and demo", ids: "D-01 to D-10", status: "shipped", items: ["Landing, roadmap, architecture pages", "24-hour private sandboxes", "Activity simulator"] },
  { group: "Phone access by QR", ids: "Q-01 to Q-10", status: "shipped", items: ["One-time pairing code, approved on the desktop", "Read-only enforced on the server", "Linked devices with revoke and audit"] },
];
const stLabel: Record<St, string> = { shipped: "Shipped", partial: "In progress", planned: "Planned" };

export function Architecture() {
  return (
    <SiteLayout>
      <section className="page-hero">
        <p className="eyebrow">Technical architecture</p>
        <h1>One Worker in front. Postgres as the source of truth.</h1>
        <p className="hero-body">
          Tend 24/7 runs as a single Cloudflare Worker in each company's own account, backed by the Postgres it already uses.
          Here is how a request flows, the principles behind it, and what 1.0 covers.
        </p>
      </section>

      <section className="site-section">
        <div className="diagram-card">
          <ArchitectureDiagram />
        </div>
      </section>

      <SiteSection title="How a request flows">
        <ol className="flow">
          {steps.map(([t, b], i) => (
            <li key={t}>
              <span className="flow-n">{i + 1}</span>
              <div>
                <h3>{t}</h3>
                <p>{b}</p>
              </div>
            </li>
          ))}
        </ol>
      </SiteSection>

      <SiteSection title="Design principles">
        <div className="cards three">
          {principles.map(([t, b]) => (
            <article key={t} className="card-dark">
              <h3>{t}</h3>
              <p>{b}</p>
            </article>
          ))}
        </div>
      </SiteSection>

      <SiteSection title="Core MVP requirements" lead="Ten areas, tracked by requirement ID in the MVP requirements document.">
        <div className="req-grid">
          {requirements.map((r) => (
            <article key={r.group} className="req">
              <div className="req-head">
                <h3>{r.group}</h3>
                <span className={`status ${r.status === "shipped" ? "shipped" : r.status === "partial" ? "next" : "planned"}`}>
                  {stLabel[r.status]}
                </span>
              </div>
              <p className="req-ids">{r.ids}</p>
              <ul>
                {r.items.map((it) => (
                  <li key={it}>{it}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </SiteSection>

      <SiteSection title="Stack">
        <table className="stack-table">
          <tbody>
            {stack.map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SiteSection>
    </SiteLayout>
  );
}
