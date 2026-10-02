// The public demo on tend247.com: each visitor gets a private copy of Fernhollow Foods.
//
//  golden   one read-only master per seed version, built with the same code as db:seed
//  pool     a few ready-made copies, so "Try the demo" never waits; recycled after an hour so
//           the sample work always looks recent (copies are time-shifted to the moment made)
//  claimed  a visitor's sandbox: expires after TEND247_DEMO_HOURS, then it is deleted with
//           its files. Reset swaps in a fresh copy.
//
// While someone is looking at a sandbox, a simulator files new requests, moves work along and
// comments, and an urgent incident is backdated on arrival so an SLA breaches within minutes.
// Guardrails: mail goes to the sandbox's mail viewer instead of being sent, webhooks are logged
// but never sent, API tokens are read-only, writes are rate limited, files are capped at 1 MB
// and records at TEND247_DEMO_MAX_RECORDS.
import type { Sql, Tx } from "../db/client.ts";
import { withTenant } from "../db/client.ts";
import type { AppConfig } from "../config.ts";
import type { WorkerDeps } from "../jobs/runner.ts";
import type { Actor } from "../audit.ts";
import { createRecord } from "../records/service.ts";
import { runTransition } from "../records/transitions.ts";
import { loadRecord } from "../records/access.ts";
import { createComment } from "../comments/service.ts";
import { syncSla } from "../sla/service.ts";
import { cancelJob, scheduleJob } from "../jobs/schedule.ts";
import { buildFernhollow, FERNHOLLOW_SEED_VERSION, PERSONAS, type Persona } from "./fernhollow.ts";
import { deleteWorkspace, importWorkspace, readWorkspace, type WorkspaceData } from "../workspace/bundle.ts";
import { AppError } from "../lib/errors.ts";

export const DEMO_ATTACHMENT_MAX_MB = 1;
const POOL_MAX_AGE_MINUTES = 60;
const IDLE_MINUTES = 20;
const GOLDEN_LOCK = 7247_0003;
/** People per sandbox (the sample has six; room to add a few). */
const SANDBOX_MAX_USERS = 40;

export function isPersona(v: unknown): v is Persona {
  return typeof v === "string" && Object.hasOwn(PERSONAS, v);
}

export function personaOf(email: string): Persona | null {
  for (const [k, p] of Object.entries(PERSONAS)) if (p.email === email) return k as Persona;
  return null;
}

// ---------------------------------------------------------------- analytics (anonymous)

export async function bump(sql: Sql | Tx, event: string, n = 1): Promise<void> {
  await sql`
    insert into demo_analytics (day, event, count) values (current_date, ${event}, ${n})
    on conflict (day, event) do update set count = demo_analytics.count + excluded.count`;
}

export async function publicStats(sql: Sql) {
  const [row] = await sql<{ today: number; week: number; requests: number; active: number }[]>`
    select
      coalesce((select sum(count) from demo_analytics where event = 'demo.started' and day = current_date), 0)::int as today,
      coalesce((select sum(count) from demo_analytics where event = 'demo.started' and day > current_date - 7), 0)::int as week,
      coalesce((select sum(count) from demo_analytics where event = 'demo.requests' and day = current_date), 0)::int as requests,
      (select count(*) from tenants where demo_state = 'claimed' and expires_at > now()
         and last_active_at > now() - interval '15 minutes')::int as active`;
  return { sandboxesToday: row!.today, sandboxesThisWeek: row!.week, requestsToday: row!.requests, activeNow: row!.active };
}

// ---------------------------------------------------------------- golden copy and pool

let goldenCache: { id: string; data: WorkspaceData; createdAt: Date } | null = null;

