// Phase 3: the public demo. Turnstile-gated start, sandboxes cloned from a golden copy, the
// role switcher, reset, expiry and pool upkeep, the simulator, and the guardrails.
import { describe, expect, it, beforeAll } from "vitest";
import { appSql, ownerSql, makeApp, baseConfig, Client, unique } from "./helpers.ts";
import { demoUpkeep, ensureGolden, simulateStep } from "../src/worker/demo/service.ts";
import { runDueJobs, processTenantOutbox } from "../src/worker/jobs/runner.ts";
import { MemoryBlobStore } from "../src/worker/attachments/blobs.ts";

const sql = appSql();
const blobs = new MemoryBlobStore();
const demo = { ...baseConfig.demo, enabled: true, poolSize: 2, maxRecords: 40 };
const hooks: string[] = [];
const { app, worker } = makeApp(sql, {
  blobs,
  config: { publicSite: true, demo },
  verifyTurnstile: async (token) => token === "human",
  webhookFetch: async (url) => {
    hooks.push(url);
    return new Response("ok");
  },
});

async function tenantOf(c: Client): Promise<string> {
  return (await c.get("/api/me")).json.workspaceId;
}

async function startDemo(): Promise<Client> {
  const c = new Client(app);
  const r = await c.post("/auth/demo/start", { turnstileToken: "human" });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return c;
}

