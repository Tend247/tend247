import { SiteLayout, SiteSection } from "./SiteLayout.tsx";

type Status = "shipped" | "next" | "planned";

const phases: { version: string; name: string; status: Status; items: string[]; gate: string }[] = [
  {
    version: "v0.1",
    name: "Foundations",
    status: "shipped",
    items: [
      "Workspaces isolated by row-level security",
      "Single sign-on, email links, roles",
      "Projects, record types, ten custom field types",
      "Records with keys, history, trash and audit log",
    ],
    gate: "Isolation tests pass; adding a field needs no migration",
  },
  {
    version: "v0.2",
    name: "Work core",
    status: "shipped",
    items: [
      "Configurable workflows with status categories",
      "Layouts, queues, teams and round-robin assignment",
      "Comments, mentions, watchers, attachments",
      "Saved views, boards, full-text search",
    ],
    gate: "One internal team runs a live queue end to end",
  },
  {
    version: "v0.3",
    name: "Service layer",
    status: "shipped",
    items: [
      "SLAs on business-hours calendars",
      "Automation rules and approvals",
      "Email in and out, notifications",
      "Nightly export and attachment replica",
    ],
    gate: "SLA, approval and email flows hold through a pilot week",
  },
  {
    version: "v1.0",
    name: "Launch",
    status: "shipped",
    items: [
      "Requester portal, REST API, signed webhooks",
      "Four starter templates and dashboards",
      "Public demo with 24-hour sandboxes",
      "Read-only phone access by QR pairing",
      "One-command installer, docs, restore drill",
    ],
    gate: "Pilot teams live on two functions; demo and installer public",
  },
];

const readiness: { area: string; items: string[] }[] = [
  {
    area: "Product",
    items: ["Four starter templates", "Requester portal", "Dashboards for SLA and workload", "REST API and webhooks"],
  },
  {
    area: "Trust",
    items: ["Tenant isolation tested on every build", "Append-only audit trail", "Backups, recovery targets, passing restore test", "Phone pairing approved on the desktop, revocable"],
  },
  {
    area: "Adoption",
    items: ["One-command install on Cloudflare", "PlanetScale tested in CI; Neon and Supabase guides", "Install, admin, template, API and restore guides", "Live demo at tend247.com"],
  },
  {
    area: "Community",
    items: ["Open-source license in the repository", "Contributing guide and issue templates", "Public changelog", "Versioned releases"],
  },
];

const later = [
  ["Custom objects", "Registers for assets, contracts or vendors, linked to records."],
  ["Formula fields", "Calculated values and roll-ups across linked records."],
  ["SAML and SCIM", "Enterprise sign-in and automatic user provisioning."],
  ["AI assistance", "Triage suggestions, suggested replies, duplicate detection."],
  ["Knowledge base", "Articles linked to records to deflect repeat requests."],
  ["Beyond Cloudflare", "Running on other clouds or on-premises."],
];

const statusLabel: Record<Status, string> = { shipped: "Shipped", next: "Next", planned: "Planned" };

export function Roadmap() {
  const done = phases.filter((p) => p.status === "shipped").length;
  return (
    <SiteLayout>
      <section className="page-hero">
        <p className="eyebrow">Roadmap</p>
        <h1>From foundations to a market-ready 1.0</h1>
        <p className="hero-body">
          Four phases, each closed by a gate that must pass before the next begins. All four are built: 1.0 is a release
          candidate while the first pilot teams go live.
        </p>
        <div className="progress" role="img" aria-label={`${done} of ${phases.length} phases shipped`}>
          {phases.map((p) => (
            <span key={p.version} className={`seg ${p.status}`} />
          ))}
        </div>
        <p className="muted-dark small">
          {done} of {phases.length} phases shipped
        </p>
      </section>

      <section className="site-section">
        <ol className="phase-track">
          {phases.map((p, i) => (
            <li key={p.version} className={`phase ${p.status}`}>
              <div className="phase-head">
                <span className="phase-version">{p.version}</span>
                <span className={`status ${p.status}`}>{statusLabel[p.status]}</span>
              </div>
              <h3>
                Phase {i} · {p.name}
              </h3>
              <ul>
                {p.items.map((it) => (
                  <li key={it}>{it}</li>
                ))}
              </ul>
              <div className="gate">
                <span className="gate-mark" aria-hidden="true" />
                <span>
                  <strong>Exit gate:</strong> {p.gate}
                </span>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <SiteSection title="What market-ready means for 1.0" lead="The launch gate checks four areas, not just features.">
        <div className="cards four">
          {readiness.map((r) => (
            <article key={r.area} className="card-dark">
              <h3>{r.area}</h3>
              <ul className="ticks compact">
                {r.items.map((it) => (
                  <li key={it}>{it}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </SiteSection>

      <SiteSection title="After 1.0" lead="Planned once real teams are running on it; order follows what adopters ask for.">
        <div className="cards three">
          {later.map(([t, b]) => (
            <article key={t} className="card-dark quiet">
              <h3>{t}</h3>
              <p>{b}</p>
            </article>
          ))}
        </div>
      </SiteSection>
    </SiteLayout>
  );
}