/** The golden copy for the current seed version, built on first use. */
export async function ensureGolden(sql: Sql): Promise<{ id: string; createdAt: Date }> {
  const find = async () => {
    const [g] = await sql<{ id: string; createdAt: Date }[]>`
      select id, created_at from tenants where demo_state = 'golden' and demo_seed = ${FERNHOLLOW_SEED_VERSION}`;
    return g ?? null;
  };
  const existing = await find();
  if (existing) return existing;
  // One builder at a time; others wait and then find it.
  return (await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${GOLDEN_LOCK})`;
    const [again] = await tx<{ id: string; createdAt: Date }[]>`
      select id, created_at from tenants where demo_state = 'golden' and demo_seed = ${FERNHOLLOW_SEED_VERSION}`;
    if (again) return again;
    const [t] = await tx<{ id: string; createdAt: Date }[]>`
      insert into tenants (slug, name, settings, demo, demo_state, demo_seed)
      values (${`demo-golden-v${FERNHOLLOW_SEED_VERSION}`}, 'Fernhollow Foods', ${tx.json({ timezone: "America/Chicago", attachmentMaxMb: DEMO_ATTACHMENT_MAX_MB })},
              true, 'golden', ${FERNHOLLOW_SEED_VERSION})
      on conflict (slug) do update set demo_seed = excluded.demo_seed
      returning id, created_at`;
    await tx`select set_config('app.tenant_id', ${t!.id}, true)`;
    await buildFernhollow(tx as unknown as Tx, t!.id);
    // The golden copy never changes: no SLA timers fire in it (each sandbox re-arms its own).
    await tx`delete from scheduled_jobs where tenant_id = ${t!.id}`;
    return t!;
  })) as { id: string; createdAt: Date };
}

async function goldenData(sql: Sql): Promise<{ data: WorkspaceData; createdAt: Date }> {
  const g = await ensureGolden(sql);
  if (goldenCache?.id !== g.id) goldenCache = { id: g.id, data: await readWorkspace(sql, g.id), createdAt: g.createdAt };
  return goldenCache;
}

function sandboxSlug(): string {
  return `demo-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** Make one sandbox from the golden copy, time-shifted so its work looks as if filed today. */
export async function createSandbox(sql: Sql, config: AppConfig, state: "pool" | "claimed", now = new Date()): Promise<string> {
  const golden = await goldenData(sql);
  const result = await importWorkspace(sql, golden.data, {
    slug: sandboxSlug(),
    name: "Fernhollow Foods",
    demo: {
      state,
      seed: FERNHOLLOW_SEED_VERSION,
      expiresAt: state === "claimed" ? new Date(now.getTime() + config.demo.hours * 3600_000) : null,
    },
    timeShiftMs: now.getTime() - golden.createdAt.getTime(),
  });
  await sql`update tenants set max_records = ${config.demo.maxRecords}, max_users = ${SANDBOX_MAX_USERS} where id = ${result.tenantId}`;
  return result.tenantId;
}

/** Hand a visitor a sandbox: from the pool when one is waiting, else a fresh copy. */
export async function claimSandbox(sql: Sql, config: AppConfig, now = new Date()): Promise<{ tenantId: string; expiresAt: Date }> {
  const expiresAt = new Date(now.getTime() + config.demo.hours * 3600_000);
  const [live] = await sql<{ n: number }[]>`
    select count(*)::int as n from tenants where demo_state = 'claimed' and expires_at > now()`;
  if ((live?.n ?? 0) >= config.demo.maxSandboxes) {
    throw new AppError("rate_limited", "The demo is very busy right now. Please try again in a few minutes.");
  }
  const [claimed] = await sql<{ id: string }[]>`
    update tenants set demo_state = 'claimed', claimed_at = now(), last_active_at = now(), expires_at = ${expiresAt}
    where id = (
      select id from tenants where demo_state = 'pool' and demo_seed = ${FERNHOLLOW_SEED_VERSION}
        and created_at > now() - make_interval(mins => ${POOL_MAX_AGE_MINUTES})
      order by created_at desc limit 1 for update skip locked)
    returning id`;
  const tenantId = claimed?.id ?? (await createSandbox(sql, config, "claimed", now));
  if (!claimed) await sql`update tenants set expires_at = ${expiresAt} where id = ${tenantId}`;
  await kickoff(sql, tenantId);
  await bump(sql, "demo.started");
  return { tenantId, expiresAt };
}

/** Sign-in target for a persona in a sandbox. */
export async function personaUser(sql: Sql, tenantId: string, persona: Persona): Promise<string> {
  const [u] = await withTenant(sql, tenantId, (tx) => tx<{ id: string }[]>`
    select id from users where email = ${PERSONAS[persona].email} and active`);
  if (!u) throw new AppError("not_found", "That demo person is not available in this sandbox");
  return u.id;
}

// ---------------------------------------------------------------- upkeep (cron)

/** Every minute on the demo deployment: delete expired sandboxes, recycle old pool copies, refill. */
export async function demoUpkeep(w: WorkerDeps): Promise<{ purged: number; created: number }> {
  if (!w.config.demo.enabled) return { purged: 0, created: 0 };
  let purged = 0;
  const expired = await w.sql<{ id: string }[]>`
    select id from tenants
    where demo and demo_state is distinct from 'golden'
      and (expires_at < now()
           or (demo_state = 'pool' and (demo_seed <> ${FERNHOLLOW_SEED_VERSION}
               or created_at < now() - make_interval(mins => ${POOL_MAX_AGE_MINUTES}))))
    order by expires_at nulls last limit 5`;
  for (const t of expired) {
    await deleteWorkspace(w.sql, t.id, [w.blobs, w.replica]);
    purged++;
  }
  // Retire golden copies of older seed versions once nothing claimed depends on them.
  await w.sql`
    delete from tenants where demo_state = 'golden' and demo_seed <> ${FERNHOLLOW_SEED_VERSION}`;
  let created = 0;
  const [pool] = await w.sql<{ n: number }[]>`
    select count(*)::int as n from tenants where demo_state = 'pool' and demo_seed = ${FERNHOLLOW_SEED_VERSION}`;
  if ((pool?.n ?? 0) < w.config.demo.poolSize) {
    await createSandbox(w.sql, w.config, "pool", w.now());
    created++;
  }
  return { purged, created };
}

// ---------------------------------------------------------------- simulator

const SIM_REQUESTS: { project: "itsd" | "hr" | "fin"; title: string; custom: Record<string, unknown>; priority?: string; description?: string }[] = [
  { project: "itsd", title: "Handheld scanner battery won't hold a charge", custom: { site: "warehouse", asset_tag: "SC-0131" } },
  { project: "itsd", title: "Can't log in to the recipe system", custom: { site: "sauce_kitchen" }, priority: "high" },
  { project: "itsd", title: "Label printer prints blank labels", custom: { site: "bottling_line", asset_tag: "LP-0045" }, priority: "high" },
  { project: "itsd", title: "Office Wi-Fi drops every few minutes", custom: { site: "office" } },
  { project: "itsd", title: "Need access to the shared quality folder", custom: { site: "office" }, priority: "low" },
  { project: "itsd", title: "Forklift tablet stuck on update screen", custom: { site: "warehouse", asset_tag: "TB-0022" } },
  { project: "hr", title: "Can I swap Thursday's late shift?", custom: { category: "shift_swap", site: "bottling_line" }, description: "Taylor can cover 2pm to 10pm." },
  { project: "hr", title: "Question about holiday pay", custom: { category: "payroll", site: "warehouse" }, description: "Does the day after Thanksgiving count?" },
  { project: "hr", title: "Requesting two days of leave in December", custom: { category: "leave", site: "sauce_kitchen" }, description: "December 22 and 23." },
  { project: "fin", title: "Invoice total doesn't match PO: jar labels", custom: { vendor: "PrintWorks", amount: 812.5, reason: "price_mismatch" } },
  { project: "fin", title: "Second invoice for the same pallet delivery", custom: { vendor: "Northline Haul", amount: 1265.4, reason: "duplicate" }, priority: "low" },
  { project: "fin", title: "Short delivery: chili flakes", custom: { vendor: "Ancho & Co", amount: 2210, reason: "quantity_mismatch" }, priority: "high" },
];

const SIM_REPLIES = [
  "Thanks, any update on this?",
  "It happened again this morning.",
  "Here's the detail you asked for: it's dock 3, the scanner by the door.",
  "No rush, just checking it's on the list.",
];

const SIM_RESOLUTIONS = ["Replaced the faulty part; working again.", "Reset the account and confirmed sign-in.", "Updated the firmware; tested with the line lead."];

interface SimContext {
  tx: Tx;
  tenantId: string;
  as: (email: string) => Promise<Actor>;
  types: Record<"itsd" | "hr" | "fin", string>;
}

async function simContext(tx: Tx, tenantId: string): Promise<SimContext> {
  const users = await tx<{ id: string; email: string; role: Actor["role"] }[]>`select id, email, role from users where active`;
  const types = await tx<{ key: string; id: string }[]>`
    select p.key, rt.id from record_types rt join projects p on p.id = rt.project_id where rt.archived_at is null and p.archived_at is null`;
  const typeOf = (key: string) => types.find((t) => t.key === key)?.id ?? "";
  return {
    tx,
    tenantId,
    as: async (email) => {
      const u = users.find((x) => x.email === email);
      if (!u) throw new Error(`demo user ${email} missing`);
      return { tenantId, userId: u.id, role: u.role };
    },
    types: { itsd: typeOf("ITSD"), hr: typeOf("HR"), fin: typeOf("FIN") },
  };
}

/** When a visitor arrives: an urgent incident filed 27 minutes ago, so its 30-minute SLA breaches soon. */
async function kickoff(sql: Sql, tenantId: string): Promise<void> {
  await withTenant(sql, tenantId, async (tx) => {
    const ctx = await simContext(tx, tenantId);
    if (!ctx.types.itsd) return;
    const jo = await ctx.as(PERSONAS.requester.email);
    const record = await createRecord(tx, jo, {
      recordTypeId: ctx.types.itsd,
      title: "Bottling line stopped: capper jammed",
      description: "Line 2 capper is jammed and the line is stopped. Maintenance is on the way but we need the PLC reset.",
      priority: "urgent",
      custom: { site: "bottling_line", asset_tag: "CP-0002" },
    });
    const filedAt = new Date(Date.now() - 27 * 60_000);
    await tx`update records set created_at = ${filedAt} where id = ${record.id}`;
    const clocks = await tx<{ id: string }[]>`delete from sla_clocks where record_id = ${record.id} returning id`;
    for (const c of clocks) await cancelJob(tx, tenantId, "sla", c.id);
    await syncSla(tx, { ...record, createdAt: filedAt });
  });
  await scheduleJob(sql, tenantId, "demo_sim", tenantId, new Date(Date.now() + 90_000));
}

const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)]!;

