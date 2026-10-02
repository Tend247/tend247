// Public demo routes. /auth/demo/start is the "Try the demo" button (Turnstile-checked and
// rate limited per visitor); /api/demo/* works only inside a demo sandbox.
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv, Ctx } from "../http.ts";
import { isSecure, readJson, requireAuth, runAfterResponse, sessionCookieName } from "../http.ts";
import { processTenantOutbox, workerDeps } from "../jobs/runner.ts";
import { withTenant } from "../db/client.ts";
import { createSession, destroySession } from "../auth/sessions.ts";
import { PERSONAS, type Persona } from "../demo/fernhollow.ts";
import { bump, claimSandbox, personaOf, personaUser, publicStats } from "../demo/service.ts";
import { deleteWorkspace } from "../workspace/bundle.ts";
import { AppError, forbidden } from "../lib/errors.ts";
import { parse } from "../lib/validate.ts";

const startBody = z.object({ turnstileToken: z.string().max(4096).optional() });
const personaBody = z.object({ persona: z.enum(Object.keys(PERSONAS) as [Persona, ...Persona[]]) });

async function signInAs(c: Ctx, tenantId: string, persona: Persona, expiresAt: Date): Promise<void> {
  const userId = await personaUser(c.get("sql"), tenantId, persona);
  const session = await withTenant(c.get("sql"), tenantId, (tx) =>
    createSession(tx, { tenantId, userId, ttlHours: 24, notAfter: expiresAt }),
  );
  setCookie(c, sessionCookieName(c), session.cookieValue, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: "Lax",
    path: "/",
    expires: session.expiresAt,
  });
}

function demoAuth(c: Ctx) {
  const auth = requireAuth(c);
  if (!auth.demo || auth.kind !== "session") throw forbidden("This only works in a demo sandbox");
  return auth;
}

async function sandboxExpiry(c: Ctx, tenantId: string): Promise<Date> {
  const [t] = await c.get("sql")<{ expiresAt: Date }[]>`select expires_at from tenants where id = ${tenantId}`;
  if (!t?.expiresAt) throw forbidden("This only works in a demo sandbox");
  return t.expiresAt;
}

const auth = new Hono<AppEnv>()
  /** Try the demo: verify the visitor, hand them a sandbox and sign them in as Sam (agent). */
  .post("/start", async (c) => {
    const { config, verifyTurnstile, rateLimits } = c.get("deps");
    if (!config.demo.enabled) throw new AppError("not_found", "The demo is not available here");
    const { turnstileToken } = parse(startBody, await readJson(c));
    const ip = c.req.header("cf-connecting-ip") ?? null;
    if (rateLimits?.demoStart && !(await rateLimits.demoStart.limit(`start:${ip ?? "unknown"}`))) {
      throw new AppError("rate_limited", "You have started several demos in a row; try again in a minute");
    }
    const human = verifyTurnstile ? await verifyTurnstile(turnstileToken ?? "", ip) : config.devLogin;
    if (!human) throw new AppError("forbidden", "We could not confirm you are human; reload the page and try again");
    const sandbox = await claimSandbox(c.get("sql"), config);
    await signInAs(c, sandbox.tenantId, "agent", sandbox.expiresAt);
    // The opening incident alerts the service desk straight away, not on the next cron run.
    await runAfterResponse(c, processTenantOutbox(workerDeps(c.get("deps"), c.get("sql"), c), sandbox.tenantId));
    return c.json({ ok: true, persona: "agent", expiresAt: sandbox.expiresAt });
  })
  /** Public numbers for the landing page's stats strip (anonymous daily counters). */
  .get("/stats", async (c) => {
    const { config } = c.get("deps");
    if (!config.demo.enabled || !c.get("dbReady")) return c.json({ stats: null }, 200, { "cache-control": "public, max-age=60" });
    return c.json({ stats: await publicStats(c.get("sql")) }, 200, { "cache-control": "public, max-age=60" });
  });

const api = new Hono<AppEnv>()
  .get("/info", async (c) => {
    const a = demoAuth(c);
    const expiresAt = await sandboxExpiry(c, a.tenantId);
    const [mail] = await withTenant(c.get("sql"), a.tenantId, (tx) => tx<{ n: number }[]>`select count(*)::int as n from demo_mail`);
    return c.json({
      persona: personaOf(a.email),
      personas: Object.entries(PERSONAS).map(([key, p]) => ({ key, label: p.label })),
      expiresAt,
      mailCount: mail?.n ?? 0,
      readOnly: a.readOnly,
    });
  })
  /** Role switcher: sign in as another Fernhollow person in the same sandbox. */
  .post("/persona", async (c) => {
    const a = demoAuth(c);
    const { persona } = parse(personaBody, await readJson(c));
    const expiresAt = await sandboxExpiry(c, a.tenantId);
    await destroySession(c.get("sql"), a);
    await signInAs(c, a.tenantId, persona, expiresAt);
    await bump(c.get("sql"), `demo.persona.${persona}`);
    return c.json({ ok: true, persona });
  })
  /** Start over with a fresh copy; the old sandbox is deleted by the next upkeep run. */
  .post("/reset", async (c) => {
    const a = demoAuth(c);
    const { config, rateLimits, blobs, replica } = c.get("deps");
    // Reset makes a new sandbox, so it shares the per-visitor budget for starting one.
    const ip = c.req.header("cf-connecting-ip") ?? a.tenantId;
    if (rateLimits?.demoStart && !(await rateLimits.demoStart.limit(`start:${ip}`))) {
      throw new AppError("rate_limited", "You have reset several times in a row; try again in a minute");
    }
    const persona = personaOf(a.email) ?? "agent";
    const sandbox = await claimSandbox(c.get("sql"), config);
    // The old sandbox goes now (sessions, data and files), not at the next upkeep run.
    await deleteWorkspace(c.get("sql"), a.tenantId, [blobs, replica]);
    await signInAs(c, sandbox.tenantId, persona, sandbox.expiresAt);
    await bump(c.get("sql"), "demo.reset");
    await runAfterResponse(c, processTenantOutbox(workerDeps(c.get("deps"), c.get("sql"), c), sandbox.tenantId));
    return c.json({ ok: true, persona });
  })
  /** Mail the sandbox would have sent (sign-in links, notifications, approval requests). */
  .get("/mail", async (c) => {
    const a = demoAuth(c);
    const mail = await withTenant(c.get("sql"), a.tenantId, (tx) => tx`
      select id, to_addr, subject, body, created_at from demo_mail order by created_at desc limit 100`);
    return c.json({ mail });
  });

export const demoRoutes = { auth, api };
