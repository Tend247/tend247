// How a request flows: every client enters one Worker; Postgres is the source of truth.

const clients = [
  ["Agent web app", "internal teams"],
  ["Requester portal", "plus landing and demo"],
  ["Inbound email", "via Email Routing"],
  ["API clients", "scoped tokens"],
  ["Cron Trigger", "every minute: events, timers"],
] as const;

const services = [
  ["Postgres via Hyperdrive", "records, config, outbox, timers"],
  ["R2: attachments", "files and their replica"],
  ["R2: backups", "nightly encrypted export"],
  ["Email Sending", "or Postmark, Resend"],
  ["Email Routing", "queue addresses, replies"],
  ["Durable Objects", "live updates, demo (1.0)"],
  ["Queues", "optional fan-out at scale"],
] as const;

export function ArchitectureDiagram() {
  const ax = 24, aw = 168, wx = 264, ww = 200, cx = 536, cw = 200, bh = 56;
  const clientY = (i: number) => 72 + i * 108;
  const serviceY = (i: number) => 72 + i * 72;
  return (
    <svg viewBox="0 0 760 584" role="img" aria-label="One Worker fronts everything; Postgres stays the system of record" className="arch">
      <defs>
        <marker id="arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" className="arch-arrowhead" />
        </marker>
      </defs>
      <g className="arch-lines">
        {clients.map((_, i) => (
          <path key={`c${i}`} d={`M${ax + aw} ${clientY(i) + 28}H${wx}`} markerEnd="url(#arch-arrow)" />
        ))}
        {services.map((_, i) => (
          <path key={`s${i}`} d={`M${wx + ww} ${serviceY(i) + 28}H${cx}`} markerEnd="url(#arch-arrow)" />
        ))}
      </g>
      {clients.map(([name, body], i) => (
        <g key={name}>
          <rect x={ax} y={clientY(i)} width={aw} height={bh} rx="8" className="arch-box" />
          <text x={ax + 12} y={clientY(i) + 24} className="arch-name">{name}</text>
          <text x={ax + 12} y={clientY(i) + 42} className="arch-body">{body}</text>
        </g>
      ))}
      <rect x={wx} y="72" width={ww} height="488" rx="10" className="arch-core" />
      <text x={wx + ww / 2} y="290" textAnchor="middle" className="arch-core-name">Tend 24/7 Worker</text>
      <text x={wx + ww / 2} y="316" textAnchor="middle" className="arch-core-body">Hono API + web app</text>
      <text x={wx + ww / 2} y="336" textAnchor="middle" className="arch-core-body">OIDC or email-link sign-in</text>
      <text x={wx + ww / 2} y="356" textAnchor="middle" className="arch-core-body">Smart Placement,</text>
      <text x={wx + ww / 2} y="376" textAnchor="middle" className="arch-core-body">runs near Postgres</text>
      {services.map(([name, body], i) => (
        <g key={name}>
          <rect x={cx} y={serviceY(i)} width={cw} height={bh} rx="8" className={i === 0 ? "arch-box db" : "arch-box"} />
          <text x={cx + 12} y={serviceY(i) + 24} className="arch-name">{name}</text>
          <text x={cx + 12} y={serviceY(i) + 42} className="arch-body">{body}</text>
        </g>
      ))}
    </svg>
  );
}