describe("starting the demo", () => {
  let visitor: Client;

  beforeAll(async () => {
    visitor = await startDemo();
  });

  it("needs a passing Turnstile check", async () => {
    expect((await new Client(app).post("/auth/demo/start", {})).status).toBe(403);
    expect((await new Client(app).post("/auth/demo/start", { turnstileToken: "bot" })).status).toBe(403);
  });

  it("is off unless the deployment hosts the demo", async () => {
    const { app: plain } = makeApp(sql);
    expect((await new Client(plain).post("/auth/demo/start", { turnstileToken: "human" })).status).toBe(404);
    expect((await new Client(plain).get("/auth/config")).json.demo).toEqual({ enabled: false, turnstileSiteKey: null });
  });

  it("signs the visitor in as Sam, an agent, in a private copy of Fernhollow that expires", async () => {
    const me = await visitor.get("/api/me");
    expect(me.json).toMatchObject({ email: "sam@fernhollow.test", role: "agent" });
    const info = await visitor.get("/api/demo/info");
    expect(info.json.persona).toBe("agent");
    expect(info.json.personas.map((p: { key: string }) => p.key)).toEqual(["requester", "agent", "lead", "admin"]);
    const hours = (Date.parse(info.json.expiresAt) - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
    const list = await visitor.get("/api/records?limit=100");
    expect(list.json.items.length).toBeGreaterThanOrEqual(10);
  });

  it("opens with an urgent incident whose SLA breaches within minutes", async () => {
    const list = await visitor.get(`/api/records?limit=100&q=${encodeURIComponent("capper")}`);
    const urgent = list.json.items.find((r: { title: string }) => r.title.startsWith("Bottling line stopped"));
    expect(urgent).toBeTruthy();
    const detail = await visitor.get(`/api/records/${urgent.key}`);
    const first = detail.json.sla.find((c: { metric: string }) => c.metric === "first_response");
    const minutes = (Date.parse(first.dueAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(1);
    expect(minutes).toBeLessThan(5);
  });

  it("gives every visitor a separate sandbox", async () => {
    const other = await startDemo();
    expect(await tenantOf(other)).not.toBe(await tenantOf(visitor));
    const mine = await visitor.post("/api/records", { recordTypeId: (await visitor.get("/api/config")).json.projects.find((p: { key: string }) => p.key === "ITSD").recordTypes[0].id, title: "Only in my sandbox", custom: { site: "office" } });
    expect(mine.status).toBe(201);
    const theirs = await other.get(`/api/records?q=${encodeURIComponent("Only in my sandbox")}`);
    expect(theirs.json.items).toHaveLength(0);
  });

  it("the golden copy and pool can never be signed into", async () => {
    const golden = await ensureGolden(sql);
    const [g] = await sql<{ slug: string }[]>`select slug from tenants where id = ${golden.id}`;
    expect((await new Client(app).post("/auth/dev", { email: "admin@fernhollow.test", workspace: g!.slug })).status).toBe(404);
  });
});

describe("inside a sandbox", () => {
  let visitor: Client;
  beforeAll(async () => {
    visitor = await startDemo();
  });

  it("switches between requester, agent, team lead and admin", async () => {
    for (const [persona, email, role] of [
      ["requester", "jo@fernhollow.test", "requester"],
      ["lead", "dana@fernhollow.test", "agent"],
      ["admin", "admin@fernhollow.test", "admin"],
    ] as const) {
      const r = await visitor.post("/api/demo/persona", { persona });
      expect(r.status).toBe(200);
      expect((await visitor.get("/api/me")).json).toMatchObject({ email, role });
    }
    expect((await visitor.post("/api/demo/persona", { persona: "root" })).status).toBe(422);
  });

  it("captures mail in the sandbox instead of sending it", async () => {
    await visitor.post("/api/demo/persona", { persona: "requester" });
    const cfg = (await visitor.get("/api/config")).json;
    const itsd = cfg.projects.find((p: { key: string }) => p.key === "ITSD");
    const r = await visitor.post("/api/records", { recordTypeId: itsd.recordTypes[0].id, title: "Mouse is broken", custom: { site: "office" } });
    expect(r.status).toBe(201);
    const mail = await visitor.get("/api/demo/mail");
    expect(mail.json.mail.some((m: { subject: string; toAddr: string }) => m.subject.includes("Mouse is broken") && m.toAddr === "jo@fernhollow.test")).toBe(true);
  });

  it("applies the guardrails: read-only tokens, 1 MB files, no inbound mail, no imports, webhooks never sent", async () => {
    await visitor.post("/api/demo/persona", { persona: "admin" });
    expect((await visitor.post("/api/tokens", { name: "w", scopes: ["records:write"] })).status).toBe(403);
    expect((await visitor.post("/api/tokens", { name: "r", scopes: ["records:read"] })).status).toBe(201);
    const big = await visitor.upload("/api/records/ITSD-1/attachments", new Uint8Array(1024 * 1024 + 1), "big.bin");
    expect(big.status).toBe(400);
    expect(big.json.error.message).toMatch(/1 MB/);
    expect((await visitor.upload("/api/records/ITSD-1/attachments", new Uint8Array(1000), "small.bin")).status).toBe(201);
    const projects = (await visitor.get("/api/admin/projects")).json.projects;
    const itsd = projects.find((p: { key: string }) => p.key === "ITSD");
    expect((await visitor.patch(`/api/admin/projects/${itsd.id}`, { inbound: { address: unique("x").toLowerCase().slice(0, 20), recordTypeId: itsd.id } })).status).toBe(403);
    expect((await visitor.post("/api/admin/import/records", { recordTypeId: itsd.id, csv: "title\nx", dryRun: false })).status).toBe(403);

    const hook = await visitor.post("/api/admin/webhooks", { name: "x", url: "https://hooks.example.com/demo", topics: ["record.created"] });
    expect(hook.status).toBe(201);
    const cfg = (await visitor.get("/api/config")).json;
    await visitor.post("/api/records", { recordTypeId: cfg.projects.find((p: { key: string }) => p.key === "ITSD").recordTypes[0].id, title: "Webhook bait", custom: { site: "office" } });
    await runDueJobs(worker());
    expect(hooks).toHaveLength(0);
    const log = await visitor.get(`/api/admin/webhook-deliveries?endpointId=${hook.json.endpoint.id}`);
    expect(log.json.deliveries[0]).toMatchObject({ status: "skipped" });
  });

  it("caps the number of records", async () => {
    const cfg = (await visitor.get("/api/config")).json;
    const typeId = cfg.projects.find((p: { key: string }) => p.key === "ITSD").recordTypes[0].id;
    let status = 201;
    for (let i = 0; i < 40 && status === 201; i++) {
      status = (await visitor.post("/api/records", { recordTypeId: typeId, title: `Filler ${i}`, custom: { site: "office" } })).status;
    }
    expect(status).toBe(403);
  });

  it("reset swaps in a fresh sandbox and retires the old one", async () => {
    const before = await tenantOf(visitor);
    const r = await visitor.post("/api/demo/reset");
    expect(r.status).toBe(200);
    const after = await tenantOf(visitor);
    expect(after).not.toBe(before);
    expect((await visitor.get("/api/me")).json.email).toBe("admin@fernhollow.test"); // same persona
    // The old sandbox is deleted at once, not left for upkeep.
    expect((await sql`select 1 from tenants where id = ${before}`).length).toBe(0);
  });

  it("resets share the per-visitor start limit, and the number of live sandboxes is capped", async () => {
    let allowed = 1;
    const { app: limited } = makeApp(sql, {
      config: { publicSite: true, demo },
      verifyTurnstile: async () => true,
      rateLimits: { demoStart: { limit: async () => allowed-- > 0 } },
    });
    const c = new Client(limited);
    expect((await c.post("/auth/demo/start", { turnstileToken: "human" })).status).toBe(200);
    expect((await c.post("/api/demo/reset")).status).toBe(429);
    const [live] = await sql<{ n: number }[]>`select count(*)::int as n from tenants where demo_state = 'claimed' and expires_at > now()`;
    const { app: full } = makeApp(sql, { config: { publicSite: true, demo: { ...demo, maxSandboxes: live!.n } }, verifyTurnstile: async () => true });
    expect((await new Client(full).post("/auth/demo/start", { turnstileToken: "human" })).status).toBe(429);
  });
});

describe("upkeep, pool and simulator", () => {
  it("deletes expired sandboxes with their files and keeps the pool full", async () => {
    const visitor = await startDemo();
    const tenantId = await tenantOf(visitor);
    await blobs.put(`t/${tenantId}/a/x`, new Uint8Array([1]), "application/octet-stream");
    await sql`update tenants set expires_at = now() - interval '1 minute' where id = ${tenantId}`;
    expect((await visitor.get("/api/me")).status).toBe(401);
    for (let i = 0; i < 6; i++) await demoUpkeep(worker());
    expect((await sql`select 1 from tenants where id = ${tenantId}`).length).toBe(0);
    expect(await blobs.list(`t/${tenantId}/`)).toEqual([]);
    const [pool] = await sql<{ n: number }[]>`select count(*)::int as n from tenants where demo_state = 'pool'`;
    expect(pool!.n).toBe(2);

    // The next visitor takes a sandbox from the pool.
    const next = await startDemo();
    const claimed = await tenantOf(next);
    const [row] = await sql<{ demoState: string }[]>`select demo_state from tenants where id = ${claimed}`;
    expect(row!.demoState).toBe("claimed");
    const [left] = await sql<{ n: number }[]>`select count(*)::int as n from tenants where demo_state = 'pool'`;
    expect(left!.n).toBe(1);
  });

  it("the simulator acts only in live, watched sandboxes", async () => {
    const visitor = await startDemo();
    const tenantId = await tenantOf(visitor);
    const w = worker();
    const count = async () => (await sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      const [r] = await tx<{ n: number }[]>`select (select count(*) from records)::int + (select count(*) from comments)::int + (select count(*) from record_events)::int as n`;
      return r!.n;
    })) as number;
    const start = await count();
    for (let i = 0; i < 5; i++) expect(await simulateStep(w, tenantId)).toBeInstanceOf(Date);
    await processTenantOutbox(w, tenantId);
    expect(await count()).toBeGreaterThan(start);

    await sql`update tenants set last_active_at = now() - interval '1 hour' where id = ${tenantId}`;
    const idle = await count();
    expect(await simulateStep(w, tenantId)).toBeInstanceOf(Date);
    expect(await count()).toBe(idle);

    await sql`update tenants set expires_at = now() - interval '1 second' where id = ${tenantId}`;
    expect(await simulateStep(w, tenantId)).toBeNull();
  });

  it("publishes anonymous stats for the landing page", async () => {
    const r = await new Client(app).get("/auth/demo/stats");
    expect(r.headers.get("cache-control")).toMatch(/max-age=60/);
    expect(r.json.stats.sandboxesToday).toBeGreaterThanOrEqual(3);
    expect(r.json.stats.requestsToday).toBeGreaterThanOrEqual(1);
  });
});

describe("the landing page without a database", () => {
  it("still gets its config when the database check fails, and nothing else works", async () => {
    const { app: broken } = makeApp(ownerSql(), { config: { publicSite: true, demo } });
    const c = new Client(broken);
    const cfg = await c.get("/auth/config");
    expect(cfg.status).toBe(200);
    expect(cfg.json).toMatchObject({ workspace: null, publicSite: true, databaseReady: false, demo: { enabled: true } });
    expect((await c.get("/auth/demo/stats")).json.stats).toBeNull();
    expect((await c.get("/api/me")).status).toBe(503);
    expect((await c.post("/auth/demo/start", { turnstileToken: "human" })).status).toBe(503);
  });
});