/** One simulator step for a sandbox (the demo_sim timer). Returns when to run next, or null to stop. */
export async function simulateStep(w: WorkerDeps, tenantId: string): Promise<Date | null> {
  const [t] = await w.sql<{ demoState: string | null; expiresAt: Date | null; lastActiveAt: Date | null }[]>`
    select demo_state, expires_at, last_active_at from tenants where id = ${tenantId}`;
  if (!t || t.demoState !== "claimed" || !t.expiresAt || t.expiresAt <= w.now()) return null;
  const next = new Date(w.now().getTime() + (120 + Math.floor(Math.random() * 120)) * 1000);
  if (!t.lastActiveAt || w.now().getTime() - t.lastActiveAt.getTime() > IDLE_MINUTES * 60_000) return next; // nobody watching
  await withTenant(w.sql, tenantId, async (tx) => {
    const ctx = await simContext(tx, tenantId);
    const [count] = await tx<{ n: number }[]>`select count(*)::int as n from records`;
    const roll = Math.random();
    if (roll < 0.5 && (count?.n ?? 0) < w.config.demo.maxRecords - 20) {
      const r = pick(SIM_REQUESTS);
      if (!ctx.types[r.project]) return;
      const by = await ctx.as(pick([PERSONAS.requester.email, "pat@fernhollow.test"]));
      await createRecord(tx, by, {
        recordTypeId: ctx.types[r.project],
        title: r.title,
        description: r.description ?? "",
        custom: r.custom,
        ...(r.priority ? { priority: r.priority } : {}),
      });
      return;
    }
    if (roll < 0.8) {
      // An agent picks up new work or resolves something in progress on the service desk.
      const [rec] = await tx<{ key: string; status: string }[]>`
        select key, status from records
        where deleted_at is null and record_type_id = ${ctx.types.itsd} and status in ('new', 'in_progress')
          and pending_approval_id is null
        order by random() limit 1`;
      if (!rec) return;
      const agent = await ctx.as(pick(["lee@fernhollow.test", PERSONAS.agent.email]));
      const loaded = await loadRecord(tx, agent, rec.key, { lock: true });
      if (!loaded) return;
      if (rec.status === "new") await runTransition(tx, agent, loaded, "start");
      else await runTransition(tx, agent, loaded, "resolve", { fields: { custom: { resolution: pick(SIM_RESOLUTIONS) } } });
      return;
    }
    const [waiting] = await tx<{ key: string; requesterId: string }[]>`
      select key, requester_id from records
      where deleted_at is null and status_category <> 'done' and requester_id is not null
      order by random() limit 1`;
    if (!waiting) return;
    const [requester] = await tx<{ email: string }[]>`select email from users where id = ${waiting.requesterId} and role = 'requester'`;
    if (!requester) return;
    await createComment(tx, await ctx.as(requester.email), waiting.key, { body: pick(SIM_REPLIES), internal: false });
  });
  return next;
}

